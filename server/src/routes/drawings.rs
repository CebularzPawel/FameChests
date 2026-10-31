//! Czysta kartka (wariant `blank`): gracz rysuje na swojej karcie na dwóch warstwach (tło i zdjęcie) i wybiera kolor tła.
//! Rysunek jest przypisany do egzemplarza karty (`card_drawings.item_id`), więc idzie za kartą przy wymianie, na rynku,
//! w jackpocie i w każdym innym przekazaniu, a znika razem z nią. Zmieniać może tylko właściciel.
//!
//! Warstwy: `bg` i `photo` to przezroczyste PNG do dalszej edycji, `flat` = kolor tła + `bg` - to widać na karcie.

use std::io::Cursor;
use std::sync::LazyLock;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use image::{imageops, ImageFormat, ImageReader, Limits, Rgba, RgbaImage};
use serde::Deserialize;
use serde_json::json;

use super::{ok, JsonBody};
use crate::achievements::parts;
use crate::auth::Me;
use crate::catalog::Catalog;
use crate::db::{lock_me, now, Conn};
use crate::error::{bad, Res};
use crate::game::{item_json, ItemJson, ItemRow};
use crate::state::AppState;

pub const VARIANT: &str = "blank";
const DEFAULT_COLOR: &str = "#ffffff";
/// największy bok warstwy i rozmiar pliku (zapis z canvasa to ok. 500 x 700 px)
const MAX_SIDE: u32 = 1024;
const MAX_BYTES: usize = 4 * 1024 * 1024;

static EMPTY: LazyLock<Vec<u8>> = LazyLock::new(|| png(&RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 0]))).unwrap_or_default());

fn png(img: &RgbaImage) -> Option<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// "#rrggbb" -> kolor (tylko taki zapis)
fn parse_color(c: &str) -> Option<[u8; 3]> {
    let h = c.strip_prefix('#').filter(|h| h.len() == 6 && h.is_ascii())?;
    let at = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([at(0)?, at(2)?, at(4)?])
}

/// Warstwa z przeglądarki (data URL albo sam base64 PNG) -> obraz. Dekodujemy z limitem rozmiaru i zapisujemy od nowa,
/// żeby w bazie był zawsze czysty PNG, a nie to, co przysłał klient.
fn decode(data: &str) -> Option<RgbaImage> {
    let b64 = data.strip_prefix("data:image/png;base64,").unwrap_or(data);
    if b64.len() > MAX_BYTES * 4 / 3 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    Some(reader.decode().ok()?.to_rgba8())
}

#[derive(Deserialize)]
pub struct DrawingRequest {
    color: String,
    bg: String,
    photo: String,
}

/// (bg, photo, flat) gotowe do zapisu; None w środku = na karcie nic nie ma (biała, bez kresek)
fn prepare(req: &DrawingRequest, color: [u8; 3]) -> Option<Option<(Vec<u8>, Vec<u8>, Vec<u8>)>> {
    let bg = decode(&req.bg)?;
    let photo = decode(&req.photo)?;
    let empty = |i: &RgbaImage| i.pixels().all(|p| p.0[3] == 0);
    if color == [255, 255, 255] && empty(&bg) && empty(&photo) {
        return Some(None);
    }
    let [r, g, b] = color;
    let mut flat = RgbaImage::from_pixel(bg.width(), bg.height(), Rgba([r, g, b, 255]));
    imageops::overlay(&mut flat, &bg, 0, 0);
    Some(Some((png(&bg)?, png(&photo)?, png(&flat)?)))
}

/// Karta w tym wariancie (także połączenie, np. flag+blank)
pub fn is_blank(variant: &str) -> bool {
    parts(variant).contains(&VARIANT)
}

pub async fn drawing_save(
    State(st): State<AppState>,
    Me(me): Me,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<DrawingRequest>,
) -> Res {
    let Some(color) = parse_color(&req.color) else { return bad("Nieprawidłowy kolor") };
    let color_text = req.color.to_lowercase();
    let layers = tokio::task::spawn_blocking(move || prepare(&req, color)).await.ok().flatten();
    let Some(layers) = layers else { return bad("Nie udało się zapisać rysunku") };
    let mut tx = st.db.begin().await?;
    lock_me(&mut tx, me.id).await?;
    let variant: Option<String> = sqlx::query_scalar("SELECT variant FROM items WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(me.id)
        .fetch_optional(&mut *tx)
        .await?;
    if !variant.as_deref().is_some_and(is_blank) {
        return bad("To nie jest twoja karta „Czysta kartka”");
    }
    let at = now();
    let Some((bg, photo, flat)) = layers else {
        sqlx::query("DELETE FROM card_drawings WHERE item_id = $1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return ok(json!({"ok": true, "v": at, "drawn": false}));
    };
    sqlx::query(
        "INSERT INTO card_drawings (item_id, color, bg, photo, flat, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item_id) DO UPDATE SET color = excluded.color, bg = excluded.bg, photo = excluded.photo,
         flat = excluded.flat, updated_at = excluded.updated_at",
    )
    .bind(id)
    .bind(&color_text)
    .bind(&bg)
    .bind(&photo)
    .bind(&flat)
    .bind(at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    ok(json!({"ok": true, "v": at, "drawn": true}))
}

/// Kolor tła i wersja rysunku (do edytora)
pub async fn drawing_info(State(st): State<AppState>, Me(_): Me, Path(id): Path<i64>) -> Res {
    let row: Option<(String, f64)> =
        sqlx::query_as("SELECT color, updated_at FROM card_drawings WHERE item_id = $1").bind(id).fetch_optional(&st.db).await?;
    let (color, v) = row.unwrap_or_else(|| (DEFAULT_COLOR.to_owned(), 0.0));
    ok(json!({"color": color, "v": v}))
}

/// Warstwa rysunku. Karta bez rysunku = przezroczysty piksel, dzięki czemu strony z kartami nie muszą nic o rysunku wiedzieć
/// poza numerem egzemplarza; przeglądarka sprawdza aktualność przez ETag.
pub async fn drawing_image(
    State(st): State<AppState>,
    Me(_): Me,
    Path((id, layer)): Path<(i64, String)>,
    headers: HeaderMap,
) -> Res<Response> {
    let sql = match layer.as_str() {
        "bg" => "SELECT bg, updated_at FROM card_drawings WHERE item_id = $1",
        "photo" => "SELECT photo, updated_at FROM card_drawings WHERE item_id = $1",
        "flat" => "SELECT flat, updated_at FROM card_drawings WHERE item_id = $1",
        _ => return Ok(StatusCode::NOT_FOUND.into_response()),
    };
    let row: Option<(Option<Vec<u8>>, f64)> = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(id).fetch_optional(&st.db).await?;
    let (bytes, at) = row.unwrap_or((None, 0.0));
    let etag = format!("\"{at}\"");
    let cache = [(header::CACHE_CONTROL, "private, no-cache".to_owned()), (header::ETAG, etag.clone())];
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, cache).into_response());
    }
    let body = Body::from(bytes.unwrap_or_else(|| EMPTY.clone()));
    Ok(([(header::CONTENT_TYPE, "image/png".to_owned()), (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned())], cache, body)
        .into_response())
}

/// Egzemplarze gracza z rysunkiem - nie liczą się jako duplikaty
pub async fn drawn_items(c: &mut Conn, uid: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT d.item_id FROM card_drawings d JOIN items i ON i.id = d.item_id WHERE i.user_id = $1")
        .bind(uid)
        .fetch_all(c)
        .await
}

/// Karty „Czysta kartka” gracza (galeria na profilu)
pub async fn blank_items(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Vec<ItemJson>> {
    let rows: Vec<(i64, String, String, i32, f64)> = sqlx::query_as(
        "SELECT id, person_id, variant, favorite, created_at FROM items
         WHERE user_id = $1 AND (variant = $2 OR variant LIKE '%+' || $2) ORDER BY id DESC LIMIT 100",
    )
    .bind(uid)
    .bind(VARIANT)
    .fetch_all(c)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, person_id, variant, favorite, created_at)| ItemRow { id, person_id, variant, favorite, created_at })
        .filter_map(|r| item_json(cat, &r))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors() {
        assert_eq!(parse_color("#ff0080"), Some([255, 0, 128]));
        assert_eq!(parse_color("ff0080"), None);
        assert_eq!(parse_color("#ff008"), None);
        assert_eq!(parse_color("#zz0080"), None);
    }

    #[test]
    fn layers_are_rewritten_and_flat_has_the_color() {
        let mut bg = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 0]));
        bg.put_pixel(0, 0, Rgba([1, 2, 3, 255]));
        let data = base64::engine::general_purpose::STANDARD.encode(png(&bg).unwrap());
        let req = DrawingRequest { color: "#102030".into(), bg: format!("data:image/png;base64,{data}"), photo: data };
        let (_, _, flat) = prepare(&req, [16, 32, 48]).unwrap().unwrap();
        let flat = image::load_from_memory(&flat).unwrap().to_rgba8();
        assert_eq!(flat.get_pixel(0, 0).0, [1, 2, 3, 255]);
        assert_eq!(flat.get_pixel(3, 3).0, [16, 32, 48, 255]);
    }

    #[test]
    fn white_card_without_strokes_counts_as_empty() {
        let data = base64::engine::general_purpose::STANDARD.encode(png(&RgbaImage::new(2, 2)).unwrap());
        let req = DrawingRequest { color: "#ffffff".into(), bg: data.clone(), photo: data };
        assert!(prepare(&req, [255, 255, 255]).unwrap().is_none());
        assert!(prepare(&req, [1, 2, 3]).unwrap().is_some());
    }

    #[test]
    fn rejects_garbage_and_huge_images() {
        assert!(decode("to nie jest obraz").is_none());
        let big = RgbaImage::new(MAX_SIDE + 1, 2);
        let data = base64::engine::general_purpose::STANDARD.encode(png(&big).unwrap());
        assert!(decode(&data).is_none());
    }
}
