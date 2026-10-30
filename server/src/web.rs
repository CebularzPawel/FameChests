//! Strony HTML (szablony Jinja z templates/ - minijinja), wersjonowanie plików statycznych, nagłówki pamięci
//! podręcznej, gzip, wysyłanie plików.

use std::path::Path;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use minijinja::{Environment, Value as JValue};
use tower::ServiceExt;
use tower_http::compression::predicate::{Predicate, SizeAbove};
use tower_http::services::ServeFile;

use crate::error::{AppError, Res};

pub struct Templates {
    dev: bool,
    env: Environment<'static>,
}

fn make_env() -> Environment<'static> {
    let mut env = Environment::new();
    // szablony wbudowane w plik wykonywalny (assets.rs)
    env.set_loader(|name| Ok(crate::assets::template(name)));
    // {{ asset('css/style.css') }} -> /static/css/style.css?v=<wersja>: po aktualizacji przeglądarka
    // zawsze pobierze nowe pliki; adres z własnych plików gry - bez escapowania "/" (jak url_for we Flasku)
    env.add_function("asset", |filename: String| -> JValue { JValue::from_safe_string(crate::assets::asset(&filename)) });
    env
}

impl Templates {
    pub fn new(dev: bool) -> Self {
        Templates { dev, env: make_env() }
    }

    pub fn render(&self, name: &str, ctx: JValue) -> Res {
        // --dev: szablony czytane od nowa przy każdym zapytaniu
        let fresh;
        let env = if self.dev {
            fresh = make_env();
            &fresh
        } else {
            &self.env
        };
        let html = env
            .get_template(name)
            .and_then(|t| t.render(ctx))
            .map_err(|e| AppError::Internal(anyhow::anyhow!("szablon {name}: {e:#}")))?;
        Ok(Html(html).into_response())
    }
}

/// Strony HTML i odpowiedzi API nie mogą być brane z pamięci przeglądarki (stara wersja gry); pliki statyczne
/// z ?v=<wersja> zmieniają adres przy każdej zmianie - przeglądarka nie musi o nie pytać.
pub async fn cache_headers(req: Request, next: Next) -> Response {
    let versioned_static = req.uri().path().starts_with("/static/")
        && req.uri().query().is_some_and(|q| q.split('&').any(|p| p.starts_with("v=") && p.len() > 2));
    let mut resp = next.run(req).await;
    let ctype = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let mime = ctype.split(';').next().unwrap_or("").trim();
    if mime == "text/html" || mime == "application/json" {
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else if versioned_static && resp.status() == StatusCode::OK {
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }
    resp
}

/// Odpowiedzi tekstowe spakowane gzipem (ekwipunek z kilkoma tysiącami kart to ~0,5 MB JSON-a, po spakowaniu ~35 KB)
#[derive(Clone, Copy)]
pub struct GzipTypes;

impl Predicate for GzipTypes {
    fn should_compress<B: axum::body::HttpBody>(&self, resp: &axum::http::Response<B>) -> bool {
        let ctype = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
        let mime = ctype.split(';').next().unwrap_or("").trim();
        matches!(mime, "application/json" | "text/html" | "image/svg+xml" | "application/manifest+json")
    }
}

pub fn gzip_predicate() -> impl Predicate {
    SizeAbove::new(1024).and(GzipTypes)
}

/// Plik z dysku (z obsługą If-Modified-Since) z typem i nagłówkiem Cache-Control
pub async fn send_file(path: &Path, mime: &str, headers: &HeaderMap, cache_control: &str) -> Res {
    let mut req = Request::builder().uri("/");
    for h in [header::IF_MODIFIED_SINCE, header::IF_NONE_MATCH, header::RANGE] {
        if let Some(v) = headers.get(&h) {
            req = req.header(h, v);
        }
    }
    let req = req.body(Body::empty()).map_err(|e| AppError::Internal(e.into()))?;
    let mime: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
    let resp = ServeFile::new_with_mime(path, &mime).oneshot(req).await.map_err(|e| AppError::Internal(e.into()))?;
    let mut resp = resp.map(Body::new);
    if resp.status() == StatusCode::NOT_FOUND {
        return Err(AppError::Status(StatusCode::NOT_FOUND));
    }
    if let Ok(v) = HeaderValue::from_str(cache_control) {
        resp.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    Ok(resp)
}

/// SVG wygenerowane przez serwer (bez pamięci podręcznej)
pub fn svg_response(svg: String) -> Response {
    ([(header::CONTENT_TYPE, "image/svg+xml"), (header::CACHE_CONTROL, "no-store")], svg).into_response()
}
