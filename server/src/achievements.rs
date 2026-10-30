//! Osiągnięcia (jak achievements.py + sekcja „osiągnięcia” w app.py): definicje z panelu admina (tabela `achievements`),
//! liczniki zdarzeń gracza (`user_counters`) i zdobyte osiągnięcia (`user_achievements`, `seen` = popup pokazany).
//!
//! Zdarzenia (zdobyta karta, otwarta skrzynka, gra w kasynie, walka w Arenie) zwiększają liczniki w transakcji zapytania
//! (`count`) i zaznaczają, że po zapytaniu trzeba sprawdzić osiągnięcia. Warstwa `layer` po udanej odpowiedzi sprawdza
//! osiągnięcia zalogowanego gracza (także zawsze przy /api/me), przyznaje nagrody i dopisuje nagłówek X-Ach - przeglądarka
//! pobiera wtedy /api/achievements/pop (popup). Ta sama warstwa dopisuje X-Bibi (easter egg Netanjahu).
//!
//! Warunek (`criteria`, 1-2 na osiągnięcie, oba muszą być spełnione): {"type": ..., "count": n, ...}
//!   cards          zdobyte karty: person / variant / rarity / crate; "unique" = różne osoby z klasera
//!   open           otwarte skrzynki ("crate" - puste = wszystkie)
//!   casino_plays   gry w kasynie ("game", "weekday" 0 = poniedziałek)
//!   casino_win     wygrane w kasynie ("game", postawiona karta "person" / "variant")
//!   casino_streak  wygrane z rzędu (remis nie przerywa) - liczy się najlepsza seria
//!   drop_together  2-4 karty, które wypadły naraz przy jednym otwieraniu (powtórzenia = tyle sztuk)
//!   arena          "mode": win albo finisher (ostatni cios kartą "person")
//! Warunki "cards" (bez "unique") liczą max(liczniki, karty w ekwipunku teraz) - działają też karty z wymiany i rynku.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Request, State};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::cookie::SignedCookieJar;
use chrono::Datelike;
use serde_json::{json, Map, Value};

use crate::auth::{find_user, session_uid, user_by_id, Admin, Me, User};
use crate::catalog::{Catalog, Person};
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{AppError, Res};
use crate::game::{
    add_chests, add_state, collected_list, discovered, drops_of, insert_item, log_admin, note_drops, valid_chest_kind, Ctx,
};
use crate::routes::{ok, JsonBody};
use crate::state::AppState;
use crate::variants::truthy;

pub const GAMES: [(&str, &str); 5] = [
    ("roulette", "Ruletka"),
    ("blackjack", "Blackjack"),
    ("slots", "Jednoręki bandyta"),
    ("jackpot", "Jackpot"),
    ("horses", "Wyścigi konne"),
];
const TYPES: [(&str, &str); 7] = [
    ("cards", "Zdobyte karty"),
    ("open", "Otwarte skrzynki"),
    ("casino_plays", "Gry w kasynie"),
    ("casino_win", "Wygrane w kasynie"),
    ("casino_streak", "Wygrane w kasynie z rzędu"),
    ("drop_together", "Wypadnięcie kart naraz"),
    ("arena", "Arena"),
];
const WEEKDAYS: [&str; 7] = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
const WEEKDAYS_IN: [&str; 7] =
    ["w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę", "w niedzielę"];
const REWARD_TYPES: [(&str, &str); 3] = [("money", "Pieniądze"), ("chest", "Skrzynki"), ("card", "Karta")];
const NAME_MAX: usize = 60;
const DESC_MAX: usize = 300;
const MAX_CRITERIA: usize = 2;
const MAX_REWARDS: usize = 8;
const MAX_COUNT: i64 = 10_000_000;

fn pairs(list: &[(&str, &str)]) -> Value {
    Value::Object(list.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect())
}

fn game_name(game: &str) -> &'static str {
    GAMES.iter().find(|(k, _)| *k == game).map_or("", |(_, n)| n)
}

/// Pole tekstowe warunku ("" gdy brak / null)
fn s<'a>(c: &'a Value, k: &str) -> &'a str {
    c.get(k).and_then(Value::as_str).unwrap_or("")
}

fn count_of(c: &Value) -> i64 {
    crate::variants::py_int(c.get("count").unwrap_or(&Value::Null)).filter(|n| *n != 0).unwrap_or(1)
}

/// Warianty składowe ("flag+gold" -> flag, gold)
pub fn parts(variant: &str) -> Vec<&str> {
    variant.split('+').filter(|x| !x.is_empty()).collect()
}

/// Warianty karty liczone w licznikach: składowe + całe połączenie
fn variant_keys(variant: &str) -> Vec<&str> {
    let mut vs = parts(variant);
    if vs.len() > 1 {
        vs.push(variant);
    }
    vs
}

// ---------------------------------------------------------------- liczniki

/// Klucze liczników zwiększane, gdy gracz zdobywa kartę
pub fn card_events(p: &Person, variant: &str) -> Vec<String> {
    let mut keys = vec!["cards".to_owned(), format!("p:{}", p.id), format!("r:{}", p.rarity)];
    for v in variant_keys(variant) {
        keys.push(format!("v:{v}"));
        keys.push(format!("pv:{}:{v}", p.id));
    }
    let crates: Vec<&String> = if p.crates.is_empty() { p.crate_.iter().collect() } else { p.crates.iter().collect() };
    for c in crates.into_iter().filter(|c| !c.is_empty()) {
        keys.push(format!("c:{c}"));
        keys.push(format!("rc:{}:{c}", p.rarity));
    }
    keys
}

/// weekday: dzień tygodnia gry (0 = poniedziałek)
fn play_events(game: &str, weekday: u32) -> Vec<String> {
    vec!["play:any".into(), format!("play:{game}"), format!("play:any:wd{weekday}"), format!("play:{game}:wd{weekday}")]
}

/// Gracz wygrał grę w kasynie; cards = karty, które postawił (osoba, wariant)
fn win_events(game: &str, cards: &[(String, String)]) -> Vec<String> {
    let mut keys = vec!["win:any".to_owned(), format!("win:{game}")];
    let unique: HashSet<&(String, String)> = cards.iter().collect();
    for g in ["any", game] {
        for (pid, variant) in &unique {
            keys.push(format!("winp:{g}:{pid}"));
            for v in variant_keys(variant) {
                keys.push(format!("winv:{g}:{v}"));
                keys.push(format!("winpv:{g}:{pid}:{v}"));
            }
        }
    }
    let mut seen = HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

fn together_key(persons: &[String]) -> String {
    let mut ps = persons.to_vec();
    ps.sort();
    format!("dt:{}", ps.join(",")) // powtórzenia zostają: "dt:a,a" = dwie karty a naraz
}

fn weekday_of(c: &Value) -> Option<usize> {
    c.get("weekday").and_then(Value::as_u64).filter(|wd| *wd <= 6).map(|wd| wd as usize)
}

fn persons_of(c: &Value) -> Vec<String> {
    c.get("persons").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// Klucz licznika, z którego liczy się warunek (None - warunek liczony z klasera: "unique")
fn criterion_key(c: &Value) -> Option<String> {
    let (p, v) = (s(c, "person"), s(c, "variant"));
    Some(match s(c, "type") {
        "cards" => {
            let (r, cr) = (s(c, "rarity"), s(c, "crate"));
            match () {
                _ if !p.is_empty() && !v.is_empty() => format!("pv:{p}:{v}"),
                _ if !p.is_empty() => format!("p:{p}"),
                _ if !v.is_empty() => format!("v:{v}"),
                _ if !r.is_empty() && !cr.is_empty() => format!("rc:{r}:{cr}"),
                _ if !r.is_empty() => format!("r:{r}"),
                _ if !cr.is_empty() => format!("c:{cr}"),
                _ => "cards".into(),
            }
        }
        "open" if !s(c, "crate").is_empty() => format!("open:{}", s(c, "crate")),
        "open" => "open".into(),
        "casino_plays" => {
            let game = Some(s(c, "game")).filter(|x| !x.is_empty()).unwrap_or("any");
            match weekday_of(c) {
                Some(wd) => format!("play:{game}:wd{wd}"),
                None => format!("play:{game}"),
            }
        }
        "casino_streak" => format!("beststreak:{}", Some(s(c, "game")).filter(|x| !x.is_empty()).unwrap_or("any")),
        "casino_win" => {
            let game = Some(s(c, "game")).filter(|x| !x.is_empty()).unwrap_or("any");
            match () {
                _ if !p.is_empty() && !v.is_empty() => format!("winpv:{game}:{p}:{v}"),
                _ if !p.is_empty() => format!("winp:{game}:{p}"),
                _ if !v.is_empty() => format!("winv:{game}:{v}"),
                _ => format!("win:{game}"),
            }
        }
        "drop_together" => together_key(&persons_of(c)),
        "arena" if s(c, "mode") == "finisher" && !p.is_empty() => format!("arena:fin:{p}"),
        "arena" if s(c, "mode") == "finisher" => "arena:fin".into(),
        "arena" => "arena:win".into(),
        _ => return None,
    })
}

type Counters = HashMap<String, i64>;

/// (ile jest, ile trzeba) dla jednego warunku. collected: różne osoby z klasera pasujące do warunku (tylko "unique");
/// owned: liczniki kart, które gracz ma teraz w ekwipunku (dla "cards")
fn progress(c: &Value, counters: &Counters, collected: usize, owned: Option<&Counters>) -> (i64, i64) {
    let need = count_of(c).max(1);
    let cards = s(c, "type") == "cards";
    if cards && c.get("unique").is_some_and(truthy) {
        return ((collected as i64).min(need), need);
    }
    let key = criterion_key(c).unwrap_or_default();
    let mut cur = counters.get(&key).copied().unwrap_or(0);
    if let (true, Some(owned)) = (cards, owned) {
        cur = cur.max(owned.get(&key).copied().unwrap_or(0));
    }
    (cur.min(need), need)
}

fn criteria(d: &Value) -> &[Value] {
    d.get("criteria").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn rewards(d: &Value) -> &[Value] {
    d.get("rewards").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

// ---------------------------------------------------------------- opisy

/// Nazwy do opisów warunków; tajne karty, których gracz jeszcze nie odkrył, są ukryte
struct Names<'a> {
    cat: &'a Catalog,
    found: Option<HashSet<String>>,
}

impl Names<'_> {
    fn person(&self, pid: &str) -> String {
        match self.cat.person(pid) {
            None => "?".into(),
            Some(p) if p.rarity == "secret" && self.found.as_ref().is_some_and(|f| !f.contains(pid)) => "???".into(),
            Some(p) => p.name.clone(),
        }
    }

    fn crate_(&self, cid: &str) -> String {
        if let Some(c) = self.cat.crates.get(cid) {
            return c.name.clone();
        }
        let g = g();
        cid.strip_prefix("money_").and_then(|k| g.money_chests.get(k)).map_or_else(|| cid.to_owned(), |m| m.name.clone())
    }

    fn variant(&self, v: &str) -> String {
        g().variants.get(v).map_or_else(|| v.to_owned(), |x| x.name.clone())
    }

    fn rarity(&self, r: &str) -> String {
        g().rarities.get(r).map_or_else(|| r.to_owned(), |x| x.name.clone())
    }
}

/// Opis warunku po polsku
fn describe(c: &Value, names: &Names) -> String {
    let n = count_of(c);
    let person = Some(s(c, "person")).filter(|x| !x.is_empty()).map(|p| names.person(p)).unwrap_or_default();
    let variant = Some(s(c, "variant")).filter(|x| !x.is_empty()).map(|v| names.variant(v)).unwrap_or_default();
    let game = |c: &Value| if s(c, "game").is_empty() { String::new() } else { format!(" ({})", game_name(s(c, "game"))) };
    match s(c, "type") {
        "cards" => {
            let mut what = if person.is_empty() { "karty".to_owned() } else { format!("kartę {person}") };
            if !variant.is_empty() {
                what += &format!(" w wariancie {variant}");
            }
            if person.is_empty() && !s(c, "rarity").is_empty() {
                what += &format!(" rzadkości {}", names.rarity(s(c, "rarity")));
            }
            if person.is_empty() && !s(c, "crate").is_empty() {
                what += &format!(" ze skrzynki {}", names.crate_(s(c, "crate")));
            }
            if c.get("unique").is_some_and(truthy) {
                format!("Zdobądź różne karty{}: {n}", what.chars().skip(5).collect::<String>())
            } else {
                format!("Zdobądź {what}: {n}×")
            }
        }
        "open" => {
            let cr = s(c, "crate");
            let which = if cr.is_empty() { String::new() } else { format!(" „{}”", names.crate_(cr)) };
            format!("Otwórz skrzynki{which}: {n}×")
        }
        "casino_plays" => {
            let wd = weekday_of(c).map(|wd| format!(" {}", WEEKDAYS_IN[wd])).unwrap_or_default();
            format!("Zagraj w kasynie{}{wd}: {n}×", game(c))
        }
        "casino_streak" => format!("Wygraj w kasynie {n} razy z rzędu{}", game(c)),
        "casino_win" => {
            let mut extra = if person.is_empty() { String::new() } else { format!(", stawiając kartę {person}") };
            if !variant.is_empty() {
                extra += &format!(" w wariancie {variant}");
            }
            format!("Wygraj w kasynie{}{extra}: {n}×", game(c))
        }
        "drop_together" => {
            let ps = persons_of(c);
            let mut uniq: Vec<&String> = vec![];
            for p in &ps {
                if !uniq.contains(&p) {
                    uniq.push(p);
                }
            }
            let list: Vec<String> = uniq
                .iter()
                .map(|p| {
                    let k = ps.iter().filter(|x| x == p).count();
                    format!("{}{}", if k > 1 { format!("{k}× ") } else { String::new() }, names.person(p))
                })
                .collect();
            format!("Wylosuj naraz (przy otwieraniu kilku skrzynek): {}", list.join(", "))
        }
        "arena" if s(c, "mode") == "finisher" => {
            let who = if person.is_empty() { "dowolną".to_owned() } else { person };
            format!(
                "Wygraj walkę w Arenie, zadając ostatni cios kartą {who}{}",
                if n > 1 { format!(": {n}×") } else { String::new() }
            )
        }
        "arena" => format!("Wygraj walki w Arenie: {n}×"),
        _ => "?".into(),
    }
}

fn reward_text(r: &Value, names: &Names) -> String {
    let n = r.get("count").and_then(Value::as_i64).unwrap_or(1);
    match s(r, "type") {
        "money" => format!("{} gr", r.get("amount").and_then(Value::as_i64).unwrap_or(0)),
        "chest" => format!("{n}× {}", names.crate_(s(r, "kind"))),
        _ => {
            let v = s(r, "variant");
            let variant = if v.is_empty() || v == "normal" { String::new() } else { format!(" ({})", names.variant(v)) };
            format!("{n}× {}{variant}", names.person(s(r, "person")))
        }
    }
}

// ---------------------------------------------------------------- walidacja (zapis z panelu admina)

/// int(float(str(v).replace(",", "."))) w granicach; default, gdy to nie liczba
fn num(v: Option<&Value>, lo: i64, hi: i64, default: i64) -> i64 {
    let x = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(t)) => t.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    };
    x.filter(|x| x.is_finite()).map_or(default, |x| (x.trunc() as i64).clamp(lo, hi))
}

fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Bool(false)) => String::new(),
        Some(x) => x.to_string(),
    }
}

fn cut(t: &str, n: usize) -> String {
    t.chars().take(n).collect()
}

/// Dozwolone wartości (karty, warianty, rzadkości, skrzynki, skrzynki w nagrodach)
struct CleanCtx<'a> {
    cat: &'a Catalog,
}

impl CleanCtx<'_> {
    fn person(&self, p: &str) -> bool {
        self.cat.people.contains_key(p)
    }

    fn variant(&self, v: &str) -> bool {
        g().variants.contains_key(v)
    }

    fn crate_(&self, c: &str) -> bool {
        self.cat.crates.get(c).is_some_and(|c| !c.special)
    }

    fn chest(&self, c: &str) -> bool {
        self.crate_(c) || c.strip_prefix("money_").is_some_and(|k| g().money_chests.contains_key(k))
    }
}

fn clean_criterion(c: &Value, ctx: &CleanCtx) -> Result<Value, &'static str> {
    let t = s(c, "type");
    if !TYPES.iter().any(|(k, _)| *k == t) {
        return Err("Nieznany rodzaj warunku");
    }
    let mut out = Map::new();
    out.insert("type".into(), json!(t));
    out.insert("count".into(), json!(num(c.get("count"), 1, MAX_COUNT, 1)));
    let (pid, var) = (text(c.get("person")), text(c.get("variant")));
    if !pid.is_empty() && !ctx.person(&pid) {
        return Err("Warunek wskazuje kartę, której nie ma w grze");
    }
    if !var.is_empty() && !ctx.variant(&var) {
        return Err("Warunek wskazuje nieistniejący wariant");
    }
    let game = || if GAMES.iter().any(|(k, _)| *k == s(c, "game")) { s(c, "game") } else { "" };
    match t {
        "cards" => {
            let rarity = if g().rarities.contains_key(s(c, "rarity")) { s(c, "rarity") } else { "" };
            let cr = if ctx.crate_(s(c, "crate")) { s(c, "crate") } else { "" };
            // "różne karty" nie ma sensu dla jednej konkretnej osoby
            let unique = c.get("unique").is_some_and(truthy) && pid.is_empty();
            out.extend([
                ("person".into(), json!(pid)),
                ("variant".into(), json!(var)),
                ("rarity".into(), json!(rarity)),
                ("crate".into(), json!(cr)),
                ("unique".into(), json!(unique)),
            ]);
        }
        "open" => {
            out.insert("crate".into(), json!(if ctx.crate_(s(c, "crate")) { s(c, "crate") } else { "" }));
        }
        "casino_plays" => {
            out.insert("game".into(), json!(game()));
            let wd = match c.get("weekday") {
                Some(Value::Number(n)) => n.as_u64(),
                Some(Value::String(t)) if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) => t.parse().ok(),
                _ => None,
            };
            out.insert("weekday".into(), wd.filter(|wd| *wd <= 6).map_or(json!(""), |wd| json!(wd)));
        }
        "casino_streak" => {
            out.insert("game".into(), json!(game()));
        }
        "casino_win" => {
            out.extend([("game".into(), json!(game())), ("person".into(), json!(pid)), ("variant".into(), json!(var))]);
        }
        "drop_together" => {
            let persons: Vec<String> = persons_of(c).into_iter().filter(|p| ctx.person(p)).collect();
            if !(2..=4).contains(&persons.len()) {
                return Err("Wybierz od 2 do 4 kart (ta sama karta może się powtarzać - np. dwie takie same naraz)");
            }
            out.insert("persons".into(), json!(persons));
            out.insert("count".into(), json!(1));
        }
        _ => {
            let fin = s(c, "mode") == "finisher";
            out.insert("mode".into(), json!(if fin { "finisher" } else { "win" }));
            out.insert("person".into(), json!(if fin { pid } else { String::new() }));
        }
    }
    Ok(Value::Object(out))
}

fn clean_reward(r: &Value, ctx: &CleanCtx) -> Result<Value, &'static str> {
    match s(r, "type") {
        "money" => match num(r.get("amount"), 1, 1_000_000_000, 0) {
            0 => Err("Podaj kwotę nagrody"),
            amount => Ok(json!({"type": "money", "amount": amount})),
        },
        "chest" => {
            if !ctx.chest(s(r, "kind")) {
                return Err("Nieznana skrzynka w nagrodzie");
            }
            Ok(json!({"type": "chest", "kind": s(r, "kind"), "count": num(r.get("count"), 1, 1000, 1)}))
        }
        "card" => {
            if !ctx.person(s(r, "person")) {
                return Err("Nagroda wskazuje kartę, której nie ma w grze");
            }
            let variant = Some(text(r.get("variant"))).filter(|v| !v.is_empty()).unwrap_or_else(|| "normal".into());
            if variant != "normal" && !ctx.variant(&variant) {
                return Err("Nagroda wskazuje nieistniejący wariant");
            }
            Ok(json!({"type": "card", "person": s(r, "person"), "variant": variant, "count": num(r.get("count"), 1, 100, 1)}))
        }
        _ => Err("Nieznany rodzaj nagrody"),
    }
}

/// Definicja osiągnięcia z formularza admina albo komunikat błędu
fn clean(raw: &Value, ctx: &CleanCtx) -> Result<Value, &'static str> {
    let name = cut(text(raw.get("name")).trim(), NAME_MAX);
    if name.is_empty() {
        return Err("Podaj nazwę osiągnięcia");
    }
    let list = |k: &str, max: usize| -> Vec<Value> {
        raw.get(k).and_then(Value::as_array).into_iter().flatten().take(max).cloned().collect()
    };
    let mut crit = vec![];
    for c in list("criteria", MAX_CRITERIA) {
        let c = if c.is_object() { c } else { json!({}) };
        crit.push(clean_criterion(&c, ctx)?);
    }
    if crit.is_empty() {
        return Err("Dodaj przynajmniej jeden warunek");
    }
    let mut rw = vec![];
    for r in list("rewards", MAX_REWARDS) {
        let r = if r.is_object() { r } else { json!({}) };
        rw.push(clean_reward(&r, ctx)?);
    }
    let icon = Some(text(raw.get("icon")).trim().to_owned()).filter(|i| !i.is_empty()).unwrap_or_else(|| "🏆".into());
    Ok(json!({
        "name": name,
        "desc": cut(text(raw.get("desc")).trim(), DESC_MAX),
        "icon": cut(&icon, 8),
        "hidden": raw.get("hidden").is_some_and(truthy),
        "enabled": raw.get("enabled").is_none_or(truthy),
        "criteria": crit,
        "rewards": rw,
    }))
}

// ---------------------------------------------------------------- zapytanie: liczniki i nagłówki

tokio::task_local! {
    static FLAGS: Flags;
}

/// Co zdarzyło się w czasie zapytania (ustawiane przez zdarzenia, czytane przez `layer`)
#[derive(Default)]
struct Flags {
    ach: Cell<bool>,
    bibi: Cell<bool>,
}

/// Po zapytaniu trzeba sprawdzić osiągnięcia zalogowanego gracza
pub fn mark() {
    let _ = FLAGS.try_with(|f| f.ach.set(true));
}

/// Gracz dostał kartę z `bibi` - nagłówek X-Bibi (przeglądarka pokazuje obrazek, bibiPlay w app.js)
pub fn mark_bibi() {
    let _ = FLAGS.try_with(|f| f.bibi.set(true));
}

/// Zwiększa liczniki gracza (+n za każdy klucz; ten sam klucz kilka razy = kilka razy więcej)
pub async fn count(c: &mut Conn, uid: i64, keys: impl IntoIterator<Item = (String, i64)>) -> sqlx::Result<()> {
    if uid <= 0 {
        return Ok(());
    }
    let mut sum: HashMap<String, i64> = HashMap::new();
    for (k, n) in keys {
        *sum.entry(k).or_default() += n;
    }
    sum.retain(|_, n| *n != 0);
    if sum.is_empty() {
        return Ok(());
    }
    let (ks, ns): (Vec<String>, Vec<i64>) = sum.into_iter().unzip();
    sqlx::query(
        "INSERT INTO user_counters (user_id, key, value) SELECT $1, k, v FROM UNNEST($2::text[], $3::bigint[]) AS t(k, v)
         ON CONFLICT (user_id, key) DO UPDATE SET value = user_counters.value + excluded.value",
    )
    .bind(uid)
    .bind(&ks)
    .bind(&ns)
    .execute(&mut *c)
    .await?;
    mark();
    Ok(())
}

fn ones(keys: Vec<String>) -> impl Iterator<Item = (String, i64)> {
    keys.into_iter().map(|k| (k, 1))
}

/// Zdobyta karta (insert_item)
pub async fn count_card(c: &mut Conn, uid: i64, p: &Person, variant: &str) -> sqlx::Result<()> {
    if p.bibi {
        mark_bibi();
    }
    count(c, uid, ones(card_events(p, variant))).await
}

/// Otwarte skrzynki: liczniki "open" i karty, które wypadły naraz (warunki "drop_together")
pub async fn count_open(c: &mut Conn, uid: i64, crate_id: &str, n: i64, persons: &[String]) -> sqlx::Result<()> {
    let mut keys = vec![("open".to_owned(), n), (format!("open:{crate_id}"), n)];
    let mut have: HashMap<&str, usize> = HashMap::new();
    for p in persons {
        *have.entry(p).or_default() += 1;
    }
    let mut seen = HashSet::new();
    for d in defs(c, false).await? {
        for cr in criteria(&d).iter().filter(|cr| s(cr, "type") == "drop_together") {
            let need = persons_of(cr);
            let fits = !need.is_empty()
                && need.iter().all(|p| have.get(p.as_str()).copied().unwrap_or(0) >= need.iter().filter(|x| *x == p).count());
            let key = together_key(&need);
            if fits && seen.insert(key.clone()) {
                keys.push((key, 1));
            }
        }
    }
    count(c, uid, keys).await
}

/// Gra w kasynie rozegrana (won: Some(true) wygrana / Some(false) przegrana / None remis, zwrot); cards = postawione
/// karty. Seria wygranych z rzędu (streak:<gra>, najlepsza: beststreak:<gra>) - przegrana ją zeruje.
pub async fn count_casino(c: &mut Conn, uid: i64, game: &str, won: Option<bool>, cards: &[(String, String)]) -> sqlx::Result<()> {
    let wd = chrono::Local::now().weekday().num_days_from_monday();
    let mut keys = play_events(game, wd);
    if won == Some(true) {
        keys.extend(win_events(game, cards));
    }
    count(c, uid, ones(keys)).await?;
    let Some(won) = won else { return Ok(()) };
    for g in ["any", game] {
        let streak = format!("streak:{g}");
        if won {
            let cur: i64 = sqlx::query_scalar(
                "INSERT INTO user_counters (user_id, key, value) VALUES ($1, $2, 1)
                 ON CONFLICT (user_id, key) DO UPDATE SET value = user_counters.value + 1 RETURNING value",
            )
            .bind(uid)
            .bind(&streak)
            .fetch_one(&mut *c)
            .await?;
            sqlx::query(
                "INSERT INTO user_counters (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO UPDATE SET
                 value = GREATEST(user_counters.value, excluded.value)",
            )
            .bind(uid)
            .bind(format!("beststreak:{g}"))
            .bind(cur)
            .execute(&mut *c)
            .await?;
        } else {
            sqlx::query("UPDATE user_counters SET value = 0 WHERE user_id = $1 AND key = $2")
                .bind(uid)
                .bind(&streak)
                .execute(&mut *c)
                .await?;
        }
    }
    Ok(())
}

/// Wygrana walka w Arenie; finisher = karta, która zadała ostatni cios (wygrana przez nokaut)
pub async fn count_arena(c: &mut Conn, uid: i64, finisher: Option<&str>) -> sqlx::Result<()> {
    let mut keys = vec!["arena:win".to_owned()];
    if let Some(pid) = finisher {
        keys.extend(["arena:fin".to_owned(), format!("arena:fin:{pid}")]);
    }
    count(c, uid, ones(keys)).await
}

/// Karty (osoba, wariant) o podanych id
pub async fn cards_of(c: &mut Conn, ids: &[i64]) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as("SELECT person_id, variant FROM items WHERE id = ANY($1)").bind(ids).fetch_all(c).await
}

// ---------------------------------------------------------------- sprawdzanie i nagrody

/// Definicje (z "id"), w kolejności z panelu admina
async fn defs(c: &mut Conn, include_off: bool) -> sqlx::Result<Vec<Value>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, data FROM achievements WHERE deleted = 0 ORDER BY pos, id").fetch_all(c).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, data)| {
            let mut d: Value = serde_json::from_str(&data).ok()?;
            d.as_object_mut()?.insert("id".into(), json!(id));
            (include_off || d.get("enabled").is_none_or(truthy)).then_some(d)
        })
        .collect())
}

async fn counters(c: &mut Conn, uid: i64) -> sqlx::Result<Counters> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT key, value FROM user_counters WHERE user_id = $1").bind(uid).fetch_all(c).await?;
    Ok(rows.into_iter().collect())
}

/// Liczniki z kart, które gracz ma teraz (te same klucze co card_events) - karty z wymiany, rynku itd.
async fn owned(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Counters> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT person_id, variant, COUNT(*) FROM items WHERE user_id = $1 GROUP BY person_id, variant",
    )
    .bind(uid)
    .fetch_all(c)
    .await?;
    let mut out = Counters::new();
    for (pid, variant, n) in rows {
        if let Some(p) = cat.person(&pid) {
            for k in card_events(p, &variant) {
                *out.entry(k).or_default() += n;
            }
        }
    }
    Ok(out)
}

/// Różne osoby z klasera gracza pasujące do warunku "unique" (rzadkość / skrzynka / wariant)
fn collected_for(cat: &Catalog, list: &[(String, String)], c: &Value) -> usize {
    let (rarity, cr, variant) = (s(c, "rarity"), s(c, "crate"), s(c, "variant"));
    let mut out = HashSet::new();
    for (pid, v) in list {
        let Some(p) = cat.person(pid) else { continue };
        if !rarity.is_empty() && p.rarity != rarity {
            continue;
        }
        if !cr.is_empty() && !p.crates.iter().chain(p.crate_.iter()).any(|x| x == cr) {
            continue;
        }
        if !variant.is_empty() && v != variant && !parts(v).contains(&variant) {
            continue;
        }
        out.insert(pid.as_str());
    }
    out.len()
}

/// Wszystko, czego trzeba do postępu gracza
struct Progress {
    counters: Counters,
    owned: Option<Counters>,
    collected: Vec<(String, String)>,
}

impl Progress {
    async fn load(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Progress> {
        Ok(Progress {
            counters: counters(c, uid).await?,
            owned: Some(owned(c, cat, uid).await?),
            collected: collected_list(c, cat, uid).await?,
        })
    }

    fn of(&self, cat: &Catalog, cr: &Value) -> (i64, i64) {
        let collected = if cr.get("unique").is_some_and(truthy) { collected_for(cat, &self.collected, cr) } else { 0 };
        progress(cr, &self.counters, collected, self.owned.as_ref())
    }

    fn done(&self, cat: &Catalog, d: &Value) -> bool {
        criteria(d).iter().all(|cr| {
            let (cur, need) = self.of(cat, cr);
            cur >= need
        })
    }
}

/// Nagrody za osiągnięcie dla zalogowanego gracza: pieniądze, skrzynki, karty
async fn grant(c: &mut Conn, cx: &Ctx, d: &Value) -> sqlx::Result<()> {
    for r in rewards(d) {
        let n = r.get("count").and_then(Value::as_i64).unwrap_or(1);
        match s(r, "type") {
            "money" => add_state(c, cx.uid(), "balance", r.get("amount").and_then(Value::as_i64).unwrap_or(0)).await?,
            "chest" if valid_chest_kind(&cx.cat, s(r, "kind")) => add_chests(c, cx.uid(), s(r, "kind"), n).await?,
            "card" if cx.cat.has(s(r, "person")) => {
                let v = s(r, "variant");
                let variant = if g().variants.contains_key(v) { v } else { "normal" };
                let mut items = vec![];
                for _ in 0..n {
                    items.push(insert_item(c, cx, s(r, "person"), variant, "achievement").await?);
                }
                note_drops(c, cx, &drops_of(&items), "drop").await?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Sprawdza osiągnięcia gracza i przyznaje te, które właśnie spełnił (razem z nagrodami). true = są nowe.
async fn award(st: &AppState, user: User) -> anyhow::Result<bool> {
    let cx = Ctx::new(st.clone(), user);
    let uid = cx.uid();
    let mut tx = st.db.begin().await?;
    let mut new = false;
    for _ in 0..4 {
        // karty z nagród też liczą się do kolejnych osiągnięć
        let earned: HashSet<String> =
            sqlx::query_scalar("SELECT ach_id FROM user_achievements WHERE user_id = $1").bind(uid).fetch_all(&mut *tx).await?
                .into_iter()
                .collect();
        let todo: Vec<Value> = defs(&mut tx, false).await?.into_iter().filter(|d| !earned.contains(s(d, "id"))).collect();
        if todo.is_empty() {
            break;
        }
        let pr = Progress::load(&mut tx, &cx.cat, uid).await?;
        let won: Vec<&Value> = todo.iter().filter(|d| pr.done(&cx.cat, d)).collect();
        if won.is_empty() {
            break;
        }
        for d in won {
            let added = sqlx::query(
                "INSERT INTO user_achievements (user_id, ach_id, at, seen) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING",
            )
            .bind(uid)
            .bind(s(d, "id"))
            .bind(now())
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if added == 1 {
                grant(&mut tx, &cx, d).await?;
                new = true;
            }
        }
    }
    tx.commit().await?;
    Ok(new)
}

/// Warstwa wokół wszystkich zapytań: po udanym zapytaniu, które zmieniło liczniki (i zawsze przy /api/me), sprawdza
/// osiągnięcia zalogowanego gracza i dopisuje X-Ach; dopisuje też X-Bibi. Osiągnięcia nigdy nie psują odpowiedzi.
pub async fn layer(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let is_me = req.uri().path() == "/api/me";
    let jar = SignedCookieJar::from_headers(req.headers(), st.cookie_key.clone());
    let (mut resp, ach, bibi) = FLAGS
        .scope(Flags::default(), async {
            let resp = next.run(req).await;
            let (ach, bibi) = FLAGS.with(|f| (f.ach.get(), f.bibi.get()));
            (resp, ach, bibi)
        })
        .await;
    if resp.status().as_u16() >= 400 {
        return resp;
    }
    if bibi {
        resp.headers_mut().insert("X-Bibi", HeaderValue::from_static("1"));
    }
    if !(ach || is_me) {
        return resp;
    }
    let Some(uid) = session_uid(&jar) else { return resp };
    let result = async {
        let user = user_by_id(&mut *st.db.acquire().await?, uid).await?;
        match user.filter(|u| u.banned == 0) {
            Some(u) => award(&st, u).await,
            None => Ok(false),
        }
    }
    .await;
    match result {
        Ok(true) => {
            resp.headers_mut().insert("X-Ach", HeaderValue::from_static("1"));
        }
        Ok(false) => {}
        Err(e) => tracing::error!("osiągnięcia: {e:#}"),
    }
    resp
}

/// Ile osiągnięć gracz zdobył, a jeszcze nie widział popupu (/api/me: achUnseen)
pub async fn unseen(c: &mut Conn, uid: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM user_achievements WHERE user_id = $1 AND seen = 0").bind(uid).fetch_one(c).await
}

// ---------------------------------------------------------------- start serwera

/// Wbudowane osiągnięcia (raz - admin może je zmienić albo usunąć) i liczniki dla starych kont
pub async fn init(c: &mut Conn, cat: &Catalog) -> sqlx::Result<()> {
    let (mut ids, mut data, mut pos) = (vec![], vec![], vec![]);
    for (i, d) in crate::data::base_game().achievements.iter().enumerate() {
        let mut d = d.clone();
        let Some(id) = d.as_object_mut().and_then(|o| o.shift_remove("id")).and_then(|v| v.as_str().map(str::to_owned))
        else {
            continue;
        };
        ids.push(id);
        data.push(d.to_string());
        pos.push(i as i32);
    }
    sqlx::query(
        "INSERT INTO achievements (id, data, pos) SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&ids)
    .bind(&data)
    .bind(&pos)
    .execute(&mut *c)
    .await?;
    backfill(c, cat).await
}

/// Gracze bez liczników osiągnięć (stare konta) dostają je z tego, co mają: karty w ekwipunku i otwarte skrzynki
async fn backfill(c: &mut Conn, cat: &Catalog) -> sqlx::Result<()> {
    let have: HashSet<i64> =
        sqlx::query_scalar("SELECT DISTINCT user_id FROM user_counters").fetch_all(&mut *c).await?.into_iter().collect();
    let mut buf: HashMap<(i64, String), i64> = HashMap::new();
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, person_id, variant, COUNT(*) FROM items WHERE user_id > 0 GROUP BY user_id, person_id, variant",
    )
    .fetch_all(&mut *c)
    .await?;
    for (uid, pid, variant, n) in rows {
        let Some(p) = cat.person(&pid).filter(|_| !have.contains(&uid)) else { continue };
        for k in card_events(p, &variant) {
            *buf.entry((uid, k)).or_default() += n;
        }
    }
    let opened: Vec<(i64, i64)> =
        sqlx::query_as("SELECT user_id, value FROM user_state WHERE key = 'opened' AND value > 0").fetch_all(&mut *c).await?;
    for (uid, n) in opened.into_iter().filter(|(u, _)| !have.contains(u)) {
        buf.insert((uid, "open".into()), n);
    }
    if buf.is_empty() {
        return Ok(());
    }
    let (mut us, mut ks, mut ns) = (vec![], vec![], vec![]);
    for ((u, k), n) in buf {
        us.push(u);
        ks.push(k);
        ns.push(n);
    }
    sqlx::query(
        "INSERT INTO user_counters (user_id, key, value) SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[])
         ON CONFLICT DO NOTHING",
    )
    .bind(&us)
    .bind(&ks)
    .bind(&ns)
    .execute(&mut *c)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- API gracza

/// Osiągnięcie dla gracza: opis, postęp, nagrody. Ukryte i niezdobyte - bez szczegółów.
fn ach_json(cat: &Catalog, d: &Value, at: Option<f64>, names: &Names, progress: Option<&Progress>) -> Value {
    let hidden = d.get("hidden").is_some_and(truthy);
    let icon = Some(s(d, "icon")).filter(|i| !i.is_empty()).unwrap_or("🏆");
    let mut out = json!({"id": s(d, "id"), "icon": icon, "hidden": hidden, "earned": at.is_some(), "at": at});
    if hidden && at.is_none() {
        out["name"] = json!("???");
        out["desc"] = json!("Ukryte osiągnięcie — zdobądź je, żeby zobaczyć, co trzeba zrobić.");
        out["progress"] = json!([]);
        out["rewards"] = json!([]);
        return out;
    }
    let conds: Vec<String> = criteria(d).iter().map(|c| describe(c, names)).collect();
    out["name"] = json!(s(d, "name"));
    out["desc"] = json!(if s(d, "desc").is_empty() { conds.join(" + ") } else { s(d, "desc").to_owned() });
    out["conditions"] = json!(conds);
    out["rewards"] = json!(rewards(d).iter().map(|r| reward_text(r, names)).collect::<Vec<_>>());
    out["progress"] = match progress {
        Some(pr) => json!(criteria(d)
            .iter()
            .map(|c| {
                let (cur, need) = pr.of(cat, c);
                json!({"cur": cur, "need": need})
            })
            .collect::<Vec<_>>()),
        None => json!([]),
    };
    out
}

/// Osiągnięcia gracza (na profilu): swoje - wszystkie z postępem, cudze - tylko zdobyte
pub async fn user_achievements(State(st): State<AppState>, Me(me): Me, Path(name): Path<String>) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let Some(u) = find_user(&mut c, &name).await? else {
        return Err(AppError::with_status(axum::http::StatusCode::NOT_FOUND, "Nie ma takiego gracza"));
    };
    let mine = u.id == me.id;
    let rows: HashMap<String, f64> = sqlx::query_as::<_, (String, f64)>("SELECT ach_id, at FROM user_achievements WHERE user_id = $1")
        .bind(u.id)
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .collect();
    let names = Names { cat: &cat, found: Some(discovered(&mut c, me.id).await?) };
    let pr = if mine { Some(Progress::load(&mut c, &cat, u.id).await?) } else { None };
    let list: Vec<Value> = defs(&mut c, false)
        .await?
        .iter()
        .filter(|d| mine || rows.contains_key(s(d, "id")))
        .map(|d| ach_json(&cat, d, rows.get(s(d, "id")).copied(), &names, pr.as_ref()))
        .collect();
    ok(json!({"mine": mine, "list": list}))
}

/// Nowe (jeszcze nie pokazane) osiągnięcia zalogowanego gracza - od razu oznaczamy je jako pokazane
pub async fn achievements_pop(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    let rows: Vec<(String, f64)> =
        sqlx::query_as("SELECT ach_id, at FROM user_achievements WHERE user_id = $1 AND seen = 0 ORDER BY at")
            .bind(me.id)
            .fetch_all(&mut *tx)
            .await?;
    let defs: HashMap<String, Value> = defs(&mut tx, true).await?.into_iter().map(|d| (s(&d, "id").to_owned(), d)).collect();
    let names = Names { cat: &cat, found: Some(discovered(&mut tx, me.id).await?) };
    let list: Vec<Value> =
        rows.iter().filter_map(|(id, at)| defs.get(id).map(|d| ach_json(&cat, d, Some(*at), &names, None))).collect();
    if !rows.is_empty() {
        sqlx::query("UPDATE user_achievements SET seen = 1 WHERE user_id = $1 AND seen = 0").bind(me.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    ok(json!({"list": list}))
}

// ---------------------------------------------------------------- panel admina

pub async fn admin_achievements(State(st): State<AppState>, Admin(_): Admin) -> Res {
    let cat = st.cat();
    let g = g();
    let mut c = st.db.acquire().await?;
    let earned: HashMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>("SELECT ach_id, COUNT(*) FROM user_achievements GROUP BY ach_id")
            .fetch_all(&mut *c)
            .await?
            .into_iter()
            .collect();
    let list: Vec<Value> = defs(&mut c, true)
        .await?
        .into_iter()
        .map(|mut d| {
            d["earned"] = json!(earned.get(s(&d, "id")).copied().unwrap_or(0));
            d
        })
        .collect();
    let mut people: Vec<Value> =
        cat.people.values().map(|p| json!({"id": p.id, "name": p.name, "rarity": p.rarity})).collect();
    people.sort_by_cached_key(|p| s(p, "name").to_lowercase());
    let crates: Vec<Value> =
        cat.crates.iter().filter(|(_, c)| !c.special).map(|(id, c)| json!({"id": id, "name": c.name})).collect();
    let chests: Vec<Value> = g.money_chests.iter().map(|(k, v)| json!({"id": format!("money_{k}"), "name": v.name})).collect();
    let variants: Vec<Value> =
        g.variants.iter().filter(|(_, v)| !v.combo).map(|(k, v)| json!({"id": k, "name": v.name})).collect();
    let rarities: Vec<Value> = g.rarities.iter().map(|(k, v)| json!({"id": k, "name": v.name})).collect();
    ok(json!({"list": list, "meta": {
        "types": pairs(&TYPES), "games": pairs(&GAMES), "rewardTypes": pairs(&REWARD_TYPES),
        "people": people, "crates": crates, "chests": chests, "variants": variants, "rarities": rarities,
        "weekdays": WEEKDAYS, "maxCriteria": MAX_CRITERIA, "maxRewards": MAX_REWARDS,
    }}))
}

/// Zapis osiągnięcia (body: {id?, name, desc, icon, hidden, enabled, criteria, rewards}); bez id - nowe
pub async fn admin_achievement_save(State(st): State<AppState>, Admin(me): Admin, JsonBody(body): JsonBody<Value>) -> Res {
    let cat = st.cat();
    let d = clean(&body, &CleanCtx { cat: &cat }).map_err(AppError::bad)?;
    let mut aid = text(body.get("id"));
    let mut tx = st.db.begin().await?;
    let data = d.to_string();
    if !aid.is_empty() {
        let n = sqlx::query("UPDATE achievements SET data = $1, deleted = 0 WHERE id = $2")
            .bind(&data)
            .bind(&aid)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(AppError::with_status(axum::http::StatusCode::NOT_FOUND, "Nie ma takiego osiągnięcia"));
        }
    } else {
        aid = format!("a_{}", hex::encode(rand::random::<[u8; 4]>()));
        sqlx::query("INSERT INTO achievements (id, data, pos) VALUES ($1, $2, (SELECT COALESCE(MAX(pos), 0) + 1 FROM achievements))")
            .bind(&aid)
            .bind(&data)
            .execute(&mut *tx)
            .await?;
    }
    log_admin(&mut tx, &me, "achievement", None, &format!("{} ({aid})", s(&d, "name"))).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "id": aid}))
}

/// Usunięcie (wbudowane osiągnięcia nie wracają po restarcie); zdobyte przez graczy znikają z ich list
pub async fn admin_achievement_delete(State(st): State<AppState>, Admin(me): Admin, Path(aid): Path<String>) -> Res {
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE achievements SET deleted = 1 WHERE id = $1 AND deleted = 0")
        .bind(&aid)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::with_status(axum::http::StatusCode::NOT_FOUND, "Nie ma takiego osiągnięcia"));
    }
    sqlx::query("DELETE FROM user_achievements WHERE ach_id = $1").bind(&aid).execute(&mut *tx).await?;
    log_admin(&mut tx, &me, "achievement_delete", None, &aid).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_progress() {
        assert_eq!(together_key(&["b".into(), "a".into(), "a".into()]), "dt:a,a,b");
        let c = json!({"type": "cards", "person": "x", "variant": "flag", "count": 2});
        assert_eq!(criterion_key(&c).unwrap(), "pv:x:flag");
        let counters = Counters::from([("pv:x:flag".into(), 1)]);
        let owned = Counters::from([("pv:x:flag".into(), 5)]);
        assert_eq!(progress(&c, &counters, 0, None), (1, 2));
        assert_eq!(progress(&c, &counters, 0, Some(&owned)), (2, 2));
        let w = json!({"type": "casino_plays", "game": "slots", "weekday": 1});
        assert_eq!(criterion_key(&w).unwrap(), "play:slots:wd1");
        assert!(win_events("roulette", &[("p".into(), "flag+gold".into())]).contains(&"winv:any:flag+gold".to_owned()));
    }

    #[test]
    fn numbers_like_python() {
        assert_eq!(num(Some(&json!("2,9")), 1, 10, 1), 2);
        assert_eq!(num(Some(&json!("abc")), 1, 10, 7), 7);
        assert_eq!(num(Some(&json!(99)), 1, 10, 1), 10);
        assert_eq!(num(None, 1, 10, 3), 3);
    }
}
