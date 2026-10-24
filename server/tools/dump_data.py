"""Jednorazowo: data.py -> server/data/game.json (dane źródłowe; wartości wyliczane - połączenia wariantów,
VARIANT_ORDER, szansa tajnej karty, słabości typów, drugie ataki - liczy serwer w Rust, src/data.rs).

    python server/tools/dump_data.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import data  # noqa: E402

variants = {k: v for k, v in data.VARIANTS.items() if not v.get("combo")}
rarities = {k: dict(v) for k, v in data.RARITIES.items()}
rarities["secret"]["weight"] = 0.0
types = {k: {kk: vv for kk, vv in v.items() if kk not in ("weak", "resist")} for k, v in data.TYPES.items()}
crates = {}
for cid, c in data.CRATES.items():
    c = dict(c)
    c["people"] = [{k: v for k, v in p.items() if k not in ("attack2", "dmg2")} for p in c["people"]]
    crates[cid] = c

out = {
    "startingBalance": data.STARTING_BALANCE,
    "cratePrice": data.CRATE_PRICE,
    "maxOpen": data.MAX_OPEN,
    "variants": variants,
    "defaultCrateVariants": data.DEFAULT_CRATE_VARIANTS,
    "cratesAddedLater": sorted(data.CRATES_ADDED_LATER),
    "contractSize": data.CONTRACT_SIZE,
    "contractVariantBonus": data.CONTRACT_VARIANT_BONUS,
    "upgradeEdge": data.UPGRADE_EDGE,
    "upgradeMax": data.UPGRADE_MAX,
    "upgradeMaxItems": data.UPGRADE_MAX_ITEMS,
    "upgradeMults": data.UPGRADE_MULTS,
    "maxDeposit": data.MAX_DEPOSIT,
    "moneyChests": data.MONEY_CHESTS,
    "dailyStreak": data.DAILY_STREAK,
    "showcaseSize": data.SHOWCASE_SIZE,
    "rarities": rarities,
    "secretOdds": data.SECRET_ODDS,
    "types": types,
    "matchups": data.MATCHUPS,
    "abilityKinds": data.ABILITY_KINDS,
    "maxExtraAbilities": data.MAX_EXTRA_ABILITIES,
    "crates": crates,
    "specialCrate": data.SPECIAL_CRATE,
    "specialSources": data.SPECIAL_SOURCES,
    "casinoSpecial": data.CASINO_SPECIAL,
    "secondAttacks": data.SECOND_ATTACKS,
    "arena": data.ARENA,
    "arenaEffects": data.ARENA_EFFECTS,
    "arenaTargets": data.ARENA_TARGETS,
    "arenaEffectTargets": data.ARENA_EFFECT_TARGETS,
    "arenaVisuals": data.ARENA_VISUALS,
    "maxAbilityEffects": data.MAX_ABILITY_EFFECTS,
    "market": data.MARKET,
    "roulette": data.ROULETTE,
    "casinoTop": data.CASINO_TOP,
    "rouletteWheel": data.ROULETTE_WHEEL,
    "rouletteRed": data.ROULETTE_RED,
    "rouletteBets": {k: {"name": n, "numbers": nums, "pays": pays} for k, (n, nums, pays) in data.ROULETTE_BETS.items()},
    "blackjack": data.BLACKJACK,
    "jackpot": data.JACKPOT,
    "patchNotes": data.PATCH_NOTES,
}
path = os.path.join(ROOT, "server", "data", "game.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
print("->", path)
