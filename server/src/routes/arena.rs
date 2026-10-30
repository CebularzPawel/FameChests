//! Arena (wersja testowa - TYLKO DLA ADMINÓW). Walkę liczy serwer (arena/engine.rs) - przeglądarka wysyła ruchy
//! i odtwarza kroki walki z animacjami.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use indexmap::IndexMap;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::shop::today;
use super::{ok, JsonBody};
use crate::arena::engine::{ai_deck, ArenaError, Player};
use crate::arena::view::BattleView;
use crate::arena::{Arena, Battle, ChallengeStatus, DeckCard, Hero, Mode, Reward, Side};
use crate::auth::{find_user, user_by_id, Admin, User};
use crate::catalog::Catalog;
use crate::data::g;
use crate::db::Conn;
use crate::error::{bad, fail, AppError, Res};
use crate::game::views::{public_person, PublicPerson};
use crate::game::{add_chests, discovered, get_chests, Chests};
use crate::state::AppState;

fn deck_error() -> String {
    format!("Talia musi mieć {} różnych kart z twojej kolekcji", g().arena.deck_size)
}

fn gone() -> AppError {
    AppError::with_status(StatusCode::NOT_FOUND, "Ta walka już się skończyła")
}

fn hero(cat: &Catalog, u: &User) -> Hero {
    u.view(cat).into()
}

/// Talia z moich kart: osoby bez powtórzeń, każda w najlepszym posiadanym wariancie (wariant to tylko wygląd)
async fn arena_deck(c: &mut Conn, cat: &Catalog, uid: i64, pids: &[String]) -> sqlx::Result<Option<Vec<DeckCard>>> {
    let n = g().arena.deck_size;
    if pids.len() != n || pids.iter().collect::<HashSet<_>>().len() != n {
        return Ok(None);
    }
    let rows = sqlx::query!("SELECT person_id, variant FROM items WHERE user_id = $1 AND person_id = ANY($2)", uid, pids)
        .fetch_all(c)
        .await?;
    let mut best: HashMap<String, String> = HashMap::new();
    for r in rows {
        let Some(p) = cat.person(&r.person_id).filter(|p| p.hp > 0) else { continue };
        let variant = if g().is_variant(&r.variant) { r.variant } else { "normal".into() };
        let current = best.get(&p.id).map_or("normal", String::as_str);
        if g().variant_idx(&variant) >= g().variant_idx(current) {
            best.insert(p.id.clone(), variant);
        }
    }
    if best.len() != n {
        return Ok(None);
    }
    Ok(Some(pids.iter().map(|p| DeckCard { pid: p.clone(), variant: best[p].clone() }).collect()))
}

async fn arena_wins_today(c: &mut Conn, uid: i64) -> sqlx::Result<i64> {
    let wins = sqlx::query_scalar!("SELECT wins FROM arena_daily WHERE user_id = $1 AND day = $2", uid, today().to_string())
        .fetch_optional(c)
        .await?;
    Ok(wins.map_or(0, i64::from))
}

/// Koniec walki: wygrana liczy się do dziennych nagród - skrzynka z pieniędzmi za 1., 3. i 9. wygraną dnia.
/// Pod zamkiem Areny, więc nagroda nie zostanie przyznana dwa razy.
async fn arena_record(st: &AppState, b: &mut Battle) -> sqlx::Result<()> {
    if b.over.is_none() || b.recorded {
        return Ok(());
    }
    b.recorded = true;
    let rules = &g().arena;
    let day = today().to_string();
    let mut tx = st.db.begin().await?;
    for k in Side::BOTH {
        let Some(uid) = b.user_of(k) else { continue };
        let mut chest = None;
        if b.over == Some(crate::arena::engine::Outcome::Won(k)) && !b.no_reward {
            sqlx::query!(
                "INSERT INTO arena_daily (user_id, day, wins) VALUES ($1, $2, 1)
                 ON CONFLICT (user_id, day) DO UPDATE SET wins = arena_daily.wins + 1",
                uid,
                day
            )
            .execute(&mut *tx)
            .await?;
            // osiągnięcia: wygrana walka, ostatni cios kartą
            let finisher = match &b.last_use {
                Some((side, pid)) if *side == k && b.reason == Some(crate::arena::engine::EndReason::Ko) => Some(pid.as_str()),
                _ => None,
            };
            crate::achievements::count_arena(&mut tx, uid, finisher).await?;
            if rules.reward_wins.contains(&arena_wins_today(&mut tx, uid).await?) {
                chest = Some(rules.reward_chest.clone());
                add_chests(&mut tx, uid, &format!("money_{}", rules.reward_chest), 1).await?;
            }
        }
        let wins = arena_wins_today(&mut tx, uid).await?;
        b.set_reward(k, Reward::new(wins, chest));
    }
    tx.commit().await
}

#[derive(Serialize)]
struct BattleReply<'a> {
    #[serde(flatten)]
    battle: BattleView<'a>,
    /// tajne karty widoczne w walce - prawdziwe dane, choć gracz ich jeszcze nie odkrył
    reveal: IndexMap<String, PublicPerson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chests: Option<Chests>,
}

async fn arena_reply(st: &AppState, me: &User, b: &mut Battle, side: Side, since: usize) -> Res {
    let cat = st.cat();
    arena_record(st, b).await?;
    let mut c = st.db.acquire().await?;
    let found = discovered(&mut c, me.id).await?;
    let reveal = b
        .visible_pids(side, since)
        .iter()
        .filter_map(|pid| cat.person(pid))
        .filter(|p| p.is_secret() && !found.contains(&p.id))
        .map(|p| (p.id.clone(), public_person(&st.images, &cat, p, true)))
        .collect();
    let chests = match b.reward(side).and_then(|r| r.chest.as_ref()) {
        Some(_) => Some(get_chests(&mut c, &cat, me.id).await?),
        None => None,
    };
    ok(BattleReply { battle: b.view(side, since), reveal, chests })
}

/// Nowa walka kończy porzuconą walkę z komputerem (porażka, bez nagród). true = trwa pojedynek z graczem.
async fn arena_abandon(st: &AppState, arena: &mut Arena, uid: i64) -> sqlx::Result<bool> {
    while let Some(id) = arena.active_battle(uid).map(|b| b.id.clone()) {
        let b = arena.battles.get_mut(&id).expect("walka z listy");
        if b.mode != Mode::Ai {
            return Ok(true);
        }
        if let Some(k) = b.side_of_user(uid) {
            b.surrender(k);
        }
        arena_record(st, b).await?;
    }
    Ok(false)
}

/// Sprawdzane co kilka sekund: wyzwania od innych graczy, odpowiedź na moje wyzwanie, trwająca walka
pub async fn arena_inbox(State(st): State<AppState>, Admin(me): Admin) -> Res {
    let wins = arena_wins_today(&mut *st.db.acquire().await?, me.id).await?;
    let mut arena = st.arena.inner.lock().await;
    let active = arena.active_battle(me.id).map(|b| b.id.clone());
    let battle = active.and_then(|id| arena.battles.get_mut(&id)).map(|b| {
        if let Some(k) = b.side_of_user(me.id) {
            b.touch_seen(k);
        }
        json!({"id": b.id, "mode": b.mode})
    });
    let (incoming, outgoing) = arena.challenges_for(me.id);
    ok(json!({"incoming": incoming, "outgoing": outgoing, "battle": battle, "rewards": Reward::new(wins, None)}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DeckRequest {
    deck: Vec<String>,
}

/// Nowa walka z komputerem
pub async fn arena_start(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<DeckRequest>) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let deck = arena_deck(&mut c, &cat, me.id, &req.deck).await?.ok_or_else(|| AppError::bad(deck_error()))?;
    let found = discovered(&mut c, me.id).await?;
    drop(c);
    let mut arena = st.arena.inner.lock().await;
    if arena_abandon(&st, &mut arena, me.id).await? {
        return bad("Masz trwający pojedynek z graczem");
    }
    arena.cleanup();
    let ai = ai_deck(&cat, &deck, &found);
    let mut b = Battle::new(
        &cat,
        Mode::Ai,
        Player { name: me.username.clone(), user: Some(me.id), deck, hero: hero(&cat, &me) },
        Player { name: "Komputer".into(), user: None, deck: ai, hero: Hero::computer() },
        Side::A,
    );
    b.start(&cat);
    let id = arena.add_battle(b);
    let b = arena.battles.get_mut(&id).expect("nowa walka");
    arena_reply(&st, &me, b, Side::A, 0).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SinceQuery {
    since: usize,
}

pub async fn arena_battle(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(bid): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Res {
    let cat = st.cat();
    let mut arena = st.arena.inner.lock().await;
    let b = arena.battles.get_mut(&bid).ok_or_else(gone)?;
    let side = b.side_of_user(me.id).ok_or_else(gone)?;
    b.touch_seen(side);
    b.tick(&cat);
    arena_reply(&st, &me, b, side, q.since).await
}

/// Ruch gracza w walce
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Move {
    Place {
        uid: i64,
    },
    Retreat {
        uid: i64,
    },
    Use {
        uid: i64,
        ab: i64,
        target: Option<i64>,
    },
    End,
    Surrender,
    /// admin: komputer gra za gracza (walka bez nagród)
    Auto {
        on: bool,
    },
}

#[derive(Deserialize)]
pub struct ActRequest {
    #[serde(flatten)]
    action: Move,
    /// kroki, które przeglądarka już pokazała
    #[serde(default)]
    since: usize,
}

pub async fn arena_act(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(bid): Path<String>,
    JsonBody(req): JsonBody<ActRequest>,
) -> Res {
    let cat = st.cat();
    let mut arena = st.arena.inner.lock().await;
    let b = arena.battles.get_mut(&bid).ok_or_else(gone)?;
    let side = b.side_of_user(me.id).ok_or_else(gone)?;
    b.touch_seen(side);
    b.tick(&cat);
    let result: Result<(), ArenaError> = match req.action {
        Move::Surrender => {
            b.surrender(side);
            Ok(())
        }
        Move::Auto { on } => {
            b.set_auto(side, on);
            Ok(())
        }
        _ if b.over.is_some() => Err(ArenaError("Walka już się skończyła".into())),
        Move::Place { uid } => b.place(&cat, side, uid),
        Move::Retreat { uid } => b.retreat(side, uid),
        Move::Use { uid, ab, target } => b.use_ability(&cat, side, uid, ab, target),
        Move::End => b.end_turn(side, false),
    };
    result.map_err(|e| AppError::bad(e.0))?;
    b.run_bots(&cat);
    arena_reply(&st, &me, b, side, req.since).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ChallengeRequest {
    username: String,
    deck: Vec<String>,
}

/// Wyzwanie innego gracza na pojedynek (z jego profilu)
pub async fn arena_challenge(State(st): State<AppState>, Admin(me): Admin, JsonBody(req): JsonBody<ChallengeRequest>) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let Some(target) = find_user(&mut c, &req.username).await?.filter(|t| t.banned == 0) else {
        return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza");
    };
    if target.id == me.id {
        return bad("Nie możesz wyzwać samego siebie");
    }
    if !target.admin() {
        // wersja testowa: walczą tylko admini
        return bad(format!("Arena jest na razie tylko dla adminów — {} nie ma do niej dostępu", target.username));
    }
    let deck = arena_deck(&mut c, &cat, me.id, &req.deck).await?.ok_or_else(|| AppError::bad(deck_error()))?;
    drop(c);
    let mut arena = st.arena.inner.lock().await;
    for uid in [me.id, target.id] {
        if arena.active_battle(uid).is_some_and(|b| b.mode == Mode::Pvp) {
            return bad(if uid == me.id {
                "Masz trwający pojedynek".to_owned()
            } else {
                format!("{} właśnie walczy z kimś innym", target.username)
            });
        }
    }
    let challenge = arena.new_challenge(me.id, target.id, hero(&cat, &me), hero(&cat, &target), deck);
    ok(challenge.view())
}

pub async fn arena_accept(
    State(st): State<AppState>,
    Admin(me): Admin,
    Path(cid): Path<String>,
    JsonBody(req): JsonBody<DeckRequest>,
) -> Res {
    let cat = st.cat();
    let mut arena = st.arena.inner.lock().await;
    arena.cleanup();
    let expired = || AppError::with_status(StatusCode::NOT_FOUND, "To wyzwanie już wygasło");
    let from = arena.challenges.get(&cid).filter(|c| c.to == me.id).map(|c| c.from).ok_or_else(expired)?;
    let mut c = st.db.acquire().await?;
    let deck = arena_deck(&mut c, &cat, me.id, &req.deck).await?.ok_or_else(|| AppError::bad(deck_error()))?;
    let rival = user_by_id(&mut c, from).await?;
    drop(c);
    if arena.challenges[&cid].status != ChallengeStatus::Pending {
        return bad("To wyzwanie jest już nieaktualne");
    }
    let Some(rival) = rival.filter(|r| r.banned == 0) else { return fail(StatusCode::NOT_FOUND, "Nie ma takiego gracza") };
    for uid in [me.id, rival.id] {
        if arena_abandon(&st, &mut arena, uid).await? {
            return bad("Ktoś z was ma już trwający pojedynek");
        }
    }
    let challenge = arena.challenges.get_mut(&cid).ok_or_else(expired)?;
    challenge.status = ChallengeStatus::Accepted;
    let rival_deck = challenge.deck.clone();
    let first = *Side::BOTH.choose(&mut rand::thread_rng()).unwrap_or(&Side::A);
    let mut b = Battle::new(
        &cat,
        Mode::Pvp,
        Player { name: rival.username.clone(), user: Some(rival.id), deck: rival_deck, hero: hero(&cat, &rival) },
        Player { name: me.username.clone(), user: Some(me.id), deck, hero: hero(&cat, &me) },
        first,
    );
    b.start(&cat);
    let id = arena.add_battle(b);
    if let Some(challenge) = arena.challenges.get_mut(&cid) {
        challenge.battle = Some(id.clone());
    }
    ok(json!({"battle": id}))
}

/// Odrzucenie wyzwania (przez wyzwanego) albo wycofanie (przez wyzywającego)
pub async fn arena_decline(State(st): State<AppState>, Admin(me): Admin, Path(cid): Path<String>) -> Res {
    let mut arena = st.arena.inner.lock().await;
    let challenge = arena
        .challenges
        .get_mut(&cid)
        .filter(|c| c.from == me.id || c.to == me.id)
        .ok_or_else(|| AppError::with_status(StatusCode::NOT_FOUND, "To wyzwanie już wygasło"))?;
    if challenge.status == ChallengeStatus::Pending {
        challenge.status = if me.id == challenge.to { ChallengeStatus::Declined } else { ChallengeStatus::Cancelled };
    }
    ok(challenge.view())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves() {
        let r: ActRequest = serde_json::from_str(r#"{"type": "use", "uid": 3, "ab": 1, "target": 105, "since": 4}"#).unwrap();
        assert!(matches!(r.action, Move::Use { uid: 3, ab: 1, target: Some(105) }) && r.since == 4);
        let r: ActRequest = serde_json::from_str(r#"{"type": "end"}"#).unwrap();
        assert!(matches!(r.action, Move::End) && r.since == 0);
        assert!(serde_json::from_str::<ActRequest>(r#"{"type": "jump"}"#).is_err());
    }
}
