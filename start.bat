@echo off
rem Gra na tym komputerze (http://127.0.0.1:5000). Wymaga: Rust (rustup), baza PostgreSQL (server\docker-compose.yml)
rem i server\.env z DATABASE_URL (wzor: server\.env.example).
rem Dodatkowe opcje: --lan (siec lokalna), --test (osobna baza, port 5001), --dev
cd /d "%~dp0server"
start "" http://127.0.0.1:5000
cargo run --release -- %*
pause
