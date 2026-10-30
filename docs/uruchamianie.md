# Uruchamianie gry na własnym komputerze

Potrzebna jest baza **PostgreSQL** (wersja Rust nie używa SQLite). Najprościej w Dockerze.

## 1. Baza danych

Nowa baza w Dockerze (w folderze `server/`):

```sh
cd server
docker compose up -d        # PostgreSQL 16 na porcie 5432, baza "scambox", dane w wolumenie scambox-db
```

Masz już kontener z PostgreSQL? Wystarczy nowa baza:

```sh
docker exec <kontener> psql -U postgres -c "CREATE DATABASE scambox"
```

Tabele tworzą się same przy pierwszym starcie gry. Karty i skrzynki z panelu admina wczytują się z
`catalog_export.json`, a własne zdjęcia z `custom_images/`.

## 2. Plik `.env`

```sh
cd server
cp .env.example .env        # Windows: copy .env.example .env
```

Najważniejsze: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/scambox`. Pozostałe ustawienia opisuje
`.env.example`. Klucz logowania bez `SECRET_KEY` zapisuje się w `secret_key.txt` (w folderze gry albo `DATA_DIR`).

## 3. Start

### Linux

```sh
cd server
cargo run --release
```

### NixOS (bez rustup)

```sh
cd server
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc nixpkgs#pkg-config -c cargo run --release
```

### Windows

Potrzebne: [Rust (rustup)](https://rustup.rs) i Visual Studio Build Tools (kompilator C dla biblioteki WebP).
Potem dwuklik `start.bat` w głównym folderze gry.

Pierwsze budowanie trwa kilka minut. Gra działa na **http://127.0.0.1:5000**. Pierwsze zarejestrowane konto jest
adminem.

## Opcje

Dopisywane po `--` (np. `cargo run --release -- --lan`) albo po `start.bat`:

| Opcja | Co |
|---|---|
| `--lan` | dostęp z innych komputerów w sieci (adres wypisuje się przy starcie) |
| `--test` | osobna baza `scambox_test` (albo `TEST_DATABASE_URL`), port 5001 - do testów, nie psuje prawdziwej gry |
| `--dev` | szablony HTML czytane przy każdym odświeżeniu, więcej logów - nigdy dla innych graczy |

Baza dla `--test` musi istnieć: `docker exec <kontener> psql -U postgres -c "CREATE DATABASE scambox_test"`.

Komendy:

```sh
cargo run --release -- export-catalog          # zmiany z panelu admina -> catalog_export.json + custom_images/
cargo run --release -- fetch-images [--force]  # pobierz zdjęcia kart (główne i alternatywne)
```

Zatrzymanie: `Ctrl+C`. Druga kopia gry na zajętym porcie się nie uruchomi.

## Gra w Dockerze (bez instalowania Rusta)

Zbudowanie obrazu (z głównego folderu gry):

```sh
docker build -f server/Dockerfile -t scambox .
```

Uruchomienie z bazą w innym kontenerze - kontener gry musi być w tej samej sieci Docker co baza:

```sh
docker inspect <kontener-bazy> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'   # nazwa sieci

docker run -d --name scambox -p 8000:8000 --network <sieć> \
  -e DATABASE_URL=postgres://postgres:postgres@<kontener-bazy>:5432/scambox \
  -e COOKIE_SECURE=0 \
  -e SECRET_KEY=<długi losowy tekst, np. openssl rand -hex 32> \
  -e DATA_DIR=/data -v scambox-data:/data \
  scambox
```

Gra: **http://127.0.0.1:8000**.

- `COOKIE_SECURE=0` - lokalnie gra działa po zwykłym `http://`. Bez tego przeglądarka nie zapamięta logowania.
- Stały `SECRET_KEY` - inaczej po każdym `docker run` wszyscy są wylogowani.
- Wolumen `scambox-data` trzyma pobrane zdjęcia kart.

Zarządzanie:

```sh
docker logs -f scambox     # logi
docker stop scambox        # zatrzymanie
docker start scambox       # ponowny start (ta sama baza i zdjęcia)
docker rm -f scambox       # usunięcie kontenera (dane zostają w bazie i w wolumenie)
```

## Problemy

| Objaw | Przyczyna |
|---|---|
| `Brak połączenia z bazą (...)` | zły `DATABASE_URL`, baza nie działa albo kontener gry jest w innej sieci Docker niż baza |
| `database "scambox" does not exist` | utwórz bazę (`CREATE DATABASE scambox`) |
| `Gra już działa (port ... jest zajęty)` | gra działa w innym oknie - zamknij je albo użyj `PORT=...` |
| logowanie "nie trzyma się" | `COOKIE_SECURE=1` na zwykłym `http://` - ustaw `COOKIE_SECURE=0` |
| błędy `sqlx` przy budowaniu | brak `SQLX_OFFLINE=true` w `.env` (budowanie bez bazy z `server/.sqlx/`) |
