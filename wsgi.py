"""Uruchamianie na serwerze (Azure App Service, Linux):

    gunicorn --workers 1 --threads 8 --timeout 600 --bind 0.0.0.0:8000 wsgi:app

Długi --timeout: przy starcie init_db() łączy się z bazą i uzupełnia dane (po aktualizacji może to chwilę trwać) -
z krótkim limitem gunicorn ubija proces przed końcem i Azure zgłasza "site failed to start within 10 mins".

Tylko JEDEN worker (procesów), za to kilka wątków: katalog kart jest w pamięci procesu,
więc przy kilku workerach zmiany z panelu admina widziałby tylko jeden z nich.

Ustawienia aplikacji (zmienne środowiskowe):
    DATABASE_URL  postgresql://...?sslmode=require   (baza PostgreSQL)
    SECRET_KEY    długi losowy tekst                  (klucz sesji logowania)
    DATA_DIR      /home/data                          (zdjęcia - folder, który przetrwa restart)
"""
from werkzeug.middleware.proxy_fix import ProxyFix

import images
from app import app

# Azure przekazuje zapytania przez proxy z HTTPS - poprawne adresy i ciasteczka tylko po HTTPS
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config["SESSION_COOKIE_SECURE"] = True
images.prefetch_all_async()
