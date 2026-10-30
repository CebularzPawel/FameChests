# Przejście z wersji Python na Rust

Wersja Python (`app.py`, `data.py`...) została usunięta z repozytorium - jest w historii git (ostatni commit z nią:
przed usunięciem plików `*.py`). Serwer Rust używa **tej samej bazy PostgreSQL** (ten sam schemat, uzupełniany przy
starcie) i **tych samych hashy haseł** (format werkzeug), więc baza z wersji Python działa od razu.

## Co się zmienia dla graczy

- Trzeba **zalogować się jeszcze raz** (nowe ciasteczko logowania). Hasła działają jak dotąd.
- Wyścigi konne: ten sam numer wyścigu ma inny przebieg niż w Pythonie (inny generator liczb losowych) - zakłady
  postawione w wersji Python na wyścig, który jeszcze się nie odbył, rozliczy już przebieg z wersji Rust.
- Poza tym nic - przeglądarka i odpowiedzi API są takie same.

## Kroki

### 1. Test na kopii prawdziwej bazy

```sh
pg_dump "$PROD_DATABASE_URL" > prod.sql
docker exec <kontener-bazy> psql -U postgres -c "CREATE DATABASE scambox_prod"
docker exec -i <kontener-bazy> psql -U postgres -d scambox_prod < prod.sql
```

Gra z `DATABASE_URL=.../scambox_prod` (i `DB_SCHEMA`, jeśli produkcja go używa). Sprawdź prawdziwe konto: saldo,
karty, gablota, oferty na rynku, lobby jackpota, osiągnięcia, panel admina.

### 2. Wdrożenie

Paczka na Azure ([hosting.md](hosting.md)) z tymi samymi `DATABASE_URL`, `SECRET_KEY` i `DB_SCHEMA`.
`DATA_DIR` na Azure Windows domyślnie `D:\home\data` - jeśli wersja Python trzymała zdjęcia gdzie indziej
(np. `/home/data` na Linuksie), zdjęcia pobiorą się z Wikipedii od nowa, a własne zdjęcia od admina wczytają się
z `custom_images/` (zrób wcześniej `cargo run --release -- export-catalog`).

### 3. Powrót (jeśli coś nie działa)

Wersja Python z historii git na tej samej bazie. Konta założone i hasła zmienione w wersji Rust działają także
w Pythonie; tabele dodane przez Rust Python pomija.
