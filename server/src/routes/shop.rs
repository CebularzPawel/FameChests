//! Skrzynki (sklep, otwieranie, skrzynki z pieniędzmi), sprzedaż, ulubione, kuźnia (kontrakt, ulepszacz),
//! codzienna nagroda i seria logowań.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use chrono::{Duration, Local, NaiveDate};
use indexmap::IndexMap;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, JsonBody};
use crate::auth::Me;
use crate::catalog::{Catalog, Person};
use crate::data::{g, GameData};
use crate::db::{lock_me, Conn};
use crate::error::{bad, fail, AppError, Res};
use crate::game::roll::{random, roll, roll_money, roll_variant};
use crate::game::views::{public_person, CrateJson, PublicPerson};
use crate::game::*;
use crate::state::AppState;

const MAX_BULK_CONTRACTS: usize = 50; // ile kontraktów naraz

fn one() -> i64 {
    1
}

fn yes() -> bool {
    true
}

fn normal() -> String {
    "normal".into()
}

// ---------------------------------------------------------------- konfiguracja i stan gracza

/// Skrzynka w sklepie: czy gracz może ją kupić
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopCrate {
    #[serde(flatten)]
    info: CrateJson,
    can_buy: bool,
    /// skrzynka jest / była w sklepie (albo to skrzynka kart specjalnych) - tylko takie widać w klaserze
    released: bool,
}

/// Skrzynki, które są albo były kiedyś w sklepie (klucze crate_released:<id> w tabeli state, jak released_crates
/// w app.py); skrzynki w sklepie dopisuje przy okazji.
async fn released_crates(c: &mut Conn, cat: &Catalog) -> sqlx::Result<HashSet<String>> {
    let keys: Vec<String> = sqlx::query_scalar::<_, String>("SELECT key FROM state WHERE key LIKE 'crate_released:%'")
        .fetch_all(&mut *c)
        .await?;
    let mut seen: HashSet<String> = keys.iter().filter_map(|k| k.split_once(':').map(|(_, id)| id.to_owned())).collect();
    for (cid, cr) in &cat.crates {
        if cr.shop && !seen.contains(cid) {
            sqlx::query("INSERT INTO state (key, value) VALUES ($1, 1) ON CONFLICT DO NOTHING")
                .bind(format!("crate_released:{cid}"))
                .execute(&mut *c)
                .await?;
            seen.insert(cid.clone());
        }
    }
    Ok(seen)
}

/// Wszystko, czego przeglądarka potrzebuje na start: zasady gry, karty, skrzynki
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResponse {
    rarities: &'static Value,
    rarity_order: &'static [String],
    variants: &'static Value,
    variant_order: &'static [String],
    types: &'static Value,
    ability_kinds: &'static Value,
    /// Arena (wersja testowa) - tylko admini; bez tego przeglądarka chowa zakładkę i wyzwania
    arena: Option<Value>,
    people: IndexMap<String, PublicPerson>,
    crates: IndexMap<String, ShopCrate>,
    crate_order: Vec<String>,
    max_open: i64,
    starting_balance: i64,
    contract_size: &'static Value,
    /// rzadkość wyniku kontraktu (pusta rzadkość jest pomijana)
    contract_next: IndexMap<String, Option<String>>,
    contract_variant_bonus: f64,
    upgrade_edge: f64,
    upgrade_max: f64,
    upgrade_max_items: usize,
    upgrade_mults: &'static [f64],
    max_deposit: i64,
    money_chests: &'static Value,
    daily_streak: i64,
    secret_odds: i64,
    showcase_size: usize,
    market: &'static Value,
    roulette: &'static Value,
    jackpot: &'static Value,
    blackjack: &'static Value,
    slots: &'static Value,
    special_variants: &'static [String],
    special_sources: &'static Value,
    casino_special: &'static Value,
}

pub async fn config(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    let g: &'static GameData = g();
    let mut c = cx.st.db.acquire().await?;
    let found = discovered(&mut c, cx.uid()).await?;
    let released = released_crates(&mut c, &cx.cat).await?;
    let people = cx
        .cat
        .people
        .iter()
        .map(|(pid, p)| (pid.clone(), public_person(&cx.st.images, &cx.cat, p, found.contains(pid))))
        .collect();
    let mut crates = IndexMap::new();
    for (cid, cr) in &cx.cat.crates {
        crates.insert(
            cid.clone(),
            ShopCrate {
                info: CrateJson::new(&cx.cat, cr),
                can_buy: can_buy(&mut c, &cx.me, cr).await?,
                released: cr.special || released.contains(cid),
            },
        );
    }
    let arena = cx.me.admin().then(|| {
        json!({"rules": g.arena_json, "effects": g.arena_effects_json, "visuals": g.arena_visuals,
               "targets": g.arena_targets, "effectTargets": g.arena_effect_targets})
    });
    ok(ConfigResponse {
        rarities: &g.rarities_json,
        rarity_order: &g.rarity_order,
        variants: &g.variants_json,
        variant_order: &g.variant_order,
        types: &g.types_json,
        ability_kinds: &g.ability_kinds,
        arena,
        people,
        crates,
        crate_order: cx.cat.crates.keys().cloned().collect(),
        max_open: g.max_open,
        starting_balance: g.starting_balance,
        contract_size: &g.contract_size_json,
        contract_next: g.contract_size.keys().map(|r| (r.clone(), cx.cat.next_rarity(r))).collect(),
        contract_variant_bonus: g.contract_variant_bonus,
        upgrade_edge: g.upgrade_edge,
        upgrade_max: g.upgrade_max,
        upgrade_max_items: g.upgrade_max_items,
        upgrade_mults: &g.upgrade_mults,
        max_deposit: g.max_deposit,
        money_chests: &g.money_chests_json,
        daily_streak: g.daily_streak,
        secret_odds: g.secret_odds,
        showcase_size: g.showcase_size,
        market: &g.market_json,
        roulette: &g.roulette_json,
        jackpot: &g.jackpot_json,
        blackjack: &g.blackjack_json,
        slots: &g.slots_json,
        special_variants: &g.special_variants,
        special_sources: &g.special_sources_json,
        casino_special: &g.casino_special_json,
    })
}

#[derive(Serialize)]
struct StateResponse {
    state: GameState,
    items: Vec<ItemJson>,
    showcase: Vec<i64>,
    chests: Chests,
    collected: Vec<(String, String)>,
}

pub async fn state(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    ok(StateResponse {
        state: get_state(&mut c, me.id).await?,
        items: my_items(&mut c, &cat, me.id).await?,
        showcase: showcase_ids(&mut c, me.id).await?,
        chests: get_chests(&mut c, &cat, me.id).await?,
        collected: collected_list(&mut c, &cat, me.id).await?,
    })
}

// ---------------------------------------------------------------- skrzynki

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenRequest {
    #[serde(rename = "crate")]
    crate_id: String,
    #[serde(default = "one")]
    count: i64,
    /// najpierw skrzynki z ekwipunku
    #[serde(default = "yes")]
    use_owned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResponse {
    drops: Vec<NewItem>,
    discovered: Vec<String>,
    state: GameState,
    from_inventory: i64,
    chests: Chests,
}

pub async fn open_crates(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<OpenRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(cr) = cx.cat.crates.get(&req.crate_id).filter(|_| (1..=g().max_open).contains(&req.count)) else {
        return bad("Nieprawidłowe żądanie");
    };
    if cr.special {
        return bad("Karty specjalne zdobywa się w kasynie albo z linku — tej skrzynki nie da się otworzyć");
    }
    if !cx.cat.crate_people(cr).any(|p| !p.is_special()) {
        return bad("Ta skrzynka jest pusta");
    }
    let owned = if req.use_owned {
        i64::from(get_chests(&mut tx, &cx.cat, cx.uid()).await?.get(&cr.id).copied().unwrap_or(0))
    } else {
        0
    };
    let from_inv = owned.min(req.count);
    if from_inv < req.count && !can_buy(&mut tx, &cx.me, cr).await? {
        let msg =
            if cr.shop { "Ta skrzynka jest dostępna tylko dla wybranych graczy" } else { "Tej skrzynki nie ma teraz w sklepie" };
        let extra = if owned > 0 { format!(" — możesz otworzyć tylko te z ekwipunku ({owned})") } else { String::new() };
        return fail(StatusCode::FORBIDDEN, format!("{msg}{extra}"));
    }
    let cost = (req.count - from_inv) * cr.price;
    if balance(&mut tx, cx.uid()).await? < cost {
        return bad("Za mało pieniędzy!");
    }
    if from_inv > 0 {
        add_chests(&mut tx, cx.uid(), &cr.id, -from_inv).await?;
    }
    add_state(&mut tx, cx.uid(), "balance", -cost).await?;
    add_state(&mut tx, cx.uid(), "spent", cost).await?;
    add_state(&mut tx, cx.uid(), "opened", req.count).await?;
    let mut drops = vec![];
    for _ in 0..req.count {
        let (person, variant) = roll(&cx.cat, cr).ok_or_else(|| AppError::bad("Ta skrzynka jest pusta"))?;
        drops.push(insert_item(&mut tx, &cx, &person.id, &variant, "drop").await?);
    }
    let discovered = note_drops(&mut tx, &cx, &drops_of(&drops), "drop").await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    let chests = get_chests(&mut tx, &cx.cat, cx.uid()).await?;
    tx.commit().await?;
    metrics::counter!("scambox_crates_opened_total", "crate" => cr.id.clone()).increment(req.count.unsigned_abs());
    ok(OpenResponse { drops, discovered, state, from_inventory: from_inv, chests })
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BuyRequest {
    #[serde(rename = "crate")]
    crate_id: String,
    #[serde(default = "one")]
    count: i64,
}

pub async fn buy_chests(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<BuyRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(cr) = cx.cat.crates.get(&req.crate_id).filter(|_| (1..=100).contains(&req.count)) else {
        return bad("Nieprawidłowe żądanie");
    };
    if !can_buy(&mut tx, &cx.me, cr).await? {
        return fail(StatusCode::FORBIDDEN, "Nie możesz kupić tej skrzynki");
    }
    let cost = req.count * cr.price;
    if balance(&mut tx, cx.uid()).await? < cost {
        return bad("Za mało pieniędzy!");
    }
    add_state(&mut tx, cx.uid(), "balance", -cost).await?;
    add_state(&mut tx, cx.uid(), "spent", cost).await?;
    add_chests(&mut tx, cx.uid(), &cr.id, req.count).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    let chests = get_chests(&mut tx, &cx.cat, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"state": state, "chests": chests}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct MoneyChestRequest {
    kind: String,
}

pub async fn open_money_chest(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<MoneyChestRequest>) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    if !g().money_chests.contains_key(&req.kind) {
        return bad("Nieznana skrzynka");
    }
    let key = format!("money_{}", req.kind);
    if get_chests(&mut tx, &cat, me.id).await?.get(&key).copied().unwrap_or(0) < 1 {
        return bad("Nie masz takiej skrzynki");
    }
    let amount = roll_money(&req.kind);
    add_chests(&mut tx, me.id, &key, -1).await?;
    add_state(&mut tx, me.id, "balance", amount).await?;
    add_state(&mut tx, me.id, "daily_total", amount).await?;
    let state = get_state(&mut tx, me.id).await?;
    let chests = get_chests(&mut tx, &cat, me.id).await?;
    tx.commit().await?;
    ok(json!({"amount": amount, "kind": req.kind, "state": state, "chests": chests}))
}

// ---------------------------------------------------------------- sprzedaż i ulubione

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct IdsRequest {
    ids: Vec<i64>,
}

pub async fn sell(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<IdsRequest>) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    if req.ids.is_empty() {
        return bad("Nic nie wybrano");
    }
    // ulubionych kart nie sprzedajemy, karty specjalne nie znikają z gry
    let rows = sqlx::query_as!(
        ItemRow,
        "SELECT id, person_id, variant, favorite, created_at FROM items WHERE user_id = $1 AND favorite = 0 AND id = ANY($2)",
        me.id,
        &req.ids
    )
    .fetch_all(&mut *tx)
    .await?;
    let rows: Vec<ItemRow> = rows.into_iter().filter(|r| !cat.person(&r.person_id).is_some_and(|p| p.is_special())).collect();
    let total: i64 = rows.iter().map(|r| row_value(&cat, r)).sum();
    let sold: Vec<i64> = rows.iter().map(|r| r.id).collect();
    delete_items(&mut tx, me.id, &sold).await?;
    add_state(&mut tx, me.id, "balance", total).await?;
    add_state(&mut tx, me.id, "earned", total).await?;
    let state = get_state(&mut tx, me.id).await?;
    tx.commit().await?;
    ok(json!({"sold": sold, "total": total, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct FavoriteRequest {
    ids: Vec<i64>,
    #[serde(default = "yes")]
    fav: bool,
}

pub async fn set_favorite(State(st): State<AppState>, Me(me): Me, JsonBody(mut req): JsonBody<FavoriteRequest>) -> Res {
    req.ids.truncate(500);
    if req.ids.is_empty() {
        return bad("Nic nie wybrano");
    }
    sqlx::query!("UPDATE items SET favorite = $1 WHERE user_id = $2 AND id = ANY($3)", i32::from(req.fav), me.id, &req.ids)
        .execute(&st.db)
        .await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- kuźnia

/// Możliwe wyniki kontraktu ze skrzynki (None = ze wszystkich skrzynek). Tylko karty ze skrzynek, które są teraz
/// w sklepie ("forge"); wynik nie może być "droższą" kartą niż najtańsza z włożonych.
fn contract_candidates<'a>(cat: &'a Catalog, crate_id: Option<&str>, target: &str, max_mult: f64) -> Vec<&'a Arc<Person>> {
    let fits = |p: &&Arc<Person>| p.rarity == target && p.value_mult <= max_mult && p.forge;
    match crate_id {
        Some(cid) => cat.crates.get(cid).map(|c| cat.crate_people(c).filter(fits).collect()).unwrap_or_default(),
        None => cat.people.values().filter(fits).collect(),
    }
}

/// Skrzynka, z której kontrakt losuje wynik za tę kartę: pierwsza skrzynka karty z kartami wyższej rzadkości
/// w sklepie; karta tylko ze skrzynek spoza sklepu - None (wszystkie skrzynki w sklepie)
fn contract_crate(cat: &Catalog, p: &Person, target: &str, max_mult: f64) -> Option<String> {
    p.crates.iter().find(|c| !contract_candidates(cat, Some(c), target, max_mult).is_empty()).cloned()
}

/// Sprawdzony kontrakt
struct Plan {
    ids: Vec<i64>,
    target: String,
    max_mult: f64,
    pool: Vec<Option<String>>,
    specials: usize,
}

/// Sprawdza karty jednego kontraktu (nic nie zmienia)
async fn contract_check(c: &mut Conn, cx: &Ctx, ids: &[i64]) -> Res<Plan> {
    let rows = owned_rows(c, &cx.cat, cx.uid(), ids).await?.ok_or_else(|| AppError::bad("Nie masz tych kart"))?;
    let person = |r: &ItemRow| &cx.cat.people[&r.person_id];
    if rows.iter().any(|r| r.favorite != 0) {
        return bad(FAV_ERROR);
    }
    if rows.iter().any(|r| person(r).is_special()) {
        return bad(SPECIAL_ERROR);
    }
    let rarities: HashSet<&str> = rows.iter().map(|r| person(r).rarity.as_str()).collect();
    let rarity = match rarities.into_iter().collect::<Vec<_>>()[..] {
        [r] => r,
        _ => return bad("Wszystkie karty muszą mieć tę samą rzadkość"),
    };
    let Some(&size) = g().contract_size.get(rarity) else {
        return bad("Z tych kart nie da się nic wytworzyć — tajnych kart nie można zrobić w kuźni");
    };
    if rows.len() != size {
        return bad(format!("Kontrakt wymaga {size} kart"));
    }
    let target = cx.cat.next_rarity(rarity).ok_or_else(|| AppError::bad("Nie ma kart wyższej rzadkości"))?;
    let max_mult = rows.iter().map(|r| person(r).value_mult).fold(f64::INFINITY, f64::min);
    let pool: Vec<Option<String>> = rows
        .iter()
        .map(|r| contract_crate(&cx.cat, person(r), &target, max_mult))
        .filter(|c| !contract_candidates(&cx.cat, c.as_deref(), &target, max_mult).is_empty())
        .collect();
    if pool.is_empty() {
        return bad("W skrzynkach ze sklepu nie ma kart wyższej rzadkości");
    }
    let specials = rows.iter().filter(|r| r.variant != "normal").count();
    Ok(Plan { ids: ids.to_vec(), target, max_mult, pool, specials })
}

#[derive(Serialize)]
struct ContractResult {
    item: NewItem,
    #[serde(rename = "crate")]
    crate_id: Option<String>,
}

/// Wykonuje sprawdzony kontrakt: zabiera karty, losuje nową
async fn contract_exec(c: &mut Conn, cx: &Ctx, plan: &Plan) -> Res<ContractResult> {
    let (crate_id, person_id, person_crate) = {
        let mut rng = rand::thread_rng();
        let crate_id = plan.pool.choose(&mut rng).cloned().flatten();
        let candidates = contract_candidates(&cx.cat, crate_id.as_deref(), &plan.target, plan.max_mult);
        let person =
            candidates.choose(&mut rng).ok_or_else(|| AppError::bad("W skrzynkach ze sklepu nie ma kart wyższej rzadkości"))?;
        (crate_id, person.id.clone(), person.crate_.clone())
    };
    delete_items(c, cx.uid(), &plan.ids).await?;
    let variant = roll_variant(1.0 + g().contract_variant_bonus * plan.specials as f64, &[]);
    let item = insert_item(c, cx, &person_id, &variant, "contract").await?;
    add_state(c, cx.uid(), "contracts", 1).await?;
    metrics::counter!("scambox_forge_total", "kind" => "contract").increment(1);
    Ok(ContractResult { item, crate_id: crate_id.or(person_crate) })
}

pub async fn contract(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<IdsRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let plan = contract_check(&mut tx, &cx, &req.ids).await?;
    let ContractResult { item, crate_id } = contract_exec(&mut tx, &cx, &plan).await?;
    let new = note_drops(&mut tx, &cx, &drops_of(std::slice::from_ref(&item)), "contract").await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"item": item, "crate": crate_id, "consumed": req.ids, "discovered": new, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ContractsRequest {
    groups: Vec<Vec<i64>>,
}

/// Wiele kontraktów naraz. Najpierw sprawdzamy wszystkie - błąd w jednym = nic się nie dzieje.
pub async fn contracts_bulk(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<ContractsRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    if !(1..=MAX_BULK_CONTRACTS).contains(&req.groups.len()) {
        return bad(format!("Naraz można zrobić od 1 do {MAX_BULK_CONTRACTS} kontraktów"));
    }
    let all_ids: Vec<i64> = req.groups.concat();
    if all_ids.iter().collect::<HashSet<_>>().len() != all_ids.len() {
        return bad("Ta sama karta nie może być w dwóch kontraktach");
    }
    let mut plans = vec![];
    for group in &req.groups {
        plans.push(contract_check(&mut tx, &cx, group).await?);
    }
    let mut results = vec![];
    for plan in &plans {
        results.push(contract_exec(&mut tx, &cx, plan).await?);
    }
    let items: Vec<NewItem> = results.iter().map(|r| r.item.clone()).collect();
    let new = note_drops(&mut tx, &cx, &drops_of(&items), "contract").await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"results": results, "consumed": all_ids, "discovered": new, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UpgradeRequest {
    ids: Vec<i64>,
    mult: f64,
}

#[derive(Serialize)]
struct UpgradeResponse {
    win: bool,
    chance: f64,
    roll: f64,
    goal: i64,
    item: Option<NewItem>,
    special: Option<NewItem>,
    consumed: Vec<i64>,
    discovered: Vec<String>,
    state: GameState,
}

/// Możliwe cele ulepszacza: karty ze skrzynek w sklepie (bez tajnych i specjalnych) w zwykłym wariancie albo
/// w nie wyjątkowych i nie wyłączonych wariantach - (wartość, karta, wariant)
fn upgrade_pool(cat: &Catalog) -> Vec<(i64, &Arc<Person>, &'static String)> {
    let g = g();
    let variants: Vec<&'static String> = g
        .variant_order
        .iter()
        .filter(|v| {
            let x = &g.variants[*v];
            *v == "normal" || !(x.combo || x.special || x.exclusive || x.off || !x.cards.is_empty())
        })
        .collect();
    cat.people
        .values()
        .filter(|p| p.forge && !p.is_secret() && !p.is_special())
        .flat_map(|p| variants.iter().map(move |v| (p.value(v), p, *v)))
        .collect()
}

/// Cel ulepszacza dla wkładu i mnożnika: najniższa wartość >= wkład × mnożnik (i > wkład) oraz wszystkie karty
/// o tej wartości - jedna z nich zostanie wylosowana
fn upgrade_targets(cat: &Catalog, stake: i64, mult: f64) -> Option<(i64, Vec<(Arc<Person>, String)>)> {
    let fits: Vec<_> = upgrade_pool(cat).into_iter().filter(|x| x.0 as f64 >= stake as f64 * mult && x.0 > stake).collect();
    let goal = fits.iter().map(|x| x.0).min()?;
    Some((goal, fits.into_iter().filter(|x| x.0 == goal).map(|x| (x.1.clone(), x.2.clone())).collect()))
}

/// Ulepszacz w kasynie, "w ciemno": gracz stawia karty i wybiera mnożnik, serwer losuje kartę-cel (gracz widzi tylko
/// jej wartość i szansę). Wygrana daje kartę-cel i może też dać kartę specjalną z kasyna (Joker).
pub async fn upgrade(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<UpgradeRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let g = g();
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let rows = owned_rows(&mut tx, &cx.cat, cx.uid(), &req.ids).await?;
    let Some(rows) = rows.filter(|r| (1..=g.upgrade_max_items).contains(&r.len()) && g.upgrade_mults.contains(&req.mult))
    else {
        return bad("Nieprawidłowy wybór kart");
    };
    if rows.iter().any(|r| r.favorite != 0) {
        return bad(FAV_ERROR);
    }
    if rows.iter().any(|r| cx.cat.people[&r.person_id].is_special()) {
        return bad(SPECIAL_ERROR);
    }
    let stake: i64 = rows.iter().map(|r| row_value(&cx.cat, r)).sum();
    let Some((goal, targets)) = upgrade_targets(&cx.cat, stake, req.mult) else {
        return bad("Nie ma tak drogiej karty - wybierz mniejszy mnożnik");
    };
    let Some((target, variant)) = targets.choose(&mut rand::thread_rng()).cloned() else {
        return bad("Nie ma tak drogiej karty - wybierz mniejszy mnożnik");
    };
    let chance = g.upgrade_max.min(stake as f64 / goal as f64 * g.upgrade_edge);
    let roll = random();
    let win = roll < chance;
    delete_items(&mut tx, cx.uid(), &req.ids).await?;
    let (item, special, discovered) = if win {
        let item = insert_item(&mut tx, &cx, &target.id, &variant, "upgrade").await?;
        let new = note_drops(&mut tx, &cx, &drops_of(std::slice::from_ref(&item)), "upgrade").await?;
        let special = super::casino::casino_special_drop(&mut tx, &cx, goal).await?; // karta specjalna z kasyna (Joker)
        (Some(item), special, new)
    } else {
        (None, None, vec![])
    };
    add_state(&mut tx, cx.uid(), if win { "upgrades_won" } else { "upgrades_lost" }, 1).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    metrics::counter!("scambox_forge_total", "kind" => if win { "upgrade_won" } else { "upgrade_lost" }).increment(1);
    ok(UpgradeResponse { win, chance, roll, goal, item, special, consumed: req.ids, discovered, state })
}

// ---------------------------------------------------------------- codzienna nagroda

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// Seria logowań: ile dni z rzędu (do wczoraj) gracz odebrał codzienną skrzynkę i czy odebrał ją dziś
async fn daily_streak(c: &mut Conn, uid: i64, today: NaiveDate) -> sqlx::Result<(i64, bool)> {
    let limit = (today + Duration::days(1)).to_string();
    let claimed: HashSet<String> =
        sqlx::query_scalar!("SELECT day FROM daily_claims WHERE user_id = $1 AND day < $2", uid, limit)
            .fetch_all(c)
            .await?
            .into_iter()
            .collect();
    let before = std::iter::successors(Some(today - Duration::days(1)), |d| Some(*d - Duration::days(1)))
        .take_while(|d| claimed.contains(&d.to_string()))
        .count() as i64;
    Ok((before, claimed.contains(&today.to_string())))
}

#[derive(Serialize)]
pub struct DailyDay {
    day: i64,
    kind: &'static str,
    claimed: bool,
    today: bool,
}

/// Dzisiejsza skrzynka w serii DAILY_STREAK dni (7. = MEGA) i które dni serii są już odebrane
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyInfo {
    today: String,
    pub claimable: bool,
    days: Vec<DailyDay>,
    today_kind: &'static str,
    streak_day: i64,
    streak: i64,
    days_to_jackpot: i64,
}

pub async fn daily_info(c: &mut Conn, uid: i64) -> sqlx::Result<DailyInfo> {
    let n = g().daily_streak;
    let kind_of = |day: i64| if day == n { "mega" } else { "daily" };
    let today = today();
    let (before, done) = daily_streak(c, uid, today).await?;
    // dzień serii, który przypada dziś (po MEGA seria liczy się od nowa)
    let pos = before % n + 1;
    Ok(DailyInfo {
        today: today.to_string(),
        claimable: !done,
        days: (1..=n)
            .map(|i| DailyDay { day: i, kind: kind_of(i), claimed: i < pos || (i == pos && done), today: i == pos })
            .collect(),
        today_kind: kind_of(pos),
        streak_day: pos,
        streak: before + i64::from(done),
        days_to_jackpot: n - pos,
    })
}

pub async fn daily(State(st): State<AppState>, Me(me): Me) -> Res {
    let mut c = st.db.acquire().await?;
    ok(daily_info(&mut c, me.id).await?)
}

pub async fn daily_claim(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let kind = daily_info(&mut tx, me.id).await?.today_kind; // 7. dzień serii logowań = MEGA skrzynka
    let inserted = sqlx::query!(
        "INSERT INTO daily_claims (user_id, day, amount) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING",
        me.id,
        today().to_string()
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return bad("Dzisiejsza skrzynka jest już odebrana");
    }
    add_chests(&mut tx, me.id, &format!("money_{kind}"), 1).await?;
    let chests = get_chests(&mut tx, &cat, me.id).await?;
    let daily = daily_info(&mut tx, me.id).await?;
    tx.commit().await?;
    ok(json!({"kind": kind, "chests": chests, "daily": daily}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_defaults() {
        let r: OpenRequest = serde_json::from_str(r#"{"crate": "pl"}"#).unwrap();
        assert_eq!((r.crate_id.as_str(), r.count, r.use_owned), ("pl", 1, true));
        let r: FavoriteRequest = serde_json::from_str(r#"{"ids": [1, 2]}"#).unwrap();
        assert!(r.fav);
        // ulepszacz "w ciemno": tylko karty i mnożnik (cel losuje serwer)
        let r: UpgradeRequest = serde_json::from_str(r#"{"ids": [5], "mult": 2}"#).unwrap();
        assert_eq!((r.ids.as_slice(), r.mult), (&[5][..], 2.0));
        assert!(serde_json::from_str::<IdsRequest>(r#"{"ids": ["x"]}"#).is_err());
    }
}
