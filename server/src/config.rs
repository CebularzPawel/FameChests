//! Ustawienia serwera: flagi uruchomienia i zmienne środowiskowe (także z pliku .env).
//!
//!   DATABASE_URL   postgresql://...           baza gry (wymagana)
//!   TEST_DATABASE_URL                         baza dla --test (domyślnie DATABASE_URL z bazą <nazwa>_test)
//!   DB_SCHEMA      famechests                 tabele gry w osobnym schemacie zamiast "public" (opcjonalnie)
//!   DB_POOL_SIZE   10
//!   SECRET_KEY     długi losowy tekst         klucz ciasteczek logowania (bez niego: DATA_DIR/secret_key.txt)
//!   DATA_DIR       /home/data                 zdjęcia i klucz poza folderem gry (domyślnie folder gry)
//!   GAME_DIR       folder z static/ i templates/ (domyślnie wykrywany)
//!   PORT, BIND     port i adres (domyślnie 5000 / 5001 z --test, 127.0.0.1 / 0.0.0.0 z --lan)
//!   COOKIE_SECURE  1 = ciasteczko tylko po HTTPS (hosting)
//!   TRUST_PROXY    1 = adres gracza z X-Forwarded-For (hosting za proxy)
//!   METRICS_ADDR   127.0.0.1:9100             metryki Prometheus (pusty = wyłączone)
//!
//! Azure App Service (Windows, scambox.exe za IIS - web.config z HttpPlatformHandler): port z HTTP_PLATFORM_PORT,
//! DATA_DIR domyślnie %HOME%\data (folder, który przetrwa restart i wdrożenie), COOKIE_SECURE i TRUST_PROXY domyślnie
//! włączone, metryki domyślnie wyłączone.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};

#[derive(Parser, Debug, Clone)]
#[command(name = "scambox", about = "ScamBox - serwer gry")]
pub struct Cli {
    /// osobna baza do testów (TEST_DATABASE_URL), port 5001
    #[arg(long, global = true)]
    pub test: bool,
    /// dostęp z innych komputerów w sieci (0.0.0.0)
    #[arg(long, global = true)]
    pub lan: bool,
    /// tryb deweloperski: szablony czytane przy każdym zapytaniu, więcej logów - NIGDY dla innych graczy
    #[arg(long, global = true)]
    pub dev: bool,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// uruchom grę (domyślnie)
    Serve,
    /// eksport zmian z panelu admina do catalog_export.json + custom_images/
    ExportCatalog,
    /// pobierz brakujące zdjęcia kart (główne i alternatywne)
    FetchImages {
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub db_schema: Option<String>,
    pub pool_size: u32,
    pub secret_key: String,
    pub base_dir: PathBuf,
    pub data_dir: PathBuf,
    pub addr: SocketAddr,
    pub cookie_secure: bool,
    pub trust_proxy: bool,
    pub metrics_addr: Option<SocketAddr>,
    pub dev: bool,
    pub lan: bool,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn env_flag(key: &str) -> bool {
    matches!(env(key).as_deref(), Some("1" | "true" | "yes" | "on"))
}

/// Flaga z domyślną wartością, gdy zmiennej nie ma
fn env_flag_or(key: &str, default: bool) -> bool {
    if env(key).is_some() {
        env_flag(key)
    } else {
        default
    }
}

/// Serwer działa na Azure App Service (zmienne ustawiane przez platformę)
fn on_azure() -> bool {
    env("WEBSITE_SITE_NAME").is_some() || env("HTTP_PLATFORM_PORT").is_some()
}

/// Folder gry (static/, templates/, catalog_export.json, custom_images/)
fn detect_base_dir() -> PathBuf {
    if let Some(dir) = env("GAME_DIR") {
        return PathBuf::from(dir);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for dir in [cwd.clone(), cwd.join("..")] {
        if dir.join("static").is_dir() && dir.join("templates").is_dir() {
            return dir.canonicalize().unwrap_or(dir);
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn test_url(url: &str) -> String {
    // postgresql://u:p@host:5432/gra?sslmode=... -> .../gra_test?sslmode=...
    let (head, query) = url.split_once('?').map(|(h, q)| (h, Some(q))).unwrap_or((url, None));
    let out = match head.rsplit_once('/') {
        Some((pre, db)) if !db.is_empty() && !pre.ends_with('/') => format!("{pre}/{db}_test"),
        _ => head.to_owned(),
    };
    query.map(|q| format!("{out}?{q}")).unwrap_or(out)
}

impl Config {
    pub fn load(cli: &Cli) -> anyhow::Result<Config> {
        let base_dir = detect_base_dir();
        let azure = on_azure();
        let data_dir = match (env("DATA_DIR"), env("HOME")) {
            (Some(dir), _) => PathBuf::from(dir),
            // Azure: %HOME% (D:\home) jest trwały - site\wwwroot podmienia każde wdrożenie
            (None, Some(home)) if azure => Path::new(&home).join("data"),
            _ => base_dir.clone(),
        };
        std::fs::create_dir_all(&data_dir)?;
        let main_url = env("DATABASE_URL").ok_or_else(|| {
            anyhow::anyhow!("Brak DATABASE_URL (np. postgresql://postgres:postgres@localhost:5432/scambox) - ustaw w .env")
        })?;
        let database_url = if cli.test { env("TEST_DATABASE_URL").unwrap_or_else(|| test_url(&main_url)) } else { main_url };
        let db_schema = env("DB_SCHEMA");
        if let Some(s) = &db_schema {
            let ok = s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
                && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            anyhow::ensure!(ok, "DB_SCHEMA: tylko małe litery, cyfry i _ (np. famechests)");
        }
        let secret_key = match env("SECRET_KEY") {
            Some(k) => k,
            None => {
                let path = data_dir.join("secret_key.txt");
                if !path.exists() {
                    let bytes: [u8; 32] = rand::random();
                    std::fs::write(&path, hex::encode(bytes))?;
                }
                std::fs::read_to_string(&path)?.trim().to_owned()
            }
        };
        // HttpPlatformHandler (IIS na Azure) podaje port, na którym ma słuchać serwer - tylko lokalnie, IIS przekazuje ruch
        let port: u16 = env("HTTP_PLATFORM_PORT")
            .or_else(|| env("PORT"))
            .map(|p| p.parse())
            .transpose()?
            .unwrap_or(if cli.test { 5001 } else { 5000 });
        let host = env("BIND").unwrap_or_else(|| if cli.lan { "0.0.0.0".into() } else { "127.0.0.1".into() });
        let metrics_addr = match std::env::var("METRICS_ADDR") {
            Ok(v) if v.trim().is_empty() => None,
            Ok(v) => Some(v.trim().parse()?),
            Err(_) if azure => None,
            Err(_) => Some(([127, 0, 0, 1], 9100).into()),
        };
        Ok(Config {
            database_url,
            db_schema,
            pool_size: env("DB_POOL_SIZE").map(|p| p.parse()).transpose()?.unwrap_or(10),
            secret_key,
            base_dir,
            data_dir,
            addr: format!("{host}:{port}").parse()?,
            cookie_secure: env_flag_or("COOKIE_SECURE", azure),
            trust_proxy: env_flag_or("TRUST_PROXY", azure),
            metrics_addr,
            dev: cli.dev,
            lan: cli.lan,
        })
    }

    /// Opis bazy do wypisania przy starcie (bez hasła)
    pub fn describe_db(&self) -> String {
        let url = self.database_url.split('?').next().unwrap_or("");
        let shown = match (url.find("//"), url.rfind('@')) {
            (Some(a), Some(b)) if b > a => format!("{}{}", &url[..a + 2], &url[b + 1..]),
            _ => url.to_owned(),
        };
        match &self.db_schema {
            Some(s) => format!("PostgreSQL {shown} (schemat {s})"),
            None => format!("PostgreSQL {shown}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_url;

    #[test]
    fn test_database_name() {
        assert_eq!(test_url("postgresql://u:p@h:5432/gra?sslmode=require"), "postgresql://u:p@h:5432/gra_test?sslmode=require");
        assert_eq!(test_url("postgres://h/gra"), "postgres://h/gra_test");
    }
}
