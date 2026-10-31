//! Znajomi, aktywność (feed), pokazywanie kart, wymiany, gablota, profile, ranking, /api/me, wiadomości od adminów,
//! Hall of Fame, lista zmian, linki do kart specjalnych.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::cookie::SignedCookieJar;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, JsonBody};
use crate::auth::{find_user, session_cookie, user_by_id, Me, User, UserView};
use crate::data::g;
use crate::db::{lock_me, lock_users, now, Conn};
use crate::error::{bad, fail, AppError, Res};
use crate::game::market::{market_badge, settle_market};
use crate::game::views::{reveal, PublicPerson};
use crate::game::*;
use crate::state::AppState;
use crate::text::clean;

const TRADE_MAX_LINES: usize = 30;
// Wymiany są tylko na karty - pieniędzy nie da się przekazać (kolumny money_give / money_want zostają dla starych wymian)
const TRADE_NO_MONEY: &str = "W wymianach można dawać tylko karty — bez pieniędzy";

fn one() -> i64 {
    1
}

fn normal() -> String {
    "normal".into()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UsernameRequest {
    username: String,
}

// ---------------------------------------------------------------- znajomi

#[derive(Serialize, Default)]
struct FriendsResponse {
    friends: Vec<UserBrief>,
    incoming: Vec<UserBrief>,
    outgoing: Vec<UserBrief>,
}

pub async fn friends(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let stats = collection_stats(&mut c, &cat).await?;
    let users: HashMap<i64, User> =
        sqlx::query_as!(User, "SELECT * FROM users").fetch_all(&mut *c).await?.into_iter().map(|u| (u.id, u)).collect();
    let rows =
        sqlx::query!("SELECT * FROM friendships WHERE requester_id = $1 OR addressee_id = $1", me.id).fetch_all(&mut *c).await?;
    let mut out = FriendsResponse::default();
    for r in rows {
        let mine = r.requester_id == me.id;
        let other = if mine { r.addressee_id } else { r.requester_id };
        let Some(u) = users.get(&other) else { continue };
        let list = match (r.status == "accepted", mine) {
            (true, _) => &mut out.friends,
            (false, true) => &mut out.outgoing,
            (false, false) => &mut out.incoming,
        };
        list.push(UserBrief::new(&cat, u, &stats));
    }
    for list in [&mut out.friends, &mut out.incoming, &mut out.outgoing] {
        list.sort_by_cached_key(|x| x.user.username.to_lowercase());
    }
    ok(out)
}

pub async fn friend_request(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<UsernameRequest>) -> Res {
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let Some(other) = find_user(&mut tx, &req.username).await? else {
        return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza");
    };
    match relation(&mut tx, me.id, other.id).await? {
        Relation::Me => return bad("Nie możesz zaprosić samego siebie 🙂"),
        Relation::Friend => return bad("Już jesteście znajomymi"),
        Relation::Outgoing => return bad("Zaproszenie już wysłane"),
        Relation::Incoming => {
            // ta osoba już nas zaprosiła - od razu akceptujemy
            sqlx::query!(
                "UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2",
                other.id,
                me.id
            )
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return ok(json!({"ok": true, "status": Relation::Friend}));
        }
        Relation::None => {}
    }
    sqlx::query!(
        "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES ($1, $2, 'pending', $3)",
        me.id,
        other.id,
        now()
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    ok(json!({"ok": true, "status": Relation::Outgoing}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RespondRequest {
    username: String,
    accept: bool,
}

pub async fn friend_respond(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<RespondRequest>) -> Res {
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let other = match find_user(&mut tx, &req.username).await? {
        Some(o) if relation(&mut tx, me.id, o.id).await? == Relation::Incoming => o,
        _ => return bad("Brak takiego zaproszenia"),
    };
    if req.accept {
        sqlx::query!("UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2", other.id, me.id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query!("DELETE FROM friendships WHERE requester_id = $1 AND addressee_id = $2", other.id, me.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true}))
}

pub async fn friend_remove(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<UsernameRequest>) -> Res {
    let mut c = st.db.acquire().await?;
    let Some(other) = find_user(&mut c, &req.username).await? else {
        return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza");
    };
    sqlx::query!(
        "DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)",
        me.id,
        other.id
    )
    .execute(&mut *c)
    .await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SearchQuery {
    q: String,
}

pub async fn user_search(State(st): State<AppState>, Me(_): Me, Query(query): Query<SearchQuery>) -> Res {
    let q = query.q.trim();
    if q.is_empty() {
        return ok(json!({"users": []}));
    }
    let cat = st.cat();
    let pattern = format!("%{}%", q.replace('%', "").replace('_', "\\_"));
    let rows = sqlx::query_as!(
        User,
        r"SELECT * FROM users WHERE banned = 0 AND LOWER(username) LIKE LOWER($1) ESCAPE '\' ORDER BY LOWER(username) LIMIT 10",
        pattern
    )
    .fetch_all(&st.db)
    .await?;
    let users: Vec<UserView> = rows.iter().map(|u| u.view(&cat)).collect();
    ok(json!({"users": users}))
}

// ---------------------------------------------------------------- aktywność / pokazywanie kart

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedAuthor {
    username: String,
    avatar: String,
    avatar_card: Option<String>,
    avatar_rarity: Option<String>,
    avatar_variant: String,
}

#[derive(Serialize)]
struct FeedEntry {
    id: i64,
    kind: String,
    person: String,
    variant: String,
    /// tajną kartę znajomego widać w aktywności, nawet jeśli samemu jej jeszcze nie odkryłeś
    reveal: Option<PublicPerson>,
    message: String,
    created: f64,
    mine: bool,
    author: FeedAuthor,
    to: Option<String>,
    value: i64,
}

pub async fn feed(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let rows = sqlx::query!(
        "SELECT f.id, f.author_id, f.kind, f.person_id, f.variant, f.message, f.created_at, u.username, u.avatar, u.avatar_card,
                u.avatar_variant, (SELECT username FROM users WHERE id = f.to_user_id) AS to_name
         FROM feed f JOIN users u ON u.id = f.author_id
         WHERE (f.author_id = $1 OR f.to_user_id = $1
            OR (f.to_user_id IS NULL AND f.author_id IN (
                SELECT addressee_id FROM friendships WHERE requester_id = $1 AND status = 'accepted'
                UNION SELECT requester_id FROM friendships WHERE addressee_id = $1 AND status = 'accepted')))
         ORDER BY f.id DESC LIMIT 60",
        me.id
    )
    .fetch_all(&mut *c)
    .await?;
    let found = discovered(&mut c, me.id).await?;
    let feed: Vec<FeedEntry> = rows
        .into_iter()
        .filter_map(|r| {
            let p = cat.person(&r.person_id)?;
            let avatar = cat.person(&r.avatar_card);
            Some(FeedEntry {
                id: r.id,
                kind: r.kind,
                reveal: reveal(&st.images, &cat, p, &found),
                value: p.value(&r.variant),
                person: r.person_id,
                variant: r.variant,
                message: r.message,
                created: r.created_at,
                mine: r.author_id == me.id,
                author: FeedAuthor {
                    username: r.username,
                    avatar: r.avatar,
                    avatar_card: avatar.map(|a| a.id.clone()),
                    avatar_rarity: avatar.map(|a| a.rarity.clone()),
                    avatar_variant: if g().is_variant(&r.avatar_variant) { r.avatar_variant } else { normal() },
                },
                to: r.to_name,
            })
        })
        .collect();
    let seen = get_state(&mut c, me.id).await?["feed_seen"];
    ok(json!({"feed": feed, "seen": seen}))
}

pub async fn feed_seen(State(st): State<AppState>, Me(me): Me) -> Res {
    let mut c = st.db.acquire().await?;
    let last = sqlx::query_scalar!("SELECT MAX(id) FROM feed").fetch_one(&mut *c).await?.unwrap_or(0);
    set_state(&mut c, me.id, "feed_seen", last).await?;
    ok(json!({"ok": true}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ShowRequest {
    item_id: i64,
    /// nick znajomego albo "all" / brak = wszyscy znajomi
    to: Option<String>,
    message: String,
}

pub async fn show_card(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<ShowRequest>) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let Some(rows) = owned_rows(&mut c, &cat, me.id, &[req.item_id]).await? else { return bad("Nie masz tej karty") };
    let friends = friend_ids(&mut c, me.id).await?;
    let to_id = match req.to.as_deref().filter(|t| !t.is_empty() && *t != "all") {
        Some(name) => match find_user(&mut c, name).await? {
            Some(o) if friends.contains(&o.id) => Some(o.id),
            _ => return bad("Możesz pokazywać karty tylko znajomym"),
        },
        None if friends.is_empty() => return bad("Nie masz jeszcze znajomych 🙂"),
        None => None,
    };
    let r = &rows[0];
    sqlx::query!(
        "INSERT INTO feed (author_id, to_user_id, kind, person_id, variant, message, created_at) VALUES ($1, $2, 'show', $3, $4, $5, $6)",
        me.id,
        to_id,
        r.person_id,
        r.variant,
        clean(&req.message, 140),
        now()
    )
    .execute(&mut *c)
    .await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- wymiany

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum TradeStatus {
    Pending,
    Accepted,
    Declined,
    Cancelled,
}

impl TradeStatus {
    fn as_str(self) -> &'static str {
        match self {
            TradeStatus::Pending => "pending",
            TradeStatus::Accepted => "accepted",
            TradeStatus::Declined => "declined",
            TradeStatus::Cancelled => "cancelled",
        }
    }
}

struct Trade {
    id: i64,
    from_id: i64,
    to_id: i64,
    status: TradeStatus,
    message: String,
    money_give: i64,
    money_want: i64,
    created_at: f64,
    updated_at: f64,
}

async fn get_trade(c: &mut Conn, tid: i64) -> sqlx::Result<Option<Trade>> {
    sqlx::query_as!(
        Trade,
        r#"SELECT id, from_id, to_id, status AS "status: TradeStatus", message, money_give, money_want, created_at, updated_at
           FROM trades WHERE id = $1"#,
        tid
    )
    .fetch_optional(c)
    .await
}

/// Wybiera konkretne karty gracza do oddania (najpierw te spoza gabloty)
async fn pick_want_items(c: &mut Conn, uid: i64, pid: &str, variant: &str, count: i32) -> sqlx::Result<Option<Vec<i64>>> {
    let rows = sqlx::query_scalar!(
        "SELECT i.id FROM items i LEFT JOIN showcase s ON s.item_id = i.id AND s.user_id = i.user_id
         WHERE i.user_id = $1 AND i.person_id = $2 AND i.variant = $3
         ORDER BY (s.item_id IS NOT NULL), i.id LIMIT $4",
        uid,
        pid,
        variant,
        i64::from(count)
    )
    .fetch_all(c)
    .await?;
    Ok((rows.len() == count as usize).then_some(rows))
}

/// Dlaczego wymiany nie da się już zrealizować - albo None
async fn trade_problem(c: &mut Conn, t: &Trade) -> sqlx::Result<Option<&'static str>> {
    let give = sqlx::query_scalar!("SELECT item_id FROM trade_lines WHERE trade_id = $1 AND side = 'give'", t.id)
        .fetch_all(&mut *c)
        .await?;
    for item in give {
        let has = sqlx::query_scalar!("SELECT 1 AS one FROM items WHERE id = $1 AND user_id = $2", item, t.from_id)
            .fetch_optional(&mut *c)
            .await?;
        if has.is_none() {
            return Ok(Some("Oferujący nie ma już wszystkich kart z oferty"));
        }
    }
    let want = sqlx::query!("SELECT person_id, variant, count FROM trade_lines WHERE trade_id = $1 AND side = 'want'", t.id)
        .fetch_all(&mut *c)
        .await?;
    for r in want {
        if pick_want_items(c, t.to_id, &r.person_id, &r.variant, r.count).await?.is_none() {
            return Ok(Some("Odbiorca nie ma już wszystkich chcianych kart"));
        }
    }
    if t.money_give != 0 || t.money_want != 0 {
        return Ok(Some(TRADE_NO_MONEY)); // stara oferta z pieniędzmi - już nie do przyjęcia
    }
    Ok(None)
}

#[derive(Serialize)]
struct TradeLine {
    person: String,
    variant: String,
    count: i32,
    value: i64,
    owner: Option<String>,
    /// tajną kartę znajomego widać w ofercie (jak na jego profilu)
    #[serde(skip_serializing_if = "Option::is_none")]
    reveal: Option<PublicPerson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradeJson {
    id: i64,
    status: TradeStatus,
    message: String,
    created: f64,
    updated: f64,
    money_give: i64,
    money_want: i64,
    from: Option<UserView>,
    to: Option<UserView>,
    mine: bool,
    give: Vec<TradeLine>,
    want: Vec<TradeLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<Option<&'static str>>,
}

async fn trade_json(c: &mut Conn, cx: &Ctx, t: &Trade, found: &HashSet<String>) -> sqlx::Result<TradeJson> {
    let users: HashMap<i64, User> = sqlx::query_as!(User, "SELECT * FROM users WHERE id IN ($1, $2)", t.from_id, t.to_id)
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    let (mut give, mut want) = (vec![], vec![]);
    let lines = sqlx::query!("SELECT side, person_id, variant, count FROM trade_lines WHERE trade_id = $1", t.id)
        .fetch_all(&mut *c)
        .await?;
    for r in lines {
        let Some(p) = cx.person(&r.person_id) else { continue };
        let owner_id = if r.side == "give" { t.from_id } else { t.to_id };
        let line = TradeLine {
            value: p.value(&r.variant),
            reveal: reveal(&cx.st.images, &cx.cat, p, found),
            owner: users.get(&owner_id).map(|o| o.username.clone()),
            person: r.person_id,
            variant: r.variant,
            count: r.count,
        };
        if r.side == "give" {
            give.push(line)
        } else {
            want.push(line)
        }
    }
    let problem = if t.status == TradeStatus::Pending { Some(trade_problem(c, t).await?) } else { None };
    Ok(TradeJson {
        id: t.id,
        status: t.status,
        message: t.message.clone(),
        created: t.created_at,
        updated: t.updated_at,
        money_give: t.money_give,
        money_want: t.money_want,
        from: users.get(&t.from_id).map(|u| u.view(&cx.cat)),
        to: users.get(&t.to_id).map(|u| u.view(&cx.cat)),
        mine: t.from_id == cx.uid(),
        give,
        want,
        problem,
    })
}

pub async fn trades_list(State(st): State<AppState>, Me(me): Me) -> Res {
    let cx = Ctx::new(st, me);
    let mut c = cx.st.db.acquire().await?;
    let me = cx.uid();
    let pending = sqlx::query_as!(
        Trade,
        r#"SELECT id, from_id, to_id, status AS "status: TradeStatus", message, money_give, money_want, created_at, updated_at
           FROM trades WHERE status = 'pending' AND (from_id = $1 OR to_id = $1) ORDER BY id DESC"#,
        me
    )
    .fetch_all(&mut *c)
    .await?;
    let history = sqlx::query_as!(
        Trade,
        r#"SELECT id, from_id, to_id, status AS "status: TradeStatus", message, money_give, money_want, created_at, updated_at
           FROM trades WHERE status != 'pending' AND (from_id = $1 OR to_id = $1) ORDER BY updated_at DESC LIMIT 15"#,
        me
    )
    .fetch_all(&mut *c)
    .await?;
    let found = discovered(&mut c, me).await?;
    let (mut incoming, mut outgoing, mut past) = (vec![], vec![], vec![]);
    for t in &pending {
        let list = if t.to_id == me { &mut incoming } else { &mut outgoing };
        list.push(trade_json(&mut c, &cx, t, &found).await?);
    }
    for t in &history {
        past.push(trade_json(&mut c, &cx, t, &found).await?);
    }
    ok(json!({"incoming": incoming, "outgoing": outgoing, "history": past}))
}

#[derive(Deserialize)]
pub struct WantLine {
    person: String,
    #[serde(default = "normal")]
    variant: String,
    #[serde(default = "one")]
    count: i64,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TradeRequest {
    to: String,
    give: Vec<i64>,
    want: Vec<WantLine>,
    message: String,
    money_give: i64,
    money_want: i64,
}

pub async fn trade_create(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<TradeRequest>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let friends = friend_ids(&mut tx, cx.uid()).await?;
    let Some(other) = find_user(&mut tx, &req.to).await?.filter(|o| friends.contains(&o.id)) else {
        return bad("Wymieniać się możesz tylko ze znajomymi");
    };
    if other.banned != 0 {
        return bad("To konto jest zablokowane");
    }
    if req.money_give != 0 || req.money_want != 0 {
        return bad(TRADE_NO_MONEY);
    }
    match (req.give.is_empty(), req.want.is_empty()) {
        (true, true) => return bad("Oferta jest pusta"),
        (true, false) | (false, true) => return bad("Coś dajesz i coś chcesz w zamian — obie strony muszą mieć karty"),
        (false, false) => {}
    }
    if req.give.len() + req.want.len() > TRADE_MAX_LINES {
        return bad("Oferta jest za duża");
    }
    let Some(rows) = owned_rows(&mut tx, &cx.cat, cx.uid(), &req.give).await? else {
        return bad("Nie masz wszystkich kart, które chcesz dać");
    };
    for w in &req.want {
        if !cx.cat.has(&w.person) || !g().is_variant(&w.variant) || !(1..=100).contains(&w.count) {
            return bad("Nieprawidłowa karta w ofercie");
        }
        if pick_want_items(&mut tx, other.id, &w.person, &w.variant, w.count as i32).await?.is_none() {
            return bad(format!("{} nie ma tylu kart: {}", other.username, cx.cat.people[&w.person].name));
        }
    }
    let tid = sqlx::query_scalar!(
        "INSERT INTO trades (from_id, to_id, message, money_give, money_want, created_at, updated_at)
         VALUES ($1, $2, $3, 0, 0, $4, $4) RETURNING id",
        cx.uid(),
        other.id,
        clean(&req.message, 140),
        now()
    )
    .fetch_one(&mut *tx)
    .await?;
    for r in &rows {
        sqlx::query!(
            "INSERT INTO trade_lines (trade_id, side, item_id, person_id, variant, count) VALUES ($1, 'give', $2, $3, $4, 1)",
            tid,
            r.id,
            r.person_id,
            r.variant
        )
        .execute(&mut *tx)
        .await?;
    }
    for w in &req.want {
        sqlx::query!(
            "INSERT INTO trade_lines (trade_id, side, item_id, person_id, variant, count) VALUES ($1, 'want', NULL, $2, $3, $4)",
            tid,
            w.person,
            w.variant,
            w.count as i32
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true, "id": tid}))
}

/// /api/trades/<id>/accept | decline | cancel
pub async fn trade_action(State(st): State<AppState>, Me(me): Me, Path((tid, action)): Path<(i64, String)>) -> Res {
    let status = match action.as_str() {
        "accept" => return trade_accept(st, me, tid).await,
        "decline" => TradeStatus::Declined,
        "cancel" => TradeStatus::Cancelled,
        _ => return bad("Nieprawidłowa operacja"),
    };
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let Some(t) = get_trade(&mut tx, tid).await?.filter(|t| t.status == TradeStatus::Pending) else {
        return bad("Nieprawidłowa operacja");
    };
    let allowed = if status == TradeStatus::Declined { t.to_id == me.id } else { t.from_id == me.id };
    if !allowed {
        return fail(StatusCode::FORBIDDEN, "To nie twoja oferta");
    }
    sqlx::query!("UPDATE trades SET status = $1, updated_at = $2 WHERE id = $3", status.as_str(), now(), tid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    ok(json!({"ok": true}))
}

async fn trade_accept(st: AppState, me: User, tid: i64) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    let mut t = get_trade(&mut tx, tid).await?;
    if let Some(tr) = &t {
        // blokujemy obie strony wymiany, potem czytamy świeży stan oferty
        lock_users(&mut tx, &[Some(tr.from_id), Some(tr.to_id)]).await?;
        t = get_trade(&mut tx, tid).await?;
    }
    let Some(t) = t.filter(|t| t.to_id == me.id && t.status == TradeStatus::Pending) else {
        return bad("Tej oferty nie można już przyjąć");
    };
    if let Some(problem) = trade_problem(&mut tx, &t).await? {
        return bad(problem);
    }
    let give: Vec<i64> = sqlx::query_scalar!("SELECT item_id FROM trade_lines WHERE trade_id = $1 AND side = 'give'", tid)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .flatten()
        .collect();
    let mut want = vec![];
    let lines = sqlx::query!("SELECT person_id, variant, count FROM trade_lines WHERE trade_id = $1 AND side = 'want'", tid)
        .fetch_all(&mut *tx)
        .await?;
    for r in lines {
        want.extend(pick_want_items(&mut tx, t.to_id, &r.person_id, &r.variant, r.count).await?.unwrap_or_default());
    }
    // nowy właściciel dostaje karty bez gwiazdki, poza gablotą; tajne karty są dla niego odkryte
    for (ids, uid) in [(&give, t.to_id), (&want, t.from_id)] {
        sqlx::query!("UPDATE items SET user_id = $1, favorite = 0 WHERE id = ANY($2)", uid, ids).execute(&mut *tx).await?;
        sqlx::query!("DELETE FROM showcase WHERE item_id = ANY($1)", ids).execute(&mut *tx).await?;
        for r in sqlx::query!("SELECT person_id, variant FROM items WHERE id = ANY($1)", ids).fetch_all(&mut *tx).await? {
            note_collected(&mut tx, uid, &r.person_id, &r.variant, "trade").await?;
            if cat.person(&r.person_id).is_some_and(|p| p.is_secret()) {
                discover(&mut tx, uid, &r.person_id).await?;
            }
        }
    }
    sqlx::query!("UPDATE trades SET status = 'accepted', updated_at = $1 WHERE id = $2", now(), tid).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut c = st.db.acquire().await?;
    ok(json!({"ok": true, "state": get_state(&mut c, me.id).await?, "items": my_items(&mut c, &cat, me.id).await?,
              "showcase": showcase_ids(&mut c, me.id).await?}))
}

// ---------------------------------------------------------------- profile, gablota, ranking

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ShowcaseRequest {
    ids: Vec<i64>,
}

pub async fn set_showcase(State(st): State<AppState>, Me(me): Me, JsonBody(mut req): JsonBody<ShowcaseRequest>) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    req.ids.truncate(g().showcase_size);
    if !req.ids.is_empty() && owned_rows(&mut tx, &cat, me.id, &req.ids).await?.is_none() {
        return bad("Nie masz tych kart");
    }
    sqlx::query!("DELETE FROM showcase WHERE user_id = $1", me.id).execute(&mut *tx).await?;
    for (pos, id) in (0i32..).zip(&req.ids) {
        sqlx::query!("INSERT INTO showcase (user_id, pos, item_id) VALUES ($1, $2, $3)", me.id, pos, id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    ok(json!({"ok": true, "showcase": req.ids}))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileRequest {
    /// ikona ze zdjęcia karty (pusty / null = bez karty); brak pola = bez zmian
    #[serde(with = "::serde_with::rust::double_option")]
    avatar_card: Option<Option<String>>,
    avatar_variant: Option<String>,
    /// emoji
    avatar: Option<String>,
}

pub async fn set_profile(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<ProfileRequest>) -> Res {
    let cat = st.cat();
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    if let Some(card) = req.avatar_card {
        // ikona ze zdjęcia karty - tylko z kart, które gracz ma (żadnych własnych plików)
        let pid = card.unwrap_or_default();
        let variant = req.avatar_variant.filter(|v| !v.is_empty()).unwrap_or_else(normal);
        if !g().is_variant(&variant) {
            return bad("Nieznany wariant");
        }
        if !pid.is_empty() {
            let owned = cat.has(&pid)
                && sqlx::query_scalar!(
                    "SELECT 1 AS one FROM items WHERE user_id = $1 AND person_id = $2 AND variant = $3 LIMIT 1",
                    me.id,
                    pid,
                    variant
                )
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            if !owned {
                return bad("Możesz ustawić tylko kartę (w wariancie), którą masz");
            }
        }
        sqlx::query!("UPDATE users SET avatar_card = $1, avatar_variant = $2 WHERE id = $3", pid, variant, me.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(avatar) = req.avatar {
        let avatar = avatar.trim();
        if !(1..=8).contains(&avatar.chars().count()) {
            return bad("Nieprawidłowy awatar");
        }
        sqlx::query!("UPDATE users SET avatar = $1, avatar_card = '' WHERE id = $2", avatar, me.id).execute(&mut *tx).await?;
    }
    let user = user_by_id(&mut tx, me.id).await?.unwrap_or(me);
    tx.commit().await?;
    ok(json!({"ok": true, "user": user.view(&cat)}))
}

#[derive(Serialize)]
struct ProfileUser {
    #[serde(flatten)]
    brief: UserBrief,
    created: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStats {
    opened: i64,
    contracts: i64,
    upgrades_won: i64,
    upgrades_lost: i64,
}

#[derive(Serialize)]
struct CollectionEntry {
    person: String,
    variant: String,
    count: i64,
}

#[derive(Serialize)]
struct ProfileResponse {
    user: ProfileUser,
    relation: Relation,
    /// tajne karty znajomego widać na jego profilu, nawet jeśli samemu się ich jeszcze nie odkryło
    reveal: IndexMap<String, PublicPerson>,
    stats: ProfileStats,
    collection: Vec<CollectionEntry>,
    collected: Vec<(String, String)>,
    showcase: Vec<ItemJson>,
    /// karty „Czysta kartka” gracza (każda ze swoim rysunkiem)
    drawings: Vec<ItemJson>,
}

pub async fn profile(State(st): State<AppState>, Me(me): Me, Path(name): Path<String>) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let Some(u) = find_user(&mut c, &name).await? else { return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza") };
    let state = get_state(&mut c, u.id).await?;
    let stats = collection_stats(&mut c, &cat).await?;
    let collection: Vec<CollectionEntry> = sqlx::query!(
        r#"SELECT person_id, variant, COUNT(*) AS "n!" FROM items WHERE user_id = $1 GROUP BY person_id, variant"#,
        u.id
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .filter(|r| cat.has(&r.person_id))
    .map(|r| CollectionEntry { person: r.person_id, variant: r.variant, count: r.n })
    .collect();
    let mut showcase = vec![];
    for id in showcase_ids(&mut c, u.id).await? {
        showcase.extend(item_by_id(&mut c, id).await?.and_then(|r| item_json(&cat, &r)));
    }
    let relation = relation(&mut c, me.id, u.id).await?;
    let collected = collected_list(&mut c, &cat, u.id).await?;
    let mut revealed = IndexMap::new();
    if relation == Relation::Friend {
        let found = discovered(&mut c, me.id).await?;
        let pids: HashSet<&String> = collection.iter().map(|c| &c.person).chain(collected.iter().map(|c| &c.0)).collect();
        for pid in pids {
            if let Some(v) = reveal(&st.images, &cat, &cat.people[pid], &found) {
                revealed.insert(pid.clone(), v);
            }
        }
    }
    let drawings = super::drawings::blank_items(&mut c, &cat, u.id).await?;
    let stat = |k: &str| state.get(k).copied().unwrap_or(0);
    ok(ProfileResponse {
        user: ProfileUser { brief: UserBrief::new(&cat, &u, &stats), created: u.created_at },
        relation,
        reveal: revealed,
        stats: ProfileStats {
            opened: stat("opened"),
            contracts: stat("contracts"),
            upgrades_won: stat("upgrades_won"),
            upgrades_lost: stat("upgrades_lost"),
        },
        collection,
        collected,
        showcase,
        drawings,
    })
}

#[derive(Serialize)]
struct RankingPlayer {
    #[serde(flatten)]
    brief: UserBrief,
    opened: i64,
    friend: bool,
    me: bool,
}

pub async fn ranking(State(st): State<AppState>, Me(me): Me) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let stats = collection_stats(&mut c, &cat).await?;
    let opened: HashMap<i64, i64> = sqlx::query!("SELECT user_id, value FROM user_state WHERE key = 'opened'")
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .map(|r| (r.user_id, r.value))
        .collect();
    let friends = friend_ids(&mut c, me.id).await?;
    // bez zablokowanych, ukrytych przez admina i tych, którzy dostali pieniądze / skrzynki od admina
    let users = sqlx::query_as!(User, "SELECT * FROM users WHERE banned = 0 AND ranking_hidden = 0 AND money_generated = 0")
        .fetch_all(&mut *c)
        .await?;
    let players: Vec<RankingPlayer> = users
        .iter()
        .map(|u| RankingPlayer {
            brief: UserBrief::new(&cat, u, &stats),
            opened: opened.get(&u.id).copied().unwrap_or(0),
            friend: friends.contains(&u.id),
            me: u.id == me.id,
        })
        .collect();
    ok(json!({"players": players, "totalCards": cat.people.len()}))
}

#[derive(Serialize)]
struct AdminMessage {
    id: i64,
    title: String,
    body: String,
    at: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    /// dzisiejszy quest (None = questy wyłączone)
    quest: Option<super::quests::QuestView>,
    /// karta, którą przy wejściu do ekwipunku zabierze UFO (easter egg, bez powiadomień)
    ufo: Option<String>,
    user: UserView,
    daily_claimable: bool,
    incoming: i64,
    unread: i64,
    trades: i64,
    market: i64,
    /// "odcisk" ekwipunku (liczba kart, suma id) - przeglądarka pobiera świeży ekwipunek, gdy coś zmieniło się
    /// bez jej udziału (wygrana w jackpocie, sprzedaż na rynku, przyjęta wymiana)
    inv: (i64, i64),
    balance: i64,
    /// wynik gry w jackpot, którego gracz jeszcze nie widział
    jackpot: Option<super::casino::JackpotJson>,
    jackpot_lobby: Option<i64>,
    jackpot_invites: i64,
    /// nowości od ostatniej wizyty
    patch_notes: Vec<&'static Value>,
    /// wiadomości od adminów, których gracz jeszcze nie widział
    messages: Vec<AdminMessage>,
    /// osiągnięcia zdobyte, a jeszcze niepokazane (np. przyznane przy zapytaniu bez nagłówka X-Ach) - achPoll
    ach_unseen: i64,
    /// rozliczone zakłady na wyścigi konne, których gracz jeszcze nie widział
    horse_news: Vec<Value>,
}

/// Odpytywane co 30 s (w lobby co 5 s) przez każdy otwarty ekran gry. Odnawia też ciasteczko logowania.
pub async fn me(State(st): State<AppState>, Me(me): Me, jar: SignedCookieJar) -> Res {
    let cx = Ctx::new(st.clone(), me);
    settle_market(&st.db, &cx.cat).await?; // licytacje kończą się na czas
    super::horses::settle_my_horses(&cx).await?;
    let mut c = st.db.acquire().await?;
    let uid = cx.uid();
    let state = get_state(&mut c, uid).await?;
    let incoming =
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!" FROM friendships WHERE addressee_id = $1 AND status = 'pending'"#, uid)
            .fetch_one(&mut *c)
            .await?;
    let unread = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!" FROM feed f JOIN users u ON u.id = f.author_id
           WHERE (f.author_id = $1 OR f.to_user_id = $1
              OR (f.to_user_id IS NULL AND f.author_id IN (
                  SELECT addressee_id FROM friendships WHERE requester_id = $1 AND status = 'accepted'
                  UNION SELECT requester_id FROM friendships WHERE addressee_id = $1 AND status = 'accepted')))
           AND f.author_id != $1 AND f.id > $2"#,
        uid,
        state["feed_seen"]
    )
    .fetch_one(&mut *c)
    .await?;
    let trades = sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!" FROM trades WHERE to_id = $1 AND status = 'pending'"#, uid)
        .fetch_one(&mut *c)
        .await?;
    let inv = sqlx::query!(r#"SELECT COUNT(*) AS "n!", COALESCE(SUM(id), 0)::BIGINT AS "s!" FROM items WHERE user_id = $1"#, uid)
        .fetch_one(&mut *c)
        .await?;
    let jackpot_invites = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!" FROM jackpots j JOIN jackpot_invites i ON i.jackpot_id = j.id WHERE i.user_id = $1
           AND j.status = 'open' AND j.joiner_id IS NULL AND j.creator_id != $1"#,
        uid
    )
    .fetch_one(&mut *c)
    .await?;
    let seen = state["patch_seen"];
    let body = MeResponse {
        quest: super::quests::quest_view(&mut c, &cx.cat, uid).await?,
        ufo: super::variants::ufo_visit(&mut c, &cx.cat, uid, state["ufo_visit"]).await?,
        user: cx.me.view(&cx.cat),
        daily_claimable: super::shop::daily_info(&mut c, uid).await?.claimable,
        incoming,
        unread,
        trades,
        market: market_badge(&mut c, uid, state["market_seen"]).await?,
        inv: (inv.n, inv.s),
        balance: state["balance"],
        jackpot: super::casino::jackpot_news(&mut c, &cx, state["jackpot_seen"]).await?,
        jackpot_lobby: super::casino::my_lobby(&mut c, uid).await?.map(|l| l.id),
        jackpot_invites,
        patch_notes: crate::data::base_game().patch_notes.iter().filter(|n| n["v"].as_i64().unwrap_or(0) > seen).take(3).collect(),
        messages: active_messages(&mut c, uid).await?,
        ach_unseen: crate::achievements::unseen(&mut c, uid).await?,
        horse_news: super::horses::horse_news(&mut c, uid).await?,
    };
    let jar = jar.add(session_cookie(uid, st.cfg.cookie_secure));
    Ok((jar, Json(body)).into_response())
}

/// Wiadomości od adminów, które gracz ma teraz zobaczyć: trwa ich czas i jeszcze ich nie widział
async fn active_messages(c: &mut Conn, uid: i64) -> sqlx::Result<Vec<AdminMessage>> {
    let rows = sqlx::query!(
        "SELECT id, title, body, starts_at FROM admin_messages m WHERE starts_at <= $1 AND ends_at > $1 AND NOT EXISTS
         (SELECT 1 FROM admin_message_seen s WHERE s.message_id = m.id AND s.user_id = $2) ORDER BY starts_at",
        now(),
        uid
    )
    .fetch_all(c)
    .await?;
    Ok(rows.into_iter().map(|r| AdminMessage { id: r.id, title: r.title, body: r.body, at: r.starts_at }).collect())
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct MessagesSeenRequest {
    ids: Vec<i64>,
}

/// Gracz zobaczył wiadomości od adminów - w tym czasie już mu się nie pokażą
pub async fn messages_seen(State(st): State<AppState>, Me(me): Me, JsonBody(req): JsonBody<MessagesSeenRequest>) -> Res {
    sqlx::query!(
        "INSERT INTO admin_message_seen (message_id, user_id, seen_at) SELECT id, $2, $3 FROM admin_messages WHERE id = ANY($1)
         ON CONFLICT DO NOTHING",
        &req.ids,
        me.id,
        now()
    )
    .execute(&st.db)
    .await?;
    ok(json!({"ok": true}))
}

/// Wiersz Hall of Fame: karta, wariant, pierwszy gracz, kiedy, skąd, ile wypadło
#[derive(Serialize)]
struct HofRow {
    p: String,
    v: String,
    u: Option<i64>,
    t: f64,
    s: String,
    n: i32,
}

/// Hall of Fame: dla każdej karty i wariantu - kto pierwszy ją zdobył, kiedy, skąd i ile ich wypadło
pub async fn hall_of_fame(State(st): State<AppState>, Me(_): Me) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let rows = sqlx::query!("SELECT * FROM hall_of_fame").fetch_all(&mut *c).await?;
    let all_users = sqlx::query_as!(User, "SELECT * FROM users").fetch_all(&mut *c).await?;
    let hidden: HashSet<i64> = all_users.iter().filter(|u| u.hidden_from_ranking()).map(|u| u.id).collect();
    let mut out = vec![];
    for r in rows.into_iter().filter(|r| cat.has(&r.person_id)) {
        let (mut u, mut t, mut s) = (r.first_user_id, r.first_at, r.source);
        if u.is_some_and(|u| hidden.contains(&u)) {
            // gracz poza rankingiem - pokazujemy pierwszego widocznego (albo nikogo)
            u = None;
            if let Some((fu, ft, fs)) = hof_first(&mut c, &r.person_id, &r.variant, Some(&hidden)).await? {
                (u, t, s) = (Some(fu), ft, fs);
            }
        }
        out.push(HofRow { p: r.person_id, v: r.variant, u, t, s, n: r.drops });
    }
    let ids: HashSet<i64> = out.iter().filter_map(|r| r.u).collect();
    let users: IndexMap<String, UserView> =
        all_users.iter().filter(|u| ids.contains(&u.id)).map(|u| (u.id.to_string(), u.view(&cat))).collect();
    ok(json!({"rows": out, "users": users}))
}

pub async fn patch_notes(Me(_): Me) -> Res {
    ok(json!({"notes": g().patch_notes}))
}

pub async fn patch_notes_seen(State(st): State<AppState>, Me(me): Me) -> Res {
    let mut c = st.db.acquire().await?;
    set_state(&mut c, me.id, "patch_seen", g().patch_version()).await?;
    ok(json!({"ok": true}))
}

// ---------------------------------------------------------------- linki do kart specjalnych

/// Gracz otworzył link od admina: dostaje kartę specjalną (w jej jedynym wariancie) - każdy gracz raz na link
pub async fn link_claim(State(st): State<AppState>, Me(me): Me, Path(token): Path<String>) -> Res {
    let cx = Ctx::new(st, me);
    let mut tx = cx.st.db.begin().await?;
    lock_me(&mut tx, cx.uid()).await?;
    let link =
        sqlx::query!("SELECT id, person_id, active FROM card_links WHERE token = $1", token).fetch_optional(&mut *tx).await?;
    let link = link.filter(|l| l.active != 0).and_then(|l| Some((l.id, super::admin::link_card(&cx.cat, &l.person_id)?.clone())));
    let (link_id, p) =
        link.ok_or_else(|| AppError::with_status(StatusCode::NOT_FOUND, "Ten link nie działa (wyłączony albo nieprawidłowy)"))?;
    let used =
        sqlx::query_scalar!("SELECT 1 AS one FROM card_link_claims WHERE link_id = $1 AND user_id = $2", link_id, cx.uid())
            .fetch_optional(&mut *tx)
            .await?;
    if used.is_some() {
        return bad("Ten link już wykorzystałeś — każdy gracz może go użyć tylko raz");
    }
    let n = sqlx::query!("UPDATE card_links SET uses = uses + 1 WHERE id = $1 AND (max_uses = 0 OR uses < max_uses)", link_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return bad("Limit graczy dla tego linku już się wyczerpał");
    }
    let item = insert_item(&mut tx, &cx, &p.id, p.fixed(), "link").await?;
    sqlx::query!(
        "INSERT INTO card_link_claims (link_id, user_id, item_id, claimed_at) VALUES ($1, $2, $3, $4)",
        link_id,
        cx.uid(),
        item.id,
        now()
    )
    .execute(&mut *tx)
    .await?;
    note_drops(&mut tx, &cx, &drops_of(std::slice::from_ref(&item)), "link").await?;
    let state = get_state(&mut tx, cx.uid()).await?;
    tx.commit().await?;
    ok(json!({"item": item, "state": state}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_request_keeps_null_card() {
        let r: ProfileRequest = serde_json::from_str(r#"{"avatarCard": null}"#).unwrap();
        assert_eq!(r.avatar_card, Some(None));
        let r: ProfileRequest = serde_json::from_str(r#"{"avatar": "🐱"}"#).unwrap();
        assert_eq!((r.avatar_card, r.avatar.as_deref()), (None, Some("🐱")));
        let r: TradeRequest = serde_json::from_str(r#"{"to": "Bob", "give": [1], "want": [{"person": "pl_zenek"}]}"#).unwrap();
        assert_eq!((r.want[0].variant.as_str(), r.want[0].count), ("normal", 1));
    }
}
