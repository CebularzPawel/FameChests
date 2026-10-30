//! Konta: hasła (format werkzeug - te same hashe co w wersji Python), sesja w podpisanym ciasteczku,
//! zalogowany gracz (`Me`) / admin (`Admin`) jako extractory, limit nieudanych logowań.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, Key, SameSite, SignedCookieJar};
use hmac::Hmac;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256, Sha512};

use crate::catalog::Catalog;
use crate::data::g;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "scambox_session";
const SESSION_DAYS: i64 = 30;
pub const MIN_PASSWORD: usize = 8;
pub const LOGIN_WINDOW: f64 = 5.0 * 60.0; // okno liczenia nieudanych logowań (sekundy)
pub const LOGIN_MAX_PER_USER: usize = 5;
pub const LOGIN_MAX_PER_IP: usize = 20;

pub fn password_error() -> String {
    format!("Hasło musi mieć co najmniej {MIN_PASSWORD} znaków")
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub avatar: String,
    pub is_admin: i32,
    pub created_at: f64,
    pub avatar_card: String,
    pub avatar_variant: String,
    pub banned: i32,
    pub ban_reason: String,
    pub ranking_hidden: i32,
    pub money_generated: i32,
}

impl User {
    pub fn admin(&self) -> bool {
        self.is_admin != 0
    }

    /// Gracz poza rankingiem (zablokowany, ukryty przez admina, z pieniędzmi od admina) - nie ma go też w Hall of Fame
    pub fn hidden_from_ranking(&self) -> bool {
        self.banned != 0 || self.ranking_hidden != 0 || self.money_generated != 0
    }

    /// Karta ustawiona jako ikona gracza (id osoby) albo None
    pub fn avatar_card<'a>(&'a self, cat: &Catalog) -> Option<&'a str> {
        Some(self.avatar_card.as_str()).filter(|p| cat.has(p))
    }

    pub fn avatar_variant(&self) -> &str {
        if g().is_variant(&self.avatar_variant) {
            &self.avatar_variant
        } else {
            "normal"
        }
    }

    /// Gracz w odpowiedziach API (nazwa, awatar, ikona z karty)
    pub fn view(&self, cat: &Catalog) -> UserView {
        let card = self.avatar_card(cat);
        UserView {
            id: self.id,
            username: self.username.clone(),
            avatar: self.avatar.clone(),
            is_admin: self.admin(),
            avatar_card: card.map(str::to_owned),
            avatar_rarity: card.map(|p| cat.people[p].rarity.clone()),
            avatar_variant: card.map(|_| self.avatar_variant().to_owned()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: i64,
    pub username: String,
    pub avatar: String,
    pub is_admin: bool,
    pub avatar_card: Option<String>,
    pub avatar_rarity: Option<String>,
    pub avatar_variant: Option<String>,
}

pub async fn find_user(c: &mut crate::db::Conn, name: &str) -> sqlx::Result<Option<User>> {
    sqlx::query_as!(User, "SELECT * FROM users WHERE LOWER(username) = LOWER($1)", name.trim()).fetch_optional(c).await
}

pub async fn user_by_id(c: &mut crate::db::Conn, id: i64) -> sqlx::Result<Option<User>> {
    sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id).fetch_optional(c).await
}

// ---------------------------------------------------------------- hasła (werkzeug.security)

/// generate_password_hash z werkzeug 3: "scrypt:32768:8:1$<sól>$<hex>" - działa też w wersji Python
pub fn hash_password(password: &str) -> String {
    use rand::distributions::{Alphanumeric, DistString};
    let salt = Alphanumeric.sample_string(&mut rand::thread_rng(), 16);
    let params = scrypt::Params::new(15, 8, 1, 64).expect("parametry scrypt");
    let mut out = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).expect("scrypt");
    format!("scrypt:32768:8:1${salt}${}", hex::encode(out))
}

/// check_password_hash z werkzeug: scrypt i pbkdf2 (sha256/sha512)
pub fn check_password(hash: &str, password: &str) -> bool {
    let mut parts = hash.splitn(3, '$');
    let (Some(method), Some(salt), Some(want)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Ok(want) = hex::decode(want) else { return false };
    let args: Vec<&str> = method.split(':').collect();
    let got: Vec<u8> = match args.as_slice() {
        ["scrypt", rest @ ..] => {
            let n: u64 = rest.first().and_then(|x| x.parse().ok()).unwrap_or(32768);
            let r: u32 = rest.get(1).and_then(|x| x.parse().ok()).unwrap_or(8);
            let p: u32 = rest.get(2).and_then(|x| x.parse().ok()).unwrap_or(1);
            if !n.is_power_of_two() {
                return false;
            }
            let Ok(params) = scrypt::Params::new(n.trailing_zeros() as u8, r, p, want.len().max(10)) else {
                return false;
            };
            let mut out = vec![0u8; want.len()];
            if scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).is_err() {
                return false;
            }
            out
        }
        ["pbkdf2", rest @ ..] => {
            let algo = rest.first().copied().unwrap_or("sha256");
            let iterations: u32 = rest.get(1).and_then(|x| x.parse().ok()).unwrap_or(600_000);
            let mut out = vec![0u8; want.len()];
            let ok = match algo {
                "sha256" => pbkdf2::pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt.as_bytes(), iterations, &mut out),
                "sha512" => pbkdf2::pbkdf2::<Hmac<Sha512>>(password.as_bytes(), salt.as_bytes(), iterations, &mut out),
                _ => return false,
            };
            if ok.is_err() {
                return false;
            }
            out
        }
        _ => return false,
    };
    constant_eq(&got, &want)
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Hashowanie trwa ~0,1 s (scrypt) - poza wątkami serwera
pub async fn hash_password_async(password: String) -> String {
    tokio::task::spawn_blocking(move || hash_password(&password)).await.expect("hash")
}

pub async fn check_password_async(hash: String, password: String) -> bool {
    tokio::task::spawn_blocking(move || check_password(&hash, &password)).await.unwrap_or(false)
}

// ---------------------------------------------------------------- sesja (podpisane ciasteczko z id gracza)

pub fn cookie_key(secret: &str) -> Key {
    Key::from(&Sha512::digest(secret.as_bytes()))
}

impl FromRef<AppState> for Key {
    fn from_ref(st: &AppState) -> Key {
        st.cookie_key.clone()
    }
}

/// Ciasteczko logowania na 30 dni (odnawiane przy /api/me - jak sesja "permanent" we Flasku)
pub fn session_cookie(uid: i64, secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, uid.to_string()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time_days(SESSION_DAYS))
        .build()
}

fn time_days(days: i64) -> time::Duration {
    time::Duration::days(days)
}

pub fn clear_session(jar: SignedCookieJar) -> SignedCookieJar {
    jar.remove(Cookie::build(SESSION_COOKIE).path("/"))
}

pub fn session_uid(jar: &SignedCookieJar) -> Option<i64> {
    jar.get(SESSION_COOKIE).and_then(|c| c.value().parse().ok())
}

/// Zalogowany gracz (zablokowane konto = wylogowane)
#[derive(Clone)]
pub struct Me(pub User);

/// Zalogowany admin
#[derive(Clone)]
pub struct Admin(pub User);

/// Gracz, jeśli jest zalogowany (zdjęcia, strona logowania)
pub struct MaybeUser(pub Option<User>);

pub enum AuthReject {
    Api(SignedCookieJar),
    Page(SignedCookieJar, String),
    Forbidden(bool),
    Internal,
}

impl IntoResponse for AuthReject {
    fn into_response(self) -> Response {
        match self {
            AuthReject::Api(jar) => {
                (StatusCode::UNAUTHORIZED, jar, Json(json!({"error": "Zaloguj się", "login": true}))).into_response()
            }
            AuthReject::Page(jar, path) => {
                let to = if path == "/" {
                    "/login".to_owned()
                } else {
                    format!("/login?next={}", form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>())
                };
                (jar, Redirect::to(&to)).into_response()
            }
            AuthReject::Forbidden(true) => (StatusCode::FORBIDDEN, Json(json!({"error": "Tylko dla admina"}))).into_response(),
            AuthReject::Forbidden(false) => Redirect::to("/").into_response(),
            AuthReject::Internal => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Błąd serwera"}))).into_response(),
        }
    }
}

async fn load_user(parts: &mut Parts, st: &AppState) -> Result<(Option<User>, SignedCookieJar), AuthReject> {
    let jar = SignedCookieJar::from_headers(&parts.headers, st.cookie_key.clone());
    let Some(uid) = session_uid(&jar) else { return Ok((None, jar)) };
    let mut c = st.db.acquire().await.map_err(|_| AuthReject::Internal)?;
    let user = user_by_id(&mut c, uid).await.map_err(|_| AuthReject::Internal)?;
    match user {
        Some(u) if u.banned != 0 => Ok((None, clear_session(jar))), // zablokowane konto - wylogowujemy
        Some(u) => Ok((Some(u), jar)),
        None => Ok((None, clear_session(jar))),
    }
}

impl FromRequestParts<AppState> for Me {
    type Rejection = AuthReject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let (user, jar) = load_user(parts, st).await?;
        match user {
            Some(u) => Ok(Me(u)),
            None if parts.uri.path().starts_with("/api/") => Err(AuthReject::Api(jar)),
            None => Err(AuthReject::Page(jar, parts.uri.path().to_owned())),
        }
    }
}

impl FromRequestParts<AppState> for Admin {
    type Rejection = AuthReject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let Me(u) = Me::from_request_parts(parts, st).await?;
        if !u.admin() {
            return Err(AuthReject::Forbidden(parts.uri.path().starts_with("/api/")));
        }
        Ok(Admin(u))
    }
}

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = AuthReject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        Ok(MaybeUser(load_user(parts, st).await?.0))
    }
}

// ---------------------------------------------------------------- nieudane logowania
// Po LOGIN_MAX_PER_USER błędnych hasłach na to samo konto albo LOGIN_MAX_PER_IP z jednego adresu trzeba odczekać,
// aż minie LOGIN_WINDOW (w pamięci procesu - serwer działa jako jeden proces).

#[derive(Default)]
pub struct LoginLimiter {
    failed: Mutex<HashMap<(bool, String), Vec<f64>>>,
}

impl LoginLimiter {
    fn recent(map: &mut HashMap<(bool, String), Vec<f64>>, key: &(bool, String), now: f64) -> Vec<f64> {
        let times: Vec<f64> =
            map.get(key).map(|t| t.iter().copied().filter(|t| now - t < LOGIN_WINDOW).collect()).unwrap_or_default();
        if times.is_empty() {
            map.remove(key);
        } else {
            map.insert(key.clone(), times.clone());
        }
        times
    }

    /// Ile sekund trzeba jeszcze czekać (0 = można próbować)
    pub fn blocked(&self, name: &str, ip: &str) -> i64 {
        let now = crate::db::now();
        let mut map = self.failed.lock();
        let mut waits: Vec<f64> = vec![];
        for (key, limit) in [((true, name.to_lowercase()), LOGIN_MAX_PER_USER), ((false, ip.to_owned()), LOGIN_MAX_PER_IP)] {
            let times = Self::recent(&mut map, &key, now);
            if times.len() >= limit {
                waits.push(LOGIN_WINDOW - (now - times[times.len() - limit]));
            }
        }
        waits.into_iter().reduce(f64::max).map(|w| w as i64 + 1).unwrap_or(0)
    }

    pub fn note(&self, name: &str, ip: &str, ok: bool) {
        let now = crate::db::now();
        let mut map = self.failed.lock();
        if ok {
            map.remove(&(true, name.to_lowercase()));
            return;
        }
        for key in [(true, name.to_lowercase()), (false, ip.to_owned())] {
            map.entry(key).or_default().push(now);
        }
        if map.len() > 10000 {
            // zabezpieczenie przed zapchaniem pamięci
            let keys: Vec<_> = map.keys().cloned().collect();
            for key in keys {
                Self::recent(&mut map, &key, now);
            }
        }
    }
}

/// "1.2.3.4:5678" -> "1.2.3.4", "[::1]:5678" -> "::1" (Azure App Service dopisuje port do X-Forwarded-For)
fn strip_port(ip: &str) -> &str {
    if let Some(rest) = ip.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match ip.split_once(':') {
        Some((host, port)) if !port.contains(':') && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => ip,
    }
}

/// Adres gracza (za proxy - ostatni z X-Forwarded-For, jak ProxyFix(x_for=1))
pub fn client_ip(st: &AppState, headers: &HeaderMap, addr: Option<&ConnectInfo<SocketAddr>>) -> String {
    if st.cfg.trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .map(|v| strip_port(v.trim()).to_owned())
            .filter(|v| !v.is_empty())
        {
            return ip;
        }
    }
    addr.map(|a| a.0.ip().to_string()).unwrap_or_default()
}

pub type Limiter = Arc<LoginLimiter>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_hash_roundtrip() {
        let h = hash_password("tajne-haslo");
        assert!(h.starts_with("scrypt:32768:8:1$"));
        assert!(check_password(&h, "tajne-haslo"));
        assert!(!check_password(&h, "inne"));
    }

    #[test]
    fn werkzeug_hashes() {
        // wygenerowane przez werkzeug.security.generate_password_hash("haslo123", method=...)
        for (h, pw) in
            serde_json::from_str::<Vec<(String, String)>>(include_str!("../tests/fixtures/werkzeug_hashes.json")).unwrap()
        {
            assert!(check_password(&h, &pw), "{h}");
            assert!(!check_password(&h, "zle-haslo"), "{h}");
        }
    }

    #[test]
    fn limiter() {
        let l = LoginLimiter::default();
        for _ in 0..LOGIN_MAX_PER_USER {
            assert_eq!(l.blocked("Ala", "1.1.1.1"), 0);
            l.note("ala", "1.1.1.1", false);
        }
        assert!(l.blocked("ALA", "2.2.2.2") > 0);
        l.note("ala", "1.1.1.1", true);
        assert_eq!(l.blocked("ala", "3.3.3.3"), 0);
    }
}
