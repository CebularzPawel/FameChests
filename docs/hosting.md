# Hosting (serwer w internecie)

## Azure App Service (Windows) - sam plik .exe

Cała gra to jeden plik `scambox.exe`: w środku są `static/`, `templates/`, `custom_images/`, `catalog_export.json` i
dane gry (`server/data/game.json`). Python ani żadne inne pliki nie są potrzebne. IIS na App Service uruchamia exe przez
HttpPlatformHandler (`deploy/azure/web.config`) i przekazuje mu ruch.

1. **Paczka** - dwuklik `build_azure.bat` (albo `cargo build --release` w `server/`). Wynik: `dist\scambox-azure.zip`
   (`scambox.exe` + `web.config`). Baza nie jest potrzebna do budowania.
2. **Aplikacja** w portalu Azure: Web App, *Publish: Code*, *Runtime stack*: dowolny (np. .NET - nie jest używany),
   *Operating System: Windows*. W *Configuration -> General settings*: **Platform: 64 Bit**, *Always On*: włączone
   (inaczej po 20 min bez ruchu proces jest zatrzymywany i walki w Arenie przepadają), *Web sockets*: obojętne.
3. **Ustawienia** (*Configuration -> Application settings*) - te same co dla wersji Python:
   - `DATABASE_URL` - baza Supabase, np.
     `postgresql://postgres.<projekt>:<hasło>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require`
     (pooler w trybie **session**, port 5432: App Service nie ma IPv6, a bezpośredni adres `db.<projekt>.supabase.co`
     jest tylko po IPv6; tryb *transaction* (6543) nie obsługuje przygotowanych zapytań, których używa serwer)
   - `SECRET_KEY` - ten sam co dotąd (inaczej wszyscy zostaną wylogowani)
   - `DB_SCHEMA` - jeśli tabele gry są w osobnym schemacie (np. `famechests`)
   - `DATA_DIR` - niepotrzebne: domyślnie `%HOME%\data` (`D:\home\data`, przetrwa restart i każde wdrożenie)
4. **Wdrożenie** paczki:
   ```sh
   az webapp deploy --resource-group <grupa> --name <aplikacja> --src-path dist/scambox-azure.zip --type zip
   ```
   albo w Kudu (`https://<aplikacja>.scm.azurewebsites.net` -> *Tools -> Zip Push Deploy*) przeciągnij zip do
   `site/wwwroot`. Przed podmianą exe zatrzymaj aplikację (*Stop*), po wdrożeniu *Start* - działający exe jest
   zablokowany przez Windows.
5. **Logi**: `D:\home\LogFiles\scambox.log` (Kudu -> *Debug console*) albo *Log stream* w portalu.

Na Azure serwer sam włącza `COOKIE_SECURE` i `TRUST_PROXY` (HTTPS i adres gracza z proxy Azure) i wyłącza metryki;
port bierze z `HTTP_PLATFORM_PORT`. Pierwszy start na bazie z wersji Python uzupełnia brakujące tabele i kolumny -
dane graczy zostają (szczegóły: [przejscie-z-pythona.md](przejscie-z-pythona.md)).

## Obraz

```sh
docker build -f server/Dockerfile -t scambox .     # z głównego folderu gry
```

Obraz zawiera serwer, `static/`, `templates/`, `catalog_export.json` i `custom_images/`. Zapytania do bazy są
sprawdzane przy budowaniu z `server/.sqlx/` - baza nie jest potrzebna do zbudowania.

## Zmienne środowiskowe

| Zmienna | Domyślnie w obrazie | Co |
|---|---|---|
| `DATABASE_URL` | - (wymagana) | `postgresql://użytkownik:hasło@serwer:5432/baza?sslmode=require` |
| `SECRET_KEY` | - | klucz ciasteczek logowania; stały, długi, losowy (bez niego: `DATA_DIR/secret_key.txt`) |
| `DATA_DIR` | folder gry | zdjęcia (`image_cache/`) i klucz - folder, który przetrwa restart |
| `DB_SCHEMA` | - | tabele gry w osobnym schemacie zamiast `public` (np. Supabase) |
| `DB_POOL_SIZE` | 10 | połączenia z bazą |
| `PORT`, `BIND` | 8000, 0.0.0.0 | adres serwera |
| `COOKIE_SECURE` | 1 | ciasteczko tylko po HTTPS |
| `TRUST_PROXY` | 1 | adres gracza z `X-Forwarded-For` (limit nieudanych logowań) - serwer za proxy z HTTPS |
| `METRICS_ADDR` | 127.0.0.1:9100 | metryki Prometheus (`/metrics`); pusty = wyłączone |
| `RUST_LOG` | scambox=info | poziom logów |

Te same `DATABASE_URL`, `SECRET_KEY` i `DATA_DIR` co w dawnej wersji Python - zmiana serwera nie wymaga
zmian w bazie.

## Ważne

- **Jeden proces.** Katalog kart i walki w Arenie są w pamięci procesu - nie uruchamiaj kilku kopii za load
  balancerem.
- **HTTPS** zapewnia hosting/proxy przed serwerem; serwer sam mówi po HTTP.
- **Metryki** (`scambox_http_requests_total`, `scambox_crates_opened_total`, `scambox_casino_games_total`,
  `scambox_market_trades_total`, `scambox_forge_total`, `scambox_login_failures_total`...) są dostępne tylko
  wewnątrz serwera; żeby je zbierać, ustaw `METRICS_ADDR=0.0.0.0:9100` i nie wystawiaj tego portu publicznie.
- Pierwszy start na istniejącej bazie: schemat jest uzupełniany (`IF NOT EXISTS`), dane graczy zostają.
