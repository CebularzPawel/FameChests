//! Rynek kart: oferty za stałą cenę (z propozycjami niższej ceny), licytacje i zlecenia "Szukam".

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{ok, JsonBody};
use crate::auth::{Me, UserView};
use crate::data::g;
use crate::db::{lock_me, now, Conn};
use crate::error::{bad, fail, AppError, Res};
use crate::game::market::*;
use crate::game::views::CardJson;
use crate::game::*;
use crate::state::AppState;
use crate::text::{fmt_money, group_thousands};

const MARKET_GONE: &str = "Ta oferta jest już nieaktualna";

/// Cena w dozwolonym zakresie (1 .. maxPrice) albo None
fn market_price(raw: Option<i64>) -> Option<i64> {
    raw.filter(|v| (1..=g().market.max_price).contains(v))
}

fn price_error() -> String {
    format!("Cena: od 1 do {} gr", group_thousands(g().market.max_price))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum WantedStatus {
    Active,
    Filled,
    Cancelled,
}

/// Zlecenie "Szukam"
struct Wanted {
    id: i64,
    buyer_id: i64,
    person_id: String,
    variant: String,
    price: i64,
    status: WantedStatus,
    seller_id: Option<i64>,
    created_at: f64,
    updated_at: f64,
}

// ---------------------------------------------------------------- widok rynku

type Users = HashMap<i64, UserView>;

fn user(users: &Users, id: Option<i64>) -> Option<UserView> {
    id.and_then(|i| users.get(&i)).cloned()
}

#[derive(Serialize)]
struct OfferView {
    id: i64,
    price: i64,
    buyer: Option<UserView>,
    created: f64,
}

#[derive(Serialize)]
struct MyOffer {
    id: i64,
    price: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListingView {
    #[serde(flatten)]
    card: CardJson,
    id: i64,
    /// egzemplarz karty (rysunek na „Czystej kartce”)
    item: i64,
    kind: ListingKind,
    price: i64,
    step: i64,
    ends_at: Option<f64>,
    created: f64,
    seller: Option<UserView>,
    mine: bool,
    top_bid: Option<i64>,
    top_bidder: Option<String>,
    my_top: bool,
    bids: i64,
    /// propozycje cen - widzi je tylko sprzedający
    offers: Vec<OfferView>,
    my_offer: Option<MyOffer>,
}

#[derive(Serialize)]
struct WantedView {
    #[serde(flatten)]
    card: CardJson,
    id: i64,
    price: i64,
    created: f64,
    buyer: Option<UserView>,
    mine: bool,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Role {
    Seller,
    Buyer,
}

/// Wpis historii: typ = fixed / auction / wanted
#[derive(Serialize)]
struct HistoryView {
    #[serde(flatten)]
    card: CardJson,
    id: i64,
    #[serde(rename = "type")]
    type_: &'static str,
    status: &'static str,
    role: Role,
    price: i64,
    at: f64,
    other: Option<UserView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MyOfferView {
    #[serde(flatten)]
    card: CardJson,
    id: i64,
    listing: i64,
    price: i64,
    list_price: i64,
    status: OfferStatus,
    at: f64,
    seller: Option<UserView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketResponse {
    now: f64,
    listings: Vec<ListingView>,
    wanted: Vec<WantedView>,
    history: Vec<HistoryView>,
    my_offers: Vec<MyOfferView>,
}

fn listing_status(s: ListingStatus) -> &'static str {
    match s {
        ListingStatus::Active => "active",
        ListingStatus::Sold => "sold",
        ListingStatus::Expired => "expired",
        ListingStatus::Cancelled => "cancelled",
    }
}

fn listing_kind(k: ListingKind) -> &'static str {
    match k {
        ListingKind::Fixed => "fixed",
        ListingKind::Auction => "auction",
    }
}

pub async fn market(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut c = cx.st.db.acquire().await?;
    let (me, now) = (cx.uid(), now());
    let found = discovered(&mut c, me).await?;
    let known = |pid: &str| cx.cat.has(pid);
    let listings: Vec<Listing> = sqlx::query_as!(
        Listing,
        r#"SELECT id, seller_id, item_id, person_id, variant, kind AS "kind: ListingKind", price, step,
                  status AS "status: ListingStatus", buyer_id, final_price, created_at, ends_at, updated_at
           FROM market_listings WHERE status = 'active' ORDER BY id DESC LIMIT 1000"#
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .filter(|r| known(&r.person_id))
    .collect();
    let history: Vec<Listing> = sqlx::query_as!(
        Listing,
        r#"SELECT id, seller_id, item_id, person_id, variant, kind AS "kind: ListingKind", price, step,
                  status AS "status: ListingStatus", buyer_id, final_price, created_at, ends_at, updated_at
           FROM market_listings WHERE status != 'active' AND (seller_id = $1 OR buyer_id = $1) ORDER BY updated_at DESC LIMIT 40"#,
        me
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .filter(|r| known(&r.person_id))
    .collect();
    let wanted: Vec<Wanted> = sqlx::query_as!(
        Wanted,
        r#"SELECT id, buyer_id, person_id, variant, price, status AS "status: WantedStatus", seller_id, created_at, updated_at
           FROM market_wanted WHERE status = 'active' ORDER BY id DESC LIMIT 500"#
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .filter(|r| known(&r.person_id))
    .collect();
    let filled: Vec<Wanted> = sqlx::query_as!(
        Wanted,
        r#"SELECT id, buyer_id, person_id, variant, price, status AS "status: WantedStatus", seller_id, created_at, updated_at
           FROM market_wanted WHERE status = 'filled' AND (buyer_id = $1 OR seller_id = $1) ORDER BY updated_at DESC LIMIT 20"#,
        me
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .filter(|r| known(&r.person_id))
    .collect();
    let my_offers = sqlx::query!(
        r#"SELECT o.id, o.listing_id, o.price, o.status AS "status: OfferStatus", o.updated_at, l.person_id, l.variant,
                  l.price AS list_price, l.seller_id
           FROM market_offers o JOIN market_listings l ON l.id = o.listing_id WHERE o.buyer_id = $1
           AND (o.status = 'pending' OR o.updated_at > $2) ORDER BY o.id DESC LIMIT 40"#,
        me,
        now - 7.0 * 86400.0
    )
    .fetch_all(&mut *c)
    .await?;
    let lids: Vec<i64> = listings.iter().map(|r| r.id).collect();
    let mut tops: HashMap<i64, Bid> = HashMap::new();
    let bids = sqlx::query_as!(
        Bid,
        "SELECT id, listing_id, bidder_id, amount FROM market_bids WHERE status = 'active' AND listing_id = ANY($1)",
        &lids
    )
    .fetch_all(&mut *c)
    .await?;
    for b in bids {
        if tops.get(&b.listing_id).is_none_or(|t| b.amount > t.amount) {
            tops.insert(b.listing_id, b);
        }
    }
    let counts: HashMap<i64, i64> = sqlx::query!(
        r#"SELECT listing_id, COUNT(*) AS "n!" FROM market_bids WHERE listing_id = ANY($1) GROUP BY listing_id"#,
        &lids
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .map(|r| (r.listing_id, r.n))
    .collect();
    let mut offers: HashMap<i64, Vec<Offer>> = HashMap::new();
    let pending = sqlx::query_as!(
        Offer,
        r#"SELECT id, listing_id, buyer_id, price, status AS "status: OfferStatus", created_at
           FROM market_offers WHERE status = 'pending' AND listing_id = ANY($1) ORDER BY price DESC"#,
        &lids
    )
    .fetch_all(&mut *c)
    .await?;
    for o in pending {
        offers.entry(o.listing_id).or_default().push(o);
    }
    let ids = listings
        .iter()
        .chain(&history)
        .map(|r| Some(r.seller_id))
        .chain(history.iter().map(|r| r.buyer_id))
        .chain(tops.values().map(|b| Some(b.bidder_id)))
        .chain(offers.values().flatten().map(|o| Some(o.buyer_id)))
        .chain(wanted.iter().chain(&filled).map(|r| Some(r.buyer_id)))
        .chain(filled.iter().map(|r| r.seller_id))
        .chain(my_offers.iter().map(|o| Some(o.seller_id)))
        .collect::<Vec<_>>();
    let users: Users = users_by_id(&mut c, &cx.cat, ids).await?.into_iter().collect();
    let card = |pid: &str, variant: &str, f: &HashSet<String>| CardJson::new(&cx.st.images, &cx.cat, pid, variant, f);

    let listings = listings
        .iter()
        .map(|r| {
            let (top, mine) = (tops.get(&r.id), r.seller_id == me);
            let list_offers = offers.get(&r.id).map(Vec::as_slice).unwrap_or_default();
            ListingView {
                card: card(&r.person_id, &r.variant, &found),
                id: r.id,
                item: r.item_id,
                kind: r.kind,
                price: r.price,
                step: r.step,
                ends_at: r.ends_at,
                created: r.created_at,
                seller: user(&users, Some(r.seller_id)),
                mine,
                top_bid: top.map(|t| t.amount),
                top_bidder: top.and_then(|t| users.get(&t.bidder_id)).map(|u| u.username.clone()),
                my_top: top.is_some_and(|t| t.bidder_id == me),
                bids: counts.get(&r.id).copied().unwrap_or(0),
                offers: if mine {
                    list_offers
                        .iter()
                        .map(|o| OfferView {
                            id: o.id,
                            price: o.price,
                            buyer: user(&users, Some(o.buyer_id)),
                            created: o.created_at,
                        })
                        .collect()
                } else {
                    vec![]
                },
                my_offer: list_offers.iter().find(|o| o.buyer_id == me).map(|o| MyOffer { id: o.id, price: o.price }),
            }
        })
        .collect();
    let wanted = wanted
        .iter()
        .map(|r| {
            // własne zlecenie na tajną kartę - karta jest znana
            let own: HashSet<String> = [r.person_id.clone()].into();
            WantedView {
                card: card(&r.person_id, &r.variant, if r.buyer_id == me { &own } else { &found }),
                id: r.id,
                price: r.price,
                created: r.created_at,
                buyer: user(&users, Some(r.buyer_id)),
                mine: r.buyer_id == me,
            }
        })
        .collect();
    let mut past: Vec<HistoryView> = history
        .iter()
        .map(|r| {
            let seller = r.seller_id == me;
            HistoryView {
                card: card(&r.person_id, &r.variant, &found),
                id: r.id,
                type_: listing_kind(r.kind),
                status: listing_status(r.status),
                role: if seller { Role::Seller } else { Role::Buyer },
                price: if r.final_price != 0 { r.final_price } else { r.price },
                at: r.updated_at,
                other: user(&users, if seller { r.buyer_id } else { Some(r.seller_id) }),
            }
        })
        .chain(filled.iter().map(|r| {
            let buyer = r.buyer_id == me;
            HistoryView {
                card: card(&r.person_id, &r.variant, &found),
                id: r.id,
                type_: "wanted",
                status: "filled",
                role: if buyer { Role::Buyer } else { Role::Seller },
                price: r.price,
                at: r.updated_at,
                other: user(&users, if buyer { r.seller_id } else { Some(r.buyer_id) }),
            }
        }))
        .collect();
    past.sort_by(|a, b| b.at.total_cmp(&a.at));
    past.truncate(50);
    let my_offers = my_offers
        .into_iter()
        .filter(|o| known(&o.person_id))
        .map(|o| MyOfferView {
            card: card(&o.person_id, &o.variant, &found),
            id: o.id,
            listing: o.listing_id,
            price: o.price,
            list_price: o.list_price,
            status: o.status,
            at: o.updated_at,
            seller: user(&users, Some(o.seller_id)),
        })
        .collect();
    set_state(&mut c, me, "market_seen", now as i64).await?;
    ok(MarketResponse { now, listings, wanted, history: past, my_offers })
}

// ---------------------------------------------------------------- oferty

fn twenty_four() -> i64 {
    24
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ListRequest {
    item: Option<i64>,
    kind: String,
    price: Option<i64>,
    /// licytacja: minimalne przebicie (0 / brak = 1)
    step: Option<i64>,
    /// licytacja: czas w godzinach (0 / brak = 24)
    #[serde(default = "twenty_four")]
    hours: i64,
}

/// Wystawienie karty: stała cena albo licytacja (cena wywoławcza, min. przebicie, czas)
pub async fn market_list(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<ListRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let rules = &g().market;
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(item_id) = req.item else { return bad("Wybierz kartę") };
    let kind = match req.kind.as_str() {
        "fixed" => ListingKind::Fixed,
        "auction" => ListingKind::Auction,
        _ => return bad("Nieprawidłowy rodzaj oferty"),
    };
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &[item_id], Use::Market).await?;
    let price = market_price(req.price).ok_or_else(|| AppError::bad(price_error()))?;
    let now = now();
    let (step, ends) = match kind {
        ListingKind::Fixed => (0, None),
        ListingKind::Auction => {
            let step = market_price(req.step.filter(|s| *s != 0).or(Some(1)))
                .ok_or_else(|| AppError::bad("Minimalne przebicie: od 1 $"))?;
            let hours = if req.hours == 0 { 24 } else { req.hours };
            if !rules.auction_hours.contains(&hours) {
                return bad("Nieprawidłowy czas licytacji");
            }
            (step, Some(now + hours as f64 * 3600.0))
        }
    };
    let active = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!" FROM market_listings WHERE seller_id = $1 AND status = 'active'"#,
        cx.uid()
    )
    .fetch_one(&mut *tx)
    .await?;
    if active >= rules.max_listings {
        return bad(format!("Możesz mieć najwyżej {} ofert naraz", rules.max_listings));
    }
    let r = &rows[0];
    escrow_items(&mut tx, cx.uid(), &[item_id]).await?;
    let lid = sqlx::query_scalar!(
        "INSERT INTO market_listings (seller_id, item_id, person_id, variant, kind, price, step, created_at, ends_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8) RETURNING id",
        cx.uid(),
        item_id,
        r.person_id,
        r.variant,
        listing_kind(kind),
        price,
        step,
        now,
        ends
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    ok(json!({"ok": true, "id": lid, "consumed": [item_id]}))
}

/// Karta z oferty po transakcji (dla przeglądarki)
async fn item_view(c: &mut Conn, cx: &Ctx, item_id: i64) -> sqlx::Result<Option<ItemJson>> {
    Ok(item_by_id(c, item_id).await?.and_then(|r| item_json(&cx.cat, &r)))
}

pub async fn market_buy(State(st): State<AppState>, Me(me): Me, Path(lid): Path<i64>) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(l) = claim_listing(&mut tx, lid, Claim::Fixed).await?.filter(|l| cx.cat.has(&l.person_id)) else {
        return bad(MARKET_GONE);
    };
    if l.seller_id == cx.uid() {
        return bad("To twoja oferta");
    }
    if balance(&mut tx, cx.uid()).await? < l.price {
        return bad("Za mało pieniędzy!");
    }
    let now = now();
    sqlx::query!(
        "UPDATE market_listings SET status = 'sold', buyer_id = $1, final_price = $2, updated_at = $3 WHERE id = $4",
        cx.uid(),
        l.price,
        now,
        lid
    )
    .execute(&mut *tx)
    .await?;
    add_state(&mut tx, cx.uid(), "balance", -l.price).await?;
    add_state(&mut tx, l.seller_id, "balance", after_fee(l.price)).await?;
    give_items(&mut tx, &cx.cat, &[l.item_id], cx.uid(), "transfer").await?;
    refund_offers(&mut tx, lid, now).await?;
    tx.commit().await?;
    metrics::counter!("scambox_market_trades_total", "kind" => "fixed").increment(1);
    let mut c = cx.st.db.acquire().await?;
    ok(json!({"ok": true, "item": item_view(&mut c, &cx, l.item_id).await?, "state": get_state(&mut c, cx.uid()).await?}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct OfferRequest {
    price: Option<i64>,
}

/// Propozycja niższej ceny - pieniądze są od razu blokowane; sprzedający może ją przyjąć albo odrzucić
pub async fn market_offer(
    State(st): State<AppState>,
    Me(me): Me,
    Path(lid): Path<i64>,
    JsonBody(req): JsonBody<OfferRequest>,
) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(l) = claim_listing(&mut tx, lid, Claim::Fixed).await?.filter(|l| cx.cat.has(&l.person_id)) else {
        return bad(MARKET_GONE);
    };
    if l.seller_id == cx.uid() {
        return bad("To twoja oferta");
    }
    let Some(price) = market_price(req.price).filter(|p| *p < l.price) else {
        return bad(format!("Zaproponuj cenę niższą niż {} (albo po prostu kup kartę)", fmt_money(l.price)));
    };
    let now = now();
    let old = sqlx::query_as!(
        Offer,
        r#"SELECT id, listing_id, buyer_id, price, status AS "status: OfferStatus", created_at
           FROM market_offers WHERE listing_id = $1 AND buyer_id = $2 AND status = 'pending'"#,
        lid,
        cx.uid()
    )
    .fetch_optional(&mut *tx)
    .await?;
    if balance(&mut tx, cx.uid()).await? + old.as_ref().map_or(0, |o| o.price) < price {
        return bad("Za mało pieniędzy!");
    }
    if let Some(old) = old {
        // nowa propozycja zastępuje poprzednią
        sqlx::query!("UPDATE market_offers SET status = 'cancelled', updated_at = $1 WHERE id = $2", now, old.id)
            .execute(&mut *tx)
            .await?;
        add_state(&mut tx, cx.uid(), "balance", old.price).await?;
    }
    add_state(&mut tx, cx.uid(), "balance", -price).await?;
    sqlx::query!(
        "INSERT INTO market_offers (listing_id, buyer_id, price, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        lid,
        cx.uid(),
        price,
        now
    )
    .execute(&mut *tx)
    .await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "state": state}))
}

/// Ustawia status propozycji, jeśli wciąż czeka. true = zmieniono.
async fn close_offer(c: &mut Conn, oid: i64, status: &str, now: f64) -> sqlx::Result<bool> {
    let n = sqlx::query!(
        "UPDATE market_offers SET status = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
        status,
        now,
        oid
    )
    .execute(c)
    .await?
    .rows_affected();
    Ok(n > 0)
}

/// accept / decline - sprzedający; cancel - kupujący wycofuje swoją propozycję
pub async fn market_offer_action(State(st): State<AppState>, Me(me): Me, Path((oid, action)): Path<(i64, String)>) -> Res {
    if !matches!(action.as_str(), "accept" | "decline" | "cancel") {
        return Err(AppError::not_found());
    }
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let (me, now) = (cx.uid(), now());
    let offer = sqlx::query_as!(
        Offer,
        r#"SELECT id, listing_id, buyer_id, price, status AS "status: OfferStatus", created_at FROM market_offers WHERE id = $1"#,
        oid
    )
    .fetch_optional(&mut *tx)
    .await?
    .filter(|o| o.status == OfferStatus::Pending);
    let Some(o) = offer else { return bad(MARKET_GONE) };
    let Some(l) = get_listing(&mut tx, o.listing_id).await? else { return bad(MARKET_GONE) };
    match action.as_str() {
        "cancel" => {
            if o.buyer_id != me {
                return fail(StatusCode::FORBIDDEN, "To nie twoja propozycja");
            }
            if close_offer(&mut tx, oid, "cancelled", now).await? {
                add_state(&mut tx, me, "balance", o.price).await?;
            }
        }
        _ if l.seller_id != me => return fail(StatusCode::FORBIDDEN, "To nie twoja oferta"),
        "decline" => {
            if close_offer(&mut tx, oid, "declined", now).await? {
                add_state(&mut tx, o.buyer_id, "balance", o.price).await?;
            }
        }
        _ => {
            let Some(l) = claim_listing(&mut tx, l.id, Claim::Any).await?.filter(|l| cx.cat.has(&l.person_id)) else {
                return bad(MARKET_GONE);
            };
            if !close_offer(&mut tx, oid, "accepted", now).await? {
                return bad("Kupujący wycofał już tę propozycję");
            }
            sqlx::query!(
                "UPDATE market_listings SET status = 'sold', buyer_id = $1, final_price = $2, updated_at = $3 WHERE id = $4",
                o.buyer_id,
                o.price,
                now,
                l.id
            )
            .execute(&mut *tx)
            .await?;
            add_state(&mut tx, me, "balance", after_fee(o.price)).await?;
            give_items(&mut tx, &cx.cat, &[l.item_id], o.buyer_id, "transfer").await?;
            refund_offers(&mut tx, l.id, now).await?;
            metrics::counter!("scambox_market_trades_total", "kind" => "offer").increment(1);
        }
    }
    let state = get_state(&mut tx, me).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BidRequest {
    amount: Option<i64>,
}

pub async fn market_bid(
    State(st): State<AppState>,
    Me(me): Me,
    Path(lid): Path<i64>,
    JsonBody(req): JsonBody<BidRequest>,
) -> Res {
    let cx = Ctx::new(st, me);
    let rules = &g().market;
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let now = now();
    let l = claim_listing(&mut tx, lid, Claim::AuctionOpen(now)).await?.filter(|l| cx.cat.has(&l.person_id));
    let Some(l) = l else { return bad("Ta licytacja już się skończyła") };
    if l.seller_id == cx.uid() {
        return bad("Nie możesz licytować własnej karty");
    }
    let top = top_bid(&mut tx, lid).await?;
    if top.as_ref().is_some_and(|t| t.bidder_id == cx.uid()) {
        return bad("Twoja oferta jest już najwyższa");
    }
    let need = top.as_ref().map_or(l.price, |t| t.amount + l.step.max(1));
    let Some(amount) = market_price(req.amount).filter(|a| *a >= need) else {
        return bad(format!("Najmniejsza możliwa oferta: {}", fmt_money(need)));
    };
    if balance(&mut tx, cx.uid()).await? < amount {
        return bad("Za mało pieniędzy!");
    }
    add_state(&mut tx, cx.uid(), "balance", -amount).await?;
    sqlx::query!(
        "INSERT INTO market_bids (listing_id, bidder_id, amount, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        lid,
        cx.uid(),
        amount,
        now
    )
    .execute(&mut *tx)
    .await?;
    if let Some(top) = top {
        // przebity gracz dostaje pieniądze z powrotem
        sqlx::query!("UPDATE market_bids SET status = 'outbid', updated_at = $1 WHERE id = $2", now, top.id)
            .execute(&mut *tx)
            .await?;
        add_state(&mut tx, top.bidder_id, "balance", top.amount).await?;
    }
    if l.ends_at.unwrap_or(now) - now < rules.snipe_seconds {
        // oferta w ostatnich chwilach przedłuża licytację (bez "snajperów")
        sqlx::query!("UPDATE market_listings SET ends_at = $1 WHERE id = $2", now + rules.snipe_seconds, lid)
            .execute(&mut *tx)
            .await?;
    }
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "state": state}))
}

/// Wycofanie mojej oferty - karta wraca do ekwipunku (licytacji, w której ktoś już licytuje, nie da się wycofać)
pub async fn market_cancel(State(st): State<AppState>, Me(me): Me, Path(lid): Path<i64>) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(l) = claim_listing(&mut tx, lid, Claim::Seller(cx.uid())).await? else { return bad(MARKET_GONE) };
    if top_bid(&mut tx, lid).await?.is_some() {
        return bad("Ktoś już licytuje — tej licytacji nie można wycofać");
    }
    let now = now();
    sqlx::query!("UPDATE market_listings SET status = 'cancelled', updated_at = $1 WHERE id = $2", now, lid)
        .execute(&mut *tx)
        .await?;
    give_items(&mut tx, &cx.cat, &[l.item_id], cx.uid(), "transfer").await?;
    refund_offers(&mut tx, lid, now).await?;
    tx.commit().await?;
    let mut c = cx.st.db.acquire().await?;
    ok(json!({"ok": true, "item": item_view(&mut c, &cx, l.item_id).await?}))
}

// ---------------------------------------------------------------- zlecenia "Szukam"

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct WantedRequest {
    person: String,
    variant: String,
    price: Option<i64>,
}

/// Zlecenie "Szukam": kupię tę kartę (w tym wariancie) za tyle - pieniądze są blokowane do realizacji / wycofania
pub async fn market_wanted_create(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<WantedRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let rules = &g().market;
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let variant = if req.variant.is_empty() { "normal" } else { req.variant.as_str() };
    let Some(p) = cx.cat.person(&req.person).filter(|_| g().is_variant(variant)).cloned() else { return bad("Wybierz kartę") };
    if !cx.cat.possible_variants(&p).iter().any(|v| v == variant) {
        // np. Rzulty tylko dla Jana Pawła II, Królewska tylko ze Skrzyni Królów
        return bad("Ta karta nie występuje w tym wariancie");
    }
    if p.is_secret() && !discovered(&mut tx, cx.uid()).await?.contains(&p.id) {
        return bad("Tej tajnej karty jeszcze nie znasz");
    }
    let price = market_price(req.price).ok_or_else(|| AppError::bad(price_error()))?;
    let active =
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!" FROM market_wanted WHERE buyer_id = $1 AND status = 'active'"#, cx.uid())
            .fetch_one(&mut *tx)
            .await?;
    if active >= rules.max_wanted {
        return bad(format!("Możesz mieć najwyżej {} zleceń naraz", rules.max_wanted));
    }
    if balance(&mut tx, cx.uid()).await? < price {
        return bad("Za mało pieniędzy!");
    }
    add_state(&mut tx, cx.uid(), "balance", -price).await?;
    sqlx::query!(
        "INSERT INTO market_wanted (buyer_id, person_id, variant, price, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        cx.uid(),
        p.id,
        variant,
        price,
        now()
    )
    .execute(&mut *tx)
    .await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "state": state}))
}

pub async fn market_wanted_cancel(State(st): State<AppState>, Me(me): Me, Path(wid): Path<i64>) -> Res {
    settle_market(&st.db, &st.cat()).await?;
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let price = sqlx::query_scalar!(
        "UPDATE market_wanted SET status = 'cancelled', updated_at = $1 WHERE id = $2 AND buyer_id = $3 AND status = 'active'
         RETURNING price",
        now(),
        wid,
        me.id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(price) = price else { return bad(MARKET_GONE) };
    add_state(&mut tx, me.id, "balance", price).await?;
    let state = get_state(&mut tx, me.id).await?;
    tx.commit().await?;
    ok(json!({"ok": true, "state": state}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct FillRequest {
    item: Option<i64>,
}

/// Sprzedaję moją kartę komuś, kto jej szuka - od razu, za cenę ze zlecenia
pub async fn market_wanted_fill(
    State(st): State<AppState>,
    Me(me): Me,
    Path(wid): Path<i64>,
    JsonBody(req): JsonBody<FillRequest>,
) -> Res {
    let cx = Ctx::new(st, me);
    settle_market(&cx.st.db, &cx.cat).await?;
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let Some(item_id) = req.item else { return bad("Wybierz kartę") };
    let wanted = sqlx::query_as!(
        Wanted,
        r#"SELECT id, buyer_id, person_id, variant, price, status AS "status: WantedStatus", seller_id, created_at, updated_at
           FROM market_wanted WHERE id = $1"#,
        wid
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(w) = wanted.filter(|w| w.status == WantedStatus::Active) else { return bad(MARKET_GONE) };
    if w.buyer_id == cx.uid() {
        return bad("To twoje zlecenie");
    }
    let rows = take_my_items(&mut tx, &cx.cat, cx.uid(), &[item_id], Use::Market).await?;
    if rows[0].person_id != w.person_id || rows[0].variant != w.variant {
        return bad("Ta karta nie pasuje do zlecenia");
    }
    let filled = sqlx::query!(
        "UPDATE market_wanted SET status = 'filled', seller_id = $1, updated_at = $2 WHERE id = $3 AND status = 'active'",
        cx.uid(),
        now(),
        wid
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if filled == 0 {
        return bad(MARKET_GONE);
    }
    give_items(&mut tx, &cx.cat, &[item_id], w.buyer_id, "transfer").await?;
    add_state(&mut tx, cx.uid(), "balance", after_fee(w.price)).await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    metrics::counter!("scambox_market_trades_total", "kind" => "wanted").increment(1);
    ok(json!({"ok": true, "consumed": [item_id], "state": state}))
}

/// Usuwany gracz: jego karty z rynku znikają razem z nim, pieniądze innych graczy wracają, jego własne propozycje,
/// licytacje i zlecenia przepadają (pieniądze były już zabrane z jego konta)
pub async fn market_forget_user(c: &mut Conn, uid: i64) -> sqlx::Result<()> {
    let now = now();
    let listings = sqlx::query!("SELECT id, item_id FROM market_listings WHERE seller_id = $1 AND status = 'active'", uid)
        .fetch_all(&mut *c)
        .await?;
    for l in listings {
        sqlx::query!("UPDATE market_listings SET status = 'cancelled', updated_at = $1 WHERE id = $2", now, l.id)
            .execute(&mut *c)
            .await?;
        refund_offers(c, l.id, now).await?;
        let bids = sqlx::query!(
            "UPDATE market_bids SET status = 'refunded', updated_at = $1 WHERE listing_id = $2 AND status = 'active'
             RETURNING bidder_id, amount",
            now,
            l.id
        )
        .fetch_all(&mut *c)
        .await?;
        for b in bids {
            add_state(c, b.bidder_id, "balance", b.amount).await?;
        }
        sqlx::query!("DELETE FROM items WHERE id = $1 AND user_id = $2", l.item_id, ESCROW).execute(&mut *c).await?;
    }
    sqlx::query!(
        "UPDATE market_offers SET status = 'cancelled', updated_at = $1 WHERE buyer_id = $2 AND status = 'pending'",
        now,
        uid
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        "UPDATE market_bids SET status = 'refunded', updated_at = $1 WHERE bidder_id = $2 AND status = 'active'",
        now,
        uid
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        "UPDATE market_wanted SET status = 'cancelled', updated_at = $1 WHERE buyer_id = $2 AND status = 'active'",
        now,
        uid
    )
    .execute(&mut *c)
    .await?;
    // jego lobby jackpota: założone - zamykamy, w cudzym - zwalniamy miejsce; znika też z zaproszeń
    sqlx::query!(
        "UPDATE jackpots SET status = 'cancelled', finished_at = $1 WHERE creator_id = $2 AND status = 'open'",
        now,
        uid
    )
    .execute(&mut *c)
    .await?;
    let joined =
        sqlx::query_scalar!("SELECT id FROM jackpots WHERE joiner_id = $1 AND status = 'open'", uid).fetch_all(&mut *c).await?;
    for jid in joined {
        super::casino::free_seat(c, jid).await?;
    }
    sqlx::query!("DELETE FROM jackpot_invites WHERE user_id = $1", uid).execute(c).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests() {
        let r: ListRequest =
            serde_json::from_str(r#"{"item": 5, "kind": "auction", "price": 20, "step": 0, "hours": 1}"#).unwrap();
        assert_eq!((r.item, r.step, r.hours), (Some(5), Some(0), 1));
        let r: ListRequest = serde_json::from_str(r#"{"kind": "fixed"}"#).unwrap();
        assert_eq!((r.item, r.hours), (None, 24));
        assert_eq!(market_price(Some(0)), None);
        assert_eq!(market_price(Some(10)), Some(10));
    }
}
