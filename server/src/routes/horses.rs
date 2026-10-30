//! Kasyno: wyścigi konne (jak sekcja „kasyno: wyścigi konne” w app.py).
//!
//! Wspólny wyścig co HORSE_RACE["period"] s (numer wyścigu = start / okres, przebieg z ziarna z tajnego klucza -
//! horses.rs), zakłady przyjmujemy od betOpen do betClose s przed startem. Postawione karty czekają w ESCROW; rozlicza je
//! (przy zapytaniach, jak settle_market) właściciel zakładu: koń wygrał - karty wracają + wygrana w kartach (stawka × pays),
//! przegrał albo zdechł / uciekł - przepadają, nikt nie wygrał (samochód na torze) - wracają. Wyścig solo: wynik od razu.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use axum::extract::{Path, State};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::casino::{pay_out, stake_error};
use super::{ok, JsonBody};
use crate::auth::{Admin, Me};
use crate::data::{g, HorseDef};
use crate::db::{lock_me, now, Conn};
use crate::error::{bad, Res};
use crate::game::{delete_items, escrow_items, ESCROW, get_state, give_items, log_admin, my_items, row_value, take_my_items, Ctx, Use};
use crate::horses::{rules, simulate, Race};
use crate::state::AppState;

const NAME_MAX: usize = 30;
const PAYS_MAX: f64 = 1000.0;

/// Konie z data.py z nazwami i mnożnikami zmienionymi w panelu admina (tabela horse_settings)
pub async fn horse_list(c: &mut Conn) -> sqlx::Result<Vec<HorseDef>> {
    let over: HashMap<i32, (String, f64)> =
        sqlx::query_as::<_, (i32, String, f64)>("SELECT horse, name, pays FROM horse_settings")
            .fetch_all(c)
            .await?
            .into_iter()
            .map(|(h, n, p)| (h, (n, p)))
            .collect();
    Ok(g()
        .horses
        .iter()
        .map(|h| {
            let mut h = h.clone();
            if let Some((name, pays)) = over.get(&(h.id as i32)) {
                if !name.is_empty() {
                    h.name = name.clone();
                }
                if *pays != 0.0 {
                    h.pays = *pays;
                }
            }
            h
        })
        .collect())
}

/// HORSE_RACE, lista koni i przedmioty - do /api/config ("horses")
pub async fn config_json(c: &mut Conn) -> sqlx::Result<Value> {
    let g = g();
    Ok(json!({"race": g.horse_race, "list": horse_list(c).await?, "items": g.horse_items}))
}

fn horse_start(race: i64) -> f64 {
    (race * rules().period) as f64
}

/// Przebieg wspólnego wyścigu o tym numerze (z pamięci podręcznej)
fn horse_data(secret: &str, race: i64) -> Arc<Race> {
    static CACHE: LazyLock<Mutex<HashMap<i64, Arc<Race>>>> = LazyLock::new(Mutex::default);
    if let Some(r) = CACHE.lock().get(&race) {
        return r.clone();
    }
    let digest = Sha256::digest(format!("{secret}:horses:{race}").as_bytes());
    let seed = u64::from_be_bytes(digest[..8].try_into().expect("8 bajtów"));
    let r = Arc::new(simulate(seed, &[]));
    let mut cache = CACHE.lock();
    if cache.len() > 64 {
        cache.clear();
    }
    cache.insert(race, r.clone());
    r
}

/// Wyścig rusza tylko, gdy postawiło na niego co najmniej minPlayers graczy (zakłady zamykają się przed startem)
async fn horse_runs(c: &mut Conn, race: i64) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT user_id) FROM horse_bets WHERE race = $1 AND status != 'cancelled'")
        .bind(race)
        .fetch_one(c)
        .await?;
    Ok(n >= rules().min_players)
}

#[derive(sqlx::FromRow)]
struct Bet {
    id: i64,
    race: i64,
    horse: i32,
    item_ids: String,
    stake: i64,
    status: String,
    payout: i64,
    result: String,
    pays: f64,
}

impl Bet {
    fn ids(&self) -> Vec<i64> {
        serde_json::from_str(&self.item_ids).unwrap_or_default()
    }

    fn json(&self) -> Value {
        json!({"id": self.id, "race": self.race, "horse": self.horse, "stake": self.stake, "status": self.status,
               "cards": self.ids().len()})
    }
}

/// SELECT zakładów (kolumny jak w Bet) + reszta zapytania
macro_rules! bets {
    ($rest:literal) => {
        concat!("SELECT id, race, horse, item_ids, stake, status, payout, result, pays FROM horse_bets ", $rest)
    };
}

/// Zakład przechodzi do rozliczenia (tylko raz, nawet przy równoczesnych zapytaniach)
async fn claim(c: &mut Conn, id: i64) -> sqlx::Result<bool> {
    let n = sqlx::query("UPDATE horse_bets SET status = 'settling' WHERE id = $1 AND status = 'open'").bind(id).execute(c).await?;
    Ok(n.rows_affected() == 1)
}

/// Rozlicza zakłady gracza na wyścigach, które się skończyły
pub async fn settle_my_horses(cx: &Ctx) -> Res<()> {
    let now = now();
    let mut tx = cx.st.db.begin().await?;
    let rows: Vec<Bet> =
        sqlx::query_as(bets!("WHERE user_id = $1 AND status = 'open' AND race <= $2"))
            .bind(cx.uid())
            .bind((now / rules().period as f64).floor() as i64)
            .fetch_all(&mut *tx)
            .await?;
    if rows.is_empty() {
        return Ok(());
    }
    lock_me(&mut tx, cx.uid()).await?;
    for b in rows {
        let ids = b.ids();
        if !horse_runs(&mut tx, b.race).await? {
            // za mało graczy - wyścig się nie odbył, zakład wraca
            if claim(&mut tx, b.id).await? {
                give_items(&mut tx, &cx.cat, &ids, cx.uid(), "horses").await?;
                sqlx::query("UPDATE horse_bets SET status = 'refund', payout = 0, result = '{}' WHERE id = $1")
                    .bind(b.id)
                    .execute(&mut *tx)
                    .await?;
            }
            continue;
        }
        let race = horse_data(&cx.st.cfg.secret_key, b.race);
        if now < horse_start(b.race) + race.dur || !claim(&mut tx, b.id).await? {
            continue;
        }
        let staked = crate::achievements::cards_of(&mut tx, &ids).await?;
        let (status, payout, result) = if race.winner < 0 || race.winner == b.horse as i64 {
            give_items(&mut tx, &cx.cat, &ids, cx.uid(), "horses").await?;
            if race.winner < 0 {
                ("refund", 0, json!({}))
            } else {
                let pays = if b.pays != 0.0 { b.pays } else { horse_list(&mut tx).await?[b.horse as usize].pays };
                let won = pay_out(&mut tx, cx, (b.stake as f64 * pays).round() as i64, "casino").await?;
                ("won", won.payout, json!({"items": won.items, "money": won.money, "special": won.special}))
            }
        } else {
            sqlx::query("DELETE FROM items WHERE user_id = $1 AND id = ANY($2)").bind(ESCROW).bind(&ids).execute(&mut *tx).await?;
            ("lost", 0, json!({}))
        };
        if status != "refund" {
            crate::achievements::count_casino(&mut tx, cx.uid(), "horses", Some(status == "won"), &staked).await?;
        }
        sqlx::query("UPDATE horse_bets SET status = $1, payout = $2, result = $3 WHERE id = $4")
            .bind(status)
            .bind(payout)
            .bind(result.to_string())
            .bind(b.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Rozliczone zakłady, których wyniku gracz jeszcze nie widział (/api/me: horseNews)
pub async fn horse_news(c: &mut Conn, uid: i64) -> sqlx::Result<Vec<Value>> {
    let rows: Vec<Bet> = sqlx::query_as(bets!("WHERE user_id = $1 AND seen = 0 AND status IN ('won', 'lost', 'refund')
         ORDER BY id LIMIT 10"))
    .bind(uid)
    .fetch_all(c)
    .await?;
    Ok(rows
        .iter()
        .map(|b| {
            json!({"id": b.id, "race": b.race, "horse": b.horse, "status": b.status, "stake": b.stake, "payout": b.payout,
                   "result": serde_json::from_str::<Value>(&b.result).unwrap_or(json!({}))})
        })
        .collect())
}

fn race_json(race: &Race, id: i64) -> Value {
    let mut v = json!(race);
    v["id"] = json!(id);
    v["start"] = json!(horse_start(id));
    v
}

pub async fn casino_horses(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    settle_my_horses(&cx).await?;
    let now = now();
    let period = rules().period;
    let cur = (now / period as f64).floor() as i64;
    let mut c = cx.st.db.acquire().await?;
    // wyścigi z zakładami (od najnowszego) - tylko te się odbyły
    let ran: Vec<i64> = sqlx::query_scalar(
        "SELECT race FROM horse_bets WHERE race BETWEEN $1 AND $2 AND status != 'cancelled'
         GROUP BY race HAVING COUNT(DISTINCT user_id) >= $3 ORDER BY race DESC",
    )
    .bind(cur - 40)
    .bind(cur)
    .bind(rules().min_players)
    .fetch_all(&mut *c)
    .await?;
    let secret = &cx.st.cfg.secret_key;
    let mut live = None;
    for k in [cur, cur - 1] {
        // wyścig trwa dłużej niż okres tylko wyjątkowo
        if k >= 0 && ran.contains(&k) {
            let race = horse_data(secret, k);
            if now < horse_start(k) + race.dur + 20.0 {
                live = Some((k, race_json(&race, k)));
                break;
            }
        }
    }
    let mut ids = vec![cur + 1];
    ids.extend(live.as_ref().map(|(k, _)| *k));
    let mine: Vec<Bet> = sqlx::query_as(bets!("WHERE user_id = $1 AND race = ANY($2) AND status != 'cancelled' ORDER BY id"))
    .bind(cx.uid())
    .bind(&ids)
    .fetch_all(&mut *c)
    .await?;
    let others: Vec<(i64, i32, i64, String)> = sqlx::query_as(
        "SELECT b.race, b.horse, b.stake, u.username FROM horse_bets b JOIN users u ON u.id = b.user_id
         WHERE b.race = ANY($1) AND b.user_id != $2 AND b.status != 'cancelled' ORDER BY b.id",
    )
    .bind(&ids)
    .bind(cx.uid())
    .fetch_all(&mut *c)
    .await?;
    let last: Vec<Value> = ran
        .iter()
        .filter(|&&k| k >= 0)
        .filter_map(|&k| {
            let race = horse_data(secret, k);
            (now >= horse_start(k) + race.dur).then(|| json!({"id": k, "start": horse_start(k), "winner": race.winner}))
        })
        .take(8)
        .collect();
    ok(json!({
        "now": now,
        "horses": horse_list(&mut c).await?,
        "live": live.map(|(_, v)| v),
        "next": {"id": cur + 1, "start": horse_start(cur + 1)},
        "mine": mine.iter().map(Bet::json).collect::<Vec<_>>(),
        "others": others.iter().map(|(race, horse, stake, user)| json!({"race": race, "horse": horse, "stake": stake, "user": user}))
            .collect::<Vec<_>>(),
        "last": last,
        "news": horse_news(&mut c, cx.uid()).await?,
    }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct HorseRequest {
    horse: Value,
    ids: Vec<i64>,
    vabank: bool,
}

impl HorseRequest {
    /// Numer konia albo błąd
    fn horse(&self) -> Res<usize> {
        crate::variants::py_int(&self.horse)
            .and_then(|h| usize::try_from(h).ok())
            .filter(|h| *h < g().horses.len())
            .ok_or_else(|| crate::error::AppError::bad("Wybierz konia"))
    }
}

pub async fn casino_horses_bet(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<HorseRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let r = rules();
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let horse = req.horse()?;
    stake_error(&mut tx, &cx, &req.ids, r.max_cards, req.vabank, 1).await?;
    let now = now();
    let race = (now / r.period as f64).floor() as i64 + 1;
    let left = horse_start(race) - now;
    if left > r.bet_open {
        return bad("Zakłady na ten wyścig jeszcze się nie zaczęły");
    }
    if left < r.bet_close {
        return bad("Zakłady na ten wyścig są już zamknięte");
    }
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM horse_bets WHERE user_id = $1 AND race = $2 AND status = 'open'")
        .bind(cx.uid())
        .bind(race)
        .fetch_one(&mut *tx)
        .await?;
    if open >= r.max_bets {
        return bad(format!("Najwyżej {} zakłady na jeden wyścig", r.max_bets));
    }
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await?;
    escrow_items(&mut tx, cx.uid(), &req.ids).await?;
    let stake: i64 = rows.iter().map(|r| row_value(&cx.cat, r)).sum();
    let pays = horse_list(&mut tx).await?[horse].pays;
    sqlx::query(
        "INSERT INTO horse_bets (race, user_id, horse, item_ids, stake, pays, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(race)
    .bind(cx.uid())
    .bind(horse as i32)
    .bind(json!(req.ids).to_string())
    .bind(stake)
    .bind(pays)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "consumed": req.ids, "state": state}))
}

pub async fn casino_horses_cancel(State(st): State<AppState>, Me(me): Me, Path(bid): Path<i64>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let b: Option<Bet> =
        sqlx::query_as(bets!("WHERE id = $1 AND user_id = $2 AND status = 'open'"))
            .bind(bid)
            .bind(cx.uid())
            .fetch_optional(&mut *tx)
            .await?;
    let Some(b) = b else { return bad("Nie ma takiego zakładu") };
    if horse_start(b.race) - now() < rules().bet_close {
        return bad("Zakłady na ten wyścig są już zamknięte");
    }
    let n = sqlx::query("UPDATE horse_bets SET status = 'cancelled' WHERE id = $1 AND status = 'open'")
        .bind(bid)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return bad("Nie ma takiego zakładu");
    }
    give_items(&mut tx, &cx.cat, &b.ids(), cx.uid(), "horses").await?;
    let items = my_items(&mut tx, &cx.cat, cx.uid()).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "items": items, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SeenRequest {
    ids: Vec<i64>,
}

pub async fn casino_horses_seen(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<SeenRequest>) -> Res {
    if !req.ids.is_empty() {
        sqlx::query("UPDATE horse_bets SET seen = 1 WHERE user_id = $1 AND id = ANY($2)")
            .bind(me.id)
            .bind(&req.ids)
            .execute(&st.db)
            .await?;
    }
    ok(json!({"ok": true}))
}

#[derive(Serialize)]
struct SoloResponse {
    race: Race,
    horse: usize,
    stake: i64,
    win: bool,
    refund: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<crate::game::NewItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    money: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payout: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    special: Option<Option<crate::game::NewItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    consumed: Option<Vec<i64>>,
    state: crate::game::GameState,
}

/// Wyścig tylko dla mnie: ziarno losowe, wynik od razu (jak w ruletce) - przeglądarka odtwarza przebieg
pub async fn casino_horses_solo(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<HorseRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let horse = req.horse()?;
    stake_error(&mut tx, &cx, &req.ids, rules().max_cards, req.vabank, 1).await?;
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await?;
    let stake: i64 = rows.iter().map(|r| row_value(&cx.cat, r)).sum();
    let staked: Vec<(String, String)> = rows.iter().map(|r| (r.person_id.clone(), r.variant.clone())).collect();
    let race = simulate(rand::random::<u64>() >> 1, &[]);
    let (win, refund) = (race.winner == horse as i64, race.winner < 0);
    let (mut items, mut money, mut payout, mut special, mut consumed) = (None, None, None, None, None);
    if win {
        let pays = horse_list(&mut tx).await?[horse].pays;
        let won = pay_out(&mut tx, &cx, (stake as f64 * pays).round() as i64, "casino").await?;
        (items, money, payout, special) = (Some(won.items), Some(won.money), Some(won.payout), Some(won.special));
    } else if !refund {
        delete_items(&mut tx, cx.uid(), &req.ids).await?;
        consumed = Some(req.ids.clone());
    }
    if !refund {
        crate::achievements::count_casino(&mut tx, cx.uid(), "horses", Some(win), &staked).await?;
    }
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(SoloResponse { race, horse, stake, win, refund, items, money, payout, special, consumed, state })
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DebugRequest {
    force: Vec<String>,
}

/// Tryb debug (admin): wyścig testowy bez stawki, ze zdarzeniami wymuszonymi na 100% (car / turbo / turn / die)
pub async fn casino_horses_debug(Admin(_): Admin, JsonBody(req): JsonBody<DebugRequest>) -> Res {
    let force: Vec<&str> =
        req.force.iter().map(String::as_str).filter(|f| ["car", "turbo", "turn", "die"].contains(f)).collect();
    ok(json!({"race": simulate(rand::random::<u64>() >> 1, &force), "force": force}))
}

pub async fn admin_horses(State(st): State<AppState>, Admin(_): Admin) -> Res {
    let mut c = st.db.acquire().await?;
    let defaults: Vec<Value> = g().horses.iter().map(|h| json!({"id": h.id, "name": h.name, "pays": h.pays})).collect();
    ok(json!({"horses": horse_list(&mut c).await?, "defaults": defaults, "nameMax": NAME_MAX}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct HorsesSaveRequest {
    horses: Option<Vec<Value>>,
}

/// Zapis nazw i mnożników koni: [{id, name, pays}] - puste pole / zero = wartość domyślna
pub async fn admin_horses_save(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<HorsesSaveRequest>) -> Res {
    let Some(rows) = req.horses else { return bad("Brak listy koni") };
    let horses = &g().horses;
    let mut clean = vec![];
    for r in &rows {
        let id = r.get("id").and_then(crate::variants::py_int);
        let pays = match r.get("pays") {
            None | Some(Value::Null) => Some(0.0),
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(t)) if t.trim().is_empty() => Some(0.0),
            Some(Value::String(t)) => t.trim().replace(',', ".").parse::<f64>().ok(),
            Some(Value::Bool(b)) => Some(*b as i64 as f64),
            _ => None,
        };
        let (Some(id), Some(pays)) = (id, pays) else { return bad("Mnożnik musi być liczbą") };
        let name: String = r.get("name").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
        let name: String = name.chars().take(NAME_MAX).collect();
        let Some(def) = usize::try_from(id).ok().and_then(|i| horses.get(i)) else { return bad("Nie ma takiego konia") };
        if pays != 0.0 && !(0.5..=PAYS_MAX).contains(&pays) {
            return bad(format!("Mnożnik: od 0,5 do {PAYS_MAX} (puste = domyślny)"));
        }
        let name = if name == def.name { String::new() } else { name };
        let pays = if pays == def.pays { 0.0 } else { (pays * 100.0).round() / 100.0 };
        clean.push((id as i32, name, pays));
    }
    let mut tx = st.db.begin().await?;
    for (id, name, pays) in clean {
        sqlx::query(
            "INSERT INTO horse_settings (horse, name, pays) VALUES ($1, $2, $3)
             ON CONFLICT (horse) DO UPDATE SET name = excluded.name, pays = excluded.pays",
        )
        .bind(id)
        .bind(name)
        .bind(pays)
        .execute(&mut *tx)
        .await?;
    }
    let list = horse_list(&mut tx).await?;
    let details = list.iter().map(|h| format!("{} ×{}", h.name, h.pays)).collect::<Vec<_>>().join(", ");
    log_admin(&mut tx, &me, "horses_save", None, &details).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "horses": list}))
}

/// Usuwany gracz: jego otwarte zakłady znikają razem z postawionymi kartami (są w ESCROW)
pub async fn horse_forget_user(c: &mut Conn, uid: i64) -> sqlx::Result<()> {
    let rows: Vec<Bet> =
        sqlx::query_as(bets!("WHERE user_id = $1 AND status IN ('open', 'settling')"))
            .bind(uid)
            .fetch_all(&mut *c)
            .await?;
    for b in rows {
        sqlx::query("DELETE FROM items WHERE user_id = $1 AND id = ANY($2)").bind(ESCROW).bind(b.ids()).execute(&mut *c).await?;
    }
    sqlx::query("DELETE FROM horse_bets WHERE user_id = $1").bind(uid).execute(c).await?;
    Ok(())
}
