# ScamBox – serwer w Rust

Serwer gry (axum + tokio + sqlx/PostgreSQL). Przeglądarka (`static/`, `templates/`) i `data/game.json` są
wbudowane w plik wykonywalny - do działania wystarczy `scambox.exe` i baza.

## Uruchomienie

```sh
cd server
docker compose up -d            # baza PostgreSQL (albo własna)
cp .env.example .env            # DATABASE_URL itd.
cargo run --release             # http://127.0.0.1:5000
cargo run --release -- --lan    # dostęp z sieci lokalnej
cargo run --release -- --test   # osobna baza (TEST_DATABASE_URL albo <baza>_test), port 5001
```

Windows: `start.bat` w głównym folderze. Hosting: Azure App Service (Windows) - `build_azure.bat`
([docs/hosting.md](../docs/hosting.md)) albo `docker build -f server/Dockerfile -t scambox .` (z głównego folderu
repozytorium), zmienne `DATABASE_URL`, `SECRET_KEY`, `DATA_DIR`.

Komendy: `cargo run --release -- export-catalog`,
`cargo run --release -- fetch-images [--force]` (zdjęcia główne i alternatywne).

Baza PostgreSQL z dawnej wersji Python działa od razu (ten sam schemat, brakujące tabele dopisuje start).
Zalogowani gracze muszą zalogować się raz ponownie (nowe ciasteczko); hasła zostają (format werkzeug).
Stary zapis w SQLite (`game.db`) przenosi `migrate_to_postgres.py` z historii git (wersja Python).

## Budowa

| Plik | Co |
|---|---|
| `src/main.rs` | komendy (`serve`, `export-catalog`, `fetch-images`), router, gzip, metryki |
| `src/startup.rs` | start bazy: schemat, uzupełnienia danych ze starszych wersji, katalog, Hall of Fame |
| `src/export.rs` | `catalog_export.json` + `custom_images/` (eksport i wczytanie w nowej instalacji) |
| `src/config.rs` | flagi `--test --lan --dev`, zmienne środowiskowe |
| `src/data.rs` + `data/game.json` | ustawienia gry i wbudowane karty (jedyne źródło, edytowane ręcznie) + wartości wyliczane |
| `src/achievements.rs` | osiągnięcia: liczniki, warunki, nagrody, warstwa `layer` (nagłówki `X-Ach` / `X-Bibi`) |
| `src/horses.rs` | symulacja wyścigu konnego z ziarna (ChaCha8); zakłady i rozliczanie w `routes/horses.rs` |
| `src/variants.rs` | ustawienia wariantów, wydarzenia, naklejki, kreator wariantów (`catalog_variants`) |
| `src/catalog.rs` | katalog = dane wbudowane + zmiany z panelu admina (`catalog_crates` / `catalog_cards`) czytane do `RawCard` / `RawCrate` i sprawdzane, w pamięci (`ArcSwap`) |
| `src/auth.rs` | konta, hasła (werkzeug scrypt/pbkdf2), sesja w podpisanym ciasteczku, `Me` / `Admin`, limit logowań |
| `src/game/` | wspólna logika: stan gracza, karty, Hall of Fame, losowanie, rynek (`settle_market`), widoki kart (`views.rs`) |
| `src/routes/` | adresy: strony, konta, sklep/kuźnia, social, rynek, kasyno, arena, admin - przy każdym handlerze struktury zapytania (`Deserialize`) i odpowiedzi (`Serialize`) |
| `src/arena/` | silnik Areny (`engine.rs`, walki w pamięci procesu) i walka z perspektywy gracza (`view.rs`) |
| `src/error.rs` | `AppError` -> `{"error": "..."}` z kodem HTTP |
| `src/lenient.rs` | adaptery `serde_with` dla pól z formularzy admina (liczby jako tekst) |
| `src/text.rs` | obcinanie tekstu po znakach, kwoty w groszach |
| `src/images.rs` | zdjęcia z Wikipedii, miniatury WebP, flagi |
| `schema.sql` | schemat PostgreSQL (wykonywany przy starcie, `IF NOT EXISTS`) |

## Zasady

- Zapytania przez `sqlx::query!` / `query_as!` / `query_scalar!` (sprawdzane przy kompilacji). Po zmianie zapytań:
  `SQLX_OFFLINE=false` w `.env`, baza z aktualnym schematem, `cargo sqlx prepare`, commit `.sqlx/`.
- Nowa kolumna / tabela: `schema.sql`.
- Zapytania zmieniające stan gracza: transakcja + `db::lock_me` na początku (podwójne kliknięcie).
- Treść zapytania: `JsonBody<T>` z własną strukturą `#[derive(Deserialize)]` (domyślne wartości przez `#[serde(default)]`),
  odpowiedź: struktura `#[derive(Serialize)]` (`rename_all = "camelCase"`); `json!` tylko dla krótkich odpowiedzi (`{"ok": true}`).
  Statusy z bazy (rynek, wymiany, jackpot) jako enumy `sqlx::Type` (`status AS "status: ListingStatus"`).
- Jeden proces serwera (katalog i Arena w pamięci).
- `data/game.json` edytuje się ręcznie (zmiana wartości wyliczanych: `tests/fixtures/derived.json`, patrz `docs/rozwoj.md`).
- Metryki Prometheus: `METRICS_ADDR` (domyślnie `127.0.0.1:9100/metrics`).

## Testy

```sh
cargo test                       # dane gry, hasła werkzeug, losowanie, katalog, Arena, osiągnięcia, wyścigi
cargo clippy --all-targets -- -D warnings
```
