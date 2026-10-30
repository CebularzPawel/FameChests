@echo off
rem Paczka na Azure App Service (Windows): buduje scambox.exe (static/, templates/, zdjecia z custom_images/ i
rem catalog_export.json sa w srodku) i robi dist\scambox-azure.zip = scambox.exe + web.config.
rem Wdrozenie: docs\hosting.md (az webapp deploy ... --type zip albo przeciagniecie do Kudu).
rem Baza nie jest potrzebna do zbudowania (zapytania sprawdzane z server\.sqlx).
setlocal
cd /d "%~dp0server"
set SQLX_OFFLINE=true
cargo build --release || goto :error
cd /d "%~dp0"
if exist dist\azure rmdir /s /q dist\azure
mkdir dist\azure || goto :error
copy /y server\target\release\scambox.exe dist\azure\ >nul || goto :error
copy /y deploy\azure\web.config dist\azure\ >nul || goto :error
if exist dist\scambox-azure.zip del dist\scambox-azure.zip
powershell -NoProfile -Command "Compress-Archive -Path 'dist\azure\*' -DestinationPath 'dist\scambox-azure.zip'" || goto :error
echo.
echo   Gotowe: dist\scambox-azure.zip
echo.
pause
exit /b 0
:error
echo.
echo   !!! Budowanie nie powiodlo sie
pause
exit /b 1
