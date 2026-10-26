//! Start bazy: schemat, jednorazowe uzupełnienia danych ze starszych wersji gry, katalog, Hall of Fame.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::config::Config;
use crate::data::g;
use crate::db::{self, now};
use crate::game::ESCROW;
use crate::{catalog, export};

/// Pierwszy gracz z kartą (do uzupełnienia Hall of Fame)
#[derive(Default)]
struct FirstDrop {
    user: Option<i64>,
    at: Option<f64>,
    /// ile kart graczy
    items: i32,
    /// ile wpisów w aktywności
    feed: i32,
}

impl FirstDrop {
    fn note(&mut self, user: Option<i64>, at: f64) {
        if self.at.is_none_or(|t| at < t) {
            (self.user, self.at) = (user, Some(at));
        }
    }
}

pub async fn init_db(pool: &PgPool, cfg: &Config) -> anyhow::Result<catalog::Catalog> {
    db::init_schema(pool).await?;
    drop_removed_variants(pool).await?;
    let mut tx = pool.begin().await?;
    // klaser pamięta karty, które gracz kiedykolwiek miał: uzupełniamy z obecnych kart i z aktywności
    sqlx::query!(
        "INSERT INTO user_collected (user_id, person_id, variant) SELECT DISTINCT user_id, person_id, variant
         FROM items WHERE user_id > 0 ON CONFLICT DO NOTHING"
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO user_collected (user_id, person_id, variant) SELECT DISTINCT author_id, person_id, variant
         FROM feed WHERE author_id IS NOT NULL ON CONFLICT DO NOTHING"
    )
    .execute(&mut *tx)
    .await?;
    // kiedy gracz pierwszy raz miał kartę (starsze wpisy bez czasu): najstarsza jego karta albo wpis w aktywności
    sqlx::query!(
        "UPDATE user_collected SET at = (SELECT MIN(i.created_at) FROM items i WHERE i.user_id = user_collected.user_id
         AND i.person_id = user_collected.person_id AND i.variant = user_collected.variant) WHERE at IS NULL"
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE user_collected SET at = (SELECT MIN(f.created_at) FROM feed f WHERE f.author_id = user_collected.user_id
         AND f.person_id = user_collected.person_id AND f.variant = user_collected.variant AND f.kind != 'show')
         WHERE at IS NULL"
    )
    .execute(&mut *tx)
    .await?;
    // kto kiedykolwiek dostał pieniądze z bankomatu / od admina (statystyka "deposited") - poza rankingiem
    sqlx::query!(
        "UPDATE users SET money_generated = 1 WHERE money_generated = 0 AND id IN
         (SELECT user_id FROM user_state WHERE key = 'deposited' AND value > 0)"
    )
    .execute(&mut *tx)
    .await?;
    // jackpot jako lobby nie blokuje kart - stoły z pierwszej wersji (karty założyciela w ESCROW) zamykamy, karty wracają
    let open = sqlx::query!("SELECT id, creator_id FROM jackpots WHERE status = 'open'").fetch_all(&mut *tx).await?;
    for j in open {
        let held = sqlx::query_scalar!(
            "SELECT ji.item_id FROM jackpot_items ji JOIN items i ON i.id = ji.item_id WHERE ji.jackpot_id = $1 AND i.user_id = $2",
            j.id,
            ESCROW
        )
        .fetch_all(&mut *tx)
        .await?;
        if !held.is_empty() {
            sqlx::query!("UPDATE items SET user_id = $1 WHERE user_id = $2 AND id = ANY($3)", j.creator_id, ESCROW, &held)
                .execute(&mut *tx)
                .await?;
            sqlx::query!("UPDATE jackpots SET status = 'cancelled', finished_at = $1 WHERE id = $2", now(), j.id)
                .execute(&mut *tx)
                .await?;
        }
    }
    // wyniki jackpota sprzed tej wersji uznajemy za obejrzane (nowi gracze dostają 0 przy rejestracji)
    sqlx::query!(
        "INSERT INTO user_state (user_id, key, value) SELECT id, 'jackpot_seen', $1 FROM users WHERE id > 0 ON CONFLICT DO NOTHING",
        (now() * 1000.0) as i64
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if export::import_if_empty(pool, &cfg.base_dir).await? {
        tracing::info!("Wczytano karty i skrzynki z catalog_export.json");
    }
    export::copy_custom_images(&cfg.base_dir, &cfg.data_dir)?;
    let mut cat = catalog::load(&mut *pool.acquire().await?).await?;
    if migrate_crate_variants(pool, &cat).await? > 0 {
        cat = catalog::load(&mut *pool.acquire().await?).await?;
    }
    backfill_hall_of_fame(pool).await?;
    Ok(cat)
}

/// Jednorazowo: skrzynki bez "variantsAll" dostają na stałe zapisane przypięte warianty (dotychczasowe wyjątkowe + zwykłe,
/// które wypadały ze wszystkich skrzynek - catalog::check_crate), żeby warianty dodane później nie przypinały się same
/// (jak catalog.migrate_crate_variants w Pythonie). Zapytania bez makr, więc bez `cargo sqlx prepare`. Zwraca liczbę skrzynek.
async fn migrate_crate_variants(pool: &PgPool, cat: &catalog::Catalog) -> anyhow::Result<usize> {
    let mut tx = pool.begin().await?;
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, data FROM catalog_crates").fetch_all(&mut *tx).await?;
    let saved: HashMap<String, Map<String, Value>> =
        rows.into_iter().map(|(id, d)| (id, serde_json::from_str(&d).unwrap_or_default())).collect();
    let mut n = 0;
    for (cid, cr) in &cat.crates {
        let mut d = saved.get(cid).cloned().unwrap_or_default();
        if cr.special || d.get("variantsAll").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        d.insert("variants".into(), json!(cr.variants));
        d.insert("variantsAll".into(), json!(true));
        sqlx::query(
            "INSERT INTO catalog_crates (id, data, deleted) VALUES ($1, $2, 0) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(cid)
        .bind(Value::Object(d).to_string())
        .execute(&mut *tx)
        .await?;
        n += 1;
    }
    tx.commit().await?;
    Ok(n)
}

/// Tabele z wariantem karty (kolumna) - przy usuwaniu wariantu z gry
const VARIANT_COLUMNS: &[(&str, &str)] = &[
    ("items", "variant"),
    ("feed", "variant"),
    ("market_listings", "variant"),
    ("market_wanted", "variant"),
    ("jackpot_items", "variant"),
    ("trade_lines", "variant"),
    ("users", "avatar_variant"),
];

/// Warianty usunięte z gry (removedVariants w game.json): karty graczy, oferty, ikony itd. w nich stają się zwykłe
/// (z połączenia zostaje warstwa: flag+greek -> flag), a wpisy w klaserze i Hall of Fame znikają. Bezpieczne przy każdym
/// starcie. Zapytania bez makr (nazwy tabel z listy), więc bez `cargo sqlx prepare`.
async fn drop_removed_variants(pool: &PgPool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    for v in &g().removed_variants {
        let combo = format!("+{v}");
        let like = format!("%+{v}");
        for (table, col) in VARIANT_COLUMNS {
            sqlx::query(&format!("UPDATE {table} SET {col} = 'normal' WHERE {col} = $1")).bind(v).execute(&mut *tx).await?;
            sqlx::query(&format!("UPDATE {table} SET {col} = REPLACE({col}, $1, '') WHERE {col} LIKE $2"))
                .bind(&combo)
                .bind(&like)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "INSERT INTO user_collected (user_id, person_id, variant) SELECT user_id, person_id, 'normal'
             FROM user_collected WHERE variant = $1 ON CONFLICT DO NOTHING",
        )
        .bind(v)
        .execute(&mut *tx)
        .await?;
        for table in ["user_collected", "hall_of_fame"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE variant = $1 OR variant LIKE $2"))
                .bind(v)
                .bind(&like)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Hall of Fame zapisujemy od tej aktualizacji. Jednorazowo (pusta tabela) uzupełniamy ją z historii: karty, które gracze
/// mają teraz (czas wylosowania) i aktywność (legendarne+ - też te później sprzedane). Liczby są przybliżone.
async fn backfill_hall_of_fame(pool: &PgPool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    if sqlx::query_scalar!("SELECT 1 AS one FROM hall_of_fame LIMIT 1").fetch_optional(&mut *tx).await?.is_some() {
        return Ok(());
    }
    let mut best: IndexMap<(String, String), FirstDrop> = IndexMap::new();
    for r in
        sqlx::query!(r#"SELECT person_id, variant, user_id, created_at FROM items WHERE user_id > 0"#).fetch_all(&mut *tx).await?
    {
        let b = best.entry((r.person_id, r.variant)).or_default();
        b.items += 1;
        b.note(r.user_id, r.created_at);
    }
    for r in
        sqlx::query!("SELECT author_id, person_id, variant, created_at FROM feed WHERE kind IN ('drop', 'contract', 'upgrade')")
            .fetch_all(&mut *tx)
            .await?
    {
        let b = best.entry((r.person_id, r.variant)).or_default();
        b.feed += 1;
        b.note(Some(r.author_id), r.created_at);
    }
    for ((pid, variant), b) in best {
        sqlx::query!(
            "INSERT INTO hall_of_fame (person_id, variant, first_user_id, first_at, source, drops)
             VALUES ($1, $2, $3, $4, 'drop', $5) ON CONFLICT DO NOTHING",
            pid,
            variant,
            b.user,
            b.at.unwrap_or(0.0),
            b.items.max(b.feed)
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
