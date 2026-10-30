//! Strony HTML, PWA (manifest, service worker), zdjęcia kart, flagi, ikony graczy.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use minijinja::context;
use serde_json::json;

use crate::auth::{Admin, MaybeUser, Me};
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{AppError, Res};
use crate::game::market::{get_listing, ListingStatus};
use crate::game::{discovered, friend_ids};
use crate::images::{mimetype, Kind};
use crate::routes::casino::JackpotStatus;
use crate::state::AppState;
use crate::web::{send_file, svg_response};

/// Widoki gry pod własnym adresem (ta sama strona index.html, widok wybiera JS)
pub const VIEWS: &[&str] = &["crates", "binder", "inventory", "forge", "market", "casino", "friends", "ranking", "arena", "stickers", "variants", "designer"];

const MYSTERY_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <defs><radialGradient id="g"><stop offset="0" stop-color="#5a4a1a"/><stop offset="1" stop-color="#0b0906"/></radialGradient></defs>
  <rect width="300" height="300" fill="url(#g)"/>
  <text x="150" y="190" font-family="Georgia, serif" font-size="150" fill="#f3e3b0" text-anchor="middle">★</text>
  <text x="150" y="268" font-family="Arial" font-weight="bold" font-size="34" fill="#f3e3b0" text-anchor="middle" letter-spacing="6">???</text>
</svg>"##;

pub async fn login_page(State(st): State<AppState>, MaybeUser(u): MaybeUser) -> Res {
    if u.is_some() {
        return Ok(Redirect::to("/").into_response());
    }
    let n = sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!" FROM users"#).fetch_one(&st.db).await?;
    st.templates.render("login.html", context! { first => n == 0 })
}

pub async fn index(State(st): State<AppState>, Me(me): Me, uri: Uri) -> Res {
    // Arena i makiety kart specjalnych: tylko admini
    if matches!(uri.path(), "/arena" | "/mockups" | "/stickers" | "/variants" | "/designer") && !me.admin() {
        return Ok(Redirect::to("/").into_response());
    }
    st.templates.render("index.html", context! {})
}

pub async fn admin_page(State(st): State<AppState>, Admin(_): Admin) -> Res {
    st.templates.render("admin.html", context! {})
}

pub async fn admin_mockups(Admin(_): Admin) -> Redirect {
    Redirect::to("/mockups") // makiety kart specjalnych są w grze (index.html), nie w panelu
}

// ---------------------------------------------------------------- aplikacja na telefon (PWA)

pub async fn manifest() -> Response {
    let data = json!({
        "name": "ScamBox", "short_name": "ScamBox", "lang": "pl",
        "description": "Otwieraj skrzynki z kartami znanych osób, zbieraj kolekcję i wymieniaj się ze znajomymi.",
        "start_url": "/crates", "scope": "/", "display": "standalone", "orientation": "portrait",
        "background_color": "#0b0e1a", "theme_color": "#0c0f17",
        "icons": [{"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/static/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    });
    ([(header::CONTENT_TYPE, "application/manifest+json")], data.to_string()).into_response()
}

/// Z głównego adresu, żeby obejmował całą grę; bez zapisywania plików gry (zawsze najnowsza wersja)
pub async fn service_worker() -> Res {
    let js = crate::assets::static_file("sw.js").ok_or(AppError::Status(StatusCode::NOT_FOUND))?;
    Ok(([(header::CONTENT_TYPE, "application/javascript"), (header::CACHE_CONTROL, "no-cache")], js.into_owned()).into_response())
}

// ---------------------------------------------------------------- flagi i zdjęcia

/// Flaga kraju do wariantu flagowego (pobrana raz z flagcdn.com i trzymana w image_cache/flags)
pub async fn flag_image(State(st): State<AppState>, Path(file): Path<String>, headers: HeaderMap) -> Res {
    let Some(code) = file.strip_suffix(".svg") else { return Err(AppError::Status(StatusCode::NOT_FOUND)) };
    let Some(path) = st.images.flag(code).await else {
        // zły kod / brak internetu: neutralna flaga z kodem kraju
        let safe: String =
            code.chars().filter(|c| c.is_ascii_alphabetic() || *c == '-').take(6).collect::<String>().to_uppercase();
        return Ok(svg_response(format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" fill="#5a6274"/>
          <rect y="160" width="640" height="160" fill="#8c97b2"/><text x="320" y="275" font-family="Arial" font-weight="bold"
          font-size="110" fill="#fff" text-anchor="middle">{safe}</text></svg>"##
        )));
    };
    let mut resp = send_file(&path, "image/svg+xml", &headers, &format!("public, max-age={}", 7 * 86400)).await?;
    // SVG z zewnątrz: bez skryptów
    resp.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
    );
    Ok(resp)
}

pub async fn image_main(
    st: State<AppState>,
    u: MaybeUser,
    Path(pid): Path<String>,
    q: Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Res {
    image(st, u, pid, "main".into(), q, headers).await
}

pub async fn image_kind(
    st: State<AppState>,
    u: MaybeUser,
    Path((pid, kind)): Path<(String, String)>,
    q: Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Res {
    image(st, u, pid, kind, q, headers).await
}

async fn image(
    State(st): State<AppState>,
    MaybeUser(u): MaybeUser,
    pid: String,
    kind: String,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Res {
    let cat = st.cat();
    let Some(p) = cat.person(&pid).cloned() else { return Err(AppError::Status(StatusCode::NOT_FOUND)) };
    let mut c = st.db.acquire().await?;
    if p.is_secret() {
        let found = match &u {
            Some(u) => discovered(&mut c, u.id).await?,
            None => Default::default(),
        };
        if !found.contains(&pid) {
            // ?admin=1 - podgląd w panelu admina, ?feed=ID - tajna karta pokazana w aktywności znajomych, ?owner, ?battle,
            // ?market, ?jackpot - karta znajomego / w walce / na rynku / w jackpocie
            let allowed = match &u {
                None => false,
                Some(u) => {
                    (q.get("admin").map(String::as_str) == Some("1") && u.admin())
                        || feed_entry_visible(&mut c, u.id, q.get("feed"), &pid).await?
                        || friend_owns(&mut c, u.id, q.get("owner"), &pid).await?
                        || arena_shows(&st, u.id, q.get("battle"), &pid).await
                        || market_shows(&mut c, u.id, q.get("market"), &pid).await?
                        || jackpot_shows(&mut c, u.id, q.get("jackpot"), &pid).await?
                }
            };
            if !allowed {
                return Ok(svg_response(MYSTERY_SVG.into()));
            }
        }
    }
    drop(c);
    // własne zdjęcie wariantu (Rzulty, Halloweenowa...; połączony wariant - ta część, która je ma), potem zdjęcie
    // z "photoFallback" (Lampionowa / Diabelska -> Halloweenowa), na końcu zwykłe
    let photos = cat.photo_variants(&pid);
    let parts: Vec<&str> = kind.split('+').filter(|v| photos.iter().any(|x| x == v)).collect();
    let path = if !parts.is_empty() {
        let mut tries: Vec<String> = parts.iter().map(|v| v.to_string()).collect();
        tries.extend(parts.iter().filter_map(|v| g().variants[*v].photo_fallback.clone()).filter(|f| photos.contains(f)));
        match tries.iter().find_map(|v| st.images.find(&pid, &Kind::Variant(v.clone()))) {
            Some(p) => Some(p),
            None => st.images.ensure(&pid, p.wiki.clone(), false).await,
        }
    } else {
        st.images.ensure(&pid, p.wiki.clone(), kind == "alt").await
    };
    if let Some(path) = path {
        // ?s=1 - mały kafelek (bęben, kuźnia, kasyno): miniatura; ?v=<wersja zdjęcia> - adres zmienia się razem ze zdjęciem
        let path = st.images.web_version_async(path, q.get("s").map(String::as_str) == Some("1")).await;
        let cache = if p.is_secret() {
            "private, no-store".to_owned()
        } else {
            format!("public, max-age={}", if q.contains_key("v") { 30 * 86400 } else { 86400 })
        };
        return send_file(&path, mimetype(&path), &headers, &cache).await;
    }
    let initials: String =
        p.name.replace('„', "").split_whitespace().take(2).filter_map(|w| w.chars().next()).collect::<String>().to_uppercase();
    let color = &g().rarities[&p.rarity].color;
    Ok(svg_response(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
      <rect width="300" height="400" fill="#1d2233"/>
      <circle cx="150" cy="170" r="95" fill="{color}" opacity=".25"/>
      <text x="150" y="200" font-family="Arial" font-size="90" font-weight="bold"
            fill="{color}" text-anchor="middle">{initials}</text></svg>"##
    )))
}

/// Ikona gracza ze zdjęcia karty
pub async fn avatar_image(State(st): State<AppState>, Me(me): Me, Path(name): Path<String>, headers: HeaderMap) -> Res {
    let cat = st.cat();
    let mut c = st.db.acquire().await?;
    let u = crate::auth::find_user(&mut c, &name).await?;
    let Some((u, pid)) = u.as_ref().and_then(|u| u.avatar_card(&cat).map(|p| (u, p.to_owned()))) else {
        return Err(AppError::Status(StatusCode::NOT_FOUND));
    };
    let p = cat.people[&pid].clone();
    // tajna karta jako ikona: widzą ją tylko ci, którzy ją odkryli, sam gracz i jego znajomi
    if p.is_secret()
        && !discovered(&mut c, me.id).await?.contains(&pid)
        && u.id != me.id
        && !friend_ids(&mut c, me.id).await?.contains(&u.id)
    {
        return Ok(svg_response(MYSTERY_SVG.into()));
    }
    drop(c);
    let Some(path) = st.images.ensure(&pid, p.wiki.clone(), false).await else {
        return Err(AppError::Status(StatusCode::NOT_FOUND));
    };
    let path = st.images.web_version_async(path, true).await; // ikona gracza jest mała - wystarczy miniatura
    send_file(&path, mimetype(&path), &headers, "private, max-age=300").await
}

// ---------------------------------------------------------------- kiedy tajną kartę widać mimo braku odkrycia

/// Zapytanie: wpisy aktywności, które widzi gracz (swoje, do niego, znajomych do wszystkich)
pub async fn feed_entry_visible(c: &mut Conn, me: i64, feed_id: Option<&String>, pid: &str) -> sqlx::Result<bool> {
    let Some(fid) = feed_id.and_then(|f| f.trim().parse::<i64>().ok()) else { return Ok(false) };
    let row = sqlx::query_scalar!(
        "SELECT f.id FROM feed f JOIN users u ON u.id = f.author_id
         WHERE (f.author_id = $1 OR f.to_user_id = $1
            OR (f.to_user_id IS NULL AND f.author_id IN (
                SELECT addressee_id FROM friendships WHERE requester_id = $1 AND status = 'accepted'
                UNION SELECT requester_id FROM friendships WHERE addressee_id = $1 AND status = 'accepted')))
         AND f.id = $2 AND f.person_id = $3",
        me,
        fid,
        pid
    )
    .fetch_optional(c)
    .await?;
    Ok(row.is_some())
}

/// Czy gracz o tej nazwie jest moim znajomym i ma tę kartę (wtedy widzę ją na jego profilu)
pub async fn friend_owns(c: &mut Conn, me: i64, owner: Option<&String>, pid: &str) -> sqlx::Result<bool> {
    let Some(owner) = owner.filter(|o| !o.is_empty()) else { return Ok(false) };
    let Some(owner) = crate::auth::find_user(c, owner).await? else { return Ok(false) };
    if !friend_ids(c, me).await?.contains(&owner.id) {
        return Ok(false);
    }
    Ok(sqlx::query_scalar!("SELECT 1 AS one FROM user_collected WHERE user_id = $1 AND person_id = $2 LIMIT 1", owner.id, pid)
        .fetch_optional(c)
        .await?
        .is_some())
}

/// Tajna karta biorąca udział w mojej walce
pub async fn arena_shows(st: &AppState, me: i64, bid: Option<&String>, pid: &str) -> bool {
    let Some(bid) = bid.filter(|b| !b.is_empty()) else { return false };
    let arena = st.arena.inner.lock().await;
    arena.battles.get(bid).is_some_and(|b| b.side_of_user(me).is_some() && b.pids().contains(pid))
}

/// Tajna karta w ofercie na rynku - jej zdjęcie widać (aktywna oferta albo moja transakcja)
pub async fn market_shows(c: &mut Conn, me: i64, lid: Option<&String>, pid: &str) -> sqlx::Result<bool> {
    let Some(lid) = lid.and_then(|l| l.trim().parse::<i64>().ok()) else { return Ok(false) };
    let l = get_listing(c, lid).await?;
    Ok(l.is_some_and(|l| {
        l.person_id == pid && (l.status == ListingStatus::Active || me == l.seller_id || Some(me) == l.buyer_id)
    }))
}

/// Tajna karta w lobby jackpota (lobby, które widzę, moja gra albo gra z ostatniej doby)
pub async fn jackpot_shows(c: &mut Conn, me: i64, jid: Option<&String>, pid: &str) -> sqlx::Result<bool> {
    let Some(jid) = jid.and_then(|j| j.trim().parse::<i64>().ok()) else { return Ok(false) };
    let Some(j) = crate::routes::casino::get_jackpot(c, jid).await? else { return Ok(false) };
    let has =
        sqlx::query_scalar!("SELECT 1 AS one FROM jackpot_items WHERE jackpot_id = $1 AND person_id = $2 LIMIT 1", jid, pid)
            .fetch_optional(&mut *c)
            .await?
            .is_some();
    if !has {
        return Ok(false);
    }
    if j.status == JackpotStatus::Open {
        return crate::routes::casino::jackpot_can_see(c, &j, me).await;
    }
    Ok(j.seat(me).is_some() || j.finished_at.unwrap_or(0.0) > now() - 86400.0)
}
