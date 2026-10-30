//! Zmiany wariantów z panelu admina (tabela `catalog_variants`, id = klucz wariantu, `data` = JSON):
//!   - `{"settings": {...}}` - ustawienia ze strony /variants: włączony, szansa / waga, opis, mnożnik wartości,
//!     ekskluzywny ("noHouse") i WYDARZENIA (od - do wariant wypada ze wszystkich albo z wybranych skrzynek),
//!   - `{"stickers": [...], "cards": {karta: {"edits", "extra"}}}` - naklejki ze strony /stickers,
//!   - `{"custom": {...}}` - projekt wariantu z kreatora (/designer), klucz `cv_<nazwa>`.
//!
//! Tu tylko sprawdzanie pól (jak `clean_*` w catalog.py); nakładanie na warianty z data/game.json - `data.rs`
//! (`GameData::with_catalog_variants`), pytania o warianty (włączony, wydarzenie, co wypada) - `catalog.rs`.

use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::data::{g, py_round};
use crate::text::clean;

/// Plik obrazka easter egga w image_cache (__egg.png itp.)
pub const EGG_ID: &str = "__egg";

/// Nazwa, pod którą Images trzyma wgrane naklejki wariantu: image_cache/__stk_mlg__<id>.png
pub fn sticker_file_id(variant: &str) -> String {
    format!("__stk_{variant}")
}

/// Id naklejki i wydarzenia: 8 znaków szesnastkowych
pub static STICKER_ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{8}$").unwrap());
static CV_COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap());

// ---------------------------------------------------------------- liczby i prawda jak w Pythonie

/// bool(x) z Pythona
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// float(x) z Pythona (None, gdy się nie da)
pub fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|x| !x.is_nan()),
        _ => None,
    }
}

/// int(x) z Pythona (napis "1.5" to błąd, liczba 1.9 -> 1)
pub fn py_int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|x| x.is_finite()).map(|x| x.trunc() as i64)),
        Value::Bool(b) => Some(*b as i64),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// _int(v, lo, hi) z catalog.py
pub fn int_in(v: Option<&Value>, lo: i64, hi: i64) -> Option<i64> {
    v.and_then(py_int).map(|x| x.clamp(lo, hi))
}

/// _num(v, lo, hi, default) z catalog.py: zaokrąglone do 2 miejsc
pub fn num_in(v: Option<&Value>, lo: f64, hi: f64, default: Option<f64>) -> Option<f64> {
    match v.and_then(py_float) {
        Some(x) => Some(py_round(x.clamp(lo, hi), 2)),
        None => default,
    }
}

fn num_or(v: Option<&Value>, lo: f64, hi: f64, default: f64) -> f64 {
    num_in(v, lo, hi, Some(default)).unwrap_or(default)
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(x) if !truthy(x) => String::new(),
        Some(x) => x.to_string(),
    }
}

// ---------------------------------------------------------------- ustawienia wariantów (strona /variants)

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VariantEvent {
    pub id: String,
    pub start: i64,
    pub end: i64,
    /// pusta lista = wszystkie skrzynki
    pub crates: Vec<String>,
    pub boost: f64,
    pub note: String,
}

/// Ustawienia wariantu z panelu - None = jak w kodzie (data/game.json)
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VariantSettings {
    pub enabled: Option<bool>,
    /// wariant był już kiedyś włączony - nawet wyłączony zostaje w klaserze (gracze mogą mieć te karty)
    pub released: bool,
    pub chance: Option<f64>,
    pub weight: Option<i64>,
    pub mult: Option<f64>,
    /// wariant ekskluzywny: nie wypada z kontraktu, ulepszacza ani wygranych w kasynie
    pub no_house: bool,
    pub desc: Option<String>,
    pub events: Vec<VariantEvent>,
}

/// Wydarzenia wariantu: [{"id", "start", "end" (sekundy unix), "crates": [] = wszystkie, "boost", "note"}]
pub fn clean_variant_events(raw: Option<&Value>) -> Vec<VariantEvent> {
    let g = g();
    let mut out: Vec<VariantEvent> = Vec::new();
    for e in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(e) = e.as_object() else { continue };
        let id = str_of(e.get("id"));
        if !STICKER_ID_RE.is_match(&id) || out.iter().any(|x| x.id == id) {
            continue;
        }
        let (Some(start), Some(end)) = (int_in(e.get("start"), 0, 4_000_000_000), int_in(e.get("end"), 0, 4_000_000_000))
        else {
            continue;
        };
        if end <= start {
            continue;
        }
        let mut crates: Vec<String> = Vec::new();
        for c in e.get("crates").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !crates.iter().any(|x| x == c) {
                crates.push(c.to_owned());
            }
        }
        crates.truncate(100);
        out.push(VariantEvent {
            id,
            start,
            end,
            crates,
            boost: num_or(e.get("boost"), 1.0, g.variant_boost_max, 1.0),
            note: clean(&str_of(e.get("note")), 80),
        });
    }
    out.sort_by_key(|e| e.start);
    let skip = out.len().saturating_sub(g.variant_event_max);
    out.split_off(skip)
}

/// Ustawienia wariantu z panelu: {"enabled", "chance", "weight", "desc", "mult", "noHouse", "events"}
pub fn clean_variant_settings(v: &str, raw: &Value) -> VariantSettings {
    let g = g();
    let empty = Map::new();
    let raw = raw.as_object().unwrap_or(&empty);
    let x = g.variant(v);
    let enabled = raw.get("enabled").and_then(Value::as_bool);
    let mut out = VariantSettings {
        enabled,
        released: raw.get("released").is_some_and(truthy) || enabled == Some(true),
        no_house: raw.get("noHouse").is_some_and(truthy) && !x.special,
        desc: raw.get("desc").and_then(Value::as_str).map(|d| clean(d, 300)),
        events: if x.special { vec![] } else { clean_variant_events(raw.get("events")) },
        ..Default::default()
    };
    let given = |k: &str| raw.get(k).is_some_and(|v| !v.is_null());
    if given("chance") && !x.always && !x.special {
        out.chance = raw.get("chance").and_then(py_float).map(|c| c.clamp(0.0, g.variant_chance_max));
    }
    if given("weight") && x.always {
        out.weight = int_in(raw.get("weight"), 1, 10000);
    }
    if given("mult") && !x.special {
        out.mult = num_in(raw.get("mult"), 0.01, g.variant_mult_max, None);
    }
    out
}

// ---------------------------------------------------------------- naklejki (strona /stickers)

/// Naklejka wariantu: "src" = "upload" (plik od admina) albo grafika z biblioteki; x / y = środek w % karty,
/// w = szerokość w % karty, rot = obrót w stopniach, flip = odbicie, anim = ruch, v = wersja pliku
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Sticker {
    pub id: String,
    pub src: String,
    #[serde(flatten)]
    pub at: Placement,
    pub v: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub rot: f64,
    pub flip: bool,
    pub anim: String,
}

/// Zmiana standardowej naklejki na jednej karcie: nowe położenie albo ukrycie
#[derive(Debug, Clone, PartialEq)]
pub enum StickerEdit {
    Hidden,
    Moved(Placement),
}

impl Serialize for StickerEdit {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            StickerEdit::Hidden => json!({"hidden": true}).serialize(s),
            StickerEdit::Moved(p) => p.serialize(s),
        }
    }
}

/// Naklejki jednej karty ponad standardowe naklejki wariantu
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct CardStickers {
    pub edits: IndexMap<String, StickerEdit>,
    pub extra: Vec<Sticker>,
}

fn placement(s: &Map<String, Value>) -> Placement {
    let anim = s.get("anim").and_then(Value::as_str).filter(|a| g().sticker_anims.contains_key(*a)).unwrap_or("none");
    Placement {
        x: num_or(s.get("x"), -25.0, 125.0, 50.0),
        y: num_or(s.get("y"), -25.0, 125.0, 50.0),
        w: num_or(s.get("w"), 2.0, 160.0, 30.0),
        rot: num_or(s.get("rot"), -180.0, 180.0, 0.0),
        flip: s.get("flip").is_some_and(truthy),
        anim: anim.to_owned(),
    }
}

/// Naklejki wariantu w kolejności od spodu (najwyżej STICKER_MAX)
pub fn clean_stickers(raw: Option<&Value>) -> Vec<Sticker> {
    let g = g();
    let mut out: Vec<Sticker> = Vec::new();
    for s in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(s) = s.as_object() else { continue };
        let id = str_of(s.get("id"));
        if !STICKER_ID_RE.is_match(&id) || out.iter().any(|x| x.id == id) {
            continue;
        }
        let Some(src) = s.get("src").and_then(Value::as_str) else { continue };
        if src != "upload" && !g.sticker_library.contains_key(src) {
            continue;
        }
        out.push(Sticker {
            id,
            src: src.to_owned(),
            at: placement(s),
            v: int_in(s.get("v"), 0, 1_000_000_000).unwrap_or(0),
        });
    }
    out.truncate(g.sticker_max);
    out
}

/// "edits" - zmiany standardowych naklejek na tej karcie, "extra" - naklejki tylko tej karty. None = same standardowe.
pub fn clean_card_stickers(raw: &Value) -> Option<CardStickers> {
    let empty = Map::new();
    let raw = raw.as_object().unwrap_or(&empty);
    let mut edits = IndexMap::new();
    for (sid, e) in raw.get("edits").and_then(Value::as_object).into_iter().flatten() {
        let Some(e) = e.as_object() else { continue };
        if !STICKER_ID_RE.is_match(sid) {
            continue;
        }
        let edit = if e.get("hidden").is_some_and(truthy) { StickerEdit::Hidden } else { StickerEdit::Moved(placement(e)) };
        edits.insert(sid.clone(), edit);
    }
    let extra = clean_stickers(raw.get("extra"));
    (!edits.is_empty() || !extra.is_empty()).then_some(CardStickers { edits, extra })
}

// ---------------------------------------------------------------- warianty z kreatora (strona /designer)

pub const CV_FONTS: &[&str] = &[
    "Rubik",
    "Bungee",
    "Cinzel",
    "Orbitron",
    "Yellowtail",
    "Permanent Marker",
    "Black Ops One",
    "Monoton",
    "Creepster",
    "Special Elite",
    "Share Tech Mono",
    "Poiret One",
    "Racing Sans One",
    "Rye",
    "Shrikhand",
    "Caveat",
    "IM Fell English",
    "Press Start 2P",
    "Bangers",
];
pub const CV_FX: &[&str] = &["sheen", "sparkles", "rain", "snow", "bubbles", "hearts", "scanlines", "vignette", "grain", "glow"];

/// (grupa, pole) -> dozwolone wartości
pub fn cv_enums() -> IndexMap<(&'static str, &'static str), Vec<&'static str>> {
    IndexMap::from([
        (("frame", "anim"), vec!["none", "shimmer", "spin"]),
        (("bg", "pattern"), vec!["none", "dots", "stripes", "diagonal", "grid", "checker", "grain", "waves", "hearts", "stars"]),
        (("bg", "anim"), vec!["none", "drift", "pulse"]),
        (("photo", "filter"), vec!["none", "grayscale", "sepia", "invert", "duotone", "vivid", "faded"]),
        (("photo", "tintMode"), vec!["none", "color", "multiply", "screen", "overlay", "soft-light"]),
        (("photo", "shape"), vec!["rect", "rounded", "circle"]),
    ])
}

pub fn cv_default() -> Value {
    json!({
        "name": "Nowy wariant", "desc": "", "tag": "✨ NOWY", "chance": 0.005, "mult": 5.0,
        "frame": {"c1": "#6a4cff", "c2": "#ffffff", "c3": "#ff4fd8", "angle": 135, "anim": "shimmer", "glow": "#9b7bff"},
        "bg": {"c1": "#1a1430", "c2": "#3a2a6a", "angle": 160, "pattern": "dots", "pc": "#ffffff", "po": 0.15, "ps": 6, "anim": "none"},
        "photo": {"filter": "none", "hue": 0, "tint": "#9b7bff", "tintMode": "none", "tintOp": 0.4, "border": "#ffffff",
                  "bw": 0.15, "shape": "rect"},
        "text": {"font": "Rubik", "name1": "#ffffff", "name2": "#d6c8ff", "glow": "#9b7bff", "color": "#f2eeff",
                 "panel": "#000000", "panelOp": 0.35},
        "tagStyle": {"bg": "#2a1a5a", "color": "#ffffff", "border": "#9b7bff"},
        "fx": {"sheen": true, "color": "#ffffff"},
    })
}

/// Opcje kreatora dla przeglądarki (cvOptions w /api/config)
pub fn cv_options() -> Value {
    let enums: Map<String, Value> = cv_enums().into_iter().map(|((g, k), v)| (format!("{g}.{k}"), json!(v))).collect();
    json!({"fonts": CV_FONTS, "fx": CV_FX, "default": cv_default(), "enums": enums})
}

fn cv_color(v: Option<&Value>, dflt: &str) -> String {
    match v.and_then(Value::as_str) {
        Some(s) if CV_COLOR.is_match(s) => s.to_owned(),
        _ => dflt.to_owned(),
    }
}

/// float z granicami, bez zaokrąglenia (num() w clean_custom_variant)
fn cv_num(v: Option<&Value>, lo: f64, hi: f64, dflt: f64) -> f64 {
    v.and_then(py_float).map_or(dflt, |x| x.clamp(lo, hi))
}

/// Projekt wariantu z kreatora - tylko znane pola, kolory #rrggbb, liczby w granicach
pub fn clean_custom_variant(d: &Value) -> Value {
    let g = g();
    let empty = Map::new();
    let d = d.as_object().unwrap_or(&empty);
    let mut out = cv_default();
    let raw_name = str_of(d.get("name"));
    let name = clean(if raw_name.is_empty() { "Nowy wariant" } else { &raw_name }, 30);
    let name = if name.is_empty() { "Nowy wariant".to_owned() } else { name };
    out["desc"] = json!(clean(&str_of(d.get("desc")), 300));
    let tag = clean(&str_of(d.get("tag")), 20);
    out["tag"] = json!(if tag.is_empty() { name.chars().take(12).collect::<String>().to_uppercase() } else { tag });
    out["name"] = json!(name);
    let chance = cv_num(d.get("chance"), 0.0, g.variant_chance_max, 0.005);
    out["chance"] = json!(chance);
    out["mult"] = json!(py_round(cv_num(d.get("mult"), 1.1, 50.0, 5.0), 2));
    let enums = cv_enums();
    for group in ["frame", "bg", "photo", "text", "tagStyle"] {
        let src = d.get(group).and_then(Value::as_object).cloned().unwrap_or_default();
        let defaults = out[group].as_object().cloned().unwrap_or_default();
        for (k, dflt) in &defaults {
            let v = src.get(k).unwrap_or(dflt);
            let new = if let Some(allowed) = enums.get(&(group, k.as_str())) {
                if v.as_str().is_some_and(|s| allowed.contains(&s)) {
                    v.clone()
                } else {
                    dflt.clone()
                }
            } else if k == "font" {
                if v.as_str().is_some_and(|s| CV_FONTS.contains(&s)) {
                    v.clone()
                } else {
                    dflt.clone()
                }
            } else if let Some(ds) = dflt.as_str() {
                if ds.starts_with('#') || v.as_str() == Some("") {
                    json!(cv_color(Some(v), ds))
                } else {
                    dflt.clone()
                }
            } else {
                let (lo, hi) = match k.as_str() {
                    "angle" | "hue" => (0.0, 360.0),
                    "po" | "tintOp" | "panelOp" => (0.0, 1.0),
                    "ps" => (2.0, 30.0),
                    "bw" => (0.0, 0.5),
                    _ => (f64::MIN, f64::MAX),
                };
                json!(py_round(cv_num(Some(v), lo, hi, dflt.as_f64().unwrap_or(0.0)), 3))
            };
            out[group][k] = new;
        }
    }
    for group in ["frame", "text"] {
        if let Some(src) = d.get(group).and_then(Value::as_object) {
            out[group]["glow"] = json!(cv_color(src.get("glow"), ""));
        }
    }
    let fx = d.get("fx").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut fx_out = Map::new();
    for k in CV_FX {
        if fx.get(*k).is_some_and(truthy) {
            fx_out.insert((*k).into(), json!(true));
        }
    }
    fx_out.insert("color".into(), json!(cv_color(fx.get("color"), "#ffffff")));
    out["fx"] = Value::Object(fx_out);
    out
}

/// Klucz nowego wariantu z kreatora: cv_ + nazwa bez polskich znaków, unikalny
pub fn custom_variant_key(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    use unicode_normalization::UnicodeNormalization;
    let ascii: String = name.nfkd().filter(char::is_ascii).collect::<String>().to_lowercase();
    let slug = Regex::new(r"[^a-z0-9]+").unwrap().replace_all(&ascii, "_").trim_matches('_').chars().take(20).collect::<String>();
    let base = format!("{}{}", g().custom_prefix, if slug.is_empty() { "wariant" } else { slug.as_str() });
    let (mut key, mut n) = (base.clone(), 2);
    while taken(&key) {
        key = format!("{base}_{n}");
        n += 1;
    }
    key
}

// ---------------------------------------------------------------- wszystko z tabeli catalog_variants

/// Zmiany wariantów z panelu admina, już sprawdzone
#[derive(Debug, Clone, Default)]
pub struct VariantState {
    /// wariant -> ustawienia (strona /variants)
    pub cfg: HashMap<String, VariantSettings>,
    /// wariant -> standardowe naklejki
    pub stickers: HashMap<String, Vec<Sticker>>,
    /// wariant -> {karta: naklejki tej karty}
    pub sticker_cards: HashMap<String, IndexMap<String, CardStickers>>,
    /// klucz -> projekt z kreatora (kolejność jak w tabeli)
    pub custom: IndexMap<String, Value>,
}

/// Wiersz catalog_variants: (id, dane)
pub type VariantRow = (String, Map<String, Value>);

impl VariantState {
    /// Czy wariant w ogóle wypada (poza wydarzeniami): ustawienie admina, a bez niego - "off" w data/game.json
    pub fn enabled(&self, v: &str) -> bool {
        match self.cfg.get(v).and_then(|s| s.enabled) {
            Some(on) => on,
            None => !g().variant(v).off,
        }
    }

    pub fn events(&self, v: &str) -> &[VariantEvent] {
        self.cfg.get(v).map_or(&[], |s| s.events.as_slice())
    }

    /// Wariant zablokowany przez admina w kuźni i kasynie ("noHouse")
    pub fn no_house(&self, v: &str) -> bool {
        self.cfg.get(v).is_some_and(|s| s.no_house)
    }

    /// Projekty z kreatora (przed nałożeniem na warianty - ustawienia i naklejki niżej dotyczą też ich)
    pub fn custom_designs(rows: &[VariantRow]) -> IndexMap<String, Value> {
        let prefix = &g().custom_prefix;
        rows.iter()
            .filter(|(id, d)| id.starts_with(prefix.as_str()) && d.contains_key("custom"))
            .map(|(id, d)| (id.clone(), clean_custom_variant(&d["custom"])))
            .collect()
    }

    /// Ustawienia i naklejki - po zarejestrowaniu wariantów z kreatora (g() zna już ich klucze)
    pub fn read(rows: &[VariantRow], custom: IndexMap<String, Value>) -> VariantState {
        let g = g();
        let mut out = VariantState { custom, ..Default::default() };
        for (id, d) in rows {
            if g.variant_defaults.contains_key(id) {
                if let Some(s) = d.get("settings") {
                    out.cfg.insert(id.clone(), clean_variant_settings(id, s));
                }
            }
            if g.sticker_variants.contains(id) {
                out.stickers.insert(id.clone(), clean_stickers(d.get("stickers")));
                let cards: IndexMap<String, CardStickers> = d
                    .get("cards")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter_map(|(pid, own)| clean_card_stickers(own).map(|o| (pid.clone(), o)))
                    .collect();
                out.sticker_cards.insert(id.clone(), cards);
            }
        }
        out
    }

    /// Naklejki karty w tym wariancie: standardowe (ze zmianami tej karty, bez ukrytych) i nad nimi naklejki tej karty
    pub fn card_stickers(&self, variant: &str, pid: &str) -> Vec<Sticker> {
        let base = self.stickers.get(variant).cloned().unwrap_or_default();
        let Some(own) = self.sticker_cards.get(variant).and_then(|m| m.get(pid)) else { return base };
        let mut out: Vec<Sticker> = base
            .into_iter()
            .filter_map(|s| match own.edits.get(&s.id) {
                Some(StickerEdit::Hidden) => None,
                Some(StickerEdit::Moved(p)) => Some(Sticker { at: p.clone(), ..s }),
                None => Some(s),
            })
            .collect();
        out.extend(own.extra.iter().cloned());
        out
    }

    /// Id wgranych plików, których używają naklejki wariantu (standardowe i na pojedynczych kartach)
    pub fn sticker_uploads(&self, variant: &str) -> std::collections::HashSet<String> {
        let std_list = self.stickers.get(variant).into_iter().flatten();
        let cards = self.sticker_cards.get(variant).into_iter().flat_map(|m| m.values()).flat_map(|o| o.extra.iter());
        std_list.chain(cards).filter(|s| s.src == "upload").map(|s| s.id.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_events() {
        let s = clean_variant_settings(
            "gold",
            &json!({"enabled": false, "chance": "0.5", "mult": 2000, "desc": "  Złota ",
                    "events": [{"id": "abcdef01", "start": 10, "end": 20, "crates": ["pl", "pl", 3], "boost": 99},
                               {"id": "abcdef01", "start": 1, "end": 5}, {"id": "zle", "start": 1, "end": 5},
                               {"id": "abcdef02", "start": 30, "end": 20}]}),
        );
        assert_eq!(s.enabled, Some(false));
        assert!(!s.released);
        assert_eq!(s.chance, Some(g().variant_chance_max));
        assert_eq!(s.mult, Some(g().variant_mult_max));
        assert_eq!(s.desc.as_deref(), Some("Złota"));
        assert_eq!(s.events.len(), 1);
        assert_eq!(s.events[0].crates, vec!["pl"]);
        assert_eq!(s.events[0].boost, g().variant_boost_max);
    }

    #[test]
    fn stickers_and_designs() {
        let lib = g().sticker_library.keys().next().unwrap().clone();
        let st = clean_stickers(Some(&json!([
            {"id": "0000000a", "src": "upload", "x": 500, "anim": "spin"},
            {"id": "0000000b", "src": lib, "flip": 1},
            {"id": "0000000c", "src": "nieznana"}
        ])));
        assert_eq!(st.len(), 2);
        assert_eq!((st[0].at.x, st[0].at.anim.as_str()), (125.0, "spin"));
        assert!(st[1].at.flip);
        let own = clean_card_stickers(&json!({"edits": {"0000000a": {"hidden": true}}, "extra": []})).unwrap();
        let vs = VariantState {
            stickers: HashMap::from([("mlg".to_string(), st)]),
            sticker_cards: HashMap::from([("mlg".to_string(), IndexMap::from([("p".to_string(), own)]))]),
            ..Default::default()
        };
        assert_eq!(vs.card_stickers("mlg", "p").len(), 1);
        assert_eq!(vs.card_stickers("mlg", "q").len(), 2);
        let cv = clean_custom_variant(&json!({"name": "Żółta Łódź", "mult": 99, "frame": {"c1": "zly", "angle": 999},
                                              "fx": {"rain": 1}}));
        assert_eq!(cv["name"], "Żółta Łódź");
        assert_eq!(cv["tag"], "ŻÓŁTA ŁÓDŹ");
        assert_eq!(cv["mult"], 50.0);
        assert_eq!(cv["frame"]["c1"], "#6a4cff");
        assert_eq!(cv["frame"]["angle"], 360.0);
        assert_eq!(cv["fx"], json!({"rain": true, "color": "#ffffff"}));
        // jak w Pythonie: litery bez rozkładu NFKD (ł) znikają
        assert_eq!(custom_variant_key("Żółta Łódź!", &|k| k == "cv_zota_odz"), "cv_zota_odz_2");
    }
}
