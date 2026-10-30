# Zmiany w kodzie serwera Rust

Opis plików: [`server/README.md`](../server/README.md). Zasady skrótem także w `CLAUDE.md`.

## Zapytania do bazy

Wszystkie zapytania przez makra `sqlx::query!` / `query_as!` / `query_scalar!` - kompilator sprawdza SQL
(tabele, kolumny, typy) z prawdziwym schematem.

- Zwykłe budowanie korzysta z zapisanych sprawdzeń w `server/.sqlx/` (`SQLX_OFFLINE=true` w `.env`) - baza
  niepotrzebna.
- **Po zmianie lub dodaniu zapytania:**
  1. w `.env`: `SQLX_OFFLINE=false` i `DATABASE_URL` do bazy z aktualnym schematem (np. `scambox_dev`
     - schemat tworzy sam serwer przy starcie albo `psql -d scambox_dev < server/schema.sql`),
  2. `cargo build` (błędy SQL wychodzą jako błędy kompilacji),
  3. `cargo sqlx prepare` (narzędzie: `cargo install sqlx-cli`; na NixOS `nixpkgs#sqlx-cli`),
  4. commit razem z `server/.sqlx/`,
  5. z powrotem `SQLX_OFFLINE=true`.
- Typy: `COUNT(*)` i wyrażenia wymagają `AS "n!"` (nie-null). Kolumny bez `NOT NULL` są `Option<...>`.
- Zapytanie zmieniające stan gracza (pieniądze, karty, skrzynki): transakcja i `db::lock_me(&mut tx, uid)` na
  początku - inaczej podwójne kliknięcie wyda to samo dwa razy. Błąd (`bad("...")`) porzuca transakcję.

## Zapytania z przeglądarki i odpowiedzi

- Treść zapytania: `JsonBody<T>`, gdzie `T` to struktura `#[derive(Deserialize)]` obok handlera (pusta treść = `{}`,
  domyślne wartości przez `#[serde(default)]` / `#[serde(default = "...")]`). Zła treść = 400
  `{"error": "Nieprawidłowe żądanie"}`.
- Pola z formularzy panelu admina, w których liczby przychodzą jako tekst: `serde_with` (`lenient::Num`) albo
  `lenient::NumOrText`, gdy pusty tekst ma znaczyć "nie podano".
- Odpowiedź: struktura `#[derive(Serialize)]` z `rename_all = "camelCase"` (klucze takie, jakich oczekuje
  `static/js`), wspólne części przez `#[serde(flatten)]` (np. `CardJson`, `UserView`). `json!` tylko dla krótkich
  odpowiedzi.
- Błąd dla gracza: `return bad("...")` (400) albo `fail(StatusCode::FORBIDDEN, "...")`; funkcje pomocnicze zwracają
  `Res<T>` i błędy przechodzą przez `?`.

## Nowa kolumna / tabela

Dopisać w `server/schema.sql` (z `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` - wykonywany przy każdym starcie).
Przeniesienie danych między kolumnami / tabelami: jednorazowa migracja w `server/src/startup.rs`.

## Ustawienia gry (ceny, szanse, warianty, karty, lista zmian)

Jedyne źródło: `server/data/game.json` (wbudowany w exe przy budowaniu) - edytować bezpośrednio, potem restart
serwera. Lista zmian dla graczy: nowy wpis NA GÓRZE `patchNotes` z większym `v`.

Wartości wyliczane (połączenia wariantów `flag+gold`, kolejność wariantów, szansa tajnej karty) liczy
`server/src/data.rs`. Test `derived_values_match_python` porównuje je z `server/tests/fixtures/derived.json`
(zapis z dawnej wersji Python) - po celowej zmianie wariantów / rzadkości w `game.json` test pokaże nowe wartości;
sprawdzić je i wpisać do `derived.json`.

## Testy

```sh
cd server
cargo test                    # dane gry, hasła werkzeug, losowanie, katalog, Arena, osiągnięcia, wyścigi
cargo clippy --all-targets -- -D warnings
cargo fmt
```
