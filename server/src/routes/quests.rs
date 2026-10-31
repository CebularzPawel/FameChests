//! Codzienny quest (domyślnie wyłączony, włącza admin w panelu): każdego dnia jeden wspólny cel dla wszystkich graczy -
//! zdobyć konkretną rzadką kartę albo dowolną kartę w rzadkim wariancie. Kto pierwszy, dostaje tę samą kartę w wariancie
//! Wanted i tyle groszy, ile jest warta; dla reszty zadanie przepada.
//!
//! Quest losuje się przy pierwszym zapytaniu danego dnia (`daily_quests`, klucz = dzień). Liczą się tylko karty, które
//! dopiero powstają (skrzynki, kuźnia, ulepszacz, kasyno) - kupno na rynku albo wymiana nie wypełnia questa, inaczej
//! wygrywałby ten, kto akurat ma najwięcej pieniędzy.

use std::collections::{HashMap, HashSet};

use axum::extract::State;
use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::shop::today;
use super::{ok, JsonBody};
use crate::achievements::{self, parts};
use crate::auth::Admin;
use crate::catalog::Catalog;
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{bad, Res};
use crate::game::{add_state, insert_plain, log_admin, Ctx};
use crate::state::AppState;

pub const REWARD_VARIANT: &str = "wanted";
const ENABLED_KEY: &str = "quests_enabled";
/// karty, które wypełniają questa: nowe, nie z rynku, wymiany ani nagród
const SOURCES: [&str; 4] = ["drop", "contract", "upgrade", "casino"];
/// rzadkości kart do questa
const RARITIES: [&str; 3] = ["red", "gold", "ultra"];
/// „rzadki wariant”: szansa na wariant przy wypadnięciu karty
const VARIANT_CHANCE: (f64, f64) = (0.002, 0.02);
const HISTORY: i64 = 14;

type QuestRow = (String, Option<String>, Option<String>, Option<i64>, Option<f64>, Option<String>, i64);
const COLUMNS: &str = "day, person_id, variant, winner_id, won_at, won_person, money";

async fn enabled(c: &mut Conn) -> sqlx::Result<bool> {
    let v: Option<i64> = sqlx::query_scalar("SELECT value FROM state WHERE key = $1").bind(ENABLED_KEY).fetch_optional(c).await?;
    Ok(v.unwrap_or(0) != 0)
}

fn day() -> String {
    today().to_string()
}

/// Karty i warianty, które teraz naprawdę można zdobyć: skrzynka jest w sklepie, wariant włączony i do niej przypięty
fn candidates(cat: &Catalog) -> (Vec<String>, Vec<String>) {
    let shop: Vec<_> = cat.crates.values().filter(|c| c.shop && !c.restricted).collect();
    let in_shop: HashSet<&str> = shop.iter().map(|c| c.id.as_str()).collect();
    let cards = cat
        .people
        .values()
        .filter(|p| RARITIES.contains(&p.rarity.as_str()) && p.crates.iter().any(|c| in_shop.contains(c.as_str())))
        .map(|p| p.id.clone())
        .collect();
    let mut variants: Vec<String> = shop.iter().flat_map(|c| cat.drop_variants(c, None).0).collect();
    variants.sort();
    variants.dedup();
    let (lo, hi) = VARIANT_CHANCE;
    let gd = g();
    variants.retain(|v| {
        let x = gd.variant(v);
        !x.combo
            && !x.special
            && !x.layer
            && !x.always
            && x.cards.is_empty()
            && v != REWARD_VARIANT
            && (lo..=hi).contains(&x.chance)
    });
    (cards, variants)
}

/// Cel questa: (karta, wariant) - jedno z dwóch
fn pick(cat: &Catalog) -> Option<(Option<String>, Option<String>)> {
    let (cards, variants) = candidates(cat);
    let mut rng = rand::thread_rng();
    let card = cards.choose(&mut rng).map(|p| (Some(p.clone()), None));
    let variant = variants.choose(&mut rng).map(|v| (None, Some(v.clone())));
    if rng.gen_bool(0.5) {
        card.or(variant)
    } else {
        variant.or(card)
    }
}

async fn row_of(c: &mut Conn, day: &str) -> sqlx::Result<Option<QuestRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM daily_quests WHERE day = $1")))
        .bind(day)
        .fetch_optional(c)
        .await
}

/// Dzisiejszy quest; pierwszy gracz danego dnia go losuje. None = questy wyłączone albo nie ma czego losować.
async fn current(c: &mut Conn, cat: &Catalog) -> sqlx::Result<Option<QuestRow>> {
    if !enabled(&mut *c).await? {
        return Ok(None);
    }
    let day = day();
    if let Some(r) = row_of(&mut *c, &day).await? {
        return Ok(Some(r));
    }
    let Some((person, variant)) = pick(cat) else { return Ok(None) };
    sqlx::query("INSERT INTO daily_quests (day, person_id, variant) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING")
        .bind(&day)
        .bind(person)
        .bind(variant)
        .execute(&mut *c)
        .await?;
    row_of(c, &day).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestView {
    day: String,
    person: Option<String>,
    variant: Option<String>,
    /// nagroda w groszach (karta w dowolnym wariancie: dopiero po zdobyciu wiadomo, która)
    reward: Option<i64>,
    done: bool,
    mine: bool,
    winner: Option<String>,
    won_person: Option<String>,
    money: i64,
}

fn reward_for(cat: &Catalog, pid: &str) -> Option<i64> {
    cat.person(pid).map(|p| p.value(REWARD_VARIANT))
}

async fn view(c: &mut Conn, cat: &Catalog, r: QuestRow, uid: i64) -> sqlx::Result<QuestView> {
    let (day, person, variant, winner_id, _, won_person, money) = r;
    let winner: Option<String> = match winner_id {
        Some(id) => sqlx::query_scalar("SELECT username FROM users WHERE id = $1").bind(id).fetch_optional(c).await?,
        None => None,
    };
    Ok(QuestView {
        day,
        reward: person.as_deref().and_then(|p| reward_for(cat, p)),
        person,
        variant,
        done: winner_id.is_some(),
        mine: winner_id == Some(uid),
        winner,
        won_person,
        money,
    })
}

/// Dzisiejszy quest dla /api/me
pub async fn quest_view(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Option<QuestView>> {
    match current(&mut *c, cat).await? {
        Some(r) => Ok(Some(view(c, cat, r, uid).await?)),
        None => Ok(None),
    }
}

/// Po każdej nowej karcie: czy to cel dzisiejszego, jeszcze niewypełnionego questa. Pierwszy wygrywa - `UPDATE` z warunkiem
/// `winner_id IS NULL` zadziała tylko dla jednego gracza, nawet gdy dwóch trafi kartę w tej samej chwili.
pub async fn after_item(c: &mut Conn, cx: &Ctx, pid: &str, variant: &str, source: &str) -> sqlx::Result<()> {
    if !SOURCES.contains(&source) || variant == REWARD_VARIANT {
        return Ok(());
    }
    let open: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT person_id, variant FROM daily_quests WHERE day = $1 AND winner_id IS NULL")
            .bind(day())
            .fetch_optional(&mut *c)
            .await?;
    let Some((want_person, want_variant)) = open else { return Ok(()) };
    let fits =
        want_person.as_deref().is_none_or(|p| p == pid) && want_variant.as_deref().is_none_or(|v| parts(variant).contains(&v));
    let Some(money) = reward_for(&cx.cat, pid).filter(|_| fits) else { return Ok(()) };
    let won = sqlx::query(
        "UPDATE daily_quests SET winner_id = $1, won_at = $2, won_person = $3, money = $4 WHERE day = $5 AND winner_id IS NULL",
    )
    .bind(cx.uid())
    .bind(now())
    .bind(pid)
    .bind(money)
    .bind(day())
    .execute(&mut *c)
    .await?
    .rows_affected();
    if won == 1 {
        insert_plain(c, cx, pid, REWARD_VARIANT, "quest").await?;
        add_state(c, cx.uid(), "balance", money).await?;
        achievements::count_quest(c, cx.uid()).await?;
    }
    Ok(())
}

async fn history(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Vec<QuestView>> {
    let rows: Vec<QuestRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM daily_quests ORDER BY day DESC LIMIT {HISTORY}")))
            .fetch_all(&mut *c)
            .await?;
    let mut out = vec![];
    for r in rows {
        out.push(view(c, cat, r, uid).await?);
    }
    Ok(out)
}

pub async fn admin_quests(State(st): State<AppState>, Admin(me): Admin) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let on = enabled(&mut c).await?;
    if on {
        current(&mut c, &cat).await?;
    }
    let (cards, variants) = candidates(&cat);
    let names: HashMap<&str, &str> = cat.people.values().map(|p| (p.id.as_str(), p.name.as_str())).collect();
    let list = history(&mut c, &cat, me.id).await?;
    let label = |q: &QuestView| match (&q.person, &q.variant) {
        (Some(p), _) => names.get(p.as_str()).copied().unwrap_or(p).to_owned(),
        (_, Some(v)) => format!("dowolna karta w wariancie {}", g().variant(v).name),
        _ => String::new(),
    };
    let history: Vec<_> =
        list.iter().map(|q| json!({"day": q.day, "target": label(q), "winner": q.winner, "money": q.money})).collect();
    ok(json!({"enabled": on, "day": day(), "history": history, "cards": cards.len(), "variants": variants.len()}))
}

#[derive(Deserialize)]
pub struct QuestSettings {
    enabled: Option<bool>,
    #[serde(default)]
    reroll: bool,
}

async fn drop_open(c: &mut Conn) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM daily_quests WHERE day = $1 AND winner_id IS NULL").bind(day()).execute(c).await?;
    Ok(())
}

pub async fn admin_quests_save(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<QuestSettings>) -> Res {
    let mut tx = st.db.begin().await?;
    if let Some(on) = req.enabled {
        sqlx::query("INSERT INTO state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(ENABLED_KEY)
            .bind(i64::from(on))
            .execute(&mut *tx)
            .await?;
        if !on {
            drop_open(&mut tx).await?; // po wyłączeniu nikt nie może już wypełnić dzisiejszego questa
        }
        log_admin(&mut tx, &me, "quests", None, if on { "włączone" } else { "wyłączone" }).await?;
    } else if req.reroll {
        let done: Option<Option<i64>> =
            sqlx::query_scalar("SELECT winner_id FROM daily_quests WHERE day = $1").bind(day()).fetch_optional(&mut *tx).await?;
        if done.flatten().is_some() {
            return bad("Dzisiejszy quest jest już wypełniony");
        }
        drop_open(&mut tx).await?;
        log_admin(&mut tx, &me, "quests", None, "nowy cel na dziś").await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true}))
}
