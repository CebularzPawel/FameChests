# ScamBox

A web game about opening crates with cards of famous people (Polish crate, World crate, PRL crate and more).
The server is written in Rust (`server/`: axum + tokio + sqlx, PostgreSQL); the browser part (`static/`,
`templates/`) is plain HTML/CSS/JS and is embedded into the server executable.

## Running it
You need [Rust (rustup)](https://rustup.rs) and a PostgreSQL database (easiest: `docker compose up -d` in `server/`).

1. `copy server\.env.example server\.env` and set `DATABASE_URL`.
2. Double-click `start.bat` (or `cd server && cargo run --release`).
3. Open http://127.0.0.1:5000

Details (Linux, NixOS, Docker, options `--lan` / `--test` / `--dev`): [docs/uruchamianie.md](docs/uruchamianie.md).

### Playing with friends (same network / Wi-Fi)
Double-click `start_lan.bat`. The console shows an address like `http://192.168.1.23:5000`; your friends open it in
their browser. (Windows may ask to allow access through the firewall; choose "Allow".)
If a friend can't connect, the network probably blocks traffic between devices (common in dorms) — use Tailscale.

### Playing with friends over Tailscale (recommended)
Double-click `start_tailscale.bat`. It runs `tailscale serve`, which makes the game available **only within your
Tailscale network**, over HTTPS, at `https://<computer-name>.<tailnet>.ts.net`.
To stop sharing: `tailscale serve --https=443 off`.

### Hosting (Azure App Service, Windows)
`build_azure.bat` builds `dist\scambox-azure.zip` = `scambox.exe` (everything is inside it) + `web.config`.
Deploy the zip and set `DATABASE_URL` / `SECRET_KEY` in the app settings: [docs/hosting.md](docs/hosting.md).

## Accounts
- Each player has their own account (username + password), balance, cards, binder and discovered secret cards.
- **The first account registered becomes admin.**
- Admin: ⚙️ admin panel — crates (shop, access, custom odds), cards (several crates per card), players (ban, browse/delete cards, crate access, money, chests, passwords, admin rights), variants, achievements, horse races and the 💸 bank.
- Odds, prices, variants and built-in cards are in `server/data/game.json`.

## What's in it
- Crates with rarities: green → blue → purple → red → gold (1%) → ULTRA (0.2%) → ★ SECRET (1 in 2137); cards can belong to several crates
- 🛒 Shop carousel; crates can be off sale or available only to selected players; 📦 chests in your inventory
- Secret cards stay hidden ("???") until you obtain them, with their own design and reveal
- Variants (Holo, Golden, Diamond, Flag, Halloween, MLG...) with their own odds and value multipliers; admins manage them on /variants, design new ones on /designer and place stickers on /stickers
- 🔍 Card viewer, epic full-screen reveal, 🏆 Hall of Fame, 🏅 achievements
- 🎁 Daily chest; 👥 friends, activity feed, profiles with a showcase, ranking; 🔄 trading
- ⚒️ Forge (contract), 🏪 market (buy, offers, auctions, "wanted"), 🎰 casino (roulette, blackjack, slots, jackpot, upgrader, horse races)
- ⚔️ Arena (admins only, test version)

## Saving admin-panel changes to GitHub
Cards and crates added in the admin panel live in the database (which also holds player accounts). Before pushing:

    cd server
    cargo run --release -- export-catalog

It writes `catalog_export.json` + `custom_images/` (cards and crates only, no player data). A new installation
(empty database) loads them automatically on first start (they are also embedded in the executable).

## Files
- `server/` – the game server (see [server/README.md](server/README.md)); `server/data/game.json` – game settings and built-in cards.
- `static/`, `templates/` – the browser part (embedded into the executable at build time).
- `catalog_export.json`, `custom_images/` – admin-panel changes for new installations.
- `deploy/azure/web.config`, `build_azure.bat` – Azure App Service package.
- `docs/` – running, hosting and development notes (Polish).

## Keyboard shortcuts
- Space / Enter – open crates; during spinning: skip; on the results screen: open again
- Esc – skip / close
- ← → – flip pages in the binder
