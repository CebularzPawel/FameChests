//! Warianty w panelu admina: ustawienia i wydarzenia (strona /variants), przypinanie do skrzynek, kreator (/designer),
//! naklejki (/stickers); easter eggi: obrazek w bębnie skrzynki i wizyta UFO.

use std::collections::HashMap;

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{ok, JsonBody};
use crate::assets::asset;
use crate::auth::{Admin, Me};
use crate::catalog::{self, Catalog, Table};
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{bad, AppError, Res};
use crate::game::{log_admin, set_state};
use crate::images::{file_mtime, mimetype, Kind};
use crate::state::AppState;
use crate::variants::{
    clean_card_stickers, clean_custom_variant, clean_stickers, clean_variant_events, clean_variant_settings,
    custom_variant_key, sticker_file_id, Sticker, EGG_ID, STICKER_ID_RE,
};
use crate::web::send_file;

fn not_found(msg: &str) -> AppError {
    AppError::with_status(StatusCode::NOT_FOUND, msg)
}

fn random_id() -> String {
    hex::encode(rand::random::<[u8; 4]>())
}

// ---------------------------------------------------------------- dla przeglądarki (/api/config)

/// Naklejka z adresem obrazka (wgrany plik albo wbudowana grafika ze static/img/mlg)
pub fn sticker_json(variant: &str, s: &Sticker) -> Value {
    let url = if s.src == "upload" {
        format!("/sticker/{variant}/{}?v={}", s.id, s.v)
    } else {
        asset(&format!("img/mlg/{}.svg", s.src))
    };
    let mut v = json!(s);
    v["url"] = json!(url);
    v
}

/// Obrazek od admina, który czasem przelatuje w bębnie skrzynki - None, gdy go nie ma
pub fn easter_egg_json(st: &AppState) -> Value {
    match st.images.find(EGG_ID, &Kind::Main) {
        Some(path) => {
            json!({"url": format!("/egg?v={}", file_mtime(&path) as i64 % 1_000_000_000), "chance": g().easter_egg_chance})
        }
        None => Value::Null,
    }
}

/// Część /api/config o wariantach: ustawienia, kreator, naklejki, easter egg
pub fn config_extras(st: &AppState, cat: &Catalog, admin: bool) -> Map<String, Value> {
    let g = g();
    let mut m = Map::new();
    // włączone / wyłączone warianty i wydarzenia (wariant na czas w wybranych skrzynkach) - strona /variants
    let cfg: Map<String, Value> = g.variant_defaults.keys().map(|v| (v.clone(), cat.variant_cfg_json(v, admin))).collect();
    m.insert("variantCfg".into(), Value::Object(cfg));
    // warianty z kreatora (/designer): projekt - wygląd rysuje przeglądarka (customVariantCSS w app.js)
    m.insert("customVariants".into(), json!(cat.vs.custom));
    m.insert("cvOptions".into(), crate::variants::cv_options());
    // naklejki od admina na wariantach (MLG...) i wbudowane grafiki
    let stickers: Map<String, Value> = g
        .sticker_variants
        .iter()
        .map(|v| {
            let list = cat.vs.stickers.get(v).into_iter().flatten().map(|s| sticker_json(v, s)).collect();
            (v.clone(), Value::Array(list))
        })
        .collect();
    m.insert("variantStickers".into(), Value::Object(stickers));
    m.insert("cardStickers".into(), card_stickers_all(cat));
    let library: Map<String, Value> = g
        .sticker_library
        .iter()
        .map(|(k, n)| (k.clone(), json!({"name": n, "url": asset(&format!("img/mlg/{k}.svg"))})))
        .collect();
    m.insert("stickerLibrary".into(), Value::Object(library));
    m.insert("stickerAnims".into(), json!(g.sticker_anims));
    m.insert("easterEgg".into(), easter_egg_json(st));
    m
}

/// Karty z własnymi naklejkami (zmienione standardowe + tylko tej karty) - gotowa lista dla każdej z nich
fn card_stickers_of(cat: &Catalog, v: &str) -> Value {
    let cards: Map<String, Value> = cat
        .vs
        .sticker_cards
        .get(v)
        .into_iter()
        .flat_map(|m| m.keys())
        .filter(|pid| cat.has(pid))
        .map(|pid| (pid.clone(), json!(cat.vs.card_stickers(v, pid).iter().map(|s| sticker_json(v, s)).collect::<Vec<_>>())))
        .collect();
    Value::Object(cards)
}

fn card_stickers_all(cat: &Catalog) -> Value {
    Value::Object(g().sticker_variants.iter().map(|v| (v.clone(), card_stickers_of(cat, v))).collect())
}

// ---------------------------------------------------------------- pliki: naklejki i easter egg

/// Naklejka wgrana przez admina na wariant (np. MLG) - ?v=<wersja> zmienia się razem z plikiem
pub async fn sticker_image(
    State(st): State<AppState>,
    Path((variant, sid)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Res {
    if !g().sticker_variants.contains(&variant) || !STICKER_ID_RE.is_match(&sid) {
        return Err(AppError::Status(StatusCode::NOT_FOUND));
    }
    let path = st.images.find(&sticker_file_id(&variant), &Kind::Variant(sid)).ok_or(AppError::Status(StatusCode::NOT_FOUND))?;
    let path = st.images.web_version_async(path, false).await;
    let cache = format!("public, max-age={}", if q.contains_key("v") { 30 * 86400 } else { 3600 });
    send_file(&path, mimetype(&path), &headers, &cache).await
}

pub async fn egg_image(
    State(st): State<AppState>,
    Me(_): Me,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Res {
    let path = st.images.find(EGG_ID, &Kind::Main).ok_or(AppError::Status(StatusCode::NOT_FOUND))?;
    let path = st.images.web_version_async(path, false).await;
    let cache = format!("public, max-age={}", if q.contains_key("v") { 30 * 86400 } else { 0 });
    send_file(&path, mimetype(&path), &headers, &cache).await
}

/// Pola i pliki formularza (multipart)
struct Form {
    fields: HashMap<String, String>,
    files: HashMap<String, (String, Vec<u8>)>,
}

impl Form {
    async fn read(mut mp: Multipart) -> Res<Form> {
        let invalid = |e: axum::extract::multipart::MultipartError| AppError::bad(format!("Nieprawidłowy formularz: {e}"));
        let (mut fields, mut files) = (HashMap::new(), HashMap::new());
        while let Some(field) = mp.next_field().await.map_err(invalid)? {
            let name = field.name().unwrap_or_default().to_owned();
            match field.file_name().map(str::to_owned) {
                Some(filename) => {
                    files.insert(name, (filename, field.bytes().await.map_err(invalid)?.to_vec()));
                }
                None => {
                    fields.insert(name, field.text().await.map_err(invalid)?);
                }
            }
        }
        Ok(Form { fields, files })
    }

    fn upload(&self, key: &str) -> Option<&[u8]> {
        self.files.get(key).filter(|(name, _)| !name.is_empty()).map(|(_, b)| b.as_slice())
    }
}

/// Easter egg w bębnie: wgranie albo usunięcie obrazka
pub async fn admin_egg_save(State(st): State<AppState>, Admin(me): Admin, mp: Multipart) -> Res {
    let form = Form::read(mp).await?;
    let action = if let Some(blob) = form.upload("image") {
        st.images.save(EGG_ID, blob, &Kind::Main).map_err(AppError::bad)?;
        "egg_save"
    } else if form.fields.get("remove").map(String::as_str) == Some("1") {
        st.images.delete(EGG_ID, &Kind::Main);
        "egg_delete"
    } else {
        return bad("Wybierz plik");
    };
    let mut c = st.db.acquire().await?;
    log_admin(&mut c, &me, action, None, "").await?;
    ok(json!({"ok": true, "easterEgg": easter_egg_json(&st)}))
}

// ---------------------------------------------------------------- wizyta UFO

fn ufo_cards(cat: &Catalog) -> Vec<String> {
    cat.people.values().filter(|p| p.source.as_deref() == Some("ufo")).map(|p| p.id.clone()).collect()
}

/// Wizyta UFO (w /api/me): rzadko gracz dostaje w ekwipunku kartę ze źródłem "ufo" - tylko do pokazania
pub async fn ufo_visit(c: &mut Conn, cat: &Catalog, uid: i64, visit: i64) -> sqlx::Result<Option<String>> {
    use rand::seq::SliceRandom;
    let cards = ufo_cards(cat);
    if cards.is_empty() {
        return Ok(None);
    }
    if visit == 0 {
        if rand::random::<f64>() >= g().ufo_visit_chance {
            return Ok(None);
        }
        set_state(c, uid, "ufo_visit", 1).await?;
    }
    Ok(cards.choose(&mut rand::thread_rng()).cloned())
}

/// Gracz zobaczył kartę w ekwipunku - UFO ją zabrało; następna wizyta znów losowo
pub async fn ufo_seen(State(st): State<AppState>, Me(me): Me) -> Res {
    let mut c = st.db.acquire().await?;
    set_state(&mut c, me.id, "ufo_visit", 0).await?;
    ok(json!({"ok": true}))
}

/// Test wizyty UFO: przy następnym wejściu do ekwipunku admin zobaczy kartę ze źródłem "ufo"
pub async fn admin_ufo_test(State(st): State<AppState>, Admin(me): Admin) -> Res {
    if ufo_cards(&st.cat()).is_empty() {
        return bad("Żadna karta nie ma źródła „UFO”");
    }
    let mut c = st.db.acquire().await?;
    set_state(&mut c, me.id, "ufo_visit", 1).await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- zapis w catalog_variants

async fn variant_row(c: &mut Conn, key: &str) -> sqlx::Result<Map<String, Value>> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT data FROM catalog_variants WHERE id = $1").bind(key).fetch_optional(&mut *c).await?;
    Ok(row.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default())
}

/// Zapis zmienionych pól wiersza catalog_variants (pozostałe pola zostają)
async fn save_variant(c: &mut Conn, key: &str, fields: Map<String, Value>) -> sqlx::Result<()> {
    let mut current = variant_row(c, key).await?;
    current.extend(fields);
    sqlx::query(
        "INSERT INTO catalog_variants (id, data, deleted) VALUES ($1, $2, 0)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, deleted = 0",
    )
    .bind(key)
    .bind(Value::Object(current).to_string())
    .execute(&mut *c)
    .await?;
    Ok(())
}

fn fields(k: &str, v: Value) -> Map<String, Value> {
    Map::from_iter([(k.to_owned(), v)])
}

// ---------------------------------------------------------------- ustawienia wariantów (strona /variants)

async fn settings_row(c: &mut Conn, variant: &str) -> sqlx::Result<Map<String, Value>> {
    Ok(variant_row(c, variant).await?.get("settings").and_then(Value::as_object).cloned().unwrap_or_default())
}

/// Zapis ustawień (sprawdzonych) - katalog trzeba potem zbudować od nowa
async fn save_settings(c: &mut Conn, variant: &str, settings: Map<String, Value>) -> sqlx::Result<()> {
    let clean = clean_variant_settings(variant, &Value::Object(settings));
    save_variant(c, variant, fields("settings", json!(clean))).await
}

/// Wariant po zmianie - przeglądarka podmienia go w S.cfg (variants, variantCfg), mnożniki jego połączeń z warstwami
/// i kolejność wariantów (zależy od mnożników)
fn admin_variant_json(cat: &Catalog, variant: &str) -> Value {
    let g = g();
    let combo_mults: Map<String, Value> = g
        .variants
        .iter()
        .filter(|(_, x)| x.combo && x.layers.iter().any(|l| l == variant))
        .map(|(k, x)| (k.clone(), json!(x.mult)))
        .collect();
    json!({"ok": true, "variant": g.variants_json[variant], "cfg": cat.variant_cfg_json(variant, true),
           "comboMults": combo_mults, "variantOrder": g.variant_order})
}

fn check_variant(variant: &str) -> Res<()> {
    if g().variant_defaults.contains_key(variant) {
        Ok(())
    } else {
        Err(not_found("Nie ma takiego wariantu"))
    }
}

/// Liczba jak w "%.3g" / ":g" w Pythonie (bez zbędnych zer)
fn short_num(x: f64) -> String {
    let s = format!("{:.3}", x);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.replace('.', ",").replace(',', ".")
}

/// Włączony / wyłączony, szansa (albo waga przy wariantach "always"), opis, mnożnik wartości i "noHouse".
/// null = wartość z kodu.
pub async fn admin_variant_save(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(variant): Path<String>,
    JsonBody(body): JsonBody<Map<String, Value>>,
) -> Res {
    check_variant(&variant)?;
    if g().variant(&variant).special {
        return bad("Warianty kart specjalnych ustawia się przy samych kartach");
    }
    let mut tx = st.db.begin().await?;
    let mut settings = settings_row(&mut tx, &variant).await?;
    for k in ["enabled", "chance", "weight", "desc", "mult", "noHouse", "cards", "crateOnly"] {
        if let Some(v) = body.get(k) {
            settings.insert(k.into(), v.clone());
        }
    }
    save_settings(&mut tx, &variant, settings).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    let cat = st.cat();
    let g = g();
    let x = g.variant(&variant);
    let s = cat.vs.cfg.get(&variant).cloned().unwrap_or_default();
    let details = format!(
        "{}: {} · szansa {}% · wartość ×{}{}{}",
        x.name,
        if cat.variant_enabled(&variant) { "włączony" } else { "wyłączony" },
        short_num(x.chance * 100.0),
        short_num(x.mult),
        if s.no_house { " · ekskluzywny (nie z kuźni ani kasyna)" } else { "" },
        s.weight.map(|w| format!(" · waga {w}")).unwrap_or_default()
    );
    let mut c = st.db.acquire().await?;
    log_admin(&mut c, &me, "variant_save", None, &details).await?;
    ok(admin_variant_json(&cat, &variant))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct VariantCrateRequest {
    #[serde(rename = "crate")]
    crate_: Option<String>,
    on: Value,
}

/// Przypina wariant do skrzynki albo go od niej odpina: {crate, on}. Zwraca nowe listy wariantów zmienionych skrzynek.
pub async fn admin_variant_crate(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(variant): Path<String>,
    JsonBody(req): JsonBody<VariantCrateRequest>,
) -> Res {
    check_variant(&variant)?;
    let g = g();
    if !g.crate_variants.contains(&variant) {
        return bad("Tego wariantu nie przypina się do skrzynek");
    }
    let cat = st.cat();
    let Some(cr) = req.crate_.as_deref().and_then(|c| cat.crates.get(c)).filter(|c| !c.special) else {
        return bad("Nie ma takiej skrzynki");
    };
    let on = crate::variants::truthy(&req.on);
    let variants: Vec<&String> = g
        .crate_variants
        .iter()
        .filter(|v| (cr.variants.contains(v) && **v != variant) || (on && **v == variant))
        .collect();
    let mut tx = st.db.begin().await?;
    let mut f = Map::new();
    f.insert("variants".into(), json!(variants));
    f.insert("variantsAll".into(), json!(true));
    catalog::save_override(&mut tx, Table::Crates, &cr.id, f).await?;
    let details = format!("{}: {} {}", g.variant(&variant).name, if on { "przypięty do" } else { "odpięty od" }, cr.name);
    log_admin(&mut tx, &me, "variant_crate", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    let cat = st.cat();
    let list = cat.crates.get(&cr.id).map(|c| c.variants.clone()).unwrap_or_default();
    ok(json!({"ok": true, "crates": {cr.id.clone(): list}}))
}

fn fmt_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%d.%m %H:%M").to_string())
        .unwrap_or_default()
}

/// Nowe wydarzenie: od - do (sekundy unix) wariant wypada z wybranych skrzynek (pusta lista = ze wszystkich)
pub async fn admin_variant_event_add(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(variant): Path<String>,
    JsonBody(mut body): JsonBody<Map<String, Value>>,
) -> Res {
    check_variant(&variant)?;
    let g = g();
    let x = g.variant(&variant);
    if x.special {
        return bad("Warianty kart specjalnych nie wypadają ze skrzynek");
    }
    let cat = st.cat();
    let crates: Vec<String> = body
        .get("crates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|c| cat.crates.get(*c).is_some_and(|cr| !cr.special))
        .map(str::to_owned)
        .collect();
    body.insert("crates".into(), json!(crates));
    body.insert("id".into(), json!(random_id()));
    let Some(ev) = clean_variant_events(Some(&json!([body]))).into_iter().next() else {
        return bad("Ustaw początek i koniec (koniec po początku)");
    };
    let now = now();
    if ev.end as f64 <= now {
        return bad("To wydarzenie już by się skończyło");
    }
    let mut tx = st.db.begin().await?;
    let mut settings = settings_row(&mut tx, &variant).await?;
    // wydarzenia skończone ponad 30 dni temu nie są już potrzebne - wystarczy jedno, żeby wariant był "w grze"
    let events: Vec<Value> = settings.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
    let is_recent = |e: &Value| e.get("end").and_then(Value::as_f64).unwrap_or(0.0) > now - 30.0 * 86400.0;
    let old: Vec<Value> = events.iter().filter(|e| !is_recent(e)).cloned().collect();
    let mut list: Vec<Value> = old.last().cloned().into_iter().collect();
    list.extend(events.iter().filter(|e| is_recent(e)).cloned());
    list.push(json!(ev));
    settings.insert("events".into(), Value::Array(list));
    save_settings(&mut tx, &variant, settings).await?;
    let mut where_ = ev.crates.iter().filter_map(|c| cat.crates.get(c)).map(|c| c.name.clone()).collect::<Vec<_>>().join(", ");
    if where_.is_empty() {
        where_ = "wszystkie skrzynki".into();
    }
    let details = format!(
        "{}: {} - {} · {where_}{}",
        x.name,
        fmt_time(ev.start),
        fmt_time(ev.end),
        if ev.boost != 1.0 { format!(" · szansa ×{}", short_num(ev.boost)) } else { String::new() }
    );
    log_admin(&mut tx, &me, "variant_event", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(admin_variant_json(&st.cat(), &variant))
}

/// Usuwa zaplanowane wydarzenie; trwające - kończy teraz (zostaje w historii, żeby wariant był nadal "w grze")
pub async fn admin_variant_event_delete(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path((variant, eid)): Path<(String, String)>,
) -> Res {
    check_variant(&variant)?;
    let now = now() as i64;
    let mut tx = st.db.begin().await?;
    let mut settings = settings_row(&mut tx, &variant).await?;
    let mut events = Vec::new();
    for e in settings.get("events").and_then(Value::as_array).cloned().unwrap_or_default() {
        let start = e.get("start").and_then(Value::as_i64).unwrap_or(0);
        if e.get("id").and_then(Value::as_str) != Some(eid.as_str()) {
            events.push(e);
        } else if start <= now {
            let mut e = e;
            e["end"] = json!((start + 1).max(now));
            events.push(e);
        }
    }
    settings.insert("events".into(), Value::Array(events));
    save_settings(&mut tx, &variant, settings).await?;
    log_admin(&mut tx, &me, "variant_event_stop", None, &g().variant(&variant).name).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(admin_variant_json(&st.cat(), &variant))
}

// ---------------------------------------------------------------- kreator wariantów (strona /designer)

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DesignRequest {
    key: Option<String>,
    design: Value,
}

/// Nowy albo zmieniony wariant z kreatora: {key (pusty = nowy), design}. Nowy wariant jest wyłączony.
pub async fn admin_variant_design_save(
    State(st): State<AppState>,
    Admin(me): Admin,
    JsonBody(req): JsonBody<DesignRequest>,
) -> Res {
    let design = clean_custom_variant(&req.design);
    let cat = st.cat();
    let g = g();
    let key = match req.key.filter(|k| !k.is_empty()) {
        Some(k) => {
            if !cat.vs.custom.contains_key(&k) {
                return bad("Nie ma takiego wariantu");
            }
            k
        }
        None => {
            if cat.vs.custom.len() >= g.custom_variant_max {
                return bad(format!("Najwyżej {} wariantów z kreatora", g.custom_variant_max));
            }
            let name = design["name"].as_str().unwrap_or_default();
            custom_variant_key(name, &|k| g.variants.contains_key(k) || g.removed_variants.iter().any(|r| r == k))
        }
    };
    let mut tx = st.db.begin().await?;
    save_variant(&mut tx, &key, fields("custom", design.clone())).await?;
    let details = format!("{} ({key})", design["name"].as_str().unwrap_or_default());
    log_admin(&mut tx, &me, "variant_design", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    let cat = st.cat();
    let g = crate::data::g();
    ok(json!({"ok": true, "key": key, "design": cat.vs.custom.get(&key), "variant": g.variants_json[&key]}))
}

/// Usuwa wariant z kreatora. Karty graczy w nim stają się zwykłe (jak przy usuniętych wariantach).
pub async fn admin_variant_design_delete(State(st): State<AppState>, Admin(me): Admin, Path(key): Path<String>) -> Res {
    let cat = st.cat();
    let Some(design) = cat.vs.custom.get(&key) else { return bad("Nie ma takiego wariantu") };
    let name = design["name"].as_str().unwrap_or_default().to_owned();
    let mut tx = st.db.begin().await?;
    crate::startup::drop_variant_everywhere(&mut tx, &key).await?;
    log_admin(&mut tx, &me, "variant_design_delete", None, &format!("{name} ({key})")).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- naklejki wariantów (strona /stickers)

fn check_sticker_variant(variant: &str) -> Res<()> {
    if g().sticker_variants.iter().any(|v| v == variant) {
        Ok(())
    } else {
        Err(not_found("Ten wariant nie ma naklejek"))
    }
}

/// Wgrany plik naklejki: od razu w image_cache, ale gracze widzą go dopiero po zapisaniu układu naklejek
pub async fn admin_sticker_upload(
    State(st): State<AppState>,
    Admin(_): Admin,
    Path(variant): Path<String>,
    mp: Multipart,
) -> Res {
    check_sticker_variant(&variant)?;
    let form = Form::read(mp).await?;
    let Some(blob) = form.upload("image") else { return bad("Wybierz plik") };
    let sid = random_id();
    let kind = Kind::Variant(sid.clone());
    st.images.save(&sticker_file_id(&variant), blob, &kind).map_err(AppError::bad)?;
    let v = st.images.find(&sticker_file_id(&variant), &kind).map_or(0, |p| file_mtime(&p) as i64 % 1_000_000_000);
    let s = clean_stickers(Some(&json!([{"id": sid, "src": "upload", "v": v}]))).remove(0);
    ok(json!({"ok": true, "sticker": sticker_json(&variant, &s)}))
}

/// Wgrane naklejki tylko z istniejącym plikiem (mógł zniknąć) i jego wersją
fn with_sticker_files(st: &AppState, variant: &str, stickers: Vec<Sticker>) -> Vec<Sticker> {
    stickers
        .into_iter()
        .filter_map(|mut s| {
            if s.src == "upload" {
                let path = st.images.find(&sticker_file_id(variant), &Kind::Variant(s.id.clone()))?;
                s.v = file_mtime(&path) as i64 % 1_000_000_000;
            }
            Some(s)
        })
        .collect()
}

/// Usuwa wgrane pliki naklejek, których nie używa już żadna naklejka (także wgrane, ale niezapisane)
fn drop_unused_stickers(st: &AppState, variant: &str) {
    st.images.delete_other(&sticker_file_id(variant), &st.cat().vs.sticker_uploads(variant));
}

fn admin_card_stickers_json(cat: &Catalog, variant: &str, pid: &str) -> Value {
    match cat.vs.sticker_cards.get(variant).and_then(|m| m.get(pid)) {
        Some(own) => json!({"edits": own.edits, "extra": own.extra.iter().map(|s| sticker_json(variant, s)).collect::<Vec<_>>()}),
        None => Value::Null,
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct StickersRequest {
    stickers: Value,
}

/// Standardowy układ naklejek wariantu naraz (kolejność = od spodu) - zmiany na pojedynczych kartach zostają
pub async fn admin_stickers_save(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(variant): Path<String>,
    JsonBody(req): JsonBody<StickersRequest>,
) -> Res {
    check_sticker_variant(&variant)?;
    let stickers = with_sticker_files(&st, &variant, clean_stickers(Some(&req.stickers)));
    let mut tx = st.db.begin().await?;
    save_variant(&mut tx, &variant, fields("stickers", json!(stickers))).await?;
    let details = format!("{}: {} naklejek", g().variant(&variant).name, stickers.len());
    log_admin(&mut tx, &me, "stickers_save", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    drop_unused_stickers(&st, &variant);
    let cat = st.cat();
    let list: Vec<Value> = cat.vs.stickers.get(&variant).into_iter().flatten().map(|s| sticker_json(&variant, s)).collect();
    ok(json!({"ok": true, "stickers": list, "cardStickers": card_stickers_of(&cat, &variant)}))
}

/// Naklejki jednej karty: zmiany standardowych naklejek ("edits") i naklejki tylko tej karty ("extra").
/// Pusty zapis = karta wraca do samych standardowych naklejek.
pub async fn admin_card_stickers_save(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path((variant, pid)): Path<(String, String)>,
    JsonBody(body): JsonBody<Value>,
) -> Res {
    check_sticker_variant(&variant)?;
    let cat = st.cat();
    let Some(person) = cat.person(&pid).cloned() else { return Err(not_found("Nie ma takiej karty")) };
    let own = clean_card_stickers(&body).map(|mut o| {
        o.extra = with_sticker_files(&st, &variant, std::mem::take(&mut o.extra));
        o
    });
    let mut tx = st.db.begin().await?;
    let mut cards = variant_row(&mut tx, &variant).await?.get("cards").and_then(Value::as_object).cloned().unwrap_or_default();
    match &own {
        Some(o) => {
            cards.insert(pid.clone(), json!(o));
        }
        None => {
            cards.remove(&pid);
        }
    }
    save_variant(&mut tx, &variant, fields("cards", Value::Object(cards))).await?;
    let what = match &own {
        Some(o) => format!("{} zmian, {} własnych", o.edits.len(), o.extra.len()),
        None => "standardowe".into(),
    };
    let details = format!("{} · {}: {what}", g().variant(&variant).name, person.name);
    log_admin(&mut tx, &me, "stickers_card", None, &details).await?;
    tx.commit().await?;
    st.refresh_catalog().await?;
    drop_unused_stickers(&st, &variant);
    let cat = st.cat();
    let list: Vec<Value> = cat.vs.card_stickers(&variant, &pid).iter().map(|s| sticker_json(&variant, s)).collect();
    ok(json!({"ok": true, "card": admin_card_stickers_json(&cat, &variant, &pid), "stickers": list}))
}

/// Do edytora: standardowe naklejki i zmiany na pojedynczych kartach (surowe - edytor sam je nakłada)
pub async fn admin_stickers_get(State(st): State<AppState>, Admin(_): Admin, Path(variant): Path<String>) -> Res {
    check_sticker_variant(&variant)?;
    let cat = st.cat();
    let list: Vec<Value> = cat.vs.stickers.get(&variant).into_iter().flatten().map(|s| sticker_json(&variant, s)).collect();
    let cards: Map<String, Value> = cat
        .vs
        .sticker_cards
        .get(&variant)
        .into_iter()
        .flat_map(|m| m.keys())
        .map(|pid| (pid.clone(), admin_card_stickers_json(&cat, &variant, pid)))
        .collect();
    ok(json!({"stickers": list, "cards": cards}))
}
