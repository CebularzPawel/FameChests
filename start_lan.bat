@echo off
rem Uruchamia gre dostepna w sieci lokalnej (np. w akademiku). Adres dla znajomych pojawi sie ponizej.
cd /d "%~dp0server"
cargo run --release -- --lan %*
pause
