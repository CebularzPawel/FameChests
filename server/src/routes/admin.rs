//! Panel admina: katalog (skrzynki, karty, zdjęcia), gracze (blokady, pieniądze, skrzynki, dostęp, hasła), wiadomości
//! do graczy, linki do kart specjalnych, dziennik działań adminów.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use serde_with::serde_as;
use unicode_normalization::UnicodeNormalization;

use super::{ok, JsonBody};
use crate::auth::{hash_password_async, password_error, Admin, User, UserView, MIN_PASSWORD};
use crate::catalog::{self, Catalog, Person, RawAbility, RawArenaCfg, RawCard, Table};
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{bad, fail, AppError, Res};
use crate::game::views::{img_version, variant_photos, CrateJson};
use crate::game::*;
use crate::images::Kind;
use crate::lenient::{Num, NumOrText};
use crate::state::AppState;
use crate::text::{clean, fmt_money_signed, Truncate};

fn yes() -> bool {
    true
}

fn not_found(msg: &str) -> AppError {
    AppError::with_status(StatusCode::NOT_FOUND, msg)
}

/// Identyfikator z nazwy: "Skrzynia Królów" -> "skrzynia_krolow"
fn slug(text: &str) -> String {
    static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-zA-Z0-9]+").unwrap());
    let ascii: String = text.replace('ł', "l").replace('Ł', "L").nfkd().filter(char::is_ascii).collect();
    let t = NON_ALNUM.replace_all(&ascii, "_").trim_matches('_').to_lowercase();
    if t.is_empty() {
        "x".into()
    } else {
        t
    }
}

/// `base`, a gdy zajęte - `base_2`, `base_3`...
fn unique_id<'a>(base: &str, taken: impl IntoIterator<Item = &'a String>) -> String {
    let taken: HashSet<&String> = taken.into_iter().collect();
    std::iter::once(base.to_owned()).chain((2..).map(|i| format!("{base}_{i}"))).find(|k| !taken.contains(k)).expect("wolny id")
}

/// Gracz dostał pieniądze / skrzynki od admina - na stałe znika z rankingu
async fn mark_money_generated(c: &mut Conn, uid: i64) -> sqlx::Result<()> {
    sqlx::query!("UPDATE users SET money_generated = 1 WHERE id = $1", uid).execute(c).await?;
    Ok(())
}

// ---------------------------------------------------------------- wiadomości do graczy
// Admin wybiera od kiedy do kiedy wiadomość jest aktywna (przeglądarka wysyła gotowe znaczniki czasu); każdy gracz,
// który wejdzie do gry w tym czasie, zobaczy ją raz.

#[derive(Serialize)]
struct MessageView {
    id: i64,
    title: String,
    body: String,
    start: f64,
    end: f64,
    admin: String,
    seen: i64,
}

pub async fn admin_messages_list(State(st): State<AppState>, Admin(_): Admin) -> Res {
    let messages: Vec<MessageView> = sqlx::query_as!(
        MessageView,
        r#"SELECT m.id, m.title, m.body, m.starts_at AS start, m.ends_at AS "end", m.admin_name AS admin,
                  (SELECT COUNT(*) FROM admin_message_seen s WHERE s.message_id = m.id) AS "seen!"
           FROM admin_messages m ORDER BY starts_at DESC"#
    )
    .fetch_all(&st.db)
    .await?;
    ok(json!({"messages": messages}))
}

#[serde_as]
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct MessageRequest {
    title: String,
    body: String,
    #[serde_as(as = "Option<Num>")]
    start: Option<f64>,
    #[serde_as(as = "Option<Num>")]
    end: Option<f64>,
}

pub async fn admin_messages_add(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<MessageRequest>) -> Res {
    let title = clean(&req.title, 100);
    let body = clean(&req.body.replace("\r\n", "\n"), 2000);
    let (Some(start), Some(end)) = (req.start, req.end) else { return bad("Podaj początek i koniec wyświetlania") };
    if title.is_empty() || body.is_empty() {
        return bad("Podaj tytuł i treść wiadomości");
    }
    if end <= start {
        return bad("Koniec musi być później niż początek");
    }
    if end <= now() {
        return bad("Ta wiadomość już by się skończyła - wybierz późniejszy koniec");
    }
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        "INSERT INTO admin_messages (title, body, starts_at, ends_at, created_at, admin_name) VALUES ($1, $2, $3, $4, $5, $6)",
        title,
        body,
        start,
        end,
        now(),
        me.username
    )
    .execute(&mut *tx)
    .await?;
    log_admin(&mut tx, &me, "message_add", None, &title).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_messages_delete(State(st): State<AppState>, Admin(me): Admin, Path(mid): Path<i64>) -> Res {
    let mut tx = st.db.begin().await?;
    let title = sqlx::query_scalar!("SELECT title FROM admin_messages WHERE id = $1", mid)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| not_found("Nie ma takiej wiadomości"))?;
    sqlx::query!("DELETE FROM admin_message_seen WHERE message_id = $1", mid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM admin_messages WHERE id = $1", mid).execute(&mut *tx).await?;
    log_admin(&mut tx, &me, "message_delete", None, &title).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct LogQuery {
    limit: Option<i64>,
}

#[derive(Serialize)]
struct LogEntry {
    id: i64,
    time: f64,
    admin: String,
    action: String,
    target: String,
    details: String,
}

pub async fn admin_log_list(State(st): State<AppState>, Admin(_): Admin, Query(q): Query<LogQuery>) -> Res {
    let limit = q.limit.unwrap_or(300).clamp(1, 1000);
    let log: Vec<LogEntry> = sqlx::query_as!(
        LogEntry,
        "SELECT id, created_at AS time, admin_name AS admin, action, target_name AS target, details
         FROM admin_log ORDER BY id DESC LIMIT $1",
        limit
    )
    .fetch_all(&st.db)
    .await?;
    ok(json!({"log": log}))
}

// ---------------------------------------------------------------- katalog

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminCrate {
    #[serde(flatten)]
    info: CrateJson,
    builtin: bool,
    modified: bool,
    hidden: bool,
    /// szanse ustawione przez admina (bez wyliczonej szansy tajnej karty)
    custom_weights: IndexMap<String, f64>,
    /// gracze z dostępem do skrzynki z ograniczeniem
    allowed: Vec<i64>,
}

/// Zdjęcia karty w panelu admina
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Photos {
    has_image: bool,
    has_alt: bool,
    card_variants: Vec<String>,
    variant_photos: IndexMap<String, i64>,
    imgv: i64,
}

impl Photos {
    fn new(st: &AppState, cat: &Catalog, pid: &str) -> Photos {
        Photos {
            has_image: st.images.find(pid, &Kind::Main).is_some(),
            has_alt: st.images.find(pid, &Kind::Alt).is_some(),
            card_variants: cat.photo_variants(pid),
            variant_photos: variant_photos(&st.images, cat, pid),
            imgv: img_version(&st.images, pid),
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum AdminCard {
    Live {
        #[serde(flatten)]
        person: Arc<Person>,
        wiki: Option<(String, String)>,
        builtin: bool,
        modified: bool,
        #[serde(flatten)]
        photos: Photos,
        owned: i64,
        hidden: bool,
    },
    /// wbudowana karta ukryta przez admina (do przywrócenia)
    Hidden {
        id: String,
        number: i64,
        #[serde(flatten)]
        raw: Box<RawCard>,
        #[serde(flatten)]
        photos: Photos,
        owned: i64,
        hidden: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminCatalog {
    crates: Vec<AdminCrate>,
    cards: Vec<AdminCard>,
    rarities: &'static Value,
    rarity_order: &'static [String],
    types: &'static Value,
    ability_kinds: &'static Value,
    max_extra_abilities: usize,
    arena: Value,
    variants: &'static Value,
    exclusive_variants: &'static [String],
    special_variants: &'static [String],
    special_sources: &'static Value,
    special_crate: &'static str,
    default_price: i64,
    users: Vec<UserView>,
}

pub async fn admin_catalog(State(st): State<AppState>, Admin(_): Admin) -> Res {
    let cat = st.cat();
    let g = g();
    let mut c = st.db.acquire().await?;
    let counts: HashMap<String, i64> = sqlx::query!(r#"SELECT person_id, COUNT(*) AS "n!" FROM items GROUP BY person_id"#)
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|r| (r.person_id, r.n))
        .collect();
    let mut access: HashMap<String, Vec<i64>> = HashMap::new();
    for r in sqlx::query!("SELECT user_id, crate_id FROM crate_access").fetch_all(&mut *c).await? {
        access.entry(r.crate_id).or_default().push(r.user_id);
    }
    let allowed = |cid: &str| access.get(cid).cloned().unwrap_or_default();
    let mut crates: Vec<AdminCrate> = cat
        .crates
        .values()
        .map(|cr| AdminCrate {
            info: CrateJson::new(&cat, cr),
            builtin: cr.builtin,
            modified: cr.modified,
            hidden: false,
            custom_weights: cr
                .weights
                .iter()
                .filter(|(r, _)| !(*r == "secret" && cr.auto_secret))
                .map(|(r, w)| (r.clone(), *w))
                .collect(),
            allowed: allowed(&cr.id),
        })
        .collect();
    crates.extend(cat.hidden_crates.iter().map(|(cid, cr)| AdminCrate {
        info: CrateJson::hidden(cid, cr),
        builtin: true,
        modified: false,
        hidden: true,
        custom_weights: cr.weights.clone(),
        allowed: allowed(cid),
    }));
    let owned = |pid: &str| counts.get(pid).copied().unwrap_or(0);
    let mut cards: Vec<AdminCard> = cat
        .people
        .values()
        .map(|p| AdminCard::Live {
            person: p.clone(),
            wiki: p.wiki.clone(),
            builtin: p.builtin,
            modified: p.modified,
            photos: Photos::new(&st, &cat, &p.id),
            owned: owned(&p.id),
            hidden: false,
        })
        .collect();
    cards.extend(cat.hidden_cards.iter().filter(|(_, p)| p.crate_.as_ref().is_some_and(|c| cat.crates.contains_key(c))).map(
        |(pid, p)| AdminCard::Hidden {
            id: pid.clone(),
            number: 0,
            raw: Box::new(p.clone()),
            photos: Photos::new(&st, &cat, pid),
            owned: owned(pid),
            hidden: true,
        },
    ));
    let users = sqlx::query_as!(User, "SELECT * FROM users ORDER BY LOWER(username)").fetch_all(&mut *c).await?;
    ok(AdminCatalog {
        crates,
        cards,
        rarities: &g.rarities_json,
        rarity_order: &g.rarity_order,
        types: &g.types_json,
        ability_kinds: &g.ability_kinds,
        max_extra_abilities: g.max_extra_abilities,
        arena: json!({"effects": g.arena_effects_json, "visuals": g.arena_visuals, "targets": g.arena_targets,
                      "effectTargets": g.arena_effect_targets, "maxEffects": g.max_ability_effects}),
        variants: &g.variants_json,
        exclusive_variants: &g.crate_variants,
        special_variants: &g.special_variants,
        special_sources: &g.special_sources_json,
        special_crate: &g.special_crate,
        default_price: g.crate_price,
        users: users.iter().map(|u| u.view(&cat)).collect(),
    })
}

/// Formularz skrzynki z panelu admina (pola formularza - liczby jako tekst)
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CrateRequest {
    /// brak = nowa skrzynka
    id: Option<String>,
    name: String,
    short: String,
    code: String,
    emoji: String,
    color1: String,
    color2: String,
    price: Option<NumOrText>,
    desc: String,
    #[serde(default = "yes")]
    shop: bool,
    restricted: bool,
    variants: Vec<String>,
    weights: IndexMap<String, NumOrText>,
    /// lista graczy z dostępem (brak = bez zmian)
    allowed: Option<Vec<i64>>,
}

fn or<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.is_empty() {
        default
    } else {
        value
    }
}

pub async fn admin_save_crate(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<CrateRequest>) -> Res {
    let cat = st.cat();
    let g = g();
    let name = req.name.trim();
    if name.is_empty() {
        return bad("Podaj nazwę skrzynki");
    }
    let price = match req.price.as_ref().map(NumOrText::integer).transpose() {
        Ok(p) => p.flatten().filter(|p| *p != 0).unwrap_or(g.crate_price).clamp(1, 1_000_000),
        Err(_) => return bad("Nieprawidłowa cena"),
    };
    let mut weights = Map::new();
    for (rarity, w) in &req.weights {
        if !g.rarities.contains_key(rarity) {
            continue;
        }
        match w.number() {
            Ok(Some(w)) => {
                weights.insert(rarity.clone(), json!(w.clamp(0.0, 1000.0)));
            }
            Ok(None) => {}
            Err(_) => return bad("Szanse muszą być liczbami"),
        }
    }
    let name = name.truncate_chars(60);
    let mut fields = Map::new();
    fields.insert("name".into(), json!(name));
    fields.insert("short".into(), json!(clean(or(&req.short, &name), 24)));
    fields.insert("code".into(), json!(clean(or(&req.code, &name.truncate_chars(2)), 4).to_uppercase().truncate_chars(4)));
    fields.insert("emoji".into(), json!(clean(or(&req.emoji, "📦"), 8)));
    fields.insert("color1".into(), json!(or(&req.color1, "#888888")));
    fields.insert("color2".into(), json!(or(&req.color2, "#333333")));
    fields.insert("price".into(), json!(price));
    fields.insert("desc".into(), json!(clean(&req.desc, 120)));
    fields.insert("shop".into(), json!(req.shop));
    fields.insert("restricted".into(), json!(req.restricted));
    // warianty przypięte do skrzynki - każdy wariant wypada tylko ze skrzynek, do których jest przypięty
    fields.insert("variants".into(), json!(g.crate_variants.iter().filter(|v| req.variants.contains(v)).collect::<Vec<_>>()));
    fields.insert("variantsAll".into(), json!(true));
    fields.insert("weights".into(), Value::Object(weights));
    let given = req.id.filter(|id| !id.is_empty());
    let cid = given.clone().unwrap_or_else(|| unique_id(&slug(&name), cat.crates.keys().chain(cat.hidden_crates.keys())));
    let mut tx = st.db.begin().await?;
    let details = format!("{}{name} · cena {price} $", if given.is_none() { "nowa: " } else { "" });
    log_admin(&mut tx, &me, "crate_save", None, &details).await?;
    catalog::save_override(&mut tx, Table::Crates, &cid, fields).await?;
    if let Some(allowed) = req.allowed {
        sqlx::query!("DELETE FROM crate_access WHERE crate_id = $1", cid).execute(&mut *tx).await?;
        sqlx::query!(
            "INSERT INTO crate_access (user_id, crate_id) SELECT DISTINCT u, $2 FROM UNNEST($1::bigint[]) AS u ON CONFLICT DO NOTHING",
            &allowed,
            cid
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true, "id": cid}))
}

pub async fn admin_delete_crate(State(st): State<AppState>, Admin(me): Admin, Path(cid): Path<String>) -> Res {
    let cat = st.cat();
    let cr = cat.crates.get(&cid).ok_or_else(|| not_found("Nie ma takiej skrzynki"))?;
    let mut tx = st.db.begin().await?;
    log_admin(&mut tx, &me, "crate_delete", None, &format!("{}{}", cr.name, if cr.builtin { " (ukryta)" } else { "" })).await?;
    if cr.builtin {
        catalog::mark_deleted(&mut tx, Table::Crates, &cid).await?; // wbudowaną tylko ukrywamy
    } else {
        catalog::remove_row(&mut tx, Table::Crates, &cid).await?;
        sqlx::query!("DELETE FROM crate_access WHERE crate_id = $1", cid).execute(&mut *tx).await?;
        // karty tylko z tej skrzynki znikają razem z nią
        for p in cat.crate_people(cr).filter(|p| !p.builtin && p.crates == [cid.clone()]) {
            catalog::remove_row(&mut tx, Table::Cards, &p.id).await?;
        }
    }
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_restore_crate(State(st): State<AppState>, Admin(me): Admin, Path(cid): Path<String>) -> Res {
    let builtin = catalog::builtin_crate(&cid).ok_or_else(|| AppError::bad("To nie jest wbudowana skrzynka"))?;
    let mut tx = st.db.begin().await?;
    catalog::remove_row(&mut tx, Table::Crates, &cid).await?;
    log_admin(&mut tx, &me, "crate_restore", None, builtin.get("name").and_then(Value::as_str).unwrap_or_default()).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true}))
}

/// Formularz karty z panelu admina (multipart: pola + pliki zdjęć)
#[derive(Default)]
struct CardForm {
    fields: Vec<(String, String)>,
    files: HashMap<String, (String, Vec<u8>)>,
}

impl CardForm {
    async fn read(mut mp: Multipart) -> Res<CardForm> {
        let invalid = |e: axum::extract::multipart::MultipartError| AppError::bad(format!("Nieprawidłowy formularz: {e}"));
        let mut form = CardForm::default();
        while let Some(field) = mp.next_field().await.map_err(invalid)? {
            let name = field.name().unwrap_or_default().to_owned();
            match field.file_name().map(str::to_owned) {
                Some(filename) => {
                    let bytes = field.bytes().await.map_err(invalid)?;
                    form.files.insert(name, (filename, bytes.to_vec()));
                }
                None => {
                    let text = field.text().await.map_err(invalid)?;
                    form.fields.push((name, text));
                }
            }
        }
        Ok(form)
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// pole albo pusty napis
    fn text(&self, key: &str) -> &str {
        self.get(key).unwrap_or_default()
    }

    fn list<'a>(&'a self, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.fields.iter().filter(move |(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// wgrany plik (z nazwą)
    fn upload(&self, key: &str) -> Option<&[u8]> {
        self.files.get(key).filter(|(name, _)| !name.is_empty()).map(|(_, b)| b.as_slice())
    }

    /// liczba z pola (puste = `default`); None = to nie liczba
    fn int(&self, key: &str, default: i64) -> Option<i64> {
        let v = self.text(key).trim();
        if v.is_empty() {
            Some(default)
        } else {
            v.parse().ok()
        }
    }
}

/// Zdjęcie z formularza: plik > adres URL > usunięcie. None = bez zmian.
async fn update_photo(st: &AppState, form: &CardForm, pid: &str, kind: &Kind, suffix: &str) -> Option<Result<(), String>> {
    if let Some(blob) = form.upload(&format!("image{suffix}")) {
        return Some(st.images.save(pid, blob, kind));
    }
    let url = form.text(&format!("image_url{suffix}")).trim();
    if !url.is_empty() {
        return Some(st.images.save_url(pid, url, kind).await);
    }
    if form.get(&format!("remove{suffix}")) == Some("1") {
        st.images.delete(pid, kind);
        return Some(Ok(()));
    }
    None
}

pub async fn admin_save_card(State(st): State<AppState>, Admin(me): Admin, mp: Multipart) -> Res {
    let form = CardForm::read(mp).await?;
    let cat = st.cat();
    let g = g();
    let name = form.text("name").trim().to_owned();
    let mut chosen: IndexSet<&str> = form.list("crates").collect();
    if chosen.is_empty() {
        chosen.extend(form.get("crate"));
    }
    // karta specjalna jest tylko w skrzynce kart specjalnych (której nie da się otworzyć), a zwykła karta - nigdy
    let crates: Vec<String> = if form.get("rarity") == Some("special") && cat.crates.contains_key(&g.special_crate) {
        vec![g.special_crate.clone()]
    } else {
        chosen.into_iter().filter(|c| cat.crates.get(*c).is_some_and(|cr| !cr.special)).map(str::to_owned).collect()
    };
    if name.is_empty() {
        return bad("Podaj nazwę karty");
    }
    let Some(main_crate) = crates.first().cloned() else { return bad("Wybierz co najmniej jedną skrzynkę") };
    let (Some(rarity), Some(type_)) =
        (form.get("rarity").filter(|r| g.rarities.contains_key(*r)), form.get("type").filter(|t| g.types.contains_key(*t)))
    else {
        return bad("Nieprawidłowa rzadkość lub typ");
    };
    let (Some(hp), Some(dmg)) = (form.int("hp", 50), form.int("dmg", 30)) else {
        return bad("HP i obrażenia muszą być liczbami");
    };
    let dmg2 = form.int("dmg2", 0).unwrap_or(0).clamp(0, 9999);
    let wiki_title = form.text("wiki_title").trim().to_owned();
    let wiki_lang = clean(or(form.text("wiki_lang"), "pl"), 5);
    let wiki = (!wiki_title.is_empty()).then(|| (wiki_lang, wiki_title.clone()));
    let kind = |k: &str| form.get(k).filter(|x| g.ability_kinds.get(*x).is_some()).unwrap_or("off").to_owned();
    let abilities: Vec<RawAbility> = form
        .list("ab_name")
        .zip(form.list("ab_kind"))
        .zip(form.list("ab_value"))
        .map(|((name, kind), value)| RawAbility {
            name: name.into(),
            kind: Some(kind.into()),
            value: value.trim().parse().unwrap_or(0),
        })
        .collect();
    let Ok(arena) = serde_json::from_str::<Vec<RawArenaCfg>>(or(form.text("arena_json"), "[]")) else {
        return bad("Nieprawidłowe ustawienia Areny");
    };
    let arena = catalog::clean_arena(&arena);
    // efekt unikalny może mieć tylko jedna karta
    let pid_now = form.text("id");
    for e in arena.iter().flat_map(|cfg| &cfg.effects) {
        let Some(info) = g.arena_effects.get(&e.id).filter(|i| i.unique) else { continue };
        let holder =
            cat.people.values().find(|p| p.id != pid_now && p.arena.iter().flat_map(|c| &c.effects).any(|x| x.id == e.id));
        if let Some(other) = holder {
            return bad(format!("Efekt „{}” jest unikalny - ma go już karta {}", info.name, other.name));
        }
    }
    let attack2 = clean(form.text("attack2"), 40);
    let crates_seen: std::collections::BTreeSet<&String> = cat.crates.keys().chain(cat.hidden_crates.keys()).collect();
    let mut fields = Map::new();
    fields.insert("name".into(), json!(name.truncate_chars(60)));
    fields.insert("crate".into(), json!(main_crate));
    fields.insert("crates".into(), json!(crates));
    fields.insert("rarity".into(), json!(rarity));
    fields.insert("type".into(), json!(type_));
    fields.insert("hp".into(), json!(hp.clamp(0, 9999)));
    fields.insert("dmg".into(), json!(dmg.clamp(0, 9999)));
    fields.insert("attack".into(), json!(clean(or(form.text("attack"), "Atak"), 40)));
    fields.insert("attack2".into(), if attack2.is_empty() { Value::Null } else { json!(attack2) });
    fields.insert("dmg2".into(), json!(dmg2));
    fields.insert("wiki".into(), json!(wiki));
    fields.insert("kind1".into(), json!(kind("kind1")));
    fields.insert("kind2".into(), json!(kind("kind2")));
    fields.insert("abilities".into(), json!(catalog::clean_abilities(&abilities)));
    fields.insert("country".into(), json!(catalog::clean_country(form.text("country"))));
    // podtytuł - krótki tekst na karcie; opis - dłuższy tekst obok karty w podglądzie
    fields.insert("subtitle".into(), json!(clean(form.text("subtitle"), catalog::SUBTITLE_MAX)));
    fields.insert("desc".into(), json!(clean(&form.text("desc").replace("\r\n", "\n"), catalog::DESC_MAX)));
    // karta specjalna: skąd (kasyno / link), jedyny wariant i wygląd (katalog sprawdza)
    fields.insert("source".into(), json!(form.get("source")));
    fields.insert("fixedVariant".into(), json!(form.get("fixed_variant")));
    fields.insert("style".into(), json!(form.get("style")));
    // skrzynki istniejące w chwili zapisu - nowe wbudowane skrzynki dodane później dopiszą tę kartę
    fields.insert("crates_seen".into(), json!(crates_seen));
    fields.insert("arena".into(), json!(arena));
    let given = form.get("id").filter(|p| !p.is_empty()).map(str::to_owned);
    let old: Option<Arc<Person>> = given.as_deref().and_then(|p| cat.person(p).cloned());
    let pid = given.unwrap_or_else(|| {
        let prefix = if main_crate == "world" { "w" } else { main_crate.as_str() };
        unique_id(&format!("{prefix}_{}", slug(&name)), cat.people.keys().chain(cat.hidden_cards.keys()))
    });
    let mut tx = st.db.begin().await?;
    let details =
        format!("{}{} · {}", if old.is_none() { "nowa: " } else { "" }, name.truncate_chars(60), g.rarities[rarity].name);
    catalog::save_override(&mut tx, Table::Cards, &pid, fields).await?;
    log_admin(&mut tx, &me, "card_save", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    let cat = st.cat();

    // zdjęcia: plik > URL > Wikipedia (gdy zmienił się artykuł albo brak zdjęcia)
    let mut warnings: Vec<String> = vec![];
    match update_photo(&st, &form, &pid, &Kind::Main, "").await {
        Some(Err(e)) => warnings.push(format!("Zdjęcie: {e}")),
        Some(Ok(())) => {}
        None => {
            let wiki_changed = old.as_ref().is_some_and(|o| o.wiki != wiki);
            if wiki.is_some() && (st.images.find(&pid, &Kind::Main).is_none() || wiki_changed) {
                let fetched = st.images.fetch(&[(pid.clone(), wiki.clone())], true).await;
                if !fetched.get(&pid).copied().unwrap_or(false) {
                    warnings.push("Nie znaleziono zdjęcia w artykule Wikipedii".into());
                }
            }
        }
    }
    if let Some(Err(e)) = update_photo(&st, &form, &pid, &Kind::Alt, "_alt").await {
        warnings.push(format!("Zdjęcie alt: {e}"));
    }
    // własne zdjęcie wariantu tej karty (Rzulty, Halloweenowa...)
    for v in cat.photo_variants(&pid) {
        if let Some(Err(e)) = update_photo(&st, &form, &pid, &Kind::Variant(v.clone()), &format!("_v_{v}")).await {
            warnings.push(format!("Zdjęcie wariantu {}: {e}", g.variants[&v].name));
        }
    }
    ok(json!({"ok": true, "id": pid, "warnings": warnings}))
}

pub async fn admin_delete_card(State(st): State<AppState>, Admin(me): Admin, Path(pid): Path<String>) -> Res {
    let cat = st.cat();
    let p = cat.person(&pid).ok_or_else(|| not_found("Nie ma takiej karty"))?;
    let mut tx = st.db.begin().await?;
    log_admin(&mut tx, &me, "card_delete", None, &format!("{}{}", p.name, if p.builtin { " (ukryta)" } else { "" })).await?;
    if p.builtin {
        catalog::mark_deleted(&mut tx, Table::Cards, &pid).await?;
    } else {
        catalog::remove_row(&mut tx, Table::Cards, &pid).await?;
        st.images.delete(&pid, &Kind::Main);
        st.images.delete(&pid, &Kind::Alt);
    }
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_restore_card(State(st): State<AppState>, Admin(me): Admin, Path(pid): Path<String>) -> Res {
    let builtin = catalog::builtin_card(&pid).ok_or_else(|| AppError::bad("To nie jest wbudowana karta"))?;
    let mut tx = st.db.begin().await?;
    catalog::remove_row(&mut tx, Table::Cards, &pid).await?;
    log_admin(&mut tx, &me, "card_restore", None, builtin.get("name").and_then(Value::as_str).unwrap_or_default()).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_refetch(State(st): State<AppState>, Admin(_): Admin, Path(pid): Path<String>) -> Res {
    let wiki = st.cat().person(&pid).ok_or_else(|| not_found("Nie ma takiej karty"))?.wiki.clone();
    let res = st.images.fetch(&[(pid.clone(), wiki)], true).await;
    ok(json!({"ok": true, "main": res.get(&pid).copied().unwrap_or(false)}))
}

// ---------------------------------------------------------------- linki do kart specjalnych
// Admin tworzy link do karty specjalnej (źródło "link"): każdy gracz, który go otworzy, dostaje tę kartę - raz na link.
// max_uses = 0 - bez limitu graczy. Wyłączony link przestaje działać.

/// Karta specjalna, którą można dawać linkiem
pub fn link_card<'a>(cat: &'a Catalog, pid: &str) -> Option<&'a Arc<Person>> {
    cat.person(pid).filter(|p| p.is_special() && p.source.as_deref() == Some("link"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkView {
    id: i64,
    token: String,
    path: String,
    person: String,
    name: String,
    variant: Option<String>,
    note: String,
    created: f64,
    created_by: Option<String>,
    active: bool,
    max_uses: i32,
    uses: i32,
    claimed_by: Vec<String>,
}

#[derive(Serialize)]
struct LinkCard {
    id: String,
    name: String,
    variant: Option<String>,
}

pub async fn admin_links(State(st): State<AppState>, Admin(_): Admin) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let users: HashMap<i64, String> = sqlx::query!("SELECT id, username FROM users")
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|r| (r.id, r.username))
        .collect();
    let mut claims: HashMap<i64, Vec<String>> = HashMap::new();
    for r in sqlx::query!("SELECT link_id, user_id FROM card_link_claims ORDER BY claimed_at DESC").fetch_all(&mut *c).await? {
        claims.entry(r.link_id).or_default().push(users.get(&r.user_id).cloned().unwrap_or_else(|| "?".into()));
    }
    let links: Vec<LinkView> = sqlx::query!("SELECT * FROM card_links ORDER BY id DESC")
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|r| {
            let p = cat.person(&r.person_id);
            LinkView {
                id: r.id,
                path: format!("/link/{}", r.token),
                token: r.token,
                name: p.map_or_else(|| r.person_id.clone(), |p| p.name.clone()),
                variant: p.and_then(|p| p.fixed_variant.clone()),
                person: r.person_id,
                note: r.note,
                created: r.created_at,
                created_by: r.created_by.and_then(|u| users.get(&u).cloned()),
                active: r.active != 0,
                max_uses: r.max_uses,
                uses: r.uses,
                claimed_by: claims.remove(&r.id).unwrap_or_default(),
            }
        })
        .collect();
    let cards: Vec<LinkCard> = cat
        .people
        .values()
        .filter(|p| link_card(&cat, &p.id).is_some())
        .map(|p| LinkCard { id: p.id.clone(), name: p.name.clone(), variant: p.fixed_variant.clone() })
        .collect();
    ok(json!({"links": links, "cards": cards}))
}

#[serde_as]
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkRequest {
    person: String,
    note: String,
    /// najwięcej graczy (0 = bez limitu)
    #[serde_as(as = "Num")]
    max_uses: i64,
}

pub async fn admin_link_create(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<LinkRequest>) -> Res {
    let cat = st.cat();
    let Some(p) = link_card(&cat, &req.person) else {
        return bad("Wybierz kartę specjalną ze źródłem „Link od admina”");
    };
    let max_uses = req.max_uses.clamp(0, 100_000) as i32;
    let note = clean(&req.note, 80);
    let token = crate::arena::engine::token();
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        "INSERT INTO card_links (token, person_id, note, created_by, created_at, max_uses) VALUES ($1, $2, $3, $4, $5, $6)",
        token,
        p.id,
        note,
        me.id,
        now(),
        max_uses
    )
    .execute(&mut *tx)
    .await?;
    let mut details = p.name.clone();
    if !note.is_empty() {
        details += &format!(" · {note}");
    }
    if max_uses > 0 {
        details += &format!(" · max {max_uses}");
    }
    log_admin(&mut tx, &me, "link_create", None, &details).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "path": format!("/link/{token}")}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ActiveRequest {
    active: bool,
}

pub async fn admin_link_toggle(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(link_id): Path<i64>,
    JsonBody(req): JsonBody<ActiveRequest>,
) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    let link = sqlx::query!("SELECT person_id, note FROM card_links WHERE id = $1", link_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| not_found("Nie ma takiego linku"))?;
    sqlx::query!("UPDATE card_links SET active = $1 WHERE id = $2", i32::from(req.active), link_id).execute(&mut *tx).await?;
    let name = cat.person(&link.person_id).map_or_else(|| link.person_id.clone(), |p| p.name.clone());
    let details = if link.note.is_empty() { name } else { format!("{name} · {}", link.note) };
    log_admin(&mut tx, &me, if req.active { "link_on" } else { "link_off" }, None, &details).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- gracze

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUser {
    #[serde(flatten)]
    brief: UserBrief,
    balance: i64,
    created: f64,
    chests: Chests,
    banned: bool,
    ban_reason: String,
    access: Vec<String>,
    ranking_hidden: bool,
    money_generated: bool,
}

/// Skrzynka dostępna tylko dla wybranych graczy
#[derive(Serialize)]
struct RestrictedCrate {
    id: String,
    name: String,
    emoji: String,
    shop: bool,
}

#[derive(Serialize)]
struct ChestKind {
    kind: String,
    name: String,
    emoji: String,
}

pub async fn admin_users(State(st): State<AppState>, Admin(me): Admin) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let stats = collection_stats(&mut c, &cat).await?;
    let balances: HashMap<i64, i64> = sqlx::query!("SELECT user_id, value FROM user_state WHERE key = 'balance'")
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|r| (r.user_id, r.value))
        .collect();
    let mut access: HashMap<i64, Vec<String>> = HashMap::new();
    for r in sqlx::query!("SELECT user_id, crate_id FROM crate_access").fetch_all(&mut *c).await? {
        access.entry(r.user_id).or_default().push(r.crate_id);
    }
    let mut users = vec![];
    for u in sqlx::query_as!(User, "SELECT * FROM users ORDER BY id").fetch_all(&mut *c).await? {
        users.push(AdminUser {
            brief: UserBrief::new(&cat, &u, &stats),
            balance: balances.get(&u.id).copied().unwrap_or(0),
            created: u.created_at,
            chests: get_chests(&mut c, &cat, u.id).await?,
            banned: u.banned != 0,
            access: access.remove(&u.id).unwrap_or_default(),
            ranking_hidden: u.ranking_hidden != 0,
            money_generated: u.money_generated != 0,
            ban_reason: u.ban_reason,
        });
    }
    let restricted: Vec<RestrictedCrate> = cat
        .crates
        .values()
        .filter(|c| c.restricted)
        .map(|c| RestrictedCrate { id: c.id.clone(), name: c.name.clone(), emoji: c.emoji.clone(), shop: c.shop })
        .collect();
    let kinds: Vec<ChestKind> = cat
        .crates
        .values()
        .filter(|c| !c.special)
        .map(|c| ChestKind { kind: c.id.clone(), name: c.name.clone(), emoji: c.emoji.clone() })
        .chain(g().money_chests.iter().map(|(k, m)| ChestKind {
            kind: format!("money_{k}"),
            name: m.name.clone(),
            emoji: m.emoji.clone(),
        }))
        .collect();
    ok(json!({"users": users, "me": me.id, "chestKinds": kinds, "restrictedCrates": restricted}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BanRequest {
    #[serde(default = "yes")]
    ban: bool,
    reason: String,
}

pub async fn admin_ban(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<BanRequest>,
) -> Res {
    if uid == me.id {
        return bad("Nie możesz zablokować samego siebie");
    }
    let reason = if req.ban { clean(&req.reason, 200) } else { String::new() };
    let mut tx = st.db.begin().await?;
    sqlx::query!("UPDATE users SET banned = $1, ban_reason = $2 WHERE id = $3", i32::from(req.ban), reason, uid)
        .execute(&mut *tx)
        .await?;
    log_admin(&mut tx, &me, if req.ban { "ban" } else { "unban" }, Some(uid), &reason).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct HiddenRequest {
    #[serde(default = "yes")]
    hidden: bool,
}

pub async fn admin_ranking_hidden(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<HiddenRequest>,
) -> Res {
    let mut tx = st.db.begin().await?;
    sqlx::query!("UPDATE users SET ranking_hidden = $1 WHERE id = $2", i32::from(req.hidden), uid).execute(&mut *tx).await?;
    log_admin(&mut tx, &me, if req.hidden { "ranking_hide" } else { "ranking_show" }, Some(uid), "").await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[derive(Serialize)]
struct UserCard {
    person: String,
    name: String,
    rarity: String,
    variant: String,
    count: i64,
    value: i64,
}

pub async fn admin_user_cards(State(st): State<AppState>, Admin(_): Admin, Path(uid): Path<i64>) -> Res {
    let cat = st.cat();
    let g = g();
    let mut cards: Vec<UserCard> = sqlx::query!(
        r#"SELECT person_id, variant, COUNT(*) AS "n!" FROM items WHERE user_id = $1 GROUP BY person_id, variant"#,
        uid
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .filter_map(|r| {
        let p = cat.person(&r.person_id)?;
        Some(UserCard {
            person: p.id.clone(),
            name: p.name.clone(),
            rarity: p.rarity.clone(),
            value: p.value(&r.variant),
            variant: r.variant,
            count: r.n,
        })
    })
    .collect();
    // od najrzadszych, potem po nazwie i wariancie
    cards.sort_by(|a, b| {
        g.rarity_idx(&b.rarity)
            .cmp(&g.rarity_idx(&a.rarity))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.variant.cmp(&b.variant))
    });
    let variants: IndexMap<&String, &String> = g.variants.iter().map(|(k, v)| (k, &v.name)).collect();
    ok(json!({"cards": cards, "variants": variants}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DeleteCardsRequest {
    /// wszystkie karty gracza
    all: bool,
    person: String,
    variant: String,
    count: Option<i64>,
}

pub async fn admin_delete_user_cards(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<DeleteCardsRequest>,
) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    let ids: Vec<i64> = if req.all {
        sqlx::query_scalar!("SELECT id FROM items WHERE user_id = $1", uid).fetch_all(&mut *tx).await?
    } else {
        sqlx::query_scalar!(
            "SELECT id FROM items WHERE user_id = $1 AND person_id = $2 AND variant = $3 ORDER BY id DESC LIMIT $4",
            uid,
            req.person,
            req.variant,
            req.count.filter(|n| *n != 0).unwrap_or(1).max(1)
        )
        .fetch_all(&mut *tx)
        .await?
    };
    if !ids.is_empty() {
        sqlx::query!("DELETE FROM items WHERE id = ANY($1)", &ids).execute(&mut *tx).await?;
        sqlx::query!("DELETE FROM showcase WHERE item_id = ANY($1)", &ids).execute(&mut *tx).await?;
        let what = if req.all {
            "wszystkie karty".to_owned()
        } else {
            let person = cat.person(&req.person).map_or_else(|| req.person.clone(), |p| p.name.clone());
            let variant = g().variants.get(&req.variant).map_or("?", |v| v.name.as_str());
            format!("{person} · {variant}")
        };
        log_admin(&mut tx, &me, "cards_delete", Some(uid), &format!("{} szt. ({what})", ids.len())).await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true, "deleted": ids.len()}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct AccessRequest {
    crates: Vec<String>,
}

pub async fn admin_set_access(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<AccessRequest>,
) -> Res {
    let cat = st.cat();
    let crates: Vec<String> = req.crates.into_iter().filter(|c| cat.crates.contains_key(c)).collect();
    let mut tx = st.db.begin().await?;
    sqlx::query!("DELETE FROM crate_access WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!(
        "INSERT INTO crate_access (user_id, crate_id) SELECT $1, c FROM UNNEST($2::text[]) AS c ON CONFLICT DO NOTHING",
        uid,
        &crates
    )
    .execute(&mut *tx)
    .await?;
    let names: Vec<&str> = crates.iter().map(|c| cat.crates[c].name.as_str()).collect();
    let details = if names.is_empty() { "brak".to_owned() } else { names.join(", ") };
    log_admin(&mut tx, &me, "access", Some(uid), &details).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ChestsRequest {
    kind: String,
    count: Option<i64>,
}

pub async fn admin_give_chests(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<ChestsRequest>,
) -> Res {
    let cat = st.cat();
    let count = req.count.unwrap_or(0);
    if !valid_chest_kind(&cat, &req.kind) || !(-1000..=1000).contains(&count) || count == 0 {
        return bad("Nieprawidłowa skrzynka lub ilość");
    }
    let mut tx = st.db.begin().await?;
    if crate::auth::user_by_id(&mut tx, uid).await?.is_none() {
        return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza");
    }
    add_chests(&mut tx, uid, &req.kind, count).await?;
    if count > 0 {
        mark_money_generated(&mut tx, uid).await?; // skrzynki od admina to darmowe pieniądze / karty
    }
    let name = match g().money_kind(&req.kind) {
        Some(m) => g().money_chests[m].name.clone(),
        None => cat.crates.get(&req.kind).map(|c| c.name.clone()).unwrap_or_default(),
    };
    log_admin(&mut tx, &me, "chests", Some(uid), &format!("{name} {count:+}")).await?;
    let chests = get_chests(&mut tx, &cat, uid).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "chests": chests}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct MoneyRequest {
    amount: Option<i64>,
}

pub async fn admin_money(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<MoneyRequest>,
) -> Res {
    let amount = req.amount.unwrap_or(0);
    let max = g().max_deposit;
    if !(-max..=max).contains(&amount) || amount == 0 {
        return bad("Nieprawidłowa kwota");
    }
    let mut tx = st.db.begin().await?;
    ensure_state(&mut tx, uid).await?;
    add_state(&mut tx, uid, "balance", amount).await?;
    if amount > 0 {
        add_state(&mut tx, uid, "deposited", amount).await?;
        mark_money_generated(&mut tx, uid).await?;
    }
    log_admin(&mut tx, &me, "money", Some(uid), &fmt_money_signed(amount)).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_toggle(State(st): State<AppState>, Admin(me): Admin, Path(uid): Path<i64>) -> Res {
    if uid == me.id {
        return bad("Nie możesz odebrać uprawnień samemu sobie");
    }
    let mut tx = st.db.begin().await?;
    let now_admin = sqlx::query_scalar!("UPDATE users SET is_admin = 1 - is_admin WHERE id = $1 RETURNING is_admin", uid)
        .fetch_optional(&mut *tx)
        .await?;
    log_admin(&mut tx, &me, if now_admin.is_some_and(|a| a != 0) { "admin_grant" } else { "admin_revoke" }, Some(uid), "")
        .await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct NewPassword {
    password: String,
}

pub async fn admin_password(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(uid): Path<i64>,
    JsonBody(req): JsonBody<NewPassword>,
) -> Res {
    if req.password.chars().count() < MIN_PASSWORD {
        return bad(password_error());
    }
    let hash = hash_password_async(req.password).await;
    let mut tx = st.db.begin().await?;
    sqlx::query!("UPDATE users SET password_hash = $1 WHERE id = $2", hash, uid).execute(&mut *tx).await?;
    log_admin(&mut tx, &me, "password", Some(uid), "").await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

pub async fn admin_delete_user(State(st): State<AppState>, Admin(me): Admin, Path(uid): Path<i64>) -> Res {
    if uid == me.id {
        return bad("Nie możesz usunąć samego siebie");
    }
    let mut tx = st.db.begin().await?;
    log_admin(&mut tx, &me, "user_delete", Some(uid), "").await?; // przed usunięciem - żeby zapisać nazwę gracza
    super::market::market_forget_user(&mut tx, uid).await?; // jego oferty na rynku i lobby jackpota
    super::casino::blackjack_forget_user(&mut tx, uid).await?; // rozdanie w trakcie i postawione w nim karty
    sqlx::query!("DELETE FROM items WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM user_state WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM user_discovered WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM daily_claims WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM user_collected WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM showcase WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM feed WHERE author_id = $1 OR to_user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM user_chests WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM crate_access WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM arena_daily WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM card_link_claims WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM admin_message_seen WHERE user_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM trade_lines WHERE trade_id IN (SELECT id FROM trades WHERE from_id = $1 OR to_id = $1)", uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM trades WHERE from_id = $1 OR to_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1", uid).execute(&mut *tx).await?;
    sqlx::query!("DELETE FROM users WHERE id = $1", uid).execute(&mut *tx).await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_ids() {
        assert_eq!(slug("Skrzynia Królów"), "skrzynia_krolow");
        assert_eq!(slug("Łódź!"), "lodz");
        assert_eq!(slug("???"), "x");
        let taken = ["pl_a".to_string(), "pl_a_2".to_string()];
        assert_eq!(unique_id("pl_a", &taken), "pl_a_3");
        assert_eq!(unique_id("pl_b", &taken), "pl_b");
    }

    #[test]
    fn admin_forms() {
        // formularz skrzynki: liczby jako tekst (Object.fromEntries(FormData))
        let r: CrateRequest =
            serde_json::from_str(r#"{"name": "X", "price": "250", "weights": {"green": "40"}, "allowed": [1, 2], "shop": true}"#)
                .unwrap();
        assert_eq!(r.price.unwrap().integer().unwrap(), Some(250));
        assert_eq!(r.weights["green"].number().unwrap(), Some(40.0));
        let r: CrateRequest = serde_json::from_str(r#"{"name": "X", "price": ""}"#).unwrap();
        assert_eq!(r.price.unwrap().integer().unwrap(), None);
        assert!(r.shop && r.allowed.is_none());
        let r: LinkRequest = serde_json::from_str(r#"{"person": "x", "maxUses": "5"}"#).unwrap();
        assert_eq!(r.max_uses, 5);
    }
}
