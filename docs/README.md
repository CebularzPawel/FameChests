# Dokumentacja – serwer w Rust

Serwer gry jest w Rust (`server/`): axum + tokio + sqlx (PostgreSQL). Przeglądarka (`static/`, `templates/`)
i dane gry (`server/data/game.json`) są wbudowane w `scambox.exe`. Wersja Python została usunięta (jest w historii git).

| Plik | Co |
|---|---|
| [uruchamianie.md](uruchamianie.md) | gra na własnym komputerze: Linux/NixOS, Windows, Docker |
| [hosting.md](hosting.md) | serwer w internecie: Azure App Service (sam .exe), obraz Docker, zmienne, HTTPS, metryki |
| [przejscie-z-pythona.md](przejscie-z-pythona.md) | jak przejść z wersji Python na Rust (test na kopii bazy, wdrożenie, powrót) |
| [rozwoj.md](rozwoj.md) | zmiany w kodzie: zapytania `sqlx::query!`, schemat, dane gry, testy |

Opis budowy kodu: [`server/README.md`](../server/README.md).
