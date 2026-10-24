//! Kasyno: ruletka, blackjack, jackpot (lobby dla 2 graczy). Stawką są karty; wygrane - w kartach
//! (house_cards, także w wariantach) + reszta w pieniądzach; przy wygranej szansa na kartę specjalną z kasyna.

use std::sync::LazyLock;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use rand::seq::SliceRandom;
use rand::Rng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{ok, JsonBody};
use crate::auth::{find_user, Me, UserView};
use crate::data::g;
use crate::db::{lock_me, lock_users, now, Conn};
use crate::error::{bad, fail, AppError, Res};
use crate::game::market::settle_market;
use crate::game::roll::{house_cards, random};
use crate::game::views::CardJson;
use crate::game::*;
use crate::state::AppState;
use crate::text::fmt_money;

type Tx = sqlx::Transaction<'static, sqlx::Postgres>;

fn yes() -> bool {
    true
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct StakeRequest {
    ids: Vec<i64>,
}

// ---------------------------------------------------------------- wygrane

/// Wygrana w grze kasyna, która daje nowe karty: z szansą wygrana / CASINO_SPECIAL["per"] (najwyżej "max") gracz dostaje
/// dodatkowo kartę specjalną z kasyna - zawsze w jej jedynym wariancie (np. Jokerowa). Zwraca nową kartę albo None.
pub(crate) async fn casino_special_drop(c: &mut Conn, cx: &Ctx, payout: i64) -> sqlx::Result<Option<NewItem>> {
    let cs = &g().casino_special;
    let pool: Vec<_> = cx.cat.people.values().filter(|p| p.is_special() && p.source.as_deref() == Some("casino")).collect();
    let Some(p) = pool.choose(&mut rand::thread_rng()).copied() else { return Ok(None) };
    if random() >= cs.max.min(payout as f64 / cs.per) {
        return Ok(None);
    }
    let item = insert_item(c, cx, &p.id, p.fixed(), "joker").await?;
    note_drops(c, cx, &drops_of(std::slice::from_ref(&item)), "joker").await?;
    Ok(Some(item))
}

/// Wygrana: karty o łącznej wartości `payout` + reszta w pieniądzach + może karta specjalna
#[derive(Serialize)]
struct Payout {
    items: Vec<NewItem>,
    money: i64,
    payout: i64,
    special: Option<NewItem>,
}

async fn pay_out(c: &mut Conn, cx: &Ctx, payout: i64, feed_kind: &str) -> sqlx::Result<Payout> {
    let (cards, money) = house_cards(&cx.cat, payout);
    let mut items = vec![];
    for (p, v) in cards {
        items.push(insert_item(c, cx, &p.id, &v, "casino").await?);
    }
    add_state(c, cx.uid(), "balance", money).await?;
    note_drops(c, cx, &drops_of(&items), feed_kind).await?;
    let special = casino_special_drop(c, cx, payout).await?;
    metrics::counter!("scambox_casino_payout_total", "game" => feed_kind.to_owned()).increment(payout.unsigned_abs());
    Ok(Payout { items, money, payout, special })
}

// ---------------------------------------------------------------- ruletka

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RouletteRequest {
    ids: Vec<i64>,
    bet: String,
}

#[derive(Serialize)]
struct RouletteResponse {
    number: i64,
    win: bool,
    bet: String,
    stake: i64,
    #[serde(flatten)]
    payout: Option<Payout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    consumed: Option<Vec<i64>>,
    state: GameState,
}

pub async fn casino_roulette(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<RouletteRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let g = g();
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(bet) = g.roulette_bets.get(&req.bet) else { return bad("Wybierz zakład na stole") };
    if !(1..=g.roulette.max_cards).contains(&req.ids.len()) {
        return bad(format!("Postaw od 1 do {} kart", g.roulette.max_cards));
    }
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await?;
    let stake: i64 = rows.iter().map(|r| row_value(&cx.cat, r)).sum();
    let number = rand::thread_rng().gen_range(0..37);
    let win = bet.numbers.contains(&number);
    let (payout, consumed) = if win {
        // karty zostają u gracza + wygrana w kartach
        (Some(pay_out(&mut tx, &cx, stake * bet.pays, "casino").await?), None)
    } else {
        delete_items(&mut tx, cx.uid(), &req.ids).await?;
        (None, Some(req.ids))
    };
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    metrics::counter!("scambox_casino_games_total", "game" => "roulette", "result" => if win { "win" } else { "lose" })
        .increment(1);
    ok(RouletteResponse { number, win, bet: req.bet, stake, payout, consumed, state })
}

// ---------------------------------------------------------------- blackjack
// Gracz przeciw krupierowi, stawką są karty (jak w ruletce). Rozdanie trwa kilka zapytań (dobierz / stój / podwój),
// więc czeka w blackjack_games, a postawione karty są w ESCROW - w tym czasie nie da się ich sprzedać ani zużyć.
// Z gabloty ich nie zdejmujemy: karta w ESCROW się w niej nie pokazuje, a po remisie albo wygranej wraca na swoje
// miejsce. Talię i zakrytą kartę krupiera zna tylko serwer.

const BJ_GONE: &str = "To rozdanie już się skończyło";

/// Karta do gry: ranga (A23456789TJQK, T = dziesiątka) + kolor (SHDC), np. "TS"
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Card(String);

impl Card {
    fn points(&self) -> i64 {
        match self.0.chars().next() {
            Some('A') => 11,
            Some('T' | 'J' | 'Q' | 'K') => 10,
            Some(d) => d.to_digit(10).map_or(0, i64::from),
            None => 0,
        }
    }

    fn is_ace(&self) -> bool {
        self.0.starts_with('A')
    }
}

/// Talia z `decks` talii po 52 karty, potasowana
fn new_deck(decks: usize) -> Vec<Card> {
    let mut deck: Vec<Card> = "A23456789TJQK"
        .chars()
        .flat_map(|r| "SHDC".chars().map(move |s| Card(format!("{r}{s}"))))
        .cycle()
        .take(52 * decks)
        .collect();
    deck.shuffle(&mut rand::thread_rng());
    deck
}

/// Suma punktów - as liczy się za 11, dopóki suma nie przekracza 21
fn total(hand: &[Card]) -> i64 {
    let mut sum: i64 = hand.iter().map(Card::points).sum();
    let mut aces = hand.iter().filter(|c| c.is_ace()).count();
    while sum > 21 && aces > 0 {
        sum -= 10;
        aces -= 1;
    }
    sum
}

fn is_blackjack(hand: &[Card]) -> bool {
    hand.len() == 2 && total(hand) == 21
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum BjResult {
    Lose,
    Push,
    Win,
    Blackjack,
}

/// Wiersz rozdania w trakcie (talia i karty jako JSON)
struct BjRow {
    item_ids: String,
    stake: i64,
    double_ids: String,
    double_stake: i64,
    deck: String,
    player: String,
    dealer: String,
}

/// Rozdanie w trakcie
struct BjGame {
    ids: Vec<i64>,
    stake: i64,
    double_ids: Vec<i64>,
    double_stake: i64,
    deck: Vec<Card>,
    player: Vec<Card>,
    dealer: Vec<Card>,
}

impl TryFrom<BjRow> for BjGame {
    type Error = serde_json::Error;

    fn try_from(r: BjRow) -> Result<Self, Self::Error> {
        Ok(BjGame {
            ids: serde_json::from_str(&r.item_ids)?,
            stake: r.stake,
            double_ids: serde_json::from_str(&r.double_ids)?,
            double_stake: r.double_stake,
            deck: serde_json::from_str(&r.deck)?,
            player: serde_json::from_str(&r.player)?,
            dealer: serde_json::from_str(&r.dealer)?,
        })
    }
}

impl BjGame {
    fn all_ids(&self) -> Vec<i64> {
        [self.ids.as_slice(), &self.double_ids].concat()
    }

    fn draw(&mut self) -> Card {
        self.deck.pop().unwrap_or_else(|| Card("2S".into()))
    }
}

async fn my_blackjack(c: &mut Conn, uid: i64) -> Res<Option<BjGame>> {
    let row = sqlx::query_as!(
        BjRow,
        "SELECT item_ids, stake, double_ids, double_stake, deck, player, dealer FROM blackjack_games WHERE user_id = $1",
        uid
    )
    .fetch_optional(c)
    .await?;
    row.map(BjGame::try_from).transpose().map_err(|e| AppError::Internal(e.into()))
}

async fn save_blackjack(c: &mut Conn, uid: i64, gm: &BjGame) -> Res<()> {
    sqlx::query!(
        "INSERT INTO blackjack_games (user_id, item_ids, stake, double_ids, double_stake, deck, player, dealer, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id) DO UPDATE SET item_ids = excluded.item_ids, stake = excluded.stake,
             double_ids = excluded.double_ids, double_stake = excluded.double_stake, deck = excluded.deck,
             player = excluded.player, dealer = excluded.dealer",
        uid,
        json(&gm.ids),
        gm.stake,
        json(&gm.double_ids),
        gm.double_stake,
        json(&gm.deck),
        json(&gm.player),
        json(&gm.dealer),
        now()
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Lista do kolumny TEXT jako JSON
fn json<T: Serialize>(v: &[T]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// Postawione karty (w ESCROW) do pokazania przy stole
async fn bj_cards(c: &mut Conn, cx: &Ctx, ids: &[i64]) -> sqlx::Result<Vec<ItemJson>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query_as!(
        ItemRow,
        "SELECT id, person_id, variant, favorite, created_at FROM items WHERE user_id = $1 AND id = ANY($2) ORDER BY id DESC",
        ESCROW,
        ids
    )
    .fetch_all(c)
    .await?;
    Ok(rows.iter().filter_map(|r| item_json(&cx.cat, r)).collect())
}

/// Rozdanie w trakcie dla przeglądarki - druga karta krupiera jest zakryta ("??")
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BjView {
    player: Vec<Card>,
    dealer: [Option<Card>; 2],
    stake: i64,
    double_stake: i64,
    items: Vec<ItemJson>,
    double_items: Vec<ItemJson>,
    can_double: bool,
}

async fn bj_view(c: &mut Conn, cx: &Ctx, gm: &BjGame) -> sqlx::Result<BjView> {
    Ok(BjView {
        player: gm.player.clone(),
        dealer: [gm.dealer.first().cloned(), Some(Card("??".into()))],
        stake: gm.stake,
        double_stake: gm.double_stake,
        items: bj_cards(c, cx, &gm.ids).await?,
        double_items: bj_cards(c, cx, &gm.double_ids).await?,
        can_double: gm.player.len() == 2 && gm.double_stake == 0,
    })
}

#[derive(Serialize)]
struct BjEnd {
    result: BjResult,
    player: Vec<Card>,
    dealer: Vec<Card>,
    stake: i64,
    items: Vec<NewItem>,
    money: i64,
    special: Option<NewItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payout: Option<i64>,
    /// postawione karty wracają do gracza (remis / wygrana)
    #[serde(skip_serializing_if = "Option::is_none")]
    returned: Option<Vec<ItemJson>>,
}

/// Koniec rozdania: krupier dobiera (jeśli trzeba), rozliczenie kart i wygranej, rozdanie znika
async fn bj_end(mut tx: Tx, cx: &Ctx, mut gm: BjGame) -> Res {
    let ids = gm.all_ids();
    let stake = gm.stake + gm.double_stake;
    let player_total = total(&gm.player);
    if player_total <= 21 && !is_blackjack(&gm.player) && !is_blackjack(&gm.dealer) {
        while total(&gm.dealer) < 17 {
            // krupier dobiera do 16 i staje na każdej 17
            let card = gm.draw();
            gm.dealer.push(card);
        }
    }
    let dealer_total = total(&gm.dealer);
    let result = if player_total > 21 {
        BjResult::Lose
    } else if is_blackjack(&gm.player) {
        if is_blackjack(&gm.dealer) {
            BjResult::Push
        } else {
            BjResult::Blackjack
        }
    } else if is_blackjack(&gm.dealer) || (player_total < dealer_total && dealer_total <= 21) {
        BjResult::Lose
    } else if player_total == dealer_total {
        BjResult::Push
    } else {
        BjResult::Win
    };
    let mut end = BjEnd {
        result,
        player: gm.player,
        dealer: gm.dealer,
        stake,
        items: vec![],
        money: 0,
        special: None,
        payout: None,
        returned: None,
    };
    if result == BjResult::Lose {
        sqlx::query!("DELETE FROM items WHERE user_id = $1 AND id = ANY($2)", ESCROW, &ids).execute(&mut *tx).await?;
        sqlx::query!("DELETE FROM showcase WHERE item_id = ANY($1)", &ids).execute(&mut *tx).await?;
    } else {
        end.returned = Some(bj_cards(&mut tx, cx, &ids).await?);
        sqlx::query!("UPDATE items SET user_id = $1 WHERE user_id = $2 AND id = ANY($3)", cx.uid(), ESCROW, &ids)
            .execute(&mut *tx)
            .await?;
    }
    if matches!(result, BjResult::Win | BjResult::Blackjack) {
        // + wygrana w kartach, jak w ruletce
        let payout = if result == BjResult::Blackjack { (stake as f64 * g().blackjack.blackjack_pays) as i64 } else { stake };
        let won = pay_out(&mut tx, cx, payout, "blackjack").await?;
        (end.items, end.money, end.payout, end.special) = (won.items, won.money, Some(won.payout), won.special);
    }
    sqlx::query!("DELETE FROM blackjack_games WHERE user_id = $1", cx.uid()).execute(&mut *tx).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    let label = serde_json::to_value(result).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    metrics::counter!("scambox_casino_games_total", "game" => "blackjack", "result" => label).increment(1);
    ok(json!({"game": null, "end": end, "state": state}))
}

/// Rozdanie trwa dalej
async fn bj_continue(mut tx: Tx, cx: &Ctx, gm: &BjGame) -> Res {
    save_blackjack(&mut tx, cx.uid(), gm).await?;
    let game = bj_view(&mut tx, cx, gm).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"game": game, "end": null, "state": state}))
}

/// Usuwany gracz: jego rozdanie znika razem z postawionymi kartami (są w ESCROW)
pub async fn blackjack_forget_user(c: &mut Conn, uid: i64) -> Res<()> {
    let Some(gm) = my_blackjack(c, uid).await? else { return Ok(()) };
    sqlx::query!("DELETE FROM items WHERE user_id = $1 AND id = ANY($2)", ESCROW, &gm.all_ids()).execute(&mut *c).await?;
    sqlx::query!("DELETE FROM blackjack_games WHERE user_id = $1", uid).execute(c).await?;
    Ok(())
}

pub async fn casino_blackjack(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    let mut c = cx.st.db.acquire().await?;
    let game = match my_blackjack(&mut c, cx.uid()).await? {
        Some(gm) => Some(bj_view(&mut c, &cx, &gm).await?),
        None => None,
    };
    ok(json!({"game": game}))
}

pub async fn casino_blackjack_deal(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<StakeRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let max = g().blackjack.max_cards;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    if my_blackjack(&mut tx, cx.uid()).await?.is_some() {
        return bad("Najpierw dokończ rozdanie");
    }
    if !(1..=max).contains(&req.ids.len()) {
        return bad(format!("Postaw od 1 do {max} kart"));
    }
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await?;
    // postawione karty do ESCROW na czas rozdania
    sqlx::query!("UPDATE items SET user_id = $1 WHERE user_id = $2 AND id = ANY($3)", ESCROW, cx.uid(), &req.ids)
        .execute(&mut *tx)
        .await?;
    let mut gm = BjGame {
        stake: rows.iter().map(|r| row_value(&cx.cat, r)).sum(),
        ids: req.ids,
        double_ids: vec![],
        double_stake: 0,
        deck: new_deck(g().blackjack.decks),
        player: vec![],
        dealer: vec![],
    };
    // na zmianę: gracz, krupier, gracz, krupier (zakryta)
    for _ in 0..2 {
        let card = gm.draw();
        gm.player.push(card);
        let card = gm.draw();
        gm.dealer.push(card);
    }
    if is_blackjack(&gm.player) || is_blackjack(&gm.dealer) {
        // krupier od razu sprawdza blackjacka - koniec rozdania
        return bj_end(tx, &cx, gm).await;
    }
    bj_continue(tx, &cx, &gm).await
}

pub async fn casino_blackjack_hit(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(mut gm) = my_blackjack(&mut tx, cx.uid()).await? else { return bad(BJ_GONE) };
    let card = gm.draw();
    gm.player.push(card);
    if total(&gm.player) >= 21 {
        // fura albo 21 - nie ma już czego dobierać
        return bj_end(tx, &cx, gm).await;
    }
    bj_continue(tx, &cx, &gm).await
}

pub async fn casino_blackjack_stand(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(gm) = my_blackjack(&mut tx, cx.uid()).await? else { return bad(BJ_GONE) };
    bj_end(tx, &cx, gm).await
}

/// Podwojenie: dokładam karty warte najwyżej tyle, co stawka, dostaję dokładnie jedną kartę i krupier gra
pub async fn casino_blackjack_double(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<StakeRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let max = g().blackjack.max_cards;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(mut gm) = my_blackjack(&mut tx, cx.uid()).await? else { return bad(BJ_GONE) };
    if gm.player.len() != 2 || gm.double_stake != 0 {
        return bad("Podwoić można tylko na dwóch pierwszych kartach");
    }
    if !(1..=max).contains(&req.ids.len()) {
        return bad(format!("Dołóż od 1 do {max} kart"));
    }
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await?;
    let extra: i64 = rows.iter().map(|r| row_value(&cx.cat, r)).sum();
    if extra > gm.stake {
        return bad(format!("Dołożone karty mogą być warte najwyżej tyle, co stawka ({})", fmt_money(gm.stake)));
    }
    sqlx::query!("UPDATE items SET user_id = $1 WHERE user_id = $2 AND id = ANY($3)", ESCROW, cx.uid(), &req.ids)
        .execute(&mut *tx)
        .await?;
    (gm.double_ids, gm.double_stake) = (req.ids, extra);
    let card = gm.draw();
    gm.player.push(card);
    bj_end(tx, &cx, gm).await
}

// ---------------------------------------------------------------- jackpot (lobby dla 2 graczy)
// Gracz zakłada lobby: publiczne (każdy może dołączyć) albo prywatne (tylko zaproszeni po nicku) - założyciel może to
// później zmienić i zapraszać kolejnych graczy. Obaj gracze wybierają karty w lobby i mogą je zmieniać (każda zmiana
// cofa akceptację obu). Gdy obaj zaakceptują, serwer od razu losuje zwycięzcę (szansa = wartość moich kart / wartość
// wszystkich kart), a zwycięzca bierze wszystkie karty. Karty w lobby NIE są blokowane: przy losowaniu sprawdzamy,
// czy gracze nadal je mają.

const JACKPOT_GONE: &str = "To lobby jest już nieaktualne";
static INVITE_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[,;\s]+").unwrap());

/// Miejsce w lobby: "a" = założyciel, "b" = drugi gracz
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Seat {
    A,
    B,
}

impl Seat {
    fn as_str(self) -> &'static str {
        match self {
            Seat::A => "a",
            Seat::B => "b",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum JackpotStatus {
    Open,
    Done,
    Cancelled,
    Expired,
}

/// Lobby / gra w jackpot
pub struct Jackpot {
    pub id: i64,
    pub creator_id: i64,
    pub joiner_id: Option<i64>,
    pub status: JackpotStatus,
    pub winner_id: Option<i64>,
    pub roll: Option<f64>,
    pub created_at: f64,
    pub finished_at: Option<f64>,
    pub is_public: i32,
    pub ready_a: i32,
    pub ready_b: i32,
}

impl Jackpot {
    /// Miejsce gracza w lobby albo None
    pub fn seat(&self, uid: i64) -> Option<Seat> {
        if self.creator_id == uid {
            Some(Seat::A)
        } else if self.joiner_id == Some(uid) {
            Some(Seat::B)
        } else {
            None
        }
    }

    fn has_joiner(&self) -> bool {
        self.joiner_id.is_some_and(|u| u != 0)
    }
}

struct JackpotItem {
    side: Seat,
    item_id: i64,
    person_id: String,
    variant: String,
    value: i64,
}

async fn jackpot_cards(c: &mut Conn, jid: i64) -> sqlx::Result<Vec<JackpotItem>> {
    sqlx::query_as!(
        JackpotItem,
        r#"SELECT side AS "side: Seat", item_id, person_id, variant, value FROM jackpot_items WHERE jackpot_id = $1"#,
        jid
    )
    .fetch_all(c)
    .await
}

pub async fn get_jackpot(c: &mut Conn, jid: i64) -> sqlx::Result<Option<Jackpot>> {
    sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE id = $1"#,
        jid
    )
    .fetch_optional(c)
    .await
}

async fn jackpot_invited(c: &mut Conn, jid: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar!("SELECT user_id FROM jackpot_invites WHERE jackpot_id = $1", jid).fetch_all(c).await
}

/// Otwarte lobby, w którym siedzi gracz (najwyżej jedno naraz), albo None
pub async fn my_lobby(c: &mut Conn, uid: i64) -> sqlx::Result<Option<Jackpot>> {
    sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE status = 'open' AND (creator_id = $1 OR joiner_id = $1) ORDER BY id DESC LIMIT 1"#, uid
    ).fetch_optional(c).await
}

pub async fn jackpot_can_see(c: &mut Conn, j: &Jackpot, uid: i64) -> sqlx::Result<bool> {
    Ok(j.is_public != 0 || j.seat(uid).is_some() || jackpot_invited(c, j.id).await?.contains(&uid))
}

#[derive(Serialize)]
struct LobbyCard {
    #[serde(flatten)]
    card: CardJson,
    id: i64,
}

/// Lobby / gra dla przeglądarki: gracze, zaproszeni, karty i wartość obu stron, akceptacje, wynik
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JackpotJson {
    id: i64,
    status: JackpotStatus,
    public: bool,
    creator: Option<UserView>,
    joiner: Option<UserView>,
    invites: Vec<UserView>,
    invited: bool,
    side: Option<Seat>,
    a: Vec<LobbyCard>,
    b: Vec<LobbyCard>,
    value_a: i64,
    value_b: i64,
    ready_a: bool,
    ready_b: bool,
    winner: Option<Seat>,
    roll: Option<f64>,
    created: f64,
    finished: Option<f64>,
}

async fn jackpots_json(c: &mut Conn, cx: &Ctx, rows: Vec<Jackpot>) -> sqlx::Result<Vec<JackpotJson>> {
    let mut invited = vec![];
    for j in &rows {
        invited.push(jackpot_invited(c, j.id).await?);
    }
    let ids = rows
        .iter()
        .flat_map(|j| [Some(j.creator_id), j.joiner_id, j.winner_id])
        .chain(invited.iter().flatten().map(|i| Some(*i)));
    let users = users_by_id(c, &cx.cat, ids).await?;
    let found = discovered(c, cx.uid()).await?;
    let me = cx.uid();
    let mut out = vec![];
    for (j, inv) in rows.into_iter().zip(invited) {
        let (mut a, mut b, mut value_a, mut value_b) = (vec![], vec![], 0, 0);
        for r in jackpot_cards(c, j.id).await? {
            let (cards, value) = match r.side {
                Seat::A => (&mut a, &mut value_a),
                Seat::B => (&mut b, &mut value_b),
            };
            *value += r.value;
            if cx.cat.has(&r.person_id) {
                let mut card = CardJson::new(&cx.st.images, &cx.cat, &r.person_id, &r.variant, &found);
                card.value = r.value;
                cards.push(LobbyCard { card, id: r.item_id });
            }
        }
        let user = |id: Option<i64>| id.and_then(|i| users.get(&i)).cloned();
        out.push(JackpotJson {
            id: j.id,
            status: j.status,
            public: j.is_public != 0,
            creator: user(Some(j.creator_id)),
            joiner: user(j.joiner_id),
            invites: inv.iter().filter_map(|i| users.get(i).cloned()).collect(),
            invited: inv.contains(&me),
            side: j.seat(me),
            a,
            b,
            value_a,
            value_b,
            ready_a: j.ready_a != 0,
            ready_b: j.ready_b != 0,
            winner: j.winner_id.map(|w| if w == j.creator_id { Seat::A } else { Seat::B }),
            roll: j.roll,
            created: j.created_at,
            finished: j.finished_at,
        });
    }
    Ok(out)
}

async fn jackpot_json(c: &mut Conn, cx: &Ctx, j: Option<Jackpot>) -> sqlx::Result<Option<JackpotJson>> {
    Ok(jackpots_json(c, cx, j.into_iter().collect()).await?.pop())
}

/// Odpowiedź z aktualnym stanem lobby
#[derive(Serialize)]
struct LobbyReply {
    jackpot: Option<JackpotJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<ItemJson>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<GameState>,
}

async fn lobby_reply(cx: &Ctx, jid: i64) -> Res<LobbyReply> {
    let mut c = cx.st.db.acquire().await?;
    let j = get_jackpot(&mut c, jid).await?;
    Ok(LobbyReply { jackpot: jackpot_json(&mut c, cx, j).await?, error: None, items: None, state: None })
}

/// Ostatnia rozstrzygnięta gra gracza, której wyniku jeszcze nie widział
pub async fn jackpot_news(c: &mut Conn, cx: &Ctx, seen_ms: i64) -> sqlx::Result<Option<JackpotJson>> {
    let j = sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE status = 'done' AND (creator_id = $1 OR joiner_id = $1) AND finished_at > $2 ORDER BY finished_at DESC LIMIT 1"#,
        cx.uid(),
        seen_ms as f64 / 1000.0

    )
    .fetch_optional(&mut *c)
    .await?;
    jackpot_json(c, cx, j).await
}

/// Nicki do zaproszenia: lista albo napis "ala, bartek"
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Names {
    List(Vec<String>),
    Text(String),
}

impl Default for Names {
    fn default() -> Self {
        Names::Text(String::new())
    }
}

/// Nicki -> id graczy (bez powtórzeń, najwyżej 10)
async fn invite_ids(c: &mut Conn, me: i64, names: &Names) -> Res<Vec<i64>> {
    let names: Vec<&str> = match names {
        Names::List(list) => list.iter().map(String::as_str).collect(),
        Names::Text(text) => INVITE_SPLIT.split(text).collect(),
    };
    let mut out: Vec<i64> = vec![];
    for name in names.into_iter().map(str::trim).filter(|n| !n.is_empty()).take(10) {
        let Some(u) = find_user(c, name).await?.filter(|u| u.banned == 0) else {
            return bad(format!("Nie ma gracza „{name}”"));
        };
        if u.id == me {
            return bad("Nie możesz zaprosić samego siebie 🙂");
        }
        if !out.contains(&u.id) {
            out.push(u.id);
        }
    }
    Ok(out)
}

async fn add_invites(c: &mut Conn, jid: i64, users: &[i64]) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO jackpot_invites (jackpot_id, user_id) SELECT $1, u FROM UNNEST($2::bigint[]) AS u ON CONFLICT DO NOTHING",
        jid,
        users
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Moje otwarte lobby o tym id (świeży wiersz) albo None
async fn open_lobby(c: &mut Conn, uid: i64, jid: i64, seat_needed: bool) -> sqlx::Result<Option<Jackpot>> {
    Ok(get_jackpot(c, jid).await?.filter(|j| j.status == JackpotStatus::Open && (!seat_needed || j.seat(uid).is_some())))
}

/// Moje otwarte lobby, w którym jestem założycielem
async fn my_own_lobby(c: &mut Conn, uid: i64, jid: i64) -> Res<Jackpot> {
    open_lobby(c, uid, jid, true).await?.filter(|j| j.seat(uid) == Some(Seat::A)).ok_or_else(|| AppError::bad(JACKPOT_GONE))
}

/// Blokuje obu graczy lobby (zawsze w tej samej kolejności) i zwraca świeży wiersz mojego otwartego lobby
async fn lock_lobby(c: &mut Conn, uid: i64, jid: i64) -> Res<Jackpot> {
    let j = open_lobby(c, uid, jid, true).await?.ok_or_else(|| AppError::bad(JACKPOT_GONE))?;
    lock_users(c, &[Some(j.creator_id), j.joiner_id]).await?;
    open_lobby(c, uid, jid, true).await?.ok_or_else(|| AppError::bad(JACKPOT_GONE))
}

/// Lobby, które widzę (publiczne, z zaproszeniem dla mnie, moje), moje lobby, ostatnie gry i moja historia
pub async fn casino_jackpot(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut c = cx.st.db.acquire().await?;
    let me = cx.uid();
    let lobbies = sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE status = 'open' AND (is_public = 1 OR creator_id = $1 OR joiner_id = $1
         OR EXISTS (SELECT 1 FROM jackpot_invites i WHERE i.jackpot_id = j.id AND i.user_id = $1)) ORDER BY id DESC LIMIT 60"#,
        me

    )
    .fetch_all(&mut *c)
    .await?;
    let recent = sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE status = 'done' ORDER BY finished_at DESC LIMIT 12"#
    )
    .fetch_all(&mut *c)
    .await?;
    let mine = sqlx::query_as!(
        Jackpot,
        r#"SELECT id, creator_id, joiner_id, status AS "status: JackpotStatus", winner_id, roll, created_at, finished_at,
                  is_public, ready_a, ready_b FROM jackpots j WHERE status != 'open' AND (creator_id = $1 OR joiner_id = $1) ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 12"#,
        me

    )
    .fetch_all(&mut *c)
    .await?;
    let current = my_lobby(&mut c, me).await?;
    ok(json!({
        "lobbies": jackpots_json(&mut c, &cx, lobbies).await?,
        "current": jackpot_json(&mut c, &cx, current).await?,
        "recent": jackpots_json(&mut c, &cx, recent).await?,
        "mine": jackpots_json(&mut c, &cx, mine).await?,
    }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CreateLobby {
    #[serde(default = "yes")]
    public: bool,
    invites: Names,
}

/// Nowe lobby: public i invites (nicki graczy). Karty wybiera się już w lobby.
pub async fn casino_jackpot_create(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<CreateLobby>) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    if my_lobby(&mut tx, cx.uid()).await?.is_some() {
        return bad("Jesteś już w lobby — najpierw je opuść");
    }
    let invites = invite_ids(&mut tx, cx.uid(), &req.invites).await?;
    let jid = sqlx::query_scalar!(
        "INSERT INTO jackpots (creator_id, is_public, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING id",
        cx.uid(),
        i32::from(req.public),
        now()
    )
    .fetch_one(&mut *tx)
    .await?;
    add_invites(&mut tx, jid, &invites).await?;
    tx.commit().await?;
    ok(lobby_reply(&cx, jid).await?)
}

/// Zajęcie wolnego miejsca w lobby (publicznym albo z zaproszeniem dla mnie)
pub async fn casino_jackpot_join(State(st): State<AppState>, Me(me): Me, Path(jid): Path<i64>) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(j) = open_lobby(&mut tx, cx.uid(), jid, false).await? else { return bad(JACKPOT_GONE) };
    if j.seat(cx.uid()).is_none() {
        if !jackpot_can_see(&mut tx, &j, cx.uid()).await? {
            return fail(StatusCode::FORBIDDEN, "To lobby jest prywatne — potrzebujesz zaproszenia");
        }
        if my_lobby(&mut tx, cx.uid()).await?.is_some() {
            return bad("Jesteś już w innym lobby — najpierw je opuść");
        }
        let joined = sqlx::query!(
            "UPDATE jackpots SET joiner_id = $1, ready_a = 0, ready_b = 0, updated_at = $2 WHERE id = $3
             AND status = 'open' AND joiner_id IS NULL",
            cx.uid(),
            now(),
            jid
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if joined == 0 {
            return bad("Ktoś był szybszy — w tym lobby nie ma już miejsca");
        }
    }
    tx.commit().await?;
    ok(lobby_reply(&cx, jid).await?)
}

/// Drugi gracz wychodzi (albo założyciel go wyprasza): jego karty znikają z lobby, akceptacje się cofają
pub async fn free_seat(c: &mut Conn, jid: i64) -> sqlx::Result<()> {
    sqlx::query!("DELETE FROM jackpot_items WHERE jackpot_id = $1 AND side = 'b'", jid).execute(&mut *c).await?;
    sqlx::query!("UPDATE jackpots SET joiner_id = NULL, ready_a = 0, ready_b = 0, updated_at = $1 WHERE id = $2", now(), jid)
        .execute(c)
        .await?;
    Ok(())
}

/// Wyjście z lobby - założyciel zamyka całe lobby (karty niczyje nie były zablokowane)
pub async fn casino_jackpot_leave(State(st): State<AppState>, Me(me): Me, Path(jid): Path<i64>) -> Res {
    let cat = st.cat();
    settle_market(&st.db, &cat).await?;
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let Some(j) = open_lobby(&mut tx, me.id, jid, true).await? else { return bad(JACKPOT_GONE) };
    if j.seat(me.id) == Some(Seat::A) {
        sqlx::query!(
            "UPDATE jackpots SET status = 'cancelled', finished_at = $1, updated_at = $1 WHERE id = $2 AND status = 'open'",
            now(),
            jid
        )
        .execute(&mut *tx)
        .await?;
    } else {
        free_seat(&mut tx, jid).await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true}))
}

pub async fn casino_jackpot_kick(State(st): State<AppState>, Me(me): Me, Path(jid): Path<i64>) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    if my_own_lobby(&mut tx, cx.uid(), jid).await?.has_joiner() {
        free_seat(&mut tx, jid).await?;
    }
    tx.commit().await?;
    ok(lobby_reply(&cx, jid).await?)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct LobbySettings {
    public: Option<bool>,
    invite: Option<Names>,
    /// id gracza do usunięcia z zaproszonych
    uninvite: Option<i64>,
}

/// Założyciel: publiczne / prywatne, zaproszenia
pub async fn casino_jackpot_settings(
    State(st): State<AppState>,
    Me(me): Me,
    Path(jid): Path<i64>,
    JsonBody(req): JsonBody<LobbySettings>,
) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    my_own_lobby(&mut tx, cx.uid(), jid).await?;
    if let Some(public) = req.public {
        sqlx::query!("UPDATE jackpots SET is_public = $1 WHERE id = $2", i32::from(public), jid).execute(&mut *tx).await?;
    }
    if let Some(names) = &req.invite {
        let invites = invite_ids(&mut tx, cx.uid(), names).await?;
        add_invites(&mut tx, jid, &invites).await?;
    }
    if let Some(uid) = req.uninvite.filter(|u| *u != 0) {
        sqlx::query!("DELETE FROM jackpot_invites WHERE jackpot_id = $1 AND user_id = $2", jid, uid).execute(&mut *tx).await?;
    }
    sqlx::query!("UPDATE jackpots SET updated_at = $1 WHERE id = $2", now(), jid).execute(&mut *tx).await?;
    tx.commit().await?;
    ok(lobby_reply(&cx, jid).await?)
}

/// Moje karty w lobby (cała nowa lista). Każda zmiana cofa akceptację obu graczy.
pub async fn casino_jackpot_cards(
    State(st): State<AppState>,
    Me(me): Me,
    Path(jid): Path<i64>,
    JsonBody(req): JsonBody<StakeRequest>,
) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    let j = lock_lobby(&mut tx, cx.uid(), jid).await?;
    let seat = j.seat(cx.uid()).unwrap_or(Seat::B);
    let max = g().jackpot.max_cards;
    if req.ids.len() > max {
        return bad(format!("Najwyżej {max} kart"));
    }
    let rows = if req.ids.is_empty() { vec![] } else { take_my_items(&mut tx, &cx.cat, cx.uid(), &req.ids, Use::Stake).await? };
    sqlx::query!("DELETE FROM jackpot_items WHERE jackpot_id = $1 AND side = $2", jid, seat.as_str()).execute(&mut *tx).await?;
    for r in &rows {
        sqlx::query!(
            "INSERT INTO jackpot_items (jackpot_id, side, item_id, person_id, variant, value) VALUES ($1, $2, $3, $4, $5, $6)",
            jid,
            seat.as_str(),
            r.id,
            r.person_id,
            r.variant,
            row_value(&cx.cat, r)
        )
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query!("UPDATE jackpots SET ready_a = 0, ready_b = 0, updated_at = $1 WHERE id = $2", now(), jid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    ok(lobby_reply(&cx, jid).await?)
}

/// Obaj zaakceptowali: sprawdzamy, czy gracze nadal mają swoje karty, losujemy zwycięzcę i dajemy mu wszystkie karty.
/// Zwraca komunikat błędu (wtedy brakujące karty znikają z lobby, a akceptacje się cofają) albo None.
async fn jackpot_play(c: &mut Conn, cx: &Ctx, j: &Jackpot) -> sqlx::Result<Option<&'static str>> {
    let now = now();
    let rows = jackpot_cards(c, j.id).await?;
    let (mut gone, mut value_a, mut value_b) = (vec![], 0i64, 0i64);
    for r in &rows {
        let owner = match r.side {
            Seat::A => Some(j.creator_id),
            Seat::B => j.joiner_id,
        };
        let item = sqlx::query_as!(
            ItemRow,
            "SELECT id, person_id, variant, favorite, created_at FROM items WHERE id = $1 AND user_id = $2 AND favorite = 0",
            r.item_id,
            owner
        )
        .fetch_optional(&mut *c)
        .await?
        .filter(|it| cx.person(&it.person_id).is_some_and(|p| !p.is_special()));
        let Some(item) = item else {
            gone.push(r.item_id);
            continue;
        };
        let v = row_value(&cx.cat, &item);
        match r.side {
            Seat::A => value_a += v,
            Seat::B => value_b += v,
        }
        sqlx::query!("UPDATE jackpot_items SET value = $1 WHERE jackpot_id = $2 AND item_id = $3", v, j.id, item.id)
            .execute(&mut *c)
            .await?;
    }
    if !gone.is_empty() || value_a == 0 || value_b == 0 {
        sqlx::query!("DELETE FROM jackpot_items WHERE jackpot_id = $1 AND item_id = ANY($2)", j.id, &gone)
            .execute(&mut *c)
            .await?;
        sqlx::query!("UPDATE jackpots SET ready_a = 0, ready_b = 0, updated_at = $1 WHERE id = $2", now, j.id)
            .execute(&mut *c)
            .await?;
        return Ok(Some(if gone.is_empty() {
            "Obaj gracze muszą postawić karty"
        } else {
            "Część kart z lobby nie jest już u graczy (sprzedane, oznaczone ⭐ albo użyte gdzie indziej) — usunęliśmy je, \
             zaakceptujcie jeszcze raz"
        }));
    }
    let roll = random();
    let winner =
        if roll < value_a as f64 / (value_a + value_b) as f64 { j.creator_id } else { j.joiner_id.unwrap_or(j.creator_id) };
    let done = sqlx::query!(
        "UPDATE jackpots SET status = 'done', value_a = $1, value_b = $2, winner_id = $3, roll = $4, finished_at = $5,
         updated_at = $5 WHERE id = $6 AND status = 'open'",
        value_a,
        value_b,
        winner,
        roll,
        now,
        j.id
    )
    .execute(&mut *c)
    .await?
    .rows_affected();
    if done == 0 {
        return Ok(Some(JACKPOT_GONE));
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.item_id).collect();
    give_items(c, &cx.cat, &ids, winner, "transfer").await?; // zwycięzca: swoje karty z powrotem + karty rywala
    metrics::counter!("scambox_casino_games_total", "game" => "jackpot", "result" => "done").increment(1);
    Ok(None)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ReadyRequest {
    #[serde(default = "yes")]
    ready: bool,
}

/// Akceptacja (ready: true / false). Gdy zaakceptują obaj - od razu losowanie.
pub async fn casino_jackpot_ready(
    State(st): State<AppState>,
    Me(me): Me,
    Path(jid): Path<i64>,
    JsonBody(req): JsonBody<ReadyRequest>,
) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    let j = lock_lobby(&mut tx, cx.uid(), jid).await?;
    let seat = j.seat(cx.uid()).unwrap_or(Seat::B);
    if req.ready && !j.has_joiner() {
        return bad("Poczekaj na drugiego gracza");
    }
    if req.ready && !jackpot_cards(&mut tx, jid).await?.iter().any(|r| r.side == seat) {
        return bad("Najpierw wybierz swoje karty");
    }
    let ready = i32::from(req.ready);
    match seat {
        Seat::A => {
            sqlx::query!("UPDATE jackpots SET ready_a = $1, updated_at = $2 WHERE id = $3", ready, now(), jid)
                .execute(&mut *tx)
                .await?
        }
        Seat::B => {
            sqlx::query!("UPDATE jackpots SET ready_b = $1, updated_at = $2 WHERE id = $3", ready, now(), jid)
                .execute(&mut *tx)
                .await?
        }
    };
    let j = get_jackpot(&mut tx, jid).await?.ok_or_else(|| AppError::bad(JACKPOT_GONE))?;
    if j.ready_a == 0 || j.ready_b == 0 {
        tx.commit().await?;
        return ok(lobby_reply(&cx, jid).await?);
    }
    let error = jackpot_play(&mut tx, &cx, &j).await?;
    tx.commit().await?;
    let mut reply = lobby_reply(&cx, jid).await?;
    if let Some(err) = error {
        reply.error = Some(err);
        return Err(AppError::Json(StatusCode::CONFLICT, serde_json::to_value(reply).map_err(anyhow::Error::from)?));
    }
    let mut c = cx.st.db.acquire().await?;
    reply.items = Some(my_items(&mut c, &cx.cat, cx.uid()).await?);
    reply.state = Some(get_state(&mut c, cx.uid()).await?);
    ok(reply)
}

/// Gracz obejrzał wynik gry - nie pokazujemy go ponownie (zapamiętany koniec gry w ms)
pub async fn casino_jackpot_seen(State(st): State<AppState>, Me(me): Me, Path(jid): Path<i64>) -> Res {
    let mut c = st.db.acquire().await?;
    let finished = get_jackpot(&mut c, jid).await?.filter(|j| j.status == JackpotStatus::Done && j.seat(me.id).is_some());
    if let Some(j) = finished {
        let ms = (j.finished_at.unwrap_or(0.0) * 1000.0) as i64 + 1;
        if ms > get_state(&mut c, me.id).await?["jackpot_seen"] {
            set_state(&mut c, me.id, "jackpot_seen", ms).await?;
        }
    }
    ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hand(cards: &[&str]) -> Vec<Card> {
        cards.iter().map(|c| Card((*c).into())).collect()
    }

    #[test]
    fn blackjack_points() {
        assert_eq!(total(&hand(&["AS", "KH"])), 21);
        assert!(is_blackjack(&hand(&["AS", "TH"])));
        assert_eq!(total(&hand(&["AS", "AH", "9C"])), 21);
        assert_eq!(total(&hand(&["KS", "QH", "5C"])), 25);
        assert_eq!(new_deck(6).len(), 312);
        let n: Names = serde_json::from_str(r#""ala, bartek""#).unwrap();
        assert!(matches!(n, Names::Text(_)));
        let n: Names = serde_json::from_str(r#"["ala"]"#).unwrap();
        assert!(matches!(n, Names::List(_)));
    }
}
