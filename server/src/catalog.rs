//! Katalog kart i skrzynek.
//!
//! Domyślne dane pochodzą z data/game.json. Zmiany z panelu admina są zapisane w bazie
//! (tabele catalog_crates / catalog_cards, kolumna `data` = JSON) i nakładane na dane domyślne:
//!   - wiersz z deleted=1 ukrywa skrzynkę/kartę,
//!   - wiersz z danymi nadpisuje pola wbudowanej skrzynki/karty albo dodaje nową.
//!
//! Nakładanie odbywa się na mapach JSON (pole po polu), potem całość jest czytana do `RawCard` / `RawCrate`
//! i sprawdzana (`Person` / `Crate`). Karta może należeć do kilku skrzynek: `crates`, `crate` to skrzynka główna
//! (jej kod i numer są nadrukowane na karcie). Katalog jest w pamięci procesu (ArcSwap) - po zmianie w panelu
//! admina budowany od nowa, dlatego serwer działa jako jeden proces.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use serde_with::{serde_as, DefaultOnError, VecSkipError};

use crate::data::{base_game, card_value, combine_variant, g, set_game, CRATE_FIELDS};
use crate::db::Conn;
use crate::lenient::Num;
use crate::text::{clean, Truncate};
use crate::variants::{VariantEvent, VariantRow, VariantState};

pub const SUBTITLE_MAX: usize = 40; // podtytuł (krótki tekst na karcie)
pub const DESC_MAX: usize = 1000; // opis (obok karty w podglądzie)
static COUNTRY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z]{2}(-[a-z0-9]{1,3})?$").unwrap());

// ---------------------------------------------------------------- karta i skrzynka po sprawdzeniu

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Ability {
    pub name: String,
    pub kind: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArenaEffectCfg {
    pub id: String,
    pub value: i64,
    pub turns: i64,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArenaCfg {
    pub visual: String,
    pub cost: Option<i64>,
    pub target: Option<String>,
    pub effects: Vec<ArenaEffectCfg>,
}

/// Karta w katalogu
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub wiki: Option<(String, String)>,
    pub rarity: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub hp: i64,
    pub attack: Option<String>,
    pub dmg: i64,
    pub attack2: Option<String>,
    pub dmg2: i64,
    pub kind1: String,
    pub kind2: String,
    pub abilities: Vec<Ability>,
    pub arena: Vec<ArenaCfg>,
    #[serde(rename = "crate")]
    pub crate_: Option<String>,
    pub crates: Vec<String>,
    /// skrzynki, w których karta jest ekskluzywna: z nich nie trafia do kasyna, ulepszacza, kuźni ani wyścigów
    pub exclusive: Vec<String>,
    pub number: i64,
    pub value_mult: f64,
    pub country: String,
    pub forge: bool,
    pub source: Option<String>,
    pub fixed_variant: Option<String>,
    pub style: Option<i64>,
    pub subtitle: String,
    pub desc: String,
    /// własne napisy na karcie (CARD_TEXT_SLOTS) - niezależne od statystyk
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub texts: IndexMap<String, String>,
    /// easter egg: wypadnięcie tej karty pokazuje obrazek (nagłówek X-Bibi)
    #[serde(skip)]
    pub bibi: bool,
    #[serde(skip)]
    pub builtin: bool,
    #[serde(skip)]
    pub modified: bool,
}

impl Person {
    pub fn value(&self, variant: &str) -> i64 {
        card_value(&self.rarity, self.value_mult, variant)
    }

    /// Karta specjalna (rzadkość Specjalna): tylko z kasyna albo z linku, zawsze w jednym wariancie, nie znika z gry
    pub fn is_special(&self) -> bool {
        self.rarity == "special"
    }

    pub fn is_secret(&self) -> bool {
        self.rarity == "secret"
    }

    /// Jedyny wariant karty specjalnej
    pub fn fixed(&self) -> &str {
        self.fixed_variant.as_deref().unwrap_or("normal")
    }
}

/// Skrzynka w katalogu
#[derive(Debug, Clone)]
pub struct Crate {
    pub id: String,
    pub name: String,
    pub short: String,
    pub code: String,
    pub emoji: String,
    pub color1: String,
    pub color2: String,
    pub price: i64,
    pub desc: String,
    pub shop: bool,
    pub restricted: bool,
    pub special: bool,
    pub variants: Vec<String>,
    pub weights: IndexMap<String, f64>,
    pub auto_secret: bool,
    pub builtin: bool,
    pub modified: bool,
    /// karty w kolejności numerów (id)
    pub people: Vec<String>,
}

impl Crate {
    /// Szansa (waga) rzadkości w danej skrzynce - własna albo domyślna
    pub fn weight(&self, rarity: &str) -> f64 {
        self.weights.get(rarity).copied().unwrap_or_else(|| default_weight(rarity))
    }
}

pub fn default_weight(rarity: &str) -> f64 {
    g().rarities.get(rarity).map_or(0.0, |r| r.weight)
}

#[derive(Default)]
pub struct Catalog {
    pub crates: IndexMap<String, Crate>,
    pub people: IndexMap<String, Arc<Person>>,
    /// wbudowane, ukryte przez admina (do przywrócenia w panelu)
    pub hidden_crates: IndexMap<String, RawCrate>,
    pub hidden_cards: IndexMap<String, RawCard>,
    /// zmiany wariantów z panelu admina: ustawienia i wydarzenia, naklejki, projekty z kreatora
    pub vs: VariantState,
}

// ---------------------------------------------------------------- dane z panelu admina (przed sprawdzeniem)

#[serde_as]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RawAbility {
    #[serde_as(as = "DefaultOnError")]
    pub name: String,
    #[serde_as(as = "DefaultOnError")]
    pub kind: Option<String>,
    #[serde_as(as = "DefaultOnError<Num>")]
    pub value: i64,
}

#[serde_as]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawEffect {
    pub id: String,
    #[serde_as(as = "DefaultOnError<Num>")]
    pub value: i64,
    #[serde_as(as = "DefaultOnError<Option<Num>>")]
    pub turns: Option<i64>,
    #[serde_as(as = "DefaultOnError")]
    pub target: Option<String>,
}

#[serde_as]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawArenaCfg {
    #[serde_as(as = "DefaultOnError")]
    pub visual: Option<String>,
    /// liczba albo "auto" / "" / null = koszt z wartości zdolności
    #[serde_as(as = "DefaultOnError<Option<Num>>")]
    pub cost: Option<i64>,
    #[serde_as(as = "DefaultOnError")]
    pub target: Option<String>,
    #[serde_as(as = "DefaultOnError<VecSkipError<_>>")]
    pub effects: Vec<RawEffect>,
}

/// Karta z data/game.json z nałożonymi zmianami admina
#[serde_as]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawCard {
    #[serde_as(as = "DefaultOnError")]
    pub name: String,
    #[serde_as(as = "DefaultOnError")]
    pub wiki: Option<(String, String)>,
    #[serde_as(as = "DefaultOnError")]
    pub rarity: Option<String>,
    #[serde(rename = "type")]
    #[serde_as(as = "DefaultOnError")]
    pub type_: Option<String>,
    #[serde_as(as = "DefaultOnError<Num>")]
    pub hp: i64,
    #[serde_as(as = "DefaultOnError")]
    pub attack: Option<String>,
    #[serde_as(as = "DefaultOnError<Num>")]
    pub dmg: i64,
    #[serde_as(as = "DefaultOnError")]
    pub attack2: Option<String>,
    #[serde_as(as = "DefaultOnError<Num>")]
    pub dmg2: i64,
    #[serde_as(as = "DefaultOnError")]
    pub kind1: Option<String>,
    #[serde_as(as = "DefaultOnError")]
    pub kind2: Option<String>,
    #[serde_as(as = "DefaultOnError<VecSkipError<_>>")]
    pub abilities: Vec<RawAbility>,
    #[serde(skip_serializing)]
    #[serde_as(as = "DefaultOnError<Vec<DefaultOnError>>")]
    pub arena: Vec<RawArenaCfg>,
    #[serde(rename = "crate")]
    #[serde_as(as = "DefaultOnError")]
    pub crate_: Option<String>,
    #[serde_as(as = "DefaultOnError<VecSkipError<_>>")]
    pub crates: Vec<String>,
    #[serde_as(as = "DefaultOnError<VecSkipError<_>>")]
    pub exclusive: Vec<String>,
    #[serde_as(as = "DefaultOnError")]
    pub country: Option<String>,
    #[serde_as(as = "DefaultOnError")]
    pub subtitle: Option<String>,
    #[serde_as(as = "DefaultOnError")]
    pub desc: Option<String>,
    #[serde_as(as = "DefaultOnError")]
    pub source: Option<String>,
    #[serde_as(as = "DefaultOnError")]
    pub fixed_variant: Option<String>,
    #[serde_as(as = "DefaultOnError<Option<Num>>")]
    pub style: Option<i64>,
    #[serde_as(as = "DefaultOnError")]
    pub texts: Value,
    #[serde_as(as = "DefaultOnError")]
    pub bibi: Value,
    pub builtin: bool,
    pub modified: bool,
}

/// Skrzynka z data/game.json z nałożonymi zmianami admina
#[serde_as]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawCrate {
    #[serde_as(as = "DefaultOnError")]
    pub name: String,
    #[serde_as(as = "DefaultOnError")]
    pub short: String,
    #[serde_as(as = "DefaultOnError")]
    pub code: String,
    #[serde_as(as = "DefaultOnError")]
    pub emoji: String,
    #[serde_as(as = "DefaultOnError")]
    pub color1: String,
    #[serde_as(as = "DefaultOnError")]
    pub color2: String,
    #[serde_as(as = "DefaultOnError<Option<Num>>")]
    pub price: Option<i64>,
    #[serde_as(as = "DefaultOnError")]
    pub desc: String,
    #[serde_as(as = "DefaultOnError")]
    pub shop: Option<bool>,
    #[serde_as(as = "DefaultOnError")]
    pub restricted: Option<bool>,
    /// None = admin nie wybierał (domyślne warianty z DEFAULT_CRATE_VARIANTS)
    #[serde_as(as = "DefaultOnError<Option<VecSkipError<_>>>")]
    pub variants: Option<Vec<String>>,
    /// lista wariantów obejmuje wszystkie przypięte warianty (zapis po wprowadzeniu przypinania - startup::migrate_crate_variants)
    #[serde(rename = "variantsAll")]
    #[serde_as(as = "DefaultOnError")]
    pub variants_all: bool,
    #[serde_as(as = "DefaultOnError<IndexMap<_, DefaultOnError<Num>>>")]
    pub weights: IndexMap<String, f64>,
    pub builtin: bool,
    pub modified: bool,
}

fn raw<T: Default + serde::de::DeserializeOwned>(m: Map<String, Value>) -> T {
    serde_json::from_value(Value::Object(m)).unwrap_or_default()
}

// ---------------------------------------------------------------- sprawdzanie pól z panelu admina

/// Dodatkowe zdolności karty (najwyżej MAX_EXTRA_ABILITIES): bez pustych nazw, rodzaj off/def/heal/eco
pub fn clean_abilities(raw: &[RawAbility]) -> Vec<Ability> {
    let g = g();
    raw.iter()
        .filter_map(|a| {
            let name = clean(&a.name, 40);
            let kind = a.kind.as_deref().filter(|k| g.ability_kinds.get(*k).is_some()).unwrap_or("off");
            (!name.is_empty()).then(|| Ability { name, kind: kind.into(), value: a.value.clamp(0, 9999) })
        })
        .take(g.max_extra_abilities)
        .collect()
}

/// Własne napisy na karcie (CARD_TEXT_SLOTS): {miejsce: tekst}; puste pomijamy
pub fn clean_texts(raw: &Value) -> IndexMap<String, String> {
    let g = g();
    raw.as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| g.card_text_slots.contains_key(*k))
        .filter_map(|(k, v)| {
            let text = match v {
                Value::String(s) => clean(s, g.card_text_max),
                Value::Null | Value::Bool(false) => String::new(),
                other => clean(&other.to_string(), g.card_text_max),
            };
            (!text.is_empty()).then(|| (k.clone(), text))
        })
        .collect()
}

/// Kod kraju karty (do wariantu flagowego): "PL" -> "pl"; nieprawidłowy -> ""
pub fn clean_country(raw: &str) -> String {
    let code = raw.trim().to_lowercase().replace('_', "-");
    if COUNTRY_RE.is_match(&code) {
        code
    } else {
        String::new()
    }
}

/// Ustawienia zdolności w Arenie - po jednym na zdolność (1., 2., dodatkowe), w tej samej kolejności
pub fn clean_arena(raw: &[RawArenaCfg]) -> Vec<ArenaCfg> {
    let g = g();
    let valid = |v: &Option<String>, set: &Value| v.as_deref().filter(|x| set.get(*x).is_some()).map(str::to_owned);
    raw.iter()
        .take(2 + g.max_extra_abilities)
        .map(|cfg| ArenaCfg {
            visual: valid(&cfg.visual, &g.arena_visuals).unwrap_or_else(|| "hit".into()),
            cost: cfg.cost.map(|c| c.clamp(0, 10)),
            target: valid(&cfg.target, &g.arena_targets),
            effects: cfg
                .effects
                .iter()
                .take(g.max_ability_effects)
                .filter(|e| g.arena_effects.contains_key(&e.id))
                .map(|e| ArenaEffectCfg {
                    id: e.id.clone(),
                    value: e.value.clamp(0, 9999),
                    turns: e.turns.map_or(1, |t| t.clamp(1, 9)),
                    target: valid(&e.target, &g.arena_effect_targets).unwrap_or_else(|| "target".into()),
                })
                .collect(),
        })
        .collect()
}

// ---------------------------------------------------------------- dane wbudowane

/// Pola wbudowanej skrzynki (CRATE_FIELDS) albo None
pub fn builtin_crate(cid: &str) -> Option<Map<String, Value>> {
    let c = crate::data::base_game().crates.get(cid)?;
    Some(c.fields.iter().filter(|(k, _)| CRATE_FIELDS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Wbudowana karta (z "crate" i "crates") albo None
pub fn builtin_card(pid: &str) -> Option<Map<String, Value>> {
    let g = g();
    let (cid, p) = g
        .crates
        .iter()
        .find_map(|(cid, c)| c.people.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(pid)).map(|p| (cid, p)))?;
    let crates: Vec<&String> = std::iter::once(cid)
        .chain(g.crates.iter().filter(|(x, c)| *x != cid && c.shared.iter().any(|s| s == pid)).map(|(x, _)| x))
        .collect();
    let mut m = p.clone();
    m.insert("crate".into(), json!(cid));
    m.insert("crates".into(), json!(crates));
    Some(m)
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// Wiersz zmian admina: (id, dane, ukryty)
pub type OverrideRow = (String, Map<String, Value>, bool);

/// Odczyt zmian admina i złożenie katalogu
pub async fn load(c: &mut Conn) -> anyhow::Result<Catalog> {
    // bez ORDER BY - kolejność skrzynek w sklepie jak w wersji Python (kolejność w tabeli)
    let crate_rows = sqlx::query!("SELECT id, data, deleted FROM catalog_crates").fetch_all(&mut *c).await?;
    let card_rows = sqlx::query!("SELECT id, data, deleted FROM catalog_cards").fetch_all(&mut *c).await?;
    let parse = |data: &str| -> Map<String, Value> { serde_json::from_str(data).unwrap_or_default() };
    let crates: Vec<OverrideRow> = crate_rows.into_iter().map(|r| (r.id, parse(&r.data), r.deleted != 0)).collect();
    let cards: Vec<OverrideRow> = card_rows.into_iter().map(|r| (r.id, parse(&r.data), r.deleted != 0)).collect();
    let variant_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, data FROM catalog_variants WHERE deleted = 0").fetch_all(&mut *c).await?;
    let variants: Vec<VariantRow> = variant_rows.into_iter().map(|(id, d)| (id, parse(&d))).collect();
    Ok(build_with_variants(&crates, &cards, &variants))
}

/// Dane wbudowane + zmiany admina -> katalog (bez zmian wariantów)
#[cfg(test)]
pub fn build(crate_rows: &[OverrideRow], card_rows: &[OverrideRow]) -> Catalog {
    build_with_variants(crate_rows, card_rows, &[])
}

/// Dane wbudowane + zmiany admina -> katalog. Najpierw warianty: projekty z kreatora i ustawienia z /variants
/// trafiają do danych gry (data::set_game - jak rebuild w catalog.py), potem skrzynki i karty.
pub fn build_with_variants(crate_rows: &[OverrideRow], card_rows: &[OverrideRow], variant_rows: &[VariantRow]) -> Catalog {
    let custom = VariantState::custom_designs(variant_rows);
    set_game(base_game().with_catalog_variants(&custom, &Default::default()));
    let vs = VariantState::read(variant_rows, custom);
    set_game(base_game().with_catalog_variants(&vs.custom, &vs.cfg));
    let g = g();
    let (crates, hidden_crates) = merge_crates(crate_rows);
    let (people, hidden_cards) = merge_cards(card_rows);

    // ---- karty: pola sprawdzone
    let mut persons: IndexMap<String, Person> =
        people.into_iter().map(|(pid, p)| (pid.clone(), check_card(pid, p, &crates))).collect();

    // ---- skrzynki: lista kart (numery), cena, warianty, szanse
    let mut out_crates: IndexMap<String, Crate> = IndexMap::new();
    let mut final_ids: IndexSet<String> = IndexSet::new();
    for (cid, c) in crates {
        let mut members: Vec<&Person> = persons.values().filter(|p| p.crates.contains(&cid)).collect();
        members.sort_by(|a, b| g.rarity_idx(&b.rarity).cmp(&g.rarity_idx(&a.rarity)).then_with(|| a.name.cmp(&b.name)));
        let present: HashSet<String> = members.iter().map(|p| p.rarity.clone()).collect();
        let member_ids: Vec<String> = members.iter().map(|p| p.id.clone()).collect();
        final_ids.extend(member_ids.iter().cloned());
        let cr = check_crate(&cid, c, &present, member_ids, &vs);
        // numer karty na skrzynce głównej
        for (n, id) in cr.people.iter().enumerate() {
            if let Some(p) = persons.get_mut(id).filter(|p| p.crate_.as_deref() == Some(cid.as_str())) {
                p.number = n as i64 + 1;
            }
        }
        out_crates.insert(cid, cr);
    }

    // wartość karty rośnie z ceną NAJTAŃSZEJ skrzynki, w której można ją zdobyć; kuźnia i kasyno: tylko karty
    // ze skrzynek, które są teraz w sklepie
    let people = final_ids
        .into_iter()
        .filter_map(|id| {
            let mut p = persons.swap_remove(&id)?;
            let cheapest = p.crates.iter().map(|c| out_crates[c].price).min().unwrap_or(g.crate_price);
            p.value_mult = (cheapest as f64 / g.crate_price as f64).max(1.0);
            p.forge = p.crates.iter().any(|c| out_crates[c].shop && !p.exclusive.contains(c));
            Some((id, Arc::new(p)))
        })
        .collect();

    Catalog { crates: out_crates, people, hidden_crates, hidden_cards, vs }
}

/// Skrzynki: wbudowane + zmiany admina (szanse łączone z domyślnymi), ukryte osobno
fn merge_crates(rows: &[OverrideRow]) -> (IndexMap<String, RawCrate>, IndexMap<String, RawCrate>) {
    let g = g();
    let mut crates: IndexMap<String, Map<String, Value>> = IndexMap::new();
    for cid in g.crates.keys() {
        let mut m = Map::new();
        m.insert("shop".into(), json!(true));
        m.insert("restricted".into(), json!(false));
        m.insert("weights".into(), json!({}));
        m.extend(builtin_crate(cid).unwrap_or_default());
        m.insert("builtin".into(), json!(true));
        crates.insert(cid.clone(), m);
    }
    let mut hidden = IndexMap::new();
    for (cid, d, deleted) in rows {
        if *deleted {
            if let Some(c) = crates.shift_remove(cid) {
                hidden.insert(cid.clone(), raw(c));
            }
            continue;
        }
        match crates.get_mut(cid) {
            Some(cur) => {
                // szanse: zmiany admina + domyślne
                let mut weights = cur.get("weights").and_then(Value::as_object).cloned().unwrap_or_default();
                if let Some(w) = d.get("weights").and_then(Value::as_object) {
                    weights.extend(w.clone());
                }
                cur.extend(d.clone());
                cur.insert("weights".into(), Value::Object(weights));
                cur.insert("modified".into(), json!(true));
            }
            None => {
                let mut m = Map::new();
                m.insert("name".into(), json!(cid));
                m.insert("short".into(), json!(cid));
                m.insert("code".into(), json!(cid.truncate_chars(2).to_uppercase()));
                m.insert("emoji".into(), json!("📦"));
                m.insert("color1".into(), json!("#888888"));
                m.insert("color2".into(), json!("#333333"));
                m.extend(d.clone());
                m.insert("builtin".into(), json!(false));
                m.insert("modified".into(), json!(false));
                crates.insert(cid.clone(), m);
            }
        }
    }
    (crates.into_iter().map(|(k, v)| (k, raw(v))).collect(), hidden)
}

/// Karty: wbudowane + zmiany admina (lista skrzynek uzupełniana o skrzynki dodane później), ukryte osobno
fn merge_cards(rows: &[OverrideRow]) -> (IndexMap<String, RawCard>, IndexMap<String, RawCard>) {
    let g = g();
    let mut people: IndexMap<String, Map<String, Value>> = IndexMap::new();
    for (cid, c) in &g.crates {
        for p in &c.people {
            let mut pm = p.clone();
            pm.insert("crate".into(), json!(cid));
            pm.insert("crates".into(), json!([cid]));
            pm.insert("builtin".into(), json!(true));
            people.insert(p.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(), pm);
        }
    }
    for (cid, c) in &g.crates {
        for pid in &c.shared {
            if let Some(p) = people.get_mut(pid) {
                let mut list = string_list(p.get("crates"));
                if !list.contains(cid) {
                    list.push(cid.clone());
                    p.insert("crates".into(), json!(list));
                }
            }
        }
    }
    let mut hidden = IndexMap::new();
    for (pid, d, deleted) in rows {
        if *deleted {
            if let Some(p) = people.shift_remove(pid) {
                hidden.insert(pid.clone(), raw(p));
            }
            continue;
        }
        match people.get_mut(pid) {
            Some(cur) => {
                let old_crates = string_list(cur.get("crates"));
                cur.extend(d.clone());
                cur.insert("modified".into(), json!(true));
                if let Some(chosen) = d.get("crates") {
                    // skrzynki dodane w kodzie PO zapisaniu karty w panelu dopisujemy; skrzynki, które już istniały
                    // i admin je odznaczył ("crates_seen"), zostają odznaczone
                    let seen: HashSet<String> = match d.get("crates_seen").map(|v| string_list(Some(v))) {
                        Some(list) if !list.is_empty() => list.into_iter().collect(),
                        _ => g.crates.keys().filter(|c| !g.crates_added_later.contains(*c)).cloned().collect(),
                    };
                    let chosen = string_list(Some(chosen));
                    let added = old_crates.into_iter().filter(|c| !seen.contains(c) && !chosen.contains(c));
                    let list: Vec<String> = chosen.iter().cloned().chain(added).collect();
                    cur.insert("crates".into(), json!(list));
                } else if let Some(main) = d.get("crate").and_then(Value::as_str) {
                    // starszy zapis z jedną skrzynką - zachowaj pozostałe
                    let list: Vec<String> =
                        std::iter::once(main.to_owned()).chain(old_crates.into_iter().filter(|c| c != main)).collect();
                    cur.insert("crates".into(), json!(list));
                }
            }
            None => {
                let mut m = d.clone();
                m.insert("builtin".into(), json!(false));
                m.insert("modified".into(), json!(false));
                if !m.contains_key("crates") {
                    m.insert("crates".into(), json!([d.get("crate")]));
                }
                people.insert(pid.clone(), m);
            }
        }
    }
    (people.into_iter().map(|(k, v)| (k, raw(v))).collect(), hidden)
}

fn check_card(id: String, p: RawCard, crates: &IndexMap<String, RawCrate>) -> Person {
    let g = g();
    let rarity = p.rarity.filter(|r| g.rarities.contains_key(r)).unwrap_or_else(|| "green".into());
    let kind = |k: Option<String>| k.filter(|x| g.ability_kinds.get(x).is_some()).unwrap_or_else(|| "off".into());
    let attack2 = p.attack2.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned);
    let crates: Vec<String> =
        p.crates.into_iter().filter(|c| crates.contains_key(c)).collect::<IndexSet<_>>().into_iter().collect();
    // ekskluzywna w skrzynce - tajna i specjalna mają własne zasady
    let exclusive: Vec<String> = if rarity == "secret" || rarity == "special" {
        Vec::new()
    } else {
        p.exclusive.into_iter().filter(|c| crates.contains(c)).collect::<IndexSet<_>>().into_iter().collect()
    };
    // karta specjalna: skąd (kasyno / link), jedyny wariant i wygląd
    let (source, fixed_variant, style) = if rarity == "special" {
        let source = p.source.filter(|x| g.special_sources.contains_key(x)).unwrap_or_else(|| "casino".into());
        let fixed = p.fixed_variant.filter(|x| g.special_variants.contains(x)).unwrap_or_else(|| {
            if source == "link" {
                "jeans".into()
            } else {
                "joker".into()
            }
        });
        let styles = g.variants.get(&fixed).map_or(0, |v| v.styles.len()).max(1) as i64;
        let style = p.style.map_or(1, |s| s.clamp(1, styles));
        (Some(source), Some(fixed), Some(style))
    } else {
        (None, None, None)
    };
    Person {
        id,
        name: p.name,
        wiki: p.wiki,
        type_: p.type_.filter(|t| g.types.contains_key(t)).unwrap_or_else(|| "tv".into()),
        hp: p.hp,
        attack: p.attack,
        dmg: p.dmg,
        dmg2: if attack2.is_some() { p.dmg2 } else { 0 },
        kind2: if attack2.is_some() { kind(p.kind2) } else { "off".into() },
        attack2,
        kind1: kind(p.kind1),
        abilities: clean_abilities(&p.abilities),
        arena: clean_arena(&p.arena),
        crate_: crates.first().cloned(),
        crates,
        exclusive,
        rarity,
        number: 0,
        value_mult: 1.0,
        country: clean_country(p.country.as_deref().unwrap_or_default()),
        forge: false,
        source,
        fixed_variant,
        style,
        subtitle: clean(p.subtitle.as_deref().unwrap_or_default(), SUBTITLE_MAX),
        desc: clean(p.desc.as_deref().unwrap_or_default(), DESC_MAX),
        texts: clean_texts(&p.texts),
        bibi: crate::variants::truthy(&p.bibi),
        builtin: p.builtin,
        modified: p.modified,
    }
}

fn check_crate(cid: &str, c: RawCrate, present: &HashSet<String>, people: Vec<String>, vs: &VariantState) -> Crate {
    let g = g();
    // skrzynka kart specjalnych: nigdy w sklepie, nie da się jej kupić ani otworzyć
    let special = g.crates.get(cid).is_some_and(|b| b.special);
    // warianty przypięte do skrzynki; zapis sprzed przypinania (bez "variantsAll") - jak wtedy działała gra: wybrane
    // wyjątkowe (albo domyślne) + włączone zwykłe warianty, które wypadały ze wszystkich skrzynek (jak chosen_crate_variants)
    let mut chosen = c.variants.unwrap_or_else(|| g.default_crate_variants.get(cid).cloned().unwrap_or_default());
    if special {
        chosen.clear(); // skrzynki kart specjalnych nie da się otworzyć - bez wariantów
    } else if !c.variants_all {
        chosen.extend(g.crate_variants.iter().filter(|v| !g.variants[*v].exclusive && vs.enabled(v)).cloned());
    }
    let mut weights: IndexMap<String, f64> = c.weights.into_iter().filter(|(r, _)| g.rarities.contains_key(r)).collect();
    // tajna karta: zawsze 1 na SECRET_ODDS otwartych skrzynek (chyba że admin ustawi inaczej)
    let auto_secret = !weights.contains_key("secret");
    if auto_secret {
        let others: f64 =
            present.iter().filter(|r| *r != "secret").map(|r| weights.get(r).copied().unwrap_or_else(|| default_weight(r))).sum();
        weights.insert("secret".into(), if others != 0.0 { others / (g.secret_odds - 1) as f64 } else { 0.0 });
    }
    Crate {
        id: cid.to_owned(),
        name: c.name,
        short: c.short,
        code: c.code,
        emoji: if c.emoji.is_empty() { "📦".into() } else { c.emoji },
        color1: c.color1,
        color2: c.color2,
        price: c.price.filter(|p| *p != 0).unwrap_or(g.crate_price).max(1),
        desc: c.desc,
        shop: c.shop.unwrap_or(true) && !special,
        restricted: c.restricted.unwrap_or(false),
        special,
        variants: g.crate_variants.iter().filter(|v| chosen.contains(v)).cloned().collect(),
        weights,
        auto_secret,
        builtin: c.builtin,
        modified: c.modified,
        people,
    }
}

// ---------------------------------------------------------------- zapis zmian admina

/// Tabela zmian admina
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Crates,
    Cards,
}

async fn override_data(c: &mut Conn, table: Table, key: &str) -> sqlx::Result<Option<String>> {
    match table {
        Table::Crates => sqlx::query_scalar!("SELECT data FROM catalog_crates WHERE id = $1", key).fetch_optional(c).await,
        Table::Cards => sqlx::query_scalar!("SELECT data FROM catalog_cards WHERE id = $1", key).fetch_optional(c).await,
    }
}

/// Zapis zmienionych pól (pozostałe pola zapisu zostają)
pub async fn save_override(c: &mut Conn, table: Table, key: &str, fields: Map<String, Value>) -> sqlx::Result<()> {
    let mut current: Map<String, Value> =
        override_data(c, table, key).await?.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default();
    current.extend(fields);
    let data = Value::Object(current).to_string();
    match table {
        Table::Crates => {
            sqlx::query!(
                "INSERT INTO catalog_crates (id, data, deleted) VALUES ($1, $2, 0)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data, deleted = 0",
                key,
                data
            )
            .execute(c)
            .await?
        }
        Table::Cards => {
            sqlx::query!(
                "INSERT INTO catalog_cards (id, data, deleted) VALUES ($1, $2, 0)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data, deleted = 0",
                key,
                data
            )
            .execute(c)
            .await?
        }
    };
    Ok(())
}

pub async fn mark_deleted(c: &mut Conn, table: Table, key: &str) -> sqlx::Result<()> {
    match table {
        Table::Crates => {
            sqlx::query!(
                "INSERT INTO catalog_crates (id, data, deleted) VALUES ($1, '{}', 1) ON CONFLICT(id) DO UPDATE SET deleted = 1",
                key
            )
            .execute(c)
            .await?
        }
        Table::Cards => {
            sqlx::query!(
                "INSERT INTO catalog_cards (id, data, deleted) VALUES ($1, '{}', 1) ON CONFLICT(id) DO UPDATE SET deleted = 1",
                key
            )
            .execute(c)
            .await?
        }
    };
    Ok(())
}

pub async fn remove_row(c: &mut Conn, table: Table, key: &str) -> sqlx::Result<()> {
    match table {
        Table::Crates => sqlx::query!("DELETE FROM catalog_crates WHERE id = $1", key).execute(c).await?,
        Table::Cards => sqlx::query!("DELETE FROM catalog_cards WHERE id = $1", key).execute(c).await?,
    };
    Ok(())
}

// ---------------------------------------------------------------- pytania o katalog

impl Catalog {
    pub fn person(&self, pid: &str) -> Option<&Arc<Person>> {
        self.people.get(pid)
    }

    pub fn has(&self, pid: &str) -> bool {
        self.people.contains_key(pid)
    }

    pub fn crate_people<'a>(&'a self, c: &'a Crate) -> impl Iterator<Item = &'a Arc<Person>> + 'a {
        c.people.iter().filter_map(|id| self.people.get(id))
    }

    /// Warianty przypięte do tej skrzynki, które są (albo były) w grze (dla tej karty: flagowy tylko z ustawionym
    /// krajem, plus warianty przypisane do samej karty, np. Rzulty)
    pub fn crate_variants(&self, c: &Crate, person: Option<&Person>) -> Vec<String> {
        let mut out: Vec<String> = c
            .variants
            .iter()
            .filter(|v| (*v != "flag" || person.is_none_or(|p| !p.country.is_empty())) && self.variant_released(v))
            .filter(|v| g().variant(v).cards.is_empty() || person.is_some_and(|p| g().variant(v).cards.contains(&p.id)))
            .cloned()
            .collect();
        if let Some(p) = person {
            out.extend(g().card_variants(&p.id).into_iter().filter(|v| !g().variant(v).crate_only));
        }
        out
    }

    // ---- ustawienia wariantów (strona /variants): włączony, wydarzenia, ekskluzywny

    pub fn variant_enabled(&self, v: &str) -> bool {
        self.vs.enabled(v)
    }

    /// Trwające teraz wydarzenie wariantu w tej skrzynce (albo None)
    pub fn variant_event(&self, v: &str, crate_id: &str, now: f64) -> Option<&VariantEvent> {
        self.vs.events(v).iter().find(|e| {
            e.start as f64 <= now && now < e.end as f64 && (e.crates.is_empty() || e.crates.iter().any(|c| c == crate_id))
        })
    }

    /// Wariant był już w grze (karty mogą istnieć): bez "off", był kiedyś włączony albo jego wydarzenie już się zaczęło
    pub fn variant_released(&self, v: &str) -> bool {
        let now = crate::db::now();
        !g().variant(v).off
            || self.vs.cfg.get(v).is_some_and(|s| s.released)
            || self.vs.enabled(v)
            || self.vs.events(v).iter().any(|e| e.start as f64 <= now)
    }

    /// Wariant może być na tej karcie: warianty z "cards" tylko na swoich kartach, flagowy tylko z krajem,
    /// warianty kart specjalnych i połączenia nigdy (połączenia powstają z warstw)
    fn variant_fits(&self, v: &str, person: Option<&Person>) -> bool {
        let g = g();
        let x = g.variant(v);
        if v == "normal" || x.combo || x.special {
            return false;
        }
        if !x.cards.is_empty() && person.is_none_or(|p| !x.cards.contains(&p.id)) {
            return false;
        }
        v != "flag" || person.is_none_or(|p| !p.country.is_empty())
    }

    /// Warianty, które mogą TERAZ wypaść z tej skrzynki (dla tej karty) i mnożniki szansy z trwających wydarzeń.
    /// Wariant przypięty do skrzynki i włączony (warianty konkretnych kart - gdy włączone); wariant z trwającym
    /// wydarzeniem w tej skrzynce - zawsze.
    pub fn drop_variants(&self, c: &Crate, person: Option<&Person>) -> (Vec<String>, HashMap<String, f64>) {
        let g = g();
        let now = crate::db::now();
        let (mut avail, mut boost) = (Vec::new(), HashMap::new());
        for v in &g.variant_order {
            if !self.variant_fits(v, person) {
                continue;
            }
            if let Some(ev) = self.variant_event(v, &c.id, now) {
                if ev.boost != 1.0 {
                    boost.insert(v.clone(), ev.boost);
                }
            } else if !self.vs.enabled(v) || ((g.variants[v].cards.is_empty() || g.variants[v].crate_only) && !c.variants.contains(v)) {
                continue;
            }
            avail.push(v.clone());
        }
        (avail, boost)
    }

    /// Czy wariant może dać kuźnia (kontrakt, ulepszacz) i kasyno - w połączeniu warstw blokuje każda zablokowana warstwa
    pub fn variant_house_ok(&self, v: &str) -> bool {
        !v.split('+').any(|x| self.vs.no_house(x))
    }

    /// Warianty z kontraktu, cele ulepszacza i wygrane w kasynie: włączone, nie wyjątkowe, nie zablokowane przez admina
    pub fn base_variants(&self) -> Vec<String> {
        let g = g();
        g.variant_order
            .iter()
            .filter(|v| {
                self.variant_fits(v, None) && !g.variants[*v].exclusive && self.vs.enabled(v) && self.variant_house_ok(v)
            })
            .cloned()
            .collect()
    }

    /// Warianty tej karty (ekskluzywne dla niej), które dają też kuźnia i kasyno: włączone, bez ograniczenia do skrzynki,
    /// nie wyjątkowe, nie zablokowane przez admina
    pub fn house_extra(&self, p: &Person) -> Vec<String> {
        let g = g();
        g.card_variants(&p.id)
            .into_iter()
            .filter(|v| !g.variants[v].exclusive && !g.variants[v].crate_only && self.vs.enabled(v) && self.variant_house_ok(v))
            .collect()
    }

    /// Warianty, które trafiły na tę kartę dzięki wydarzeniom (już rozpoczętym) w jej skrzynkach
    pub fn event_variants(&self, p: &Person) -> HashSet<String> {
        let now = crate::db::now();
        self.vs
            .cfg
            .keys()
            .filter(|v| self.variant_fits(v, Some(p)))
            .filter(|v| {
                self.vs.events(v).iter().any(|e| {
                    e.start as f64 <= now && (e.crates.is_empty() || e.crates.iter().any(|c| p.crates.contains(c)))
                })
            })
            .cloned()
            .collect()
    }

    /// Ustawienia wariantu dla przeglądarki: włączony i wydarzenia (gracze: trwające i rozpoczęte, admini: wszystkie,
    /// z zapisanymi ustawieniami i wartościami z kodu)
    pub fn variant_cfg_json(&self, v: &str, admin: bool) -> Value {
        let now = crate::db::now();
        let mut events: Vec<&VariantEvent> = self.vs.events(v).iter().collect();
        if !admin {
            events.retain(|e| e.start as f64 <= now);
            let running: Vec<&VariantEvent> = events.iter().copied().filter(|e| e.end as f64 > now).collect();
            events = if running.is_empty() { events.last().copied().into_iter().collect() } else { running };
        }
        let mut out = json!({"enabled": self.vs.enabled(v), "released": self.variant_released(v), "events": events,
                             "noHouse": !self.variant_house_ok(v)});
        if admin {
            let g = g();
            let saved = match self.vs.cfg.get(v) {
                Some(s) => json!({"enabled": s.enabled, "chance": s.chance, "weight": s.weight, "desc": s.desc,
                                  "mult": s.mult, "noHouse": s.no_house, "cards": s.cards, "crateOnly": s.crate_only}),
                None => json!({"enabled": null, "chance": null, "weight": null, "desc": null, "mult": null, "noHouse": null,
                               "cards": [], "crateOnly": false}),
            };
            out["saved"] = saved;
            out["defaults"] = json!(g.variant_defaults.get(v));
            out["off"] = json!(g.variant(v).off);
        }
        out
    }

    /// Warianty, dla których ta karta może mieć własne zdjęcie: przypisane do karty (np. Rzulty JP2) i wyjątkowe
    /// warianty z polem "photo" (np. Halloweenowa), jeśli są włączone w którejś skrzynce karty
    pub fn photo_variants(&self, pid: &str) -> Vec<String> {
        let g = g();
        let mut out: IndexSet<String> = g.card_variants(pid).into_iter().collect();
        if let Some(p) = self.people.get(pid) {
            let from_crates = p.crates.iter().filter_map(|c| self.crates.get(c)).flat_map(|cr| cr.variants.iter());
            out.extend(from_crates.filter(|v| g.variants[*v].photo).cloned());
        }
        out.into_iter().collect()
    }

    /// Warianty, w których ta karta może istnieć: zwykłe zawsze, wyjątkowe tylko z jej skrzynek (flagowy - z krajem),
    /// własne warianty karty i połączenia warstw z każdym z nich (bez "noCombo"). Karta specjalna - tylko jej wariant.
    pub fn possible_variants(&self, p: &Person) -> Vec<String> {
        let g = g();
        if p.is_special() {
            return vec![p.fixed().to_owned()];
        }
        let mut extra: HashSet<String> = g.card_variants(&p.id).into_iter().collect();
        extra.extend(self.event_variants(p));
        for cr in p.crates.iter().filter_map(|c| self.crates.get(c)) {
            extra.extend(self.crate_variants(cr, Some(p)));
        }
        // zwykłe warianty - jeśli są (albo były) w grze: wyłączony od początku nie pojawia się w klaserze
        let base: Vec<&String> = g
            .variant_order
            .iter()
            .filter(|v| {
                let x = &g.variants[*v];
                !x.combo
                    && (*v == "normal" || extra.contains(*v) || (!x.exclusive && self.variant_released(v)))
            })
            .collect();
        let combos: HashSet<String> = base
            .iter()
            .filter(|l| g.variants[**l].layer && !g.variants[**l].no_combo)
            .flat_map(|layer| {
                base.iter().filter(|b| **b != "normal" && !g.variants[**b].layer).map(move |b| combine_variant(layer, b))
            })
            .collect();
        g.variant_order.iter().filter(|v| base.contains(v) || combos.contains(*v)).cloned().collect()
    }

    /// Rzadkość wyniku kontraktu: następna, która ma karty w sklepie (pusta rzadkość jest pomijana)
    pub fn next_rarity(&self, rarity: &str) -> Option<String> {
        let g = g();
        let present: HashSet<&str> = self.people.values().filter(|p| p.forge).map(|p| p.rarity.as_str()).collect();
        let start = g.rarity_order.iter().position(|r| r == rarity)? + 1;
        g.rarity_order[start..].iter().find(|r| present.contains(r.as_str()) && *r != "secret").cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog() {
        let cat = build(&[], &[]);
        let jp2 = cat.person("pl_secret").unwrap();
        assert_eq!(jp2.crates, vec!["pl", "prl"]);
        assert_eq!(jp2.number, 1);
        assert_eq!(jp2.value_mult, 1.0);
        assert!(cat.possible_variants(jp2).contains(&"rzulty".to_string()));
        let tusk = cat.person("pl_tusk").unwrap();
        assert!(tusk.crates.contains(&"halloween".to_string()));
        let pv = cat.possible_variants(tusk);
        assert!(pv.contains(&"halloween+gold".to_string()) && pv.contains(&"devil".to_string()));
        assert!(!pv.contains(&"devil+gold".to_string()));
        assert!(!cat.crates["specjalne"].shop);
        assert_eq!(cat.next_rarity("green").as_deref(), Some("blue"));
    }

    #[test]
    fn admin_overrides() {
        let crate_data: Map<String, Value> =
            serde_json::from_str(r#"{"name": "Nowa", "price": "300", "weights": {"green": "40", "blue": 10}}"#).unwrap();
        let card_data: Map<String, Value> = serde_json::from_str(
            r#"{"name": "Testowa", "crates": ["nowa"], "rarity": "blue", "type": "tv", "hp": "80", "dmg": 20,
                "abilities": [{"name": "Cios", "kind": "def", "value": "50"}, "zle", {"name": ""}],
                "arena": [{"visual": "fire", "cost": "auto", "effects": [{"id": "burn", "value": 5, "turns": 99}]}, 7],
                "country": "PL"}"#,
        )
        .unwrap();
        let hide: Map<String, Value> = Map::new();
        let cat = build(
            &[("nowa".into(), crate_data, false)],
            &[("nowa_testowa".into(), card_data, false), ("pl_zenek".into(), hide, true)],
        );
        let cr = &cat.crates["nowa"];
        assert_eq!((cr.price, cr.weights["green"], cr.weights["blue"]), (300, 40.0, 10.0));
        assert!(cr.auto_secret && cr.weights["secret"] > 0.0);
        let p = cat.person("nowa_testowa").unwrap();
        assert_eq!((p.hp, p.value_mult, p.country.as_str()), (80, 3.0, "pl"));
        assert_eq!(p.abilities, vec![Ability { name: "Cios".into(), kind: "def".into(), value: 50 }]);
        assert_eq!(p.arena.len(), 2);
        assert_eq!((p.arena[0].visual.as_str(), p.arena[0].cost, p.arena[0].effects[0].turns), ("fire", None, 9));
        assert_eq!(p.arena[1].visual, "hit");
        assert!(!cat.has("pl_zenek") && cat.hidden_cards.contains_key("pl_zenek"));
    }
}
