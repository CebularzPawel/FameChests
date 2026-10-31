//! Dane gry z `data/game.json` (przeniesione z data.py) + wartości wyliczane tak samo jak w data.py:
//! połączenia wariantów warstwowych ("flag+gold"), VARIANT_ORDER, szansa tajnej karty, słabości typów, drugie ataki.
//! Zmiany ustawień gry (ceny, szanse, lista zmian PATCH_NOTES...) - w `data/game.json`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use arc_swap::ArcSwap;
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Dane z data/game.json (warianty bez zmian z panelu admina)
static BASE: LazyLock<GameData> =
    LazyLock::new(|| GameData::from_json(include_str!("../data/game.json")).expect("data/game.json: nieprawidłowe dane gry"));
/// Dane gry z nałożonymi zmianami wariantów z panelu admina (catalog::load podmienia je razem z katalogiem)
static CURRENT: LazyLock<ArcSwap<GameData>> = LazyLock::new(|| ArcSwap::from_pointee(BASE.clone()));

/// Skrót: `g.variants`, `g.rarities`... (migawka - zmiany z panelu admina widać w następnym wywołaniu)
pub fn g() -> Arc<GameData> {
    CURRENT.load_full()
}

/// Dane z data/game.json, bez zmian z panelu admina
pub fn base_game() -> &'static GameData {
    &BASE
}

/// Nowe dane gry (po zmianie wariantów w panelu admina)
pub fn set_game(gd: GameData) {
    CURRENT.store(Arc::new(gd));
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VariantDef {
    pub name: String,
    pub desc: String,
    /// naklejki od admina (strona /stickers): true albo "under" (pod zdjęciem)
    pub stickers: Value,
    /// wariant z kreatora (/designer)
    pub custom: bool,
    pub chance: f64,
    pub mult: f64,
    pub exclusive: bool,
    pub layer: bool,
    pub extra_chance: f64,
    pub always: bool,
    pub weight: Option<f64>,
    pub photo: bool,
    pub photo_fallback: Option<String>,
    pub no_combo: bool,
    pub cards: Vec<String>,
    /// wariant kart "cards" tylko ze skrzynek, do których jest przypięty
    pub crate_only: bool,
    pub special: bool,
    pub combo: bool,
    pub layers: Vec<String>,
    pub styles: Vec<String>,
    /// domyślnie wyłączony (nie wypada, nie jest celem ulepszacza)
    pub off: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RarityDef {
    pub name: String,
    pub weight: f64,
    pub value: i64,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoneyChest {
    pub name: String,
    pub emoji: String,
    pub min: i64,
    pub max: i64,
    pub curve: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCfg {
    pub fee: f64,
    pub max_price: i64,
    pub max_listings: i64,
    pub max_wanted: i64,
    pub auction_hours: Vec<i64>,
    pub snipe_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouletteCfg {
    pub max_cards: usize,
    pub max_payout_cards: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouletteBet {
    pub numbers: Vec<i64>,
    pub pays: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlackjackCfg {
    pub max_cards: usize,
    pub decks: usize,
    pub blackjack_pays: f64,
}

/// Symbol jednorękiego bandyty: waga losowania i mnożnik za trzy jednakowe
#[derive(Debug, Clone, Deserialize)]
pub struct SlotSymbol {
    pub id: String,
    pub weight: f64,
    pub pays: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotsCfg {
    pub max_cards: usize,
    /// symbol, którego dokładnie dwa dają wygraną "pair_pays"
    pub pair: String,
    pub pair_pays: i64,
    pub symbols: Vec<SlotSymbol>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JackpotCfg {
    pub max_cards: usize,
    pub expire_hours: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CasinoSpecial {
    pub per: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRules {
    pub deck_size: usize,
    pub board_slots: usize,
    pub actions: i64,
    pub max_coins: i64,
    pub card_cost: HashMap<String, i64>,
    pub ability_cost: Vec<(i64, i64)>,
    pub reward_wins: Vec<i64>,
    pub reward_chest: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct ArenaEffect {
    pub name: String,
    pub icon: String,
    pub unique: bool,
}

#[derive(Clone)]
pub struct TypeDef {
    pub weak: Option<String>,
    pub resist: Option<String>,
}

/// Wartości wariantu z kodu, do których wraca "Przywróć domyślne" na stronie /variants
#[derive(Debug, Clone, serde::Serialize)]
pub struct VariantDefault {
    pub chance: f64,
    pub weight: Option<f64>,
    pub desc: String,
    pub mult: f64,
}

/// Koń w wyścigach (ustawienia z kodu; nazwę i mnożnik zmienia admin - tabela horse_settings)
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct HorseDef {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub speed: f64,
    pub pitch: f64,
    pub pays: f64,
}

#[derive(Clone)]
pub struct GameData {
    pub starting_balance: i64,
    pub crate_price: i64,
    pub max_open: i64,
    pub variants: IndexMap<String, VariantDef>,
    pub variants_json: Value,
    pub variant_order: Vec<String>,
    pub crate_variants: Vec<String>,
    pub special_variants: Vec<String>,
    pub casino_variants: Vec<String>,
    /// warianty z naklejkami od admina (strona /stickers)
    pub sticker_variants: Vec<String>,
    /// wartości wariantów z kodu (bez połączeń; także warianty z kreatora)
    pub variant_defaults: IndexMap<String, VariantDefault>,
    /// warianty z data/game.json (bez połączeń) - podstawa dla with_catalog_variants
    base_variants_raw: IndexMap<String, Map<String, Value>>,
    pub variant_mult_max: f64,
    pub variant_event_max: usize,
    pub variant_boost_max: f64,
    pub variant_chance_max: f64,
    pub sticker_library: IndexMap<String, String>,
    pub sticker_anims: IndexMap<String, String>,
    pub sticker_max: usize,
    pub custom_prefix: String,
    pub custom_variant_max: usize,
    pub ufo_visit_chance: f64,
    pub easter_egg_chance: f64,
    pub card_text_slots: IndexMap<String, String>,
    pub card_text_max: usize,
    pub horse_race: Value,
    pub horse_items: Value,
    pub horses: Vec<HorseDef>,
    /// osiągnięcia wbudowane (wpisywane raz do tabeli achievements)
    pub achievements: Vec<Value>,
    pub default_crate_variants: HashMap<String, Vec<String>>,
    pub crates_added_later: HashSet<String>,
    pub contract_size: IndexMap<String, usize>,
    pub contract_size_json: Value,
    pub contract_variant_bonus: f64,
    pub upgrade_edge: f64,
    pub upgrade_max: f64,
    pub upgrade_max_items: usize,
    /// mnożniki wkładu do wyboru w ulepszaczu "w ciemno"
    pub upgrade_mults: Vec<f64>,
    /// warianty usunięte z gry - karty graczy w nich zamieniamy przy starcie (startup::drop_removed_variants)
    pub removed_variants: Vec<String>,
    pub max_deposit: i64,
    pub money_chests: IndexMap<String, MoneyChest>,
    pub money_chests_json: Value,
    pub daily_streak: i64,
    pub showcase_size: usize,
    pub rarities: IndexMap<String, RarityDef>,
    pub rarities_json: Value,
    pub rarity_order: Vec<String>,
    pub secret_odds: i64,
    pub types: IndexMap<String, TypeDef>,
    pub types_json: Value,
    pub ability_kinds: Value,
    pub max_extra_abilities: usize,
    /// wbudowane skrzynki: pola skrzynki (bez "people") + lista kart (słowniki jak P() w data.py)
    pub crates: IndexMap<String, BuiltinCrate>,
    pub special_crate: String,
    pub special_sources: IndexMap<String, String>,
    pub special_sources_json: Value,
    pub casino_special: CasinoSpecial,
    pub casino_special_json: Value,
    pub arena: ArenaRules,
    pub arena_json: Value,
    pub arena_effects: IndexMap<String, ArenaEffect>,
    pub arena_effects_json: Value,
    pub arena_targets: Value,
    pub arena_effect_targets: Value,
    pub arena_visuals: Value,
    pub max_ability_effects: usize,
    pub market: MarketCfg,
    pub market_json: Value,
    pub roulette: RouletteCfg,
    pub roulette_json: Value,
    pub casino_top: f64,
    pub roulette_bets: IndexMap<String, RouletteBet>,
    pub blackjack: BlackjackCfg,
    pub blackjack_json: Value,
    pub slots: SlotsCfg,
    pub slots_json: Value,
    pub jackpot: JackpotCfg,
    pub jackpot_json: Value,
    pub patch_notes: Vec<Value>,
}

#[derive(Clone)]
pub struct BuiltinCrate {
    pub fields: Map<String, Value>,
    pub people: Vec<Map<String, Value>>,
    pub shared: Vec<String>,
    pub special: bool,
}

pub const CRATE_FIELDS: &[&str] =
    &["name", "short", "code", "emoji", "color1", "color2", "price", "desc", "shop", "restricted", "weights", "variants"];

/// round(x, nd) z Pythona (zaokrąglenie dokładnej wartości dziesiętnej)
pub fn py_round(x: f64, nd: usize) -> f64 {
    format!("{x:.nd$}").parse().unwrap_or(x)
}

fn get<T: serde::de::DeserializeOwned>(raw: &Value, key: &str) -> anyhow::Result<T> {
    serde_json::from_value(raw.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| anyhow::anyhow!("game.json: pole {key}: {e}"))
}

impl GameData {
    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        let raw: Value = serde_json::from_str(text)?;

        // ---- warianty + połączenia warstw ("flag+gold") - VariantTables::build
        let variants_raw: IndexMap<String, Map<String, Value>> = get(&raw, "variants")?;
        let vt = VariantTables::build(&variants_raw, &IndexMap::new())?;

        // ---- rzadkości: tajna = 1 na SECRET_ODDS skrzynek
        let secret_odds: i64 = get(&raw, "secretOdds")?;
        let mut rarities_raw: IndexMap<String, Map<String, Value>> = get(&raw, "rarities")?;
        let others: f64 =
            rarities_raw.iter().filter(|(k, _)| *k != "secret").map(|(_, r)| r["weight"].as_f64().unwrap_or(0.0)).sum();
        if let Some(s) = rarities_raw.get_mut("secret") {
            s.insert("weight".into(), json!(others / (secret_odds - 1) as f64));
        }
        let rarities: IndexMap<String, RarityDef> = rarities_raw
            .iter()
            .map(|(k, v)| Ok((k.clone(), serde_json::from_value(Value::Object(v.clone()))?)))
            .collect::<anyhow::Result<_>>()?;
        let rarities_json = Value::Object(rarities_raw.iter().map(|(k, v)| (k.clone(), Value::Object(v.clone()))).collect());
        let rarity_order = rarities.keys().cloned().collect();

        // ---- typy: słabość / odporność z MATCHUPS
        let mut types_raw: IndexMap<String, Map<String, Value>> = get(&raw, "types")?;
        let matchups: IndexMap<String, (String, String)> = get(&raw, "matchups")?;
        for (t, (weak, res)) in &matchups {
            if let Some(x) = types_raw.get_mut(t) {
                x.insert("weak".into(), json!(weak));
                x.insert("resist".into(), json!(res));
            }
        }
        let types = types_raw
            .iter()
            .map(|(k, v)| {
                let s = |f: &str| v.get(f).and_then(Value::as_str).map(str::to_owned);
                (k.clone(), TypeDef { weak: s("weak"), resist: s("resist") })
            })
            .collect();
        let types_json = Value::Object(types_raw.iter().map(|(k, v)| (k.clone(), Value::Object(v.clone()))).collect());

        // ---- skrzynki i karty (drugie ataki z SECOND_ATTACKS)
        let second: HashMap<String, (String, i64)> = get(&raw, "secondAttacks")?;
        let crates_raw: IndexMap<String, Map<String, Value>> = get(&raw, "crates")?;
        let mut crates = IndexMap::new();
        for (cid, c) in crates_raw {
            let mut people: Vec<Map<String, Value>> = serde_json::from_value(c.get("people").cloned().unwrap_or(json!([])))?;
            for p in &mut people {
                let id = p.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                if let Some((name, dmg)) = second.get(&id) {
                    p.insert("attack2".into(), json!(name));
                    p.insert("dmg2".into(), json!(dmg));
                }
            }
            let shared = serde_json::from_value(c.get("shared").cloned().unwrap_or(json!([])))?;
            let special = c.get("special").and_then(Value::as_bool).unwrap_or(false);
            let fields = c.into_iter().filter(|(k, _)| k != "people" && k != "shared").collect();
            crates.insert(cid, BuiltinCrate { fields, people, shared, special });
        }

        let contract_size: IndexMap<String, usize> = get(&raw, "contractSize")?;
        let money_chests: IndexMap<String, MoneyChest> = get(&raw, "moneyChests")?;
        let special_sources: IndexMap<String, String> = get(&raw, "specialSources")?;
        let arena_effects: IndexMap<String, ArenaEffect> = get(&raw, "arenaEffects")?;
        let crates_added_later: Vec<String> = get(&raw, "cratesAddedLater")?;
        let v = |k: &str| raw.get(k).cloned().unwrap_or(Value::Null);

        Ok(GameData {
            starting_balance: get(&raw, "startingBalance")?,
            crate_price: get(&raw, "cratePrice")?,
            max_open: get(&raw, "maxOpen")?,
            variants: vt.variants,
            variants_json: vt.variants_json,
            variant_order: vt.variant_order,
            crate_variants: vt.crate_variants,
            special_variants: vt.special_variants,
            casino_variants: vt.casino_variants,
            sticker_variants: vt.sticker_variants,
            variant_defaults: vt.variant_defaults,
            base_variants_raw: variants_raw,
            variant_mult_max: get(&raw, "variantMultMax")?,
            variant_event_max: get(&raw, "variantEventMax")?,
            variant_boost_max: get(&raw, "variantBoostMax")?,
            variant_chance_max: get(&raw, "variantChanceMax")?,
            sticker_library: get(&raw, "stickerLibrary")?,
            sticker_anims: get(&raw, "stickerAnims")?,
            sticker_max: get(&raw, "stickerMax")?,
            custom_prefix: get(&raw, "customPrefix")?,
            custom_variant_max: get(&raw, "customVariantMax")?,
            ufo_visit_chance: raw["ufoVisit"]["chance"].as_f64().unwrap_or(0.0),
            easter_egg_chance: raw["easterEgg"]["chance"].as_f64().unwrap_or(0.0),
            card_text_slots: get(&raw, "cardTextSlots")?,
            card_text_max: get(&raw, "cardTextMax")?,
            horse_race: v("horseRace"),
            horse_items: v("horseItems"),
            horses: get(&raw, "horses")?,
            achievements: get(&raw, "achievements")?,
            default_crate_variants: get(&raw, "defaultCrateVariants")?,
            crates_added_later: crates_added_later.into_iter().collect(),
            contract_size,
            contract_size_json: v("contractSize"),
            contract_variant_bonus: get(&raw, "contractVariantBonus")?,
            upgrade_edge: get(&raw, "upgradeEdge")?,
            upgrade_max: get(&raw, "upgradeMax")?,
            upgrade_max_items: get(&raw, "upgradeMaxItems")?,
            upgrade_mults: get(&raw, "upgradeMults")?,
            removed_variants: get(&raw, "removedVariants")?,
            max_deposit: get(&raw, "maxDeposit")?,
            money_chests,
            money_chests_json: v("moneyChests"),
            daily_streak: get(&raw, "dailyStreak")?,
            showcase_size: get(&raw, "showcaseSize")?,
            rarities,
            rarities_json,
            rarity_order,
            secret_odds,
            types,
            types_json,
            ability_kinds: v("abilityKinds"),
            max_extra_abilities: get(&raw, "maxExtraAbilities")?,
            crates,
            special_crate: get(&raw, "specialCrate")?,
            special_sources,
            special_sources_json: v("specialSources"),
            casino_special: get(&raw, "casinoSpecial")?,
            casino_special_json: v("casinoSpecial"),
            arena: get(&raw, "arena")?,
            arena_json: v("arena"),
            arena_effects,
            arena_effects_json: v("arenaEffects"),
            arena_targets: v("arenaTargets"),
            arena_effect_targets: v("arenaEffectTargets"),
            arena_visuals: v("arenaVisuals"),
            max_ability_effects: get(&raw, "maxAbilityEffects")?,
            market: get(&raw, "market")?,
            market_json: v("market"),
            roulette: get(&raw, "roulette")?,
            roulette_json: {
                // dict(ROULETTE, wheel=..., red=..., bets=...) - jak w /api/config
                let mut m = raw["roulette"].as_object().cloned().unwrap_or_default();
                m.insert("wheel".into(), v("rouletteWheel"));
                m.insert("red".into(), v("rouletteRed"));
                m.insert("bets".into(), v("rouletteBets"));
                Value::Object(m)
            },
            casino_top: get(&raw, "casinoTop")?,
            roulette_bets: get(&raw, "rouletteBets")?,
            blackjack: get(&raw, "blackjack")?,
            blackjack_json: v("blackjack"),
            slots: get(&raw, "slots")?,
            slots_json: v("slots"),
            jackpot: get(&raw, "jackpot")?,
            jackpot_json: v("jackpot"),
            patch_notes: get(&raw, "patchNotes")?,
        })
    }

    /// Warianty z nałożonymi zmianami z panelu admina: projekty z kreatora (custom: klucz -> projekt) i ustawienia
    /// ze strony /variants (szansa / waga / opis / mnożnik; połączenia warstw przeliczane jako iloczyn) - jak
    /// register_custom_variants + rebuild w wersji Python
    pub fn with_catalog_variants(
        &self,
        custom: &IndexMap<String, Value>,
        cfg: &HashMap<String, crate::variants::VariantSettings>,
    ) -> GameData {
        let mut raw = self.base_variants_raw.clone();
        let mut custom_raw: IndexMap<String, Map<String, Value>> = IndexMap::new();
        for (k, d) in custom {
            let m = json!({"name": d["name"], "chance": d["chance"], "mult": d["mult"], "off": true, "custom": true,
                           "stickers": true, "desc": d["desc"]});
            custom_raw.insert(k.clone(), m.as_object().cloned().unwrap_or_default());
        }
        let mut gd = self.clone();
        // wartości z kodu: wbudowane z data/game.json, z kreatora - z projektu
        let defaults = match VariantTables::build(&raw, &custom_raw) {
            Ok(vt) => vt.variant_defaults,
            Err(_) => self.variant_defaults.clone(),
        };
        for (k, x) in raw.iter_mut().chain(custom_raw.iter_mut()) {
            // opis zawsze jest (także pusty), ustawienia z panelu nadpisują wartości z kodu
            if !x.contains_key("desc") {
                x.insert("desc".into(), json!(""));
            }
            if let Some(s) = cfg.get(k) {
                if let Some(c) = s.chance {
                    x.insert("chance".into(), json!(c));
                }
                if let Some(w) = s.weight {
                    x.insert("weight".into(), json!(w));
                }
                if let Some(d) = &s.desc {
                    x.insert("desc".into(), json!(d));
                }
                if let Some(m) = s.mult {
                    x.insert("mult".into(), json!(m));
                }
                if !s.cards.is_empty() {
                    x.insert("cards".into(), json!(s.cards));
                    x.insert("crateOnly".into(), json!(s.crate_only));
                }
            }
        }
        match VariantTables::build(&raw, &custom_raw) {
            Ok(vt) => {
                gd.variants = vt.variants;
                gd.variants_json = vt.variants_json;
                gd.variant_order = vt.variant_order;
                gd.crate_variants = vt.crate_variants;
                gd.special_variants = vt.special_variants;
                gd.casino_variants = vt.casino_variants;
                gd.sticker_variants = vt.sticker_variants;
                gd.variant_defaults = defaults;
            }
            Err(e) => tracing::error!("warianty z panelu admina: {e:#}"),
        }
        gd
    }

    pub fn variant(&self, v: &str) -> &VariantDef {
        self.variants.get(v).unwrap_or(&self.variants["normal"])
    }

    pub fn is_variant(&self, v: &str) -> bool {
        self.variants.contains_key(v)
    }

    pub fn rarity_idx(&self, r: &str) -> usize {
        self.rarity_order.iter().position(|x| x == r).unwrap_or(0)
    }

    pub fn variant_idx(&self, v: &str) -> usize {
        self.variant_order.iter().position(|x| x == v).unwrap_or(0)
    }

    /// Najnowsza wersja listy zmian (PATCH_NOTES[0]["v"])
    pub fn patch_version(&self) -> i64 {
        self.patch_notes.first().and_then(|n| n["v"].as_i64()).unwrap_or(0)
    }

    /// Warianty przypisane tylko do tej karty (np. Rzulty dla Jana Pawła II)
    pub fn card_variants(&self, pid: &str) -> Vec<String> {
        self.variants.iter().filter(|(_, x)| x.cards.iter().any(|c| c == pid)).map(|(k, _)| k.clone()).collect()
    }

    pub fn money_kind<'a>(&self, kind: &'a str) -> Option<&'a str> {
        kind.strip_prefix("money_").filter(|m| self.money_chests.contains_key(*m))
    }
}

/// Warianty z połączeniami warstw i listy wyliczane z nich (jak pętla w data.py i register_custom_variants)
struct VariantTables {
    variants: IndexMap<String, VariantDef>,
    variants_json: Value,
    variant_order: Vec<String>,
    crate_variants: Vec<String>,
    special_variants: Vec<String>,
    casino_variants: Vec<String>,
    sticker_variants: Vec<String>,
    variant_defaults: IndexMap<String, VariantDefault>,
}

impl VariantTables {
    /// builtin: warianty z data/game.json, custom: z kreatora (dopisywane po połączeniach wbudowanych, jak w Pythonie)
    fn build(
        builtin: &IndexMap<String, Map<String, Value>>,
        custom: &IndexMap<String, Map<String, Value>>,
    ) -> anyhow::Result<VariantTables> {
        let flag = |x: &Map<String, Value>, k: &str| x.get(k).and_then(Value::as_bool).unwrap_or(false);
        let mut all = builtin.clone();
        let layers: Vec<String> = all.iter().filter(|(_, x)| flag(x, "layer")).map(|(k, _)| k.clone()).collect();
        let add_combos = |all: &mut IndexMap<String, Map<String, Value>>, bases: Vec<(String, Map<String, Value>)>| {
            for layer in &layers {
                for (base, x) in &bases {
                    if base == "normal" || flag(x, "layer") || flag(x, "combo") || flag(x, "special") {
                        continue;
                    }
                    let lx = &all[layer];
                    let name = format!("{} + {}", lx["name"].as_str().unwrap_or(""), x["name"].as_str().unwrap_or(""));
                    let mult = py_round(lx["mult"].as_f64().unwrap_or(1.0) * x["mult"].as_f64().unwrap_or(1.0), 2);
                    let m = json!({"name": name, "chance": 0.0, "mult": mult, "exclusive": true, "combo": true,
                                   "layers": [layer, base]});
                    all.insert(format!("{layer}+{base}"), m.as_object().cloned().unwrap_or_default());
                }
            }
        };
        let builtin_bases: Vec<(String, Map<String, Value>)> = all.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        add_combos(&mut all, builtin_bases);
        all.extend(custom.iter().map(|(k, v)| (k.clone(), v.clone())));
        add_combos(&mut all, custom.iter().map(|(k, v)| (k.clone(), v.clone())).collect());

        let variants: IndexMap<String, VariantDef> = all
            .iter()
            .map(|(k, v)| Ok((k.clone(), serde_json::from_value(Value::Object(v.clone()))?)))
            .collect::<anyhow::Result<_>>()?;
        let variants_json = Value::Object(all.iter().map(|(k, v)| (k.clone(), Value::Object(v.clone()))).collect());
        let mut variant_order: Vec<String> = variants.keys().cloned().collect();
        variant_order.sort_by(|a, b| variants[a].mult.total_cmp(&variants[b].mult)); // stabilne, jak sorted()
        // warianty przypinane do skrzynek: wszystkie poza zwykłą, połączeniami, wariantami kart specjalnych
        // i konkretnych kart (jak CRATE_VARIANTS w data.py)
        let crate_variants = variants
            .iter()
            .filter(|(k, x)| *k != "normal" && (x.cards.is_empty() || x.crate_only) && !x.combo && !x.special)
            .map(|(k, _)| k.clone())
            .collect();
        let special_variants = variants.iter().filter(|(_, x)| x.special).map(|(k, _)| k.clone()).collect();
        let casino_variants = variant_order
            .iter()
            .filter(|v| *v == "normal" || (variants[*v].chance > 0.0 && !variants[*v].exclusive))
            .cloned()
            .collect();
        let sticker_variants = variants
            .iter()
            .filter(|(_, x)| !x.stickers.is_null() && x.stickers != json!(false))
            .map(|(k, _)| k.clone())
            .collect();
        let variant_defaults = builtin
            .iter()
            .chain(custom.iter())
            .filter(|(_, x)| !flag(x, "combo"))
            .map(|(k, x)| {
                (
                    k.clone(),
                    VariantDefault {
                        chance: x.get("chance").and_then(Value::as_f64).unwrap_or(0.0),
                        weight: x.get("weight").and_then(Value::as_f64),
                        desc: x.get("desc").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        mult: x.get("mult").and_then(Value::as_f64).unwrap_or(1.0),
                    },
                )
            })
            .collect();
        Ok(VariantTables {
            variants,
            variants_json,
            variant_order,
            crate_variants,
            special_variants,
            casino_variants,
            sticker_variants,
            variant_defaults,
        })
    }
}

/// Wariant-warstwa (flaga) + zwykły wariant: "flag" + "gold" -> "flag+gold" (+ zwykła = sama flaga)
pub fn combine_variant(layer: &str, base: &str) -> String {
    if base == "normal" {
        layer.to_owned()
    } else {
        format!("{layer}+{base}")
    }
}

/// Wartość karty w groszach: wartość rzadkości × valueMult (droższe skrzynki) × mnożnik wariantu,
/// zaokrąglona jak round() w Pythonie (połówki do parzystej).
pub fn card_value(rarity: &str, value_mult: f64, variant: &str) -> i64 {
    let g = g();
    let base = g.rarities.get(rarity).map(|r| r.value).unwrap_or(0) as f64 * value_mult;
    (base * g.variant(variant).mult).round_ties_even() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/derived.json")).unwrap()
    }

    #[test]
    fn derived_values_match_python() {
        let f = fixture();
        // inne testy podmieniają dane gry (set_game, z "desc" itd. z catalog_variants) - porównujemy wbudowane
        let g = base_game();
        assert_eq!(g.variants_json, f["variants"], "VARIANTS");
        assert_eq!(json!(g.variant_order), f["variantOrder"]);
        assert_eq!(json!(g.crate_variants), f["crateVariants"]);
        assert_eq!(json!(g.special_variants), f["specialVariants"]);
        assert_eq!(json!(g.casino_variants), f["casinoVariants"]);
        assert_eq!(g.rarities_json, f["rarities"]);
        assert_eq!(g.types_json, f["types"]);
        for c in g.crates.values() {
            for p in &c.people {
                let id = p["id"].as_str().unwrap();
                assert_eq!(Value::Object(p.clone()), f["people"][id], "karta {id}");
            }
        }
    }

    #[test]
    fn card_values_match_python() {
        let f = fixture();
        let g = g();
        let people: HashMap<String, String> = g
            .crates
            .values()
            .flat_map(|c| c.people.iter())
            .map(|p| (p["id"].as_str().unwrap().to_owned(), p["rarity"].as_str().unwrap().to_owned()))
            .collect();
        // klucze fixture: "pid|wariant|valueMult"
        for (key, want) in f["cardValues"].as_object().unwrap() {
            let mut parts = key.split('|');
            let (pid, variant, mult) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            let mult: f64 = mult.parse().unwrap();
            assert_eq!(card_value(&people[pid], mult, variant), want.as_i64().unwrap(), "{key}");
        }
    }
}
