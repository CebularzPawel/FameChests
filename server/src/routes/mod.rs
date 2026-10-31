//! Adresy gry: strony HTML i API (/api/...). Odpowiedzi API takie same jak w wersji Python - przeglądarka
//! (static/js) działa bez zmian.

pub mod account;
pub mod admin;
pub mod arena;
pub mod casino;
pub mod drawings;
pub mod horses;
pub mod market;
pub mod pages;
pub mod quests;
pub mod shop;
pub mod social;
pub mod variants;

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::AppError;
use crate::state::AppState;

/// Treść zapytania (JSON) jako typ `T` - bez względu na Content-Type; pusta treść = `{}`.
pub struct JsonBody<T>(pub T);

impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state).await.map_err(IntoResponse::into_response)?;
        let json: &[u8] = if bytes.iter().all(u8::is_ascii_whitespace) { b"{}" } else { &bytes };
        serde_json::from_slice(json).map(JsonBody).map_err(|e| {
            tracing::debug!("nieprawidłowa treść zapytania: {e}");
            AppError::bad("Nieprawidłowe żądanie").into_response()
        })
    }
}

/// Odpowiedź JSON
pub fn ok<T: Serialize>(v: T) -> crate::error::Res {
    Ok(Json(v).into_response())
}

pub fn router(st: AppState) -> Router {
    use account::*;
    use admin::*;
    use arena::*;
    use casino::*;
    use market::*;
    use pages::*;
    use shop::*;
    use social::*;

    let mut r = Router::new()
        // strony
        .route("/login", get(login_page))
        .route("/", get(index))
        .route("/inventory/hall-of-fame", get(index))
        .route("/player/{name}", get(index))
        .route("/link/{token}", get(index))
        .route("/mockups", get(index))
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(service_worker))
        .route("/admin", get(admin_page))
        .route("/admin/mockups", get(admin_mockups))
        .route("/flag/{code}", get(flag_image))
        .route("/img/{person_id}", get(image_main))
        .route("/img/{person_id}/{kind}", get(image_kind))
        .route("/avatar/{name}", get(avatar_image))
        .route("/drawing/{id}/{layer}", get(drawings::drawing_image))
        // konta
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/password", post(change_password))
        // skrzynki, kuźnia, codzienna nagroda
        .route("/api/config", get(config))
        .route("/api/state", get(state))
        .route("/api/open", post(open_crates))
        .route("/api/chests/buy", post(buy_chests))
        .route("/api/chests/money", post(open_money_chest))
        .route("/api/sell", post(sell))
        .route("/api/favorite", post(set_favorite))
        .route("/api/contract", post(contract))
        .route("/api/contracts", post(contracts_bulk))
        .route("/api/upgrade", post(upgrade))
        .route("/api/daily", get(daily))
        .route("/api/daily/claim", post(daily_claim))
        // znajomi, aktywność, wymiany, profile
        .route("/api/friends", get(friends))
        .route("/api/friends/request", post(friend_request))
        .route("/api/friends/respond", post(friend_respond))
        .route("/api/friends/remove", post(friend_remove))
        .route("/api/users/search", get(user_search))
        .route("/api/feed", get(feed))
        .route("/api/feed/seen", post(feed_seen))
        .route("/api/show", post(show_card))
        .route("/api/trades", get(trades_list).post(trade_create))
        .route("/api/trades/{tid}/{action}", post(trade_action))
        .route("/api/showcase", post(set_showcase))
        .route("/api/profile", post(set_profile))
        .route("/api/users/{name}", get(profile))
        .route("/api/ranking", get(ranking))
        .route("/api/me", get(me))
        .route("/api/messages/seen", post(messages_seen))
        .route("/api/halloffame", get(hall_of_fame))
        .route("/api/patchnotes", get(patch_notes))
        .route("/api/patchnotes/seen", post(patch_notes_seen))
        .route("/api/links/{token}/claim", post(link_claim))
        // rynek
        .route("/api/market", get(market))
        .route("/api/market/list", post(market_list))
        .route("/api/market/wanted", post(market_wanted_create))
        .route("/api/market/wanted/{wid}/cancel", post(market_wanted_cancel))
        .route("/api/market/wanted/{wid}/fill", post(market_wanted_fill))
        .route("/api/market/offers/{oid}/{action}", post(market_offer_action))
        .route("/api/market/{lid}/buy", post(market_buy))
        .route("/api/market/{lid}/offer", post(market_offer))
        .route("/api/market/{lid}/bid", post(market_bid))
        .route("/api/market/{lid}/cancel", post(market_cancel))
        // kasyno
        .route("/api/casino/roulette", post(casino_roulette))
        .route("/api/casino/slots", post(casino_slots))
        .route("/api/casino/blackjack", get(casino_blackjack))
        .route("/api/casino/blackjack/deal", post(casino_blackjack_deal))
        .route("/api/casino/blackjack/hit", post(casino_blackjack_hit))
        .route("/api/casino/blackjack/stand", post(casino_blackjack_stand))
        .route("/api/casino/blackjack/double", post(casino_blackjack_double))
        .route("/api/casino/jackpot", get(casino_jackpot).post(casino_jackpot_create))
        .route("/api/casino/jackpot/{jid}/join", post(casino_jackpot_join))
        .route("/api/casino/jackpot/{jid}/leave", post(casino_jackpot_leave))
        .route("/api/casino/jackpot/{jid}/kick", post(casino_jackpot_kick))
        .route("/api/casino/jackpot/{jid}/settings", post(casino_jackpot_settings))
        .route("/api/casino/jackpot/{jid}/cards", post(casino_jackpot_cards))
        .route("/api/casino/jackpot/{jid}/ready", post(casino_jackpot_ready))
        .route("/api/casino/jackpot/{jid}/seen", post(casino_jackpot_seen))
        .route("/api/casino/horses", get(horses::casino_horses))
        .route("/api/casino/horses/bet", post(horses::casino_horses_bet))
        .route("/api/casino/horses/bet/{bid}/cancel", post(horses::casino_horses_cancel))
        .route("/api/casino/horses/seen", post(horses::casino_horses_seen))
        .route("/api/casino/horses/solo", post(horses::casino_horses_solo))
        .route("/api/casino/horses/debug", post(horses::casino_horses_debug))
        .route("/api/admin/horses", get(horses::admin_horses).post(horses::admin_horses_save))
        .route("/api/admin/quests", get(quests::admin_quests).post(quests::admin_quests_save))
        .route("/api/items/{id}/drawing", get(drawings::drawing_info).post(drawings::drawing_save))
        // arena (tylko admini)
        .route("/api/arena/inbox", get(arena_inbox))
        .route("/api/arena/start", post(arena_start))
        .route("/api/arena/battle/{bid}", get(arena_battle))
        .route("/api/arena/battle/{bid}/act", post(arena_act))
        .route("/api/arena/challenge", post(arena_challenge))
        .route("/api/arena/challenge/{cid}/accept", post(arena_accept))
        .route("/api/arena/challenge/{cid}/decline", post(arena_decline))
        // panel admina
        .route("/api/admin/messages", get(admin_messages_list).post(admin_messages_add))
        .route("/api/admin/messages/{mid}", delete(admin_messages_delete))
        .route("/api/admin/log", get(admin_log_list))
        .route("/api/admin/catalog", get(admin_catalog))
        .route("/api/admin/crates", post(admin_save_crate))
        .route("/api/admin/crates/{cid}", delete(admin_delete_crate))
        .route("/api/admin/crates/{cid}/restore", post(admin_restore_crate))
        .route("/api/admin/cards", post(admin_save_card))
        .route("/api/admin/cards/{pid}", delete(admin_delete_card))
        .route("/api/admin/cards/{pid}/restore", post(admin_restore_card))
        .route("/api/admin/cards/{pid}/refetch", post(admin_refetch))
        .route("/api/admin/links", get(admin_links).post(admin_link_create))
        .route("/api/admin/links/{link_id}", post(admin_link_toggle))
        .route("/api/admin/users", get(admin_users))
        .route("/api/admin/users/{user_id}", delete(admin_delete_user))
        .route("/api/admin/users/{user_id}/ban", post(admin_ban))
        .route("/api/admin/users/{user_id}/ranking", post(admin_ranking_hidden))
        .route("/api/admin/users/{user_id}/cards", get(admin_user_cards))
        .route("/api/admin/users/{user_id}/cards/delete", post(admin_delete_user_cards))
        .route("/api/admin/users/{user_id}/access", post(admin_set_access))
        .route("/api/admin/users/{user_id}/chests", post(admin_give_chests))
        .route("/api/admin/users/{user_id}/money", post(admin_money))
        .route("/api/admin/users/{user_id}/admin", post(admin_toggle))
        .route("/api/admin/users/{user_id}/password", post(admin_password))
        // osiągnięcia
        .route("/api/users/{name}/achievements", get(crate::achievements::user_achievements))
        .route("/api/achievements/pop", post(crate::achievements::achievements_pop))
        .route(
            "/api/admin/achievements",
            get(crate::achievements::admin_achievements).post(crate::achievements::admin_achievement_save),
        )
        .route("/api/admin/achievements/{aid}/delete", post(crate::achievements::admin_achievement_delete))
        // warianty: ustawienia, wydarzenia, kreator, naklejki; easter eggi
        .route("/sticker/{variant}/{sid}", get(variants::sticker_image))
        .route("/egg", get(variants::egg_image))
        .route("/api/ufo/seen", post(variants::ufo_seen))
        .route("/api/admin/egg", post(variants::admin_egg_save))
        .route("/api/admin/ufo/test", post(variants::admin_ufo_test))
        .route("/api/admin/variants/{variant}", post(variants::admin_variant_save))
        .route("/api/admin/variants/{variant}/crates", post(variants::admin_variant_crate))
        .route("/api/admin/variants/{variant}/events", post(variants::admin_variant_event_add))
        .route("/api/admin/variants/{variant}/events/{eid}/delete", post(variants::admin_variant_event_delete))
        .route("/api/admin/variant-designs", post(variants::admin_variant_design_save))
        .route("/api/admin/variant-designs/{key}/delete", post(variants::admin_variant_design_delete))
        .route("/api/admin/stickers/{variant}", get(variants::admin_stickers_get).post(variants::admin_stickers_save))
        .route("/api/admin/stickers/{variant}/upload", post(variants::admin_sticker_upload))
        .route("/api/admin/stickers/{variant}/card/{pid}", post(variants::admin_card_stickers_save));
    for view in pages::VIEWS {
        r = r.route(&format!("/{view}"), get(index));
    }
    r.with_state(st)
}
