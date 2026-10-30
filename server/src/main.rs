//! ScamBox - serwer gry (Rust: axum + tokio + sqlx/PostgreSQL). Przeglądarka (static/, templates/) bez zmian.
//!
//!   cargo run --release                 gra na http://127.0.0.1:5000
//!   cargo run --release -- --lan        dostęp z innych komputerów w sieci
//!   cargo run --release -- --test       osobna baza (TEST_DATABASE_URL), port 5001
//!   cargo run --release -- export-catalog
//!   cargo run --release -- fetch-images [--force]

mod arena;
mod achievements;
mod assets;
mod horses;
mod auth;
mod catalog;
mod config;
mod data;
mod db;
mod domain;
mod error;
mod export;
mod game;
mod ids;
mod images;
mod lenient;
mod routes;
mod startup;
mod state;
mod text;
mod variants;
mod web;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use axum::extract::{MatchedPath, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use clap::Parser;
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use crate::config::{Cli, Command, Config};
use crate::images::{Images, Kind};
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            if cli.dev {
                "scambox=debug,tower_http=debug".into()
            } else {
                "scambox=info".into()
            }
        }))
        .init();
    let cfg = Config::load(&cli)?;
    match cli.command.clone().unwrap_or(Command::Serve) {
        Command::Serve => serve(cfg).await,
        Command::ExportCatalog => {
            let pool = db::connect(&cfg).await?;
            let (crates, cards, imgs) = export::export_catalog(&pool, &cfg).await?;
            println!(
                "Wyeksportowano: {crates} skrzynek, {cards} kart, {imgs} własnych zdjęć -> catalog_export.json, custom_images/"
            );
            Ok(())
        }
        Command::FetchImages { force } => {
            let pool = db::connect(&cfg).await?;
            db::init_schema(&pool).await?;
            let cat = catalog::load(&mut *pool.acquire().await?).await?;
            let images = Arc::new(Images::new(&cfg.data_dir));
            let people: Vec<_> = cat.people.values().map(|p| (p.id.clone(), p.wiki.clone())).collect();
            let res = images.fetch(&people, force).await;
            let missing: Vec<&String> = res.iter().filter(|(_, ok)| !**ok).map(|(p, _)| p).collect();
            println!(
                "Główne: {}/{}{}",
                res.len() - missing.len(),
                res.len(),
                if missing.is_empty() {
                    String::new()
                } else {
                    format!(" | brak: {}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
                }
            );
            let n = images.fetch_alt(&people, force).await;
            let have = people.iter().filter(|(p, _)| images.find(p, &Kind::Alt).is_some()).count();
            println!("Alternatywne: {have}/{} (nowe: {n})", people.len());
            Ok(())
        }
    }
}

async fn serve(cfg: Config) -> anyhow::Result<()> {
    // druga kopia gry na zajętym porcie się nie uruchomi
    let listener = match tokio::net::TcpListener::bind(cfg.addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("\n  !!! Gra już działa (port {} jest zajęty) - prawdopodobnie w innym oknie: {e}", cfg.addr.port());
            eprintln!("  Zamknij tamto okno (Ctrl+C) i uruchom grę jeszcze raz.\n");
            std::process::exit(1);
        }
    };
    if let Some(addr) = cfg.metrics_addr {
        match metrics_exporter_prometheus::PrometheusBuilder::new().with_http_listener(addr).install() {
            Ok(()) => tracing::info!("metryki Prometheus: http://{addr}/metrics"),
            Err(e) => tracing::warn!("metryki wyłączone ({addr}): {e}"),
        }
    }

    let pool = db::connect(&cfg).await?;
    let cat = startup::init_db(&pool, &cfg).await?;
    let images = Arc::new(Images::new(&cfg.data_dir));
    let st = AppState {
        db: pool,
        cfg: Arc::new(cfg.clone()),
        catalog: Arc::new(ArcSwap::from_pointee(cat)),
        templates: Arc::new(web::Templates::new(cfg.dev)),
        images: images.clone(),
        arena: Arc::default(),
        login: Arc::default(),
        cookie_key: auth::cookie_key(&cfg.secret_key),
    };

    // zdjęcia kart i miniatury - w tle
    let people: Vec<_> = st.cat().people.values().map(|p| (p.id.clone(), p.wiki.clone())).collect();
    tokio::spawn(async move { images.prefetch_all(people).await });
    // porzucone walki i wyzwania w Arenie
    let arena = st.arena.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            arena.inner.lock().await.cleanup();
        }
    });

    let app = routes::router(st.clone())
        .route("/static/{*path}", axum::routing::get(assets::serve_static))
        // osiągnięcia (X-Ach) i X-Bibi po udanym zapytaniu
        .layer(middleware::from_fn_with_state(st, achievements::layer))
        .layer(middleware::from_fn(web::cache_headers))
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(5)).compress_when(web::gzip_predicate()))
        .layer(RequestBodyLimitLayer::new(20 * 1024 * 1024))
        .layer(axum::extract::DefaultBodyLimit::max(20 * 1024 * 1024))
        .layer(middleware::from_fn(track_metrics))
        .layer(TraceLayer::new_for_http());

    if cfg.lan {
        println!("\n  Znajomi w tej samej sieci wchodzą na:  http://{}:{}\n", lan_address(), cfg.addr.port());
    }
    println!("\n  Gra działa na:  http://127.0.0.1:{}   (baza: {})\n", cfg.addr.port(), cfg.describe_db());
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// Liczba i czas zapytań (metryki Prometheus)
async fn track_metrics(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let path = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "other".into());
    let method = req.method().to_string();
    let resp = next.run(req).await;
    let labels = [("method", method), ("path", path), ("status", resp.status().as_u16().to_string())];
    metrics::counter!("scambox_http_requests_total", &labels).increment(1);
    metrics::histogram!("scambox_http_request_duration_seconds", &labels).record(start.elapsed().as_secs_f64());
    resp
}

fn lan_address() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("10.255.255.255:1")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "?".into())
}
