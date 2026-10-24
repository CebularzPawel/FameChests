//! Dane gry z `data/game.json` (przeniesione z data.py) + wartości wyliczane tak samo jak w data.py:
//! połączenia wariantów warstwowych ("flag+gold"), VARIANT_ORDER, szansa tajnej karty, słabości typów, drugie ataki.
//! Zmiany ustawień gry (ceny, szanse, lista zmian PATCH_NOTES...) - w `data/game.json`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub static GAME: LazyLock<GameData> =
    LazyLock::new(|| GameData::from_json(include_str!("../data/game.json")).expect("data/game.json: nieprawidłowe dane gry"));

/// Skrót: `G.variants`, `G.rarities`...
pub fn g() -> &'static GameData {
    &GAME
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VariantDef {
    pub name: String,
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

pub struct TypeDef {
    pub weak: Option<String>,
    pub resist: Option<String>,
}

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
    pub jackpot: JackpotCfg,
    pub jackpot_json: Value,
    pub patch_notes: Vec<Value>,
}

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

        // ---- warianty + połączenia warstw ("flag+gold"), jak pętla w data.py
        let mut variants_raw: IndexMap<String, Map<String, Value>> = get(&raw, "variants")?;
        let layers: Vec<String> = variants_raw
            .iter()
            .filter(|(_, x)| x.get("layer").and_then(Value::as_bool).unwrap_or(false))
            .map(|(k, _)| k.clone())
            .collect();
        for layer in &layers {
            let snapshot: Vec<(String, Map<String, Value>)> = variants_raw.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (base, x) in snapshot {
                let flag = |k: &str| x.get(k).and_then(Value::as_bool).unwrap_or(false);
                if base == "normal" || flag("layer") || flag("combo") || flag("special") {
                    continue;
                }
                let lx = &variants_raw[layer];
                let name = format!("{} + {}", lx["name"].as_str().unwrap_or(""), x["name"].as_str().unwrap_or(""));
                let mult = py_round(lx["mult"].as_f64().unwrap_or(1.0) * x["mult"].as_f64().unwrap_or(1.0), 2);
                let mut m = Map::new();
                m.insert("name".into(), json!(name));
                m.insert("chance".into(), json!(0.0));
                m.insert("mult".into(), json!(mult));
                m.insert("exclusive".into(), json!(true));
                m.insert("combo".into(), json!(true));
                m.insert("layers".into(), json!([layer, base]));
                variants_raw.insert(format!("{layer}+{base}"), m);
            }
        }
        let variants: IndexMap<String, VariantDef> = variants_raw
            .iter()
            .map(|(k, v)| Ok((k.clone(), serde_json::from_value(Value::Object(v.clone()))?)))
            .collect::<anyhow::Result<_>>()?;
        let variants_json = Value::Object(variants_raw.iter().map(|(k, v)| (k.clone(), Value::Object(v.clone()))).collect());
        let mut variant_order: Vec<String> = variants.keys().cloned().collect();
        variant_order.sort_by(|a, b| variants[a].mult.total_cmp(&variants[b].mult)); // stabilne, jak sorted()
        let exclusive_variants: Vec<String> = variants.iter().filter(|(_, x)| x.exclusive).map(|(k, _)| k.clone()).collect();
        let crate_variants = exclusive_variants
            .iter()
            .filter(|v| variants[*v].cards.is_empty() && !variants[*v].combo && !variants[*v].special)
            .cloned()
            .collect();
        let special_variants = variants.iter().filter(|(_, x)| x.special).map(|(k, _)| k.clone()).collect();
        let casino_variants = variant_order
            .iter()
            .filter(|v| *v == "normal" || (variants[*v].chance > 0.0 && !variants[*v].exclusive))
            .cloned()
            .collect();

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
            variants,
            variants_json,
            variant_order,
            crate_variants,
            special_variants,
            casino_variants,
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
            jackpot: get(&raw, "jackpot")?,
            jackpot_json: v("jackpot"),
            patch_notes: get(&raw, "patchNotes")?,
        })
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
        let g = g();
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
