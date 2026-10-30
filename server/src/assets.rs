//! Pliki gry wbudowane w plik wykonywalny (scambox.exe działa sam, bez folderu gry): static/, templates/,
//! custom_images/ i catalog_export.json. W wersji debug (cargo run bez --release) rust-embed czyta je z dysku przy każdym
//! zapytaniu - zmiany w JS/CSS/szablonach widać od razu.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use axum::extract::Path;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../static/"]
pub struct Static;

#[derive(RustEmbed)]
#[folder = "../templates/"]
pub struct Templates;

#[derive(RustEmbed)]
#[folder = "../custom_images/"]
pub struct CustomImages;

/// catalog_export.json z repozytorium (zmiany z panelu admina dla nowej instalacji)
pub const CATALOG_EXPORT: &str = include_str!("../../catalog_export.json");

/// Plik z static/ (ścieżka względna, np. "js/app.js")
pub fn static_file(path: &str) -> Option<Cow<'static, [u8]>> {
    Static::get(path).map(|f| f.data)
}

/// Szablon z templates/ jako tekst
pub fn template(name: &str) -> Option<String> {
    Templates::get(name).map(|f| String::from_utf8_lossy(&f.data).into_owned())
}

/// Wersja pliku statycznego do adresu ?v= (skrót treści - zmienia się razem z plikiem)
fn version(path: &str) -> String {
    static CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);
    if !cfg!(debug_assertions) {
        if let Some(v) = CACHE.lock().get(path) {
            return v.clone();
        }
    }
    let v = Static::get(path).map(|f| hex::encode(&f.metadata.sha256_hash()[..5])).unwrap_or_else(|| "0".into());
    CACHE.lock().insert(path.to_owned(), v.clone());
    v
}

/// {{ asset('css/style.css') }} -> /static/css/style.css?v=<wersja>: po aktualizacji przeglądarka zawsze pobierze
/// nowe pliki (jak asset() w wersji Python)
pub fn asset(path: &str) -> String {
    format!("/static/{path}?v={}", version(path))
}

/// /static/<ścieżka> - pliki z wbudowanego folderu static/ (ETag = skrót treści)
pub async fn serve_static(Path(path): Path<String>, headers: HeaderMap) -> Response {
    let Some(file) = Static::get(&path) else { return StatusCode::NOT_FOUND.into_response() };
    let etag = format!("\"{}\"", hex::encode(&file.metadata.sha256_hash()[..8]));
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let mime = file.metadata.mimetype().to_owned();
    let mut resp = file.data.into_owned().into_response();
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    // pliki z ?v= dostają długą pamięć podręczną w web::cache_headers
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_files() {
        assert!(static_file("js/app.js").is_some());
        assert!(template("index.html").is_some());
        assert!(asset("css/style.css").starts_with("/static/css/style.css?v="));
        assert!(CATALOG_EXPORT.contains("\"cards\""));
    }
}
