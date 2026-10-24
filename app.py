import datetime
import functools
import gzip
import json
import os
import random
import re
import secrets
import socket
import sys
import threading
import time
import unicodedata

from flask import (Flask, Response, g, jsonify, redirect, render_template, request, send_file, session,
                   url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import arena
import catalog
import database
import export_catalog
import images
from data import (ABILITY_KINDS, ARENA, ARENA_EFFECT_TARGETS, ARENA_EFFECTS, ARENA_TARGETS, ARENA_VISUALS,
                  MAX_ABILITY_EFFECTS, MAX_EXTRA_ABILITIES, CONTRACT_SIZE, CONTRACT_VARIANT_BONUS, CRATE_PRICE, DAILY_STREAK, MAX_DEPOSIT,
                  MAX_OPEN, MONEY_CHESTS, RARITIES, RARITY_ORDER, SECRET_ODDS, SHOWCASE_SIZE,
                  STARTING_BALANCE, TYPES, UPGRADE_EDGE, UPGRADE_MAX, UPGRADE_MAX_ITEMS, UPGRADE_MULTS, REMOVED_VARIANTS, VARIANT_ORDER,
                  VARIANTS, VARIANT_DEFAULTS, CRATE_VARIANTS, PATCH_NOTES, MARKET, ROULETTE, ROULETTE_BETS, ROULETTE_RED, ROULETTE_WHEEL,
                  JACKPOT, card_value, card_variants, combine_variant, SPECIAL_VARIANTS, SPECIAL_SOURCES, SPECIAL_CRATE,
                  CASINO_SPECIAL, CASINO_VARIANTS, CASINO_TOP, BLACKJACK, STICKER_VARIANTS, STICKER_LIBRARY,
                  STICKER_ANIMS)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEST_MODE = "--test" in sys.argv  # osobny zapis do testów: python app.py --test
LAN_MODE = "--lan" in sys.argv    # dostęp z innych komputerów w sieci: python app.py --lan
DEV_MODE = "--dev" in sys.argv    # tryb deweloperski (auto-przeładowanie, debugger) - NIGDY dla innych graczy
DB_PATH = os.path.join(BASE_DIR, "test.db" if TEST_MODE else "game.db")
KEY_PATH = os.path.join(images.DATA_DIR, "secret_key.txt")

STATE_KEYS = (("balance", STARTING_BALANCE), ("opened", 0), ("spent", 0), ("earned", 0), ("deposited", 0),
              ("contracts", 0), ("upgrades_won", 0), ("upgrades_lost", 0), ("feed_seen", 0), ("daily_total", 0),
              ("patch_seen", 0),  # patch_seen: ostatnia obejrzana lista zmian (PATCH_NOTES)
              ("market_seen", 0),  # market_seen: kiedy gracz ostatnio oglądał rynek (znaczek z nowościami)
              ("jackpot_seen", 0))  # jackpot_seen: koniec (ms) ostatniej gry w jackpot, której wynik gracz już widział
ESCROW = 0  # "właściciel" kart wystawionych na rynek / postawionych w blackjacku (czekają na koniec transakcji)
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,20}$")
FEED_RARITY = RARITY_ORDER.index("gold")  # od legendarnych w górę dropy trafiają automatycznie do aktywności znajomych
MIN_PASSWORD = 8  # nowe hasła (stare, krótsze nadal działają przy logowaniu)
PASSWORD_ERROR = f"Hasło musi mieć co najmniej {MIN_PASSWORD} znaków"
LOGIN_WINDOW = 5 * 60                      # okno liczenia nieudanych logowań (sekundy)
LOGIN_MAX_PER_USER, LOGIN_MAX_PER_IP = 5, 20


def load_secret_key():
    if os.environ.get("SECRET_KEY"):  # hosting: klucz w ustawieniach aplikacji, nie w pliku
        return os.environ["SECRET_KEY"]
    if not os.path.exists(KEY_PATH):
        with open(KEY_PATH, "w") as f:
            f.write(secrets.token_hex(32))
    with open(KEY_PATH) as f:
        return f.read().strip()


app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=20 * 1024 * 1024,
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=30),
)
rng = random.SystemRandom()


# Wersjonowanie plików statycznych: ?v=<czas modyfikacji> - po aktualizacji przeglądarka zawsze pobierze nowe pliki
@app.template_global()
def asset(filename):
    path = os.path.join(app.static_folder, filename)
    version = int(os.path.getmtime(path)) if os.path.exists(path) else 0
    return url_for("static", filename=filename, v=version)


@app.after_request
def no_cache_pages(resp):
    # strony HTML i odpowiedzi API nie mogą być brane z pamięci przeglądarki (stara wersja gry)
    if resp.mimetype in ("text/html", "application/json"):
        resp.headers["Cache-Control"] = "no-store"
    # pliki statyczne z ?v=<wersja> (asset()) zmieniają adres przy każdej zmianie - przeglądarka nie musi o nie pytać
    elif request.endpoint == "static" and request.args.get("v") and resp.status_code == 200:
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return gzip_response(resp)


GZIP_TYPES = ("application/json", "text/html", "image/svg+xml", "application/manifest+json")


def gzip_response(resp):
    """Odpowiedzi tekstowe wysyłamy spakowane gzipem: ekwipunek z kilkoma tysiącami kart to ~0,5 MB JSON-a, po spakowaniu
    ~35 KB. Duże odpowiedzi potrafiły się też zawieszać na kilkanaście sekund na Windowsie (antywirus sprawdzający ruch)."""
    if (resp.mimetype not in GZIP_TYPES or resp.direct_passthrough or not resp.is_sequence
            or "Content-Encoding" in resp.headers or "gzip" not in request.headers.get("Accept-Encoding", "").lower()):
        return resp
    data = resp.get_data()
    if len(data) < 1024:
        return resp
    resp.set_data(gzip.compress(data, 5))
    resp.headers["Content-Encoding"] = "gzip"
    resp.vary.add("Accept-Encoding")
    return resp


# ---------------------------------------------------------------- baza danych

def db():
    if "db" not in g:
        g.db = database.connect(DB_PATH)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = database.connect(DB_PATH)
    if conn.pg:
        conn.executescript(database.PG_SCHEMA)
    else:
        init_sqlite(conn)
    catalog.init_tables(conn)
    drop_removed_variants(conn)
    # klaser pamięta karty, które gracz kiedykolwiek miał: uzupełniamy z obecnych kart i z aktywności
    # (wszystko, co ktoś wylosował / pokazał, kiedyś było jego) - bezpieczne przy każdym starcie
    conn.execute("INSERT INTO user_collected (user_id, person_id, variant) SELECT DISTINCT user_id, person_id, variant "
                 "FROM items WHERE user_id > 0 ON CONFLICT DO NOTHING")   # 0 = karty na rynku / w jackpocie
    conn.execute("INSERT INTO user_collected (user_id, person_id, variant) SELECT DISTINCT author_id, person_id, variant "
                 "FROM feed WHERE author_id IS NOT NULL ON CONFLICT DO NOTHING")
    # kiedy gracz pierwszy raz miał kartę (starsze wpisy bez czasu): najstarsza jego karta albo wpis w aktywności
    conn.execute("UPDATE user_collected SET at = (SELECT MIN(i.created_at) FROM items i WHERE i.user_id = user_collected.user_id "
                 "AND i.person_id = user_collected.person_id AND i.variant = user_collected.variant) WHERE at IS NULL")
    conn.execute("UPDATE user_collected SET at = (SELECT MIN(f.created_at) FROM feed f WHERE f.author_id = user_collected.user_id "
                 "AND f.person_id = user_collected.person_id AND f.variant = user_collected.variant AND f.kind != 'show') "
                 "WHERE at IS NULL")
    # kto kiedykolwiek dostał pieniądze z bankomatu / od admina (statystyka "deposited") - poza rankingiem
    conn.execute("UPDATE users SET money_generated = 1 WHERE money_generated = 0 AND id IN "
                 "(SELECT user_id FROM user_state WHERE key = 'deposited' AND value > 0)")
    # jackpot jako lobby nie blokuje kart - stoły z pierwszej wersji (karty założyciela w ESCROW) zamykamy, karty wracają
    for jid, creator in conn.execute("SELECT id, creator_id FROM jackpots WHERE status = 'open'").fetchall():
        held = [r[0] for r in conn.execute("SELECT ji.item_id FROM jackpot_items ji JOIN items i ON i.id = ji.item_id "
                                           "WHERE ji.jackpot_id = ? AND i.user_id = ?", (jid, ESCROW))]
        if held:
            marks = ",".join("?" * len(held))
            conn.execute(f"UPDATE items SET user_id = ? WHERE user_id = ? AND id IN ({marks})", [creator, ESCROW, *held])
            conn.execute("UPDATE jackpots SET status = 'cancelled', finished_at = ? WHERE id = ?", (time.time(), jid))
    # wyniki jackpota sprzed tej wersji uznajemy za obejrzane (nowi gracze dostają 0 przy rejestracji)
    conn.execute("INSERT INTO user_state (user_id, key, value) SELECT id, 'jackpot_seen', ? FROM users WHERE id > 0 "
                 "ON CONFLICT DO NOTHING", (int(time.time() * 1000),))   # WHERE: SQLite tego wymaga przy SELECT + ON CONFLICT
    conn.commit()
    if export_catalog.import_if_empty(conn):  # nowa instalacja: karty i skrzynki z catalog_export.json
        print("  Wczytano karty i skrzynki z catalog_export.json")
    export_catalog.copy_custom_images()
    catalog.rebuild(conn)
    backfill_hall_of_fame(conn)
    conn.close()


# tabele z wariantem karty (kolumna) - przy usuwaniu wariantu z gry
VARIANT_COLUMNS = [("items", "variant"), ("feed", "variant"), ("market_listings", "variant"), ("market_wanted", "variant"),
                   ("jackpot_items", "variant"), ("trade_lines", "variant"), ("users", "avatar_variant")]


def drop_removed_variants(conn):
    """Warianty usunięte z gry (REMOVED_VARIANTS): karty graczy, oferty, ikony itd. w nich stają się zwykłe (z połączenia
    zostaje warstwa: flag+greek -> flag), a wpisy w klaserze, Hall of Fame i ustawienia wariantu znikają. Bezpieczne przy
    każdym starcie (gdy nic nie zostało, nic się nie zmienia)."""
    for v in REMOVED_VARIANTS:
        for table, col in VARIANT_COLUMNS:
            conn.execute(f"UPDATE {table} SET {col} = 'normal' WHERE {col} = ?", (v,))
            conn.execute(f"UPDATE {table} SET {col} = REPLACE({col}, ?, '') WHERE {col} LIKE ?", ("+" + v, "%+" + v))
        conn.execute("INSERT INTO user_collected (user_id, person_id, variant) SELECT user_id, person_id, 'normal' "
                     "FROM user_collected WHERE variant = ? ON CONFLICT DO NOTHING", (v,))
        for table in ("user_collected", "hall_of_fame"):
            conn.execute(f"DELETE FROM {table} WHERE variant = ? OR variant LIKE ?", (v, "%+" + v))
        conn.execute("DELETE FROM catalog_variants WHERE id = ?", (v,))
    conn.commit()


def backfill_hall_of_fame(conn):
    """Hall of Fame zapisujemy od tej aktualizacji. Jednorazowo (pusta tabela) uzupełniamy ją z historii: karty, które
    gracze mają teraz (czas wylosowania) i aktywność (legendarne+ - też te później sprzedane). Liczby są przybliżone."""
    if conn.execute("SELECT 1 FROM hall_of_fame LIMIT 1").fetchone():
        return
    best = {}  # (osoba, wariant) -> [gracz, czas, ile kart, ile wpisów w aktywności]
    for r in conn.execute("SELECT person_id, variant, user_id, created_at FROM items WHERE user_id > 0"):
        b = best.setdefault((r[0], r[1] or "normal"), [None, None, 0, 0])
        b[2] += 1
        if b[1] is None or r[3] < b[1]:
            b[0], b[1] = r[2], r[3]
    for r in conn.execute("SELECT author_id, person_id, variant, created_at FROM feed "
                          "WHERE kind IN ('drop', 'contract', 'upgrade') AND person_id IS NOT NULL"):
        b = best.setdefault((r[1], r[2] or "normal"), [None, None, 0, 0])
        b[3] += 1
        if b[1] is None or r[3] < b[1]:
            b[0], b[1] = r[0], r[3]
    for (pid, variant), (user_id, at, n_items, n_feed) in best.items():
        conn.execute("INSERT INTO hall_of_fame (person_id, variant, first_user_id, first_at, source, drops) "
                     "VALUES (?, ?, ?, ?, 'drop', ?) ON CONFLICT DO NOTHING", (pid, variant, user_id, at, max(n_items, n_feed)))
    conn.commit()


def init_sqlite(conn):
    """Schemat SQLite razem z migracjami starszych zapisów gry (PostgreSQL: database.PG_SCHEMA)."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id TEXT NOT NULL,
            holo INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS discovered (person_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            avatar TEXT NOT NULL DEFAULT '😎',
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_state (user_id INTEGER NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL,
                                               PRIMARY KEY (user_id, key));
        CREATE TABLE IF NOT EXISTS user_discovered (user_id INTEGER NOT NULL, person_id TEXT NOT NULL,
                                                    PRIMARY KEY (user_id, person_id));
        CREATE TABLE IF NOT EXISTS user_collected (user_id INTEGER NOT NULL, person_id TEXT NOT NULL, variant TEXT NOT NULL,
                                                   PRIMARY KEY (user_id, person_id, variant));
        CREATE TABLE IF NOT EXISTS daily_claims (user_id INTEGER NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL,
                                                 PRIMARY KEY (user_id, day));
        CREATE TABLE IF NOT EXISTS friendships (requester_id INTEGER NOT NULL, addressee_id INTEGER NOT NULL,
                                                status TEXT NOT NULL, created_at REAL NOT NULL,
                                                PRIMARY KEY (requester_id, addressee_id));
        CREATE TABLE IF NOT EXISTS showcase (user_id INTEGER NOT NULL, pos INTEGER NOT NULL, item_id INTEGER NOT NULL,
                                             PRIMARY KEY (user_id, pos));
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            message TEXT NOT NULL DEFAULT '',
            money_give INTEGER NOT NULL DEFAULT 0, money_want INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trade_lines (
            trade_id INTEGER NOT NULL, side TEXT NOT NULL, item_id INTEGER,
            person_id TEXT NOT NULL, variant TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS crate_access (user_id INTEGER NOT NULL, crate_id TEXT NOT NULL,
                                                 PRIMARY KEY (user_id, crate_id));
        CREATE TABLE IF NOT EXISTS user_chests (user_id INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
                                                PRIMARY KEY (user_id, kind));
        CREATE TABLE IF NOT EXISTS arena_daily (user_id INTEGER NOT NULL, day TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0,
                                                PRIMARY KEY (user_id, day));
        CREATE TABLE IF NOT EXISTS hall_of_fame (person_id TEXT NOT NULL, variant TEXT NOT NULL, first_user_id INTEGER,
                                                 first_at REAL NOT NULL, source TEXT NOT NULL DEFAULT 'drop',
                                                 drops INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (person_id, variant));
        CREATE TABLE IF NOT EXISTS admin_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at REAL NOT NULL,
            admin_id INTEGER, admin_name TEXT NOT NULL,
            action TEXT NOT NULL,
            target_id INTEGER, target_name TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT ''
        );
        -- wiadomości od adminów: gracz widzi je raz, przy pierwszym wejściu do gry między starts_at a ends_at
        CREATE TABLE IF NOT EXISTS admin_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL, body TEXT NOT NULL,
            starts_at REAL NOT NULL, ends_at REAL NOT NULL,
            created_at REAL NOT NULL, admin_name TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS admin_message_seen (message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
                                                       seen_at REAL NOT NULL, PRIMARY KEY (message_id, user_id));
        CREATE TABLE IF NOT EXISTS feed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER NOT NULL,
            to_user_id INTEGER,
            kind TEXT NOT NULL,
            person_id TEXT NOT NULL,
            variant TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS market_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seller_id INTEGER NOT NULL, item_id INTEGER NOT NULL, person_id TEXT NOT NULL, variant TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'fixed', price INTEGER NOT NULL, step INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active', buyer_id INTEGER, final_price INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL, ends_at REAL, updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS market_listings_status ON market_listings (status);
        CREATE TABLE IF NOT EXISTS market_offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL, price INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS market_offers_listing ON market_offers (listing_id);
        CREATE TABLE IF NOT EXISTS market_bids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL, bidder_id INTEGER NOT NULL, amount INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active', created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS market_bids_listing ON market_bids (listing_id);
        CREATE TABLE IF NOT EXISTS market_wanted (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            buyer_id INTEGER NOT NULL, person_id TEXT NOT NULL, variant TEXT NOT NULL, price INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active', seller_id INTEGER, created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jackpots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_id INTEGER NOT NULL, invite_id INTEGER, joiner_id INTEGER,
            status TEXT NOT NULL DEFAULT 'open', value_a INTEGER NOT NULL DEFAULT 0, value_b INTEGER NOT NULL DEFAULT 0,
            winner_id INTEGER, roll REAL, created_at REAL NOT NULL, finished_at REAL,
            is_public INTEGER NOT NULL DEFAULT 1, ready_a INTEGER NOT NULL DEFAULT 0, ready_b INTEGER NOT NULL DEFAULT 0,
            updated_at REAL
        );
        CREATE TABLE IF NOT EXISTS jackpot_invites (jackpot_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
                                                    PRIMARY KEY (jackpot_id, user_id));
        CREATE TABLE IF NOT EXISTS jackpot_items (
            jackpot_id INTEGER NOT NULL, side TEXT NOT NULL, item_id INTEGER NOT NULL,
            person_id TEXT NOT NULL, variant TEXT NOT NULL, value INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jackpot_items_jackpot ON jackpot_items (jackpot_id);
        CREATE TABLE IF NOT EXISTS card_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE, person_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
            created_by INTEGER, created_at REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS card_link_claims (link_id INTEGER NOT NULL, user_id INTEGER NOT NULL, item_id INTEGER,
                                                     claimed_at REAL NOT NULL, PRIMARY KEY (link_id, user_id));
        -- rozdanie blackjacka w trakcie (najwyżej jedno na gracza; po rozliczeniu znika). Listy w JSON: id postawionych
        -- kart (w ESCROW), talia, karty gracza i krupiera ("AS" = as pik, "TH" = dziesiątka kier)
        CREATE TABLE IF NOT EXISTS blackjack_games (
            user_id INTEGER PRIMARY KEY,
            item_ids TEXT NOT NULL, stake INTEGER NOT NULL,
            double_ids TEXT NOT NULL DEFAULT '[]', double_stake INTEGER NOT NULL DEFAULT 0,
            deck TEXT NOT NULL, player TEXT NOT NULL, dealer TEXT NOT NULL, created_at REAL NOT NULL
        );
    """)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(items)")]
    if "variant" not in cols:  # migracja: holo (0/1) -> variant
        conn.execute("ALTER TABLE items ADD COLUMN variant TEXT NOT NULL DEFAULT 'normal'")
        conn.execute("UPDATE items SET variant = 'holo' WHERE holo = 1")
    # migracja: wariant Alt Art został usunięty -> karty Alt Art zamieniamy na Holo (najbliższa wartość)
    conn.execute("UPDATE items SET variant = 'holo' WHERE variant = 'alt'")
    conn.execute("UPDATE feed SET variant = 'holo' WHERE variant = 'alt'")
    if "user_id" not in cols:  # migracja: karty należą do kont
        conn.execute("ALTER TABLE items ADD COLUMN user_id INTEGER")
    if "favorite" not in cols:  # migracja: ulubione karty (nie da się ich sprzedać)
        conn.execute("ALTER TABLE items ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS items_user ON items (user_id)")
    ucols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if "avatar_card" not in ucols:  # migracja: ikona gracza ze zdjęcia karty
        conn.execute("ALTER TABLE users ADD COLUMN avatar_card TEXT NOT NULL DEFAULT ''")
    if "avatar_variant" not in ucols:  # migracja: ikona w wariancie karty (złota, diamentowa...)
        conn.execute("ALTER TABLE users ADD COLUMN avatar_variant TEXT NOT NULL DEFAULT 'normal'")
    if "banned" not in ucols:  # migracja: blokowanie kont
        conn.execute("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''")
    if "ranking_hidden" not in ucols:  # migracja: admin może ukryć gracza w rankingu
        conn.execute("ALTER TABLE users ADD COLUMN ranking_hidden INTEGER NOT NULL DEFAULT 0")
    if "money_generated" not in ucols:  # migracja: gracze, którzy dostali pieniądze od admina (poza rankingiem)
        conn.execute("ALTER TABLE users ADD COLUMN money_generated INTEGER NOT NULL DEFAULT 0")
    ccols = [r[1] for r in conn.execute("PRAGMA table_info(user_collected)")]
    if "at" not in ccols:  # migracja: kiedy i skąd gracz pierwszy raz zdobył kartę (Hall of Fame bez ukrytych graczy)
        conn.execute("ALTER TABLE user_collected ADD COLUMN at REAL")
        conn.execute("ALTER TABLE user_collected ADD COLUMN source TEXT")
    jcols = [r[1] for r in conn.execute("PRAGMA table_info(jackpots)")]
    for col, sql in (("is_public", "INTEGER NOT NULL DEFAULT 1"), ("ready_a", "INTEGER NOT NULL DEFAULT 0"),
                     ("ready_b", "INTEGER NOT NULL DEFAULT 0"), ("updated_at", "REAL")):
        if col not in jcols:  # migracja: jackpot jako lobby (publiczne/prywatne, akceptacja obu graczy)
            conn.execute(f"ALTER TABLE jackpots ADD COLUMN {col} {sql}")


def ensure_state(conn, uid):
    for key, val in STATE_KEYS:
        conn.execute("INSERT INTO user_state (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", (uid, key, val))


def adopt_legacy_save(conn, uid):
    """Pierwsze konto przejmuje zapis gry sprzed wprowadzenia kont."""
    conn.execute("UPDATE items SET user_id = ? WHERE user_id IS NULL", (uid,))
    for key, value in conn.execute("SELECT key, value FROM state").fetchall():
        conn.execute("INSERT INTO user_state (user_id, key, value) VALUES (?, ?, ?) "
                 "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value", (uid, key, value))
    conn.execute("INSERT INTO user_discovered (user_id, person_id) SELECT ?, person_id FROM discovered WHERE true ON CONFLICT DO NOTHING", (uid,))  # WHERE: bez niego SQLite czyta ON jako JOIN
    conn.execute("DELETE FROM state")
    conn.execute("DELETE FROM discovered")


# ---------------------------------------------------------------- konta

# Nieudane logowania (w pamięci procesu - na serwerze działa jeden worker): po LOGIN_MAX_PER_USER błędnych
# hasłach na to samo konto albo LOGIN_MAX_PER_IP z jednego adresu trzeba odczekać, aż minie LOGIN_WINDOW.
_failed_logins = {}
_failed_lock = threading.Lock()


def _recent_failures(key, now):
    times = [t for t in _failed_logins.get(key, ()) if now - t < LOGIN_WINDOW]
    if times:
        _failed_logins[key] = times
    else:
        _failed_logins.pop(key, None)
    return times


def login_blocked(name):
    """Ile sekund trzeba jeszcze czekać (0 = można próbować)."""
    now = time.time()
    with _failed_lock:
        waits = []
        for key, limit in ((("user", name.lower()), LOGIN_MAX_PER_USER), (("ip", request.remote_addr), LOGIN_MAX_PER_IP)):
            times = _recent_failures(key, now)
            if len(times) >= limit:
                waits.append(LOGIN_WINDOW - (now - times[-limit]))
        return int(max(waits)) + 1 if waits else 0


def note_login(name, ok):
    now = time.time()
    with _failed_lock:
        if ok:
            _failed_logins.pop(("user", name.lower()), None)
            return
        for key in (("user", name.lower()), ("ip", request.remote_addr)):
            _failed_logins.setdefault(key, []).append(now)
        if len(_failed_logins) > 10000:  # zabezpieczenie przed zapchaniem pamięci
            for key in list(_failed_logins):
                _recent_failures(key, now)


def current_user():
    if "user" not in g:
        uid = session.get("uid")
        g.user = db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone() if uid else None
    return g.user


def uid():
    return current_user()["id"]


def lock_me():
    """Na początku zapytań, które sprawdzają stan gracza i potem go zmieniają (pieniądze, karty, skrzynki):
    podwójne kliknięcie nie wyda tych samych pieniędzy ani kart dwa razy."""
    db().lock_users(uid())


# gracze online: kiedy ostatnio coś wysłali (otwarta gra odpytuje /api/me co 30 s, w ukrytej karcie nie)
# w pamięci procesu jak katalog - po restarcie serwera licznik zaczyna od zera
LAST_SEEN = {}
ONLINE_SECONDS = 120


def online_count():
    now = time.time()
    return sum(1 for t in list(LAST_SEEN.values()) if now - t < ONLINE_SECONDS)


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if u is not None and u["banned"]:  # zablokowane konto - wylogowujemy
            session.clear()
            g.user = None
        if current_user() is None:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Zaloguj się", "login": True}), 401
            return redirect(url_for("login_page", next=request.path) if request.path != "/" else url_for("login_page"))
        LAST_SEEN[current_user()["id"]] = time.time()
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @functools.wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if not current_user()["is_admin"]:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Tylko dla admina"}), 403
            return redirect("/")
        return fn(*a, **kw)
    return wrapper


def avatar_card(u):
    """Karta ustawiona jako ikona gracza (id osoby) albo None."""
    pid = u["avatar_card"] if "avatar_card" in u.keys() else ""
    return pid if pid in catalog.PEOPLE else None


def avatar_variant(u):
    v = u["avatar_variant"] if "avatar_variant" in u.keys() else "normal"
    return v if v in VARIANTS else "normal"


def user_json(u):
    pid = avatar_card(u)
    return {"id": u["id"], "username": u["username"], "avatar": u["avatar"], "isAdmin": bool(u["is_admin"]),
            "avatarCard": pid, "avatarRarity": catalog.PEOPLE[pid]["rarity"] if pid else None,
            "avatarVariant": avatar_variant(u) if pid else None}


def find_user(name):
    return db().execute("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", ((name or "").strip(),)).fetchone()


@app.route("/login")
def login_page():
    if current_user():
        return redirect("/")
    first = db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return render_template("login.html", first=first)


@app.post("/api/register")
def register():
    body = request.get_json(force=True)
    name = (body.get("username") or "").strip()
    pw = body.get("password") or ""
    if not USERNAME_RE.match(name):
        return jsonify({"error": "Nazwa: 3–20 znaków (litery, cyfry, _ . -)"}), 400
    if len(pw) < MIN_PASSWORD:
        return jsonify({"error": PASSWORD_ERROR}), 400
    conn = db()
    if find_user(name):
        return jsonify({"error": "Ta nazwa jest już zajęta"}), 400
    first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    new_id = conn.execute("INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?) "
                          "RETURNING id", (name, generate_password_hash(pw), int(first), time.time())).fetchone()[0]
    if first:
        adopt_legacy_save(conn, new_id)
    ensure_state(conn, new_id)
    # nowy gracz nie musi czytać starych list zmian - zobaczy dopiero następną aktualizację
    conn.execute("UPDATE user_state SET value = ? WHERE user_id = ? AND key = 'patch_seen'", (PATCH_NOTES[0]["v"], new_id))
    conn.commit()
    session.clear()
    session.permanent = True
    session["uid"] = new_id
    return jsonify({"ok": True, "first": first})


@app.post("/api/login")
def login():
    body = request.get_json(force=True)
    name = (body.get("username") or "").strip()
    wait = login_blocked(name)
    if wait:
        return jsonify({"error": f"Za dużo nieudanych prób logowania. Spróbuj ponownie za {wait // 60 + 1} min."}), 429
    u = find_user(name)
    if u is None or not check_password_hash(u["password_hash"], body.get("password") or ""):
        note_login(name, False)
        time.sleep(0.4)
        return jsonify({"error": "Zła nazwa użytkownika lub hasło"}), 400
    note_login(name, True)
    if u["banned"]:
        reason = f" Powód: {u['ban_reason']}" if u["ban_reason"] else ""
        return jsonify({"error": f"To konto zostało zablokowane przez admina.{reason}"}), 403
    ensure_state(db(), u["id"])
    db().commit()
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    return jsonify({"ok": True})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/password")
@login_required
def change_password():
    lock_me()
    body = request.get_json(force=True)
    name = current_user()["username"]
    if login_blocked(name):
        return jsonify({"error": "Za dużo nieudanych prób. Spróbuj ponownie za kilka minut."}), 429
    if not check_password_hash(current_user()["password_hash"], body.get("old") or ""):
        note_login(name, False)
        return jsonify({"error": "Obecne hasło jest nieprawidłowe"}), 400
    if len(body.get("new") or "") < MIN_PASSWORD:
        return jsonify({"error": "Nowe " + PASSWORD_ERROR[0].lower() + PASSWORD_ERROR[1:]}), 400
    db().execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(body["new"]), uid()))
    db().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- stan gracza

def get_state(user_id=None):
    user_id = user_id or uid()
    st = dict(STATE_KEYS)
    st.update({r["key"]: r["value"] for r in db().execute("SELECT key, value FROM user_state WHERE user_id = ?", (user_id,))})
    return st


def add_state(key, delta, user_id=None):
    user_id = user_id or uid()
    ensure_state(db(), user_id)
    db().execute("UPDATE user_state SET value = value + ? WHERE user_id = ? AND key = ?", (delta, user_id, key))


def set_state(key, value):
    db().execute("INSERT INTO user_state (user_id, key, value) VALUES (?, ?, ?) "
                 "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value", (uid(), key, value))


def discovered(user_id=None):
    if user_id is None and current_user() is None:
        return set()
    return {r[0] for r in db().execute("SELECT person_id FROM user_discovered WHERE user_id = ?", (user_id or uid(),))}


def money_kind(kind):
    return kind[len("money_"):] if kind.startswith("money_") and kind[len("money_"):] in MONEY_CHESTS else None


def valid_chest_kind(kind):
    return (kind in catalog.CRATES and not catalog.CRATES[kind]["special"]) or money_kind(kind) is not None


def get_chests(user_id=None):
    rows = db().execute("SELECT kind, count FROM user_chests WHERE user_id = ? AND count > 0", (user_id or uid(),))
    return {r["kind"]: r["count"] for r in rows if valid_chest_kind(r["kind"])}


def add_chests(kind, delta, user_id=None):
    user_id = user_id or uid()
    db().execute("INSERT INTO user_chests (user_id, kind, count) VALUES (?, ?, 0) ON CONFLICT(user_id, kind) DO NOTHING",
                 (user_id, kind))
    db().execute("UPDATE user_chests SET count = CASE WHEN count + ? > 0 THEN count + ? ELSE 0 END "
                 "WHERE user_id = ? AND kind = ?", (delta, delta, user_id, kind))


def has_access(crate_id, user_id=None):
    return db().execute("SELECT 1 FROM crate_access WHERE user_id = ? AND crate_id = ?",
                        (user_id or uid(), crate_id)).fetchone() is not None


def can_buy(crate):
    """Czy zalogowany gracz może KUPIĆ tę skrzynkę (otwieranie posiadanych skrzynek jest zawsze możliwe)."""
    if crate.get("special"):   # skrzynka kart specjalnych - nie da się jej kupić (nawet adminowi)
        return False
    u = current_user()
    if u is not None and u["is_admin"]:
        return True
    return crate["shop"] and (not crate["restricted"] or has_access(crate["id"]))


def roll_money(kind):
    c = MONEY_CHESTS[kind]
    amount = c["min"] + (c["max"] - c["min"]) * rng.random() ** c["curve"]
    return int(round(amount / 100.0)) * 100


def item_json(row):
    person = catalog.PEOPLE.get(row["person_id"])
    if person is None:  # karta usunięta z katalogu
        return None
    variant = row["variant"] if row["variant"] in VARIANTS else "normal"
    return {"id": row["id"], "person": person["id"], "variant": variant,
            "value": card_value(person, variant), "created": row["created_at"], "fav": bool(row["favorite"])}


def note_collected(user_id, person_id, variant, source="transfer"):
    """Karta trafia na stałe do klasera gracza (zostaje tam także po sprzedaży). Zapamiętujemy, kiedy i skąd gracz zdobył
    ją pierwszy raz (drop / contract / upgrade / casino; transfer = rynek, jackpot; trade = wymiana) - do Hall of Fame."""
    db().execute("INSERT INTO user_collected (user_id, person_id, variant, at, source) VALUES (?, ?, ?, ?, ?) "
                 "ON CONFLICT DO NOTHING", (user_id, person_id, variant, time.time(), source))


def collected_list(user_id):
    return [[r[0], r[1]] for r in db().execute("SELECT person_id, variant FROM user_collected WHERE user_id = ?", (user_id,))
            if r[0] in catalog.PEOPLE]


def insert_item(person_id, variant, source="drop"):
    """Nowa karta gracza (source: drop = ze skrzynki, contract, upgrade, joker = karta specjalna z kasyna, link = z linku
    od admina - do Hall of Fame; casino - zwykła wygrana w kasynie, bez Hall of Fame)."""
    now = time.time()
    note_collected(uid(), person_id, variant, source)
    new_id = db().execute("INSERT INTO items (person_id, holo, variant, created_at, user_id) VALUES (?, ?, ?, ?, ?) "
                          "RETURNING id", (person_id, int(variant != "normal"), variant, now, uid())).fetchone()[0]
    return {"id": new_id, "person": person_id, "variant": variant,
            "value": card_value(catalog.PEOPLE[person_id], variant), "created": now, "fav": False,
            "first": note_hall_of_fame(person_id, variant, source, now) if source != "casino" else False}


def hidden_from_ranking(u):
    """Gracz poza rankingiem (zablokowany, ukryty przez admina, z pieniędzmi od admina) - nie pokazujemy go też w Hall of Fame."""
    return bool(u["banned"] or u["ranking_hidden"] or u["money_generated"])


def note_hall_of_fame(person_id, variant, source, now):
    """Hall of Fame: kto pierwszy zdobył tę kartę w tym wariancie (i kiedy) + ile ich w ogóle wypadło.
    Zwraca True, gdy gracz trafia do Hall of Fame jako pierwszy (ukryci gracze się nie liczą - liczy się pierwszy widoczny)."""
    cur = db().execute("INSERT INTO hall_of_fame (person_id, variant, first_user_id, first_at, source, drops) "
                       "VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (person_id, variant) DO NOTHING",
                       (person_id, variant, uid(), now, source))
    db().execute("UPDATE hall_of_fame SET drops = drops + 1 WHERE person_id = ? AND variant = ?", (person_id, variant))
    if hidden_from_ranking(current_user()):
        return False
    if cur.rowcount == 1:
        return True
    # pierwszy był gracz ukryty w rankingu - jestem pierwszym widocznym, jeśli nikt widoczny nie miał jej wcześniej
    first = hof_first(person_id, variant)
    return first is None or first[0] == uid()


def note_drops(items, kind="drop"):
    """Odkrywa tajne karty i wrzuca legendarne+ do aktywności znajomych. Zwraca nowo odkryte id."""
    new = []
    for it in items:
        rarity = catalog.PEOPLE[it["person"]]["rarity"]
        if rarity == "secret":
            cur = db().execute("INSERT INTO user_discovered (user_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                               (uid(), it["person"]))
            if cur.rowcount:
                new.append(it["person"])
        if RARITY_ORDER.index(rarity) >= FEED_RARITY:
            db().execute("INSERT INTO feed (author_id, to_user_id, kind, person_id, variant, created_at) "
                         "VALUES (?, NULL, ?, ?, ?, ?)", (uid(), kind, it["person"], it["variant"], time.time()))
    return new


def variant_photos(pid):
    """{wariant: wersja} - warianty tej karty, które mają własne zdjęcie (wersja = czas pliku, dla pamięci przeglądarki)."""
    out = {}
    for v in catalog.photo_variants(pid):
        path = images.find(pid, v)
        if path:
            out[v] = int(os.path.getmtime(path)) % 100000
    return out


def img_version(pid):
    paths = [images.find(pid), images.find(pid, True)]
    return int(sum(os.path.getmtime(p) for p in paths if p)) % 100000


def public_person(p, found):
    """Karta dla klienta - tajne karty są zamaskowane, dopóki ich nie zdobędziesz."""
    if p["rarity"] == "secret" and p["id"] not in found:
        return {"id": p["id"], "rarity": "secret", "crate": p["crate"], "crates": p["crates"], "number": p["number"], "masked": True,
                "valueMult": p.get("valueMult", 1),
                "name": "???", "type": "tv", "hp": 0, "attack": "???", "dmg": 0, "imgv": 0}
    base = {k: p.get(k) for k in ("id", "name", "rarity", "type", "hp", "attack", "dmg", "attack2", "dmg2",
                                  "kind1", "kind2", "abilities", "arena", "crate", "crates", "number", "valueMult",
                                  "country", "forge", "source", "fixedVariant", "style", "subtitle", "desc")}
    base["imgv"] = img_version(p["id"])
    vp = variant_photos(p["id"])
    if vp:
        base["variantPhotos"] = vp
    return base


# ---------------------------------------------------------------- strony

@app.route("/")
@app.route("/<any(crates, binder, inventory, forge, market, casino, friends, ranking, arena):view>")
@app.route("/inventory/hall-of-fame")
@app.route("/player/<name>")
@app.route("/link/<token>")   # link do karty specjalnej - kartę odbiera przeglądarka (/api/links/<token>/claim)
@app.route("/mockups")         # makiety kart specjalnych - tylko dla adminów
@app.route("/stickers")        # edytor naklejek wariantów (np. MLG) - tylko dla adminów
@app.route("/variants")        # warianty: podgląd, włączanie, szanse, wydarzenia, propozycje nowych - tylko dla adminów
@login_required
def index(view=None, name=None, token=None):
    # Arena, makiety, naklejki i warianty: tylko admini
    if (view == "arena" or request.path in ("/mockups", "/stickers", "/variants")) and not current_user()["is_admin"]:
        return redirect("/")
    return render_template("index.html")


# ---------------------------------------------------------------- aplikacja na telefon (PWA)

@app.route("/manifest.webmanifest")
def manifest():
    data = {
        "name": "ScamBox", "short_name": "ScamBox", "lang": "pl",
        "description": "Otwieraj skrzynki z kartami znanych osób, zbieraj kolekcję i wymieniaj się ze znajomymi.",
        "start_url": "/crates", "scope": "/", "display": "standalone", "orientation": "portrait",
        "background_color": "#0b0e1a", "theme_color": "#0c0f17",
        "icons": [{"src": url_for("static", filename="icons/icon-192.png"), "sizes": "192x192", "type": "image/png"},
                  {"src": url_for("static", filename="icons/icon-512.png"), "sizes": "512x512", "type": "image/png"},
                  {"src": url_for("static", filename="icons/maskable-512.png"), "sizes": "512x512", "type": "image/png",
                   "purpose": "maskable"}],
    }
    return Response(json.dumps(data, ensure_ascii=False), mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    # z głównego adresu, żeby obejmował całą grę; bez zapisywania plików gry (zawsze najnowsza wersja)
    resp = send_file(os.path.join(app.static_folder, "sw.js"), mimetype="application/javascript", max_age=0)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/admin")
@admin_required
def admin_page():
    return render_template("admin.html")


@app.route("/admin/mockups")
@admin_required
def admin_mockups():
    return redirect("/mockups")   # makiety kart specjalnych są w grze (index.html), nie w panelu


def svg_response(svg):
    return Response(svg, mimetype="image/svg+xml", headers={"Cache-Control": "no-store"})


MYSTERY_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <defs><radialGradient id="g"><stop offset="0" stop-color="#5a4a1a"/><stop offset="1" stop-color="#0b0906"/></radialGradient></defs>
  <rect width="300" height="300" fill="url(#g)"/>
  <text x="150" y="190" font-family="Georgia, serif" font-size="150" fill="#f3e3b0" text-anchor="middle">★</text>
  <text x="150" y="268" font-family="Arial" font-weight="bold" font-size="34" fill="#f3e3b0" text-anchor="middle" letter-spacing="6">???</text>
</svg>"""


@app.route("/flag/<code>.svg")
def flag_image(code):
    """Flaga kraju do wariantu flagowego (pobrana raz z flagcdn.com i trzymana w image_cache/flags)."""
    path = images.flag(code)
    if path is None:  # zły kod / brak internetu: neutralna flaga z kodem kraju
        safe = re.sub(r"[^A-Za-z-]", "", code)[:6].upper()
        resp = svg_response(f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" fill="#5a6274"/>
          <rect y="160" width="640" height="160" fill="#8c97b2"/><text x="320" y="275" font-family="Arial" font-weight="bold"
          font-size="110" fill="#fff" text-anchor="middle">{safe}</text></svg>""")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    resp = send_file(path, mimetype="image/svg+xml", max_age=7 * 86400)
    resp.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'"  # SVG z zewnątrz: bez skryptów
    return resp


@app.route("/img/<person_id>")
@app.route("/img/<person_id>/<kind>")
def image(person_id, kind="main"):
    p = catalog.PEOPLE.get(person_id)
    if p is None:
        return "", 404
    if p["rarity"] == "secret" and person_id not in discovered():
        # ?admin=1 - podgląd w panelu admina, ?feed=ID - tajna karta pokazana w aktywności znajomych
        u = current_user()
        allowed = (request.args.get("admin") == "1" and u and u["is_admin"]) or                   (u and feed_entry_visible(request.args.get("feed"), person_id)) or                   (u and friend_owns(request.args.get("owner"), person_id)) or \
                  (u and arena_shows(request.args.get("battle"), person_id)) or \
                  (u and market_shows(request.args.get("market"), person_id)) or \
                  (u and jackpot_shows(request.args.get("jackpot"), person_id))
        if not allowed:
            return svg_response(MYSTERY_SVG)
    # własne zdjęcie wariantu (Rzulty, Halloweenowa...; połączony wariant - ta część, która je ma), potem zdjęcie
    # z "photoFallback" (Lampionowa / Diabelska -> Halloweenowa), na końcu zwykłe
    photos = catalog.photo_variants(person_id)
    parts = [v for v in kind.split("+") if v in photos]
    if parts:
        tries = parts + [VARIANTS[v]["photoFallback"] for v in parts if VARIANTS[v].get("photoFallback") in photos]
        path = next((x for x in map(lambda v: images.find(person_id, v), tries) if x), None) or images.ensure(person_id)
    else:
        path = images.ensure(person_id, alt=(kind == "alt"))
    if path:
        # ?s=1 - mały kafelek (bęben, kuźnia, kasyno): miniatura; ?v=<wersja zdjęcia> - adres zmienia się razem ze zdjęciem
        path = images.web_version(path, thumb=request.args.get("s") == "1")
        resp = send_file(path, mimetype=images.mimetype(path), max_age=30 * 86400 if request.args.get("v") else 86400)
        if p["rarity"] == "secret":
            resp.headers["Cache-Control"] = "private, no-store"
        return resp
    initials = "".join(w[0] for w in p["name"].replace("„", "").split()[:2]).upper()
    color = RARITIES[p["rarity"]]["color"]
    return svg_response(f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
      <rect width="300" height="400" fill="#1d2233"/>
      <circle cx="150" cy="170" r="95" fill="{color}" opacity=".25"/>
      <text x="150" y="200" font-family="Arial" font-size="90" font-weight="bold"
            fill="{color}" text-anchor="middle">{initials}</text></svg>""")


@app.route("/sticker/<variant>/<sid>")
def sticker_image(variant, sid):
    """Naklejka wgrana przez admina na wariant (np. MLG) - ?v=<wersja> zmienia się razem z plikiem."""
    if variant not in STICKER_VARIANTS or not catalog.STICKER_ID_RE.match(sid):
        return "", 404
    path = images.find(catalog.sticker_file_id(variant), sid)
    if not path:
        return "", 404
    path = images.web_version(path)
    return send_file(path, mimetype=images.mimetype(path), max_age=30 * 86400 if request.args.get("v") else 3600)


def sticker_json(variant, s):
    """Naklejka dla przeglądarki - z adresem obrazka (wgrany plik albo wbudowana grafika z static/img/mlg)."""
    url = f"/sticker/{variant}/{s['id']}?v={s['v']}" if s["src"] == "upload" else asset(f"img/mlg/{s['src']}.svg")
    return dict(s, url=url)


# ---------------------------------------------------------------- API gry

def crate_json(c):
    return {k: c.get(k) for k in ("id", "name", "short", "code", "emoji", "color1", "color2", "price", "desc",
                                  "shop", "restricted", "special")} | \
           {"people": [p["id"] for p in c["people"]], "variants": c.get("variants") or [],
            "weights": {r: catalog.crate_weight(c, r) for r in RARITY_ORDER}}


@app.get("/api/config")
@login_required
def config():
    found = discovered()
    return jsonify({
        "rarities": RARITIES,
        "rarityOrder": RARITY_ORDER,
        "variants": VARIANTS,
        "variantOrder": VARIANT_ORDER,
        # włączone / wyłączone warianty i wydarzenia (wariant na czas w wybranych skrzynkach) - strona /variants
        "variantCfg": {v: catalog.variant_cfg_json(v, current_user()["is_admin"]) for v in VARIANT_DEFAULTS},
        "types": TYPES,
        "abilityKinds": ABILITY_KINDS,
        # Arena (wersja testowa) - tylko admini; bez tego klucza przeglądarka chowa zakładkę i wyzwania
        "arena": {"rules": ARENA, "effects": ARENA_EFFECTS, "visuals": ARENA_VISUALS, "targets": ARENA_TARGETS,
                  "effectTargets": ARENA_EFFECT_TARGETS} if current_user()["is_admin"] else None,
        "people": {pid: public_person(p, found) for pid, p in catalog.PEOPLE.items()},
        "crates": {cid: crate_json(c) | {"canBuy": can_buy(c)} for cid, c in catalog.CRATES.items()},
        "crateOrder": list(catalog.CRATES),
        "maxOpen": MAX_OPEN,
        "startingBalance": STARTING_BALANCE,
        "contractSize": CONTRACT_SIZE,
        "contractNext": {r: next_rarity(r) for r in CONTRACT_SIZE},   # rzadkość wyniku (pusta rzadkość jest pomijana)
        "contractVariantBonus": CONTRACT_VARIANT_BONUS,
        "upgradeEdge": UPGRADE_EDGE,
        "upgradeMax": UPGRADE_MAX,
        "upgradeMaxItems": UPGRADE_MAX_ITEMS,
        "upgradeMults": UPGRADE_MULTS,
        "maxDeposit": MAX_DEPOSIT,
        "moneyChests": MONEY_CHESTS,
        "dailyStreak": DAILY_STREAK,
        "secretOdds": SECRET_ODDS,
        "showcaseSize": SHOWCASE_SIZE,
        "market": MARKET,
        "roulette": dict(ROULETTE, wheel=ROULETTE_WHEEL, red=ROULETTE_RED,
                         bets={k: {"name": n, "numbers": nums, "pays": pays} for k, (n, nums, pays) in ROULETTE_BETS.items()}),
        "jackpot": JACKPOT,
        "blackjack": BLACKJACK,
        "specialVariants": SPECIAL_VARIANTS, "specialSources": SPECIAL_SOURCES, "casinoSpecial": CASINO_SPECIAL,
        # naklejki od admina na wariantach (MLG...) i wbudowane grafiki (część z nich jest też w samym wyglądzie MLG)
        "variantStickers": {v: [sticker_json(v, s) for s in catalog.STICKERS.get(v, [])] for v in STICKER_VARIANTS},
        # karty z własnymi naklejkami (zmienione standardowe + tylko tej karty) - gotowa lista dla każdej z nich
        "cardStickers": {v: {pid: [sticker_json(v, s) for s in catalog.card_stickers(v, pid)]
                             for pid in catalog.STICKER_CARDS.get(v, {}) if pid in catalog.PEOPLE} for v in STICKER_VARIANTS},
        "stickerLibrary": {k: {"name": n, "url": asset(f"img/mlg/{k}.svg")} for k, n in STICKER_LIBRARY.items()},
        "stickerAnims": STICKER_ANIMS,
    })


def my_items():
    rows = db().execute("SELECT * FROM items WHERE user_id = ? ORDER BY id DESC", (uid(),)).fetchall()
    return [i for i in (item_json(r) for r in rows) if i]


@app.get("/api/state")
@login_required
def state():
    return jsonify({"state": get_state(), "items": my_items(), "showcase": showcase_ids(uid()), "chests": get_chests(),
                    "collected": collected_list(uid())})


def roll_variant(avail, boost=None, factor=1.0):
    """Wariant karty. avail = warianty, które mogą teraz wypaść (catalog.drop_variants dla skrzynki,
    catalog.base_variants dla kontraktu), boost = {wariant: mnożnik szansy} z trwających wydarzeń (strona /variants).
    Wariant-warstwa (flaga) z szansą "extraChance" dostaje jeszcze jeden wariant - z tymi samymi szansami co zwykle.
    Warianty "always" (Halloweenowa / Lampionowa / Diabelska): w tej skrzynce każda karta dostaje jeden z nich
    (losowany według "weight"), a zwykły wariant losuje się normalnie - chyba że wylosowany ma "noCombo" (Lampionowa,
    Diabelska): wtedy karta ma tylko ten wariant."""
    boost = boost or {}
    always = [v for v in avail if VARIANTS[v].get("always")]
    if always:
        layer = rng.choices(always, weights=[VARIANTS[v].get("weight", 1) * boost.get(v, 1) for v in always])[0]
        if VARIANTS[layer].get("noCombo"):
            return layer
        return combine_variant(layer, roll_variant([v for v in avail if not VARIANTS[v].get("layer")], boost, factor))

    def chance(v):
        return VARIANTS[v]["chance"] * boost.get(v, 1)
    specials = [v for v in reversed(VARIANT_ORDER) if v in avail]  # najrzadsze najpierw
    total = sum(chance(v) for v in specials)
    factor = min(factor, 0.9 / total) if total else factor
    r, acc = rng.random(), 0.0
    for v in specials:
        acc += chance(v) * factor
        if r < acc:
            if VARIANTS[v].get("layer") and rng.random() < VARIANTS[v].get("extraChance", 0):
                bases = [b for b in specials if not VARIANTS[b].get("layer")]
                if bases:
                    return combine_variant(v, rng.choices(bases, weights=[chance(b) for b in bases])[0])
            return v
    return "normal"


def roll(crate):
    present = {p["rarity"] for p in crate["people"] if p["rarity"] != "special"}   # karty specjalne nie wypadają ze skrzynek
    weights = [catalog.crate_weight(crate, r) if r in present else 0 for r in RARITY_ORDER]
    rarity = rng.choices(RARITY_ORDER, weights=weights)[0]
    person = rng.choice([p for p in crate["people"] if p["rarity"] == rarity])
    return person, roll_variant(*catalog.drop_variants(crate, person))


@app.post("/api/open")
@login_required
def open_crates():
    lock_me()
    body = request.get_json(force=True)
    crate = catalog.CRATES.get(body.get("crate"))
    count = int(body.get("count", 1))
    if crate is None or not 1 <= count <= MAX_OPEN:
        return jsonify({"error": "Nieprawidłowe żądanie"}), 400
    if crate["special"]:
        return jsonify({"error": "Karty specjalne zdobywa się w kasynie albo z linku — tej skrzynki nie da się otworzyć"}), 400
    if not any(p["rarity"] != "special" for p in crate["people"]):
        return jsonify({"error": "Ta skrzynka jest pusta"}), 400
    owned = get_chests().get(crate["id"], 0) if body.get("useOwned", True) else 0
    from_inv = min(owned, count)
    if from_inv < count and not can_buy(crate):
        msg = "Ta skrzynka jest dostępna tylko dla wybranych graczy" if crate["shop"] else "Tej skrzynki nie ma teraz w sklepie"
        return jsonify({"error": msg + (f" — możesz otworzyć tylko te z ekwipunku ({owned})" if owned else "")}), 403
    cost = (count - from_inv) * crate["price"]
    if get_state()["balance"] < cost:
        return jsonify({"error": "Za mało pieniędzy!"}), 400
    if from_inv:
        add_chests(crate["id"], -from_inv)
    add_state("balance", -cost)
    add_state("spent", cost)
    add_state("opened", count)
    drops = []
    for _ in range(count):
        person, variant = roll(crate)
        drops.append(insert_item(person["id"], variant))
    new = note_drops(drops)
    db().commit()
    return jsonify({"drops": drops, "discovered": new, "state": get_state(), "fromInventory": from_inv,
                    "chests": get_chests()})


@app.post("/api/chests/buy")
@login_required
def buy_chests():
    lock_me()
    body = request.get_json(force=True)
    crate = catalog.CRATES.get(body.get("crate"))
    count = int(body.get("count", 1))
    if crate is None or not 1 <= count <= 100:
        return jsonify({"error": "Nieprawidłowe żądanie"}), 400
    if not can_buy(crate):
        return jsonify({"error": "Nie możesz kupić tej skrzynki"}), 403
    cost = count * crate["price"]
    if get_state()["balance"] < cost:
        return jsonify({"error": "Za mało pieniędzy!"}), 400
    add_state("balance", -cost)
    add_state("spent", cost)
    add_chests(crate["id"], count)
    db().commit()
    return jsonify({"state": get_state(), "chests": get_chests()})


@app.post("/api/chests/money")
@login_required
def open_money_chest():
    lock_me()
    kind = request.get_json(force=True).get("kind")
    if kind not in MONEY_CHESTS:
        return jsonify({"error": "Nieznana skrzynka"}), 400
    if get_chests().get("money_" + kind, 0) < 1:
        return jsonify({"error": "Nie masz takiej skrzynki"}), 400
    amount = roll_money(kind)
    add_chests("money_" + kind, -1)
    add_state("balance", amount)
    add_state("daily_total", amount)
    db().commit()
    return jsonify({"amount": amount, "kind": kind, "state": get_state(), "chests": get_chests()})


def owned_rows(ids):
    """Zwraca wiersze moich kart o podanych id albo None, jeśli czegoś brakuje."""
    if not ids or len(set(ids)) != len(ids):
        return None
    marks = ",".join("?" * len(ids))
    rows = db().execute(f"SELECT * FROM items WHERE user_id = ? AND id IN ({marks})", [uid(), *ids]).fetchall()
    if len(rows) != len(ids) or any(r["person_id"] not in catalog.PEOPLE for r in rows):
        return None
    return rows


def delete_items(ids):
    marks = ",".join("?" * len(ids))
    db().execute(f"DELETE FROM items WHERE user_id = ? AND id IN ({marks})", [uid(), *ids])
    db().execute(f"DELETE FROM showcase WHERE user_id = ? AND item_id IN ({marks})", [uid(), *ids])


def row_value(r):
    return card_value(catalog.PEOPLE[r["person_id"]], r["variant"])


@app.post("/api/sell")
@login_required
def sell():
    lock_me()
    ids = [int(i) for i in request.get_json(force=True).get("ids", [])]
    if not ids:
        return jsonify({"error": "Nic nie wybrano"}), 400
    marks = ",".join("?" * len(ids))
    rows = db().execute(f"SELECT * FROM items WHERE user_id = ? AND favorite = 0 AND id IN ({marks})",
                        [uid(), *ids]).fetchall()  # ulubionych kart nie sprzedajemy
    rows = [r for r in rows if not catalog.is_special(catalog.PEOPLE.get(r["person_id"]))]   # karty specjalne nie znikają z gry
    total = sum(row_value(r) for r in rows if r["person_id"] in catalog.PEOPLE)
    delete_items([r["id"] for r in rows] or [-1])
    add_state("balance", total)
    add_state("earned", total)
    db().commit()
    return jsonify({"sold": [r["id"] for r in rows], "total": total, "state": get_state()})


FAV_ERROR = "Ulubionych kart (⭐) nie da się zużyć ani sprzedać — najpierw odznacz gwiazdkę"
SPECIAL_ERROR = "Kart specjalnych nie da się sprzedać grze, postawić ani zużyć — można je tylko wymienić albo sprzedać na rynku"


@app.post("/api/favorite")
@login_required
def set_favorite():
    body = request.get_json(force=True)
    ids = [int(i) for i in body.get("ids", [])][:500]
    if not ids:
        return jsonify({"error": "Nic nie wybrano"}), 400
    marks = ",".join("?" * len(ids))
    db().execute(f"UPDATE items SET favorite = ? WHERE user_id = ? AND id IN ({marks})",
                 [int(bool(body.get("fav", True))), uid(), *ids])
    db().commit()
    return jsonify({"ok": True})


class ContractError(Exception):
    """Kontrakt niezgodny z zasadami - komunikat dla gracza."""


MAX_BULK_CONTRACTS = 50   # ile kontraktów naraz


def contract_candidates(crate_id, target, max_mult):
    """Możliwe wyniki kontraktu ze skrzynki (None = ze wszystkich skrzynek w sklepie). Tylko karty ze skrzynek, które są
    teraz w sklepie ("forge"); wynik nie może być "droższą" kartą (np. tylko ze skrzynek po 500 gr) niż najtańsza z włożonych."""
    people = catalog.CRATES[crate_id]["people"] if crate_id else catalog.PEOPLE.values()
    return [p for p in people if p["rarity"] == target and p.get("valueMult", 1) <= max_mult and p.get("forge")]


def contract_crate(p, target, max_mult):
    """Skrzynka, z której kontrakt losuje wynik za tę kartę: pierwsza skrzynka karty z kartami wyższej rzadkości
    w sklepie; karta tylko ze skrzynek spoza sklepu - None (wszystkie skrzynki w sklepie)."""
    return next((c for c in p["crates"] if contract_candidates(c, target, max_mult)), None)


def next_rarity(rarity):
    """Rzadkość wyniku kontraktu: następna, która ma karty w sklepie (pusta rzadkość, np. Niepospolita bez kart, jest pomijana)."""
    present = {p["rarity"] for p in catalog.PEOPLE.values() if p.get("forge")}
    return next((r for r in RARITY_ORDER[RARITY_ORDER.index(rarity) + 1:] if r in present and r != "secret"), None)


def contract_check(ids):
    """Sprawdza karty jednego kontraktu (nic nie zmienia). Zwraca plan albo rzuca ContractError."""
    rows = owned_rows(ids)
    if rows is None:
        raise ContractError("Nie masz tych kart")
    if any(r["favorite"] for r in rows):
        raise ContractError(FAV_ERROR)
    if any(catalog.is_special(catalog.PEOPLE[r["person_id"]]) for r in rows):
        raise ContractError(SPECIAL_ERROR)
    rarities = {catalog.PEOPLE[r["person_id"]]["rarity"] for r in rows}
    rarity = rarities.pop() if len(rarities) == 1 else None
    if rarity is not None and rarity not in CONTRACT_SIZE:
        raise ContractError("Z tych kart nie da się nic wytworzyć — tajnych kart nie można zrobić w kuźni")
    if rarity not in CONTRACT_SIZE:
        raise ContractError("Wszystkie karty muszą mieć tę samą rzadkość")
    if len(rows) != CONTRACT_SIZE[rarity]:
        raise ContractError(f"Kontrakt wymaga {CONTRACT_SIZE[rarity]} kart")
    target = next_rarity(rarity)
    if target is None:
        raise ContractError("Nie ma kart wyższej rzadkości")
    max_mult = min(catalog.PEOPLE[r["person_id"]].get("valueMult", 1) for r in rows)
    pool = [c for c in (contract_crate(catalog.PEOPLE[r["person_id"]], target, max_mult) for r in rows)
            if contract_candidates(c, target, max_mult)]
    if not pool:
        raise ContractError("W skrzynkach ze sklepu nie ma kart wyższej rzadkości")
    return {"ids": ids, "target": target, "max_mult": max_mult, "pool": pool,
            "specials": sum(r["variant"] != "normal" for r in rows)}


def contract_exec(plan):
    """Wykonuje sprawdzony kontrakt: zabiera karty, losuje nową. Zwraca (karta, skrzynka wyniku)."""
    crate_id = rng.choice(plan["pool"])
    person = rng.choice(contract_candidates(crate_id, plan["target"], plan["max_mult"]))
    delete_items(plan["ids"])
    variant = roll_variant(catalog.base_variants(), factor=1 + CONTRACT_VARIANT_BONUS * plan["specials"])
    item = insert_item(person["id"], variant, "contract")
    add_state("contracts", 1)
    return item, crate_id or person["crate"]


@app.post("/api/contract")
@login_required
def contract():
    lock_me()
    ids = [int(i) for i in request.get_json(force=True).get("ids", [])]
    try:
        plan = contract_check(ids)
    except ContractError as e:
        return jsonify({"error": str(e)}), 400
    item, crate_id = contract_exec(plan)
    new = note_drops([item], "contract")
    db().commit()
    return jsonify({"item": item, "crate": crate_id, "consumed": ids, "discovered": new, "state": get_state()})


@app.post("/api/contracts")
@login_required
def contracts_bulk():
    """Wiele kontraktów naraz: groups = [[id, id, ...], ...]. Najpierw sprawdzamy wszystkie - błąd w jednym = nic się nie dzieje."""
    lock_me()
    groups = request.get_json(force=True).get("groups")
    if not isinstance(groups, list) or not 1 <= len(groups) <= MAX_BULK_CONTRACTS:
        return jsonify({"error": f"Naraz można zrobić od 1 do {MAX_BULK_CONTRACTS} kontraktów"}), 400
    try:
        groups = [[int(i) for i in g] for g in groups]
    except (TypeError, ValueError):
        return jsonify({"error": "Nieprawidłowe żądanie"}), 400
    all_ids = [i for g in groups for i in g]
    if len(set(all_ids)) != len(all_ids):
        return jsonify({"error": "Ta sama karta nie może być w dwóch kontraktach"}), 400
    try:
        plans = [contract_check(g) for g in groups]
    except ContractError as e:
        return jsonify({"error": str(e)}), 400
    results = []
    for plan in plans:
        item, crate_id = contract_exec(plan)
        results.append({"item": item, "crate": crate_id})
    new = note_drops([r["item"] for r in results], "contract")
    db().commit()
    return jsonify({"results": results, "consumed": all_ids, "discovered": new, "state": get_state()})


def upgrade_pool():
    """Możliwe cele ulepszacza: karty ze skrzynek w sklepie (bez tajnych i specjalnych) w zwykłym wariancie albo we
    włączonych, nie wyjątkowych wariantach - [(wartość, karta, wariant)]."""
    variants = ["normal", *catalog.base_variants()]
    return [(card_value(p, v), p, v) for p in catalog.PEOPLE.values()
            if p.get("forge") and p["rarity"] not in ("secret", "special") for v in variants]


def upgrade_targets(stake, mult):
    """Cel ulepszacza dla wkładu i mnożnika: najniższa wartość >= wkład × mnożnik (i > wkład) oraz wszystkie karty
    o tej wartości (jedna z nich zostanie wylosowana). (wartość, [(karta, wariant)]) albo (None, [])."""
    fits = [x for x in upgrade_pool() if x[0] >= stake * mult and x[0] > stake]
    if not fits:
        return None, []
    goal = min(x[0] for x in fits)
    return goal, [(p, v) for value, p, v in fits if value == goal]


@app.post("/api/upgrade")
@login_required
def upgrade():
    """Ulepszacz w kasynie, "w ciemno": gracz stawia karty i wybiera mnożnik, serwer losuje kartę-cel (gracz widzi tylko
    jej wartość i szansę). Wygrana daje kartę-cel i może też dać kartę specjalną z kasyna (Joker)."""
    lock_me()
    body = request.get_json(force=True)
    try:
        ids = [int(i) for i in body.get("ids", [])]
        mult = float(body.get("mult"))
    except (TypeError, ValueError):
        return bad("Nieprawidłowy wybór kart")
    rows = owned_rows(ids)
    if rows is None or not 1 <= len(rows) <= UPGRADE_MAX_ITEMS or mult not in UPGRADE_MULTS:
        return bad("Nieprawidłowy wybór kart")
    if any(r["favorite"] for r in rows):
        return bad(FAV_ERROR)
    if any(catalog.is_special(catalog.PEOPLE[r["person_id"]]) for r in rows):
        return bad(SPECIAL_ERROR)
    stake = sum(row_value(r) for r in rows)
    goal, targets = upgrade_targets(stake, mult)
    if not targets:
        return bad("Nie ma tak drogiej karty - wybierz mniejszy mnożnik")
    chance = min(UPGRADE_MAX, stake / goal * UPGRADE_EDGE)
    roll_ = rng.random()
    win = roll_ < chance
    delete_items(ids)
    item = special = None
    new = []
    if win:
        target, variant = rng.choice(targets)
        item = insert_item(target["id"], variant, "upgrade")
        new = note_drops([item], "upgrade")
        special = casino_special_drop(goal)   # karta specjalna z kasyna (Joker) albo None
    add_state("upgrades_won" if win else "upgrades_lost", 1)
    db().commit()
    return jsonify({"win": win, "chance": chance, "roll": roll_, "goal": goal, "item": item, "special": special,
                    "consumed": ids, "discovered": new, "state": get_state()})


# ---------------------------------------------------------------- codzienna nagroda

def daily_streak(user_id, today):
    """Seria logowań: ile dni z rzędu (do wczoraj) gracz odebrał codzienną skrzynkę i czy odebrał ją dziś."""
    claimed = {r["day"] for r in db().execute("SELECT day FROM daily_claims WHERE user_id = ? AND day < ?",
                                              (user_id, (today + datetime.timedelta(days=1)).isoformat()))}
    before, d = 0, today - datetime.timedelta(days=1)
    while d.isoformat() in claimed:
        before, d = before + 1, d - datetime.timedelta(days=1)
    return before, today.isoformat() in claimed


def daily_info(user_id):
    """Dzisiejsza skrzynka w serii DAILY_STREAK dni: dzień serii 1..7 (7. = MEGA), które dni serii są już odebrane."""
    today = datetime.date.today()
    before, done = daily_streak(user_id, today)
    # dzień serii, który przypada dziś (po MEGA seria liczy się od nowa: 7 odebranych dni -> dziś znów 1. dzień)
    pos = before % DAILY_STREAK + 1
    kind = "mega" if pos == DAILY_STREAK else "daily"
    days = [{"day": i, "kind": "mega" if i == DAILY_STREAK else "daily", "claimed": i < pos or (i == pos and done),
             "today": i == pos} for i in range(1, DAILY_STREAK + 1)]
    return {"today": today.isoformat(), "claimable": not done, "days": days, "todayKind": kind, "streakDay": pos,
            "streak": before + done, "daysToJackpot": DAILY_STREAK - pos}


@app.get("/api/daily")
@login_required
def daily():
    return jsonify(daily_info(uid()))


@app.post("/api/daily/claim")
@login_required
def daily_claim():
    lock_me()
    today = datetime.date.today()
    kind = daily_info(uid())["todayKind"]   # 7. dzień serii logowań = MEGA skrzynka
    cur = db().execute("INSERT INTO daily_claims (user_id, day, amount) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
                       (uid(), today.isoformat()))
    if not cur.rowcount:
        return jsonify({"error": "Dzisiejsza skrzynka jest już odebrana"}), 400
    add_chests("money_" + kind, 1)
    db().commit()
    return jsonify({"kind": kind, "chests": get_chests(), "daily": daily_info(uid())})


# ---------------------------------------------------------------- znajomi

def friend_ids(user_id):
    rows = db().execute("""
        SELECT addressee_id FROM friendships WHERE requester_id = ? AND status = 'accepted'
        UNION SELECT requester_id FROM friendships WHERE addressee_id = ? AND status = 'accepted'""",
                        (user_id, user_id))
    return {r[0] for r in rows}


def relation(me, other):
    if me == other:
        return "me"
    r = db().execute("SELECT requester_id, status FROM friendships WHERE (requester_id = ? AND addressee_id = ?) "
                     "OR (requester_id = ? AND addressee_id = ?)", (me, other, other, me)).fetchone()
    if r is None:
        return "none"
    if r["status"] == "accepted":
        return "friend"
    return "outgoing" if r["requester_id"] == me else "incoming"


def collection_stats():
    """Wartość kolekcji i liczba unikalnych kart dla wszystkich graczy."""
    stats = {}
    for r in db().execute("SELECT user_id, person_id, variant FROM items WHERE user_id IS NOT NULL"):
        p = catalog.PEOPLE.get(r["person_id"])
        if p is None:
            continue
        s = stats.setdefault(r["user_id"], {"value": 0, "unique": set(), "total": 0})
        s["value"] += card_value(p, r["variant"])
        s["unique"].add(r["person_id"])
        s["total"] += 1
    return stats


def brief(u, stats=None):
    s = (stats or {}).get(u["id"], {"value": 0, "unique": set(), "total": 0})
    return dict(user_json(u), value=s["value"], unique=len(s["unique"]), total=s["total"])


@app.get("/api/friends")
@login_required
def friends():
    me = uid()
    stats = collection_stats()
    users = {u["id"]: u for u in db().execute("SELECT * FROM users")}
    rows = db().execute("SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?", (me, me)).fetchall()
    out = {"friends": [], "incoming": [], "outgoing": []}
    for r in rows:
        other = r["addressee_id"] if r["requester_id"] == me else r["requester_id"]
        if other not in users:
            continue
        key = "friends" if r["status"] == "accepted" else ("outgoing" if r["requester_id"] == me else "incoming")
        out[key].append(brief(users[other], stats))
    for k in out:
        out[k].sort(key=lambda x: x["username"].lower())
    return jsonify(out)


@app.post("/api/friends/request")
@login_required
def friend_request():
    lock_me()
    other = find_user(request.get_json(force=True).get("username"))
    me = uid()
    if other is None:
        return jsonify({"error": "Nie ma takiego gracza"}), 404
    rel = relation(me, other["id"])
    if rel == "me":
        return jsonify({"error": "Nie możesz zaprosić samego siebie 🙂"}), 400
    if rel == "friend":
        return jsonify({"error": "Już jesteście znajomymi"}), 400
    if rel == "outgoing":
        return jsonify({"error": "Zaproszenie już wysłane"}), 400
    if rel == "incoming":  # ta osoba już nas zaprosiła - od razu akceptujemy
        db().execute("UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?",
                     (other["id"], me))
        db().commit()
        return jsonify({"ok": True, "status": "friend"})
    db().execute("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)",
                 (me, other["id"], time.time()))
    db().commit()
    return jsonify({"ok": True, "status": "outgoing"})


@app.post("/api/friends/respond")
@login_required
def friend_respond():
    lock_me()
    body = request.get_json(force=True)
    other = find_user(body.get("username"))
    if other is None or relation(uid(), other["id"]) != "incoming":
        return jsonify({"error": "Brak takiego zaproszenia"}), 400
    if body.get("accept"):
        db().execute("UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?",
                     (other["id"], uid()))
    else:
        db().execute("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?", (other["id"], uid()))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/friends/remove")
@login_required
def friend_remove():
    other = find_user(request.get_json(force=True).get("username"))
    if other is None:
        return jsonify({"error": "Nie ma takiego gracza"}), 404
    db().execute("DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)",
                 (uid(), other["id"], other["id"], uid()))
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/users/search")
@login_required
def user_search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 1:
        return jsonify({"users": []})
    rows = db().execute("SELECT * FROM users WHERE banned = 0 AND LOWER(username) LIKE LOWER(?) ESCAPE '\\' ORDER BY LOWER(username) LIMIT 10",
                        ("%" + q.replace("%", "").replace("_", "\\_") + "%",)).fetchall()
    return jsonify({"users": [user_json(u) for u in rows]})


# ---------------------------------------------------------------- aktywność / pokazywanie kart

def visible_feed_sql():
    return """FROM feed f JOIN users u ON u.id = f.author_id
              WHERE (f.author_id = :me OR f.to_user_id = :me
                 OR (f.to_user_id IS NULL AND f.author_id IN (
                     SELECT addressee_id FROM friendships WHERE requester_id = :me AND status = 'accepted'
                     UNION SELECT requester_id FROM friendships WHERE addressee_id = :me AND status = 'accepted')))"""


def friend_owns(owner_name, person_id):
    """Czy gracz o tej nazwie jest moim znajomym i ma tę kartę (wtedy widzę ją na jego profilu)."""
    owner = find_user(owner_name) if owner_name else None
    if owner is None or owner["id"] not in friend_ids(uid()):
        return False
    return db().execute("SELECT 1 FROM user_collected WHERE user_id = ? AND person_id = ? LIMIT 1",
                        (owner["id"], person_id)).fetchone() is not None


def feed_entry_visible(feed_id, person_id):
    try:
        feed_id = int(feed_id)
    except (TypeError, ValueError):
        return False
    me = uid()
    row = db().execute(f"SELECT f.id {visible_feed_sql()} AND f.id = :fid AND f.person_id = :pid",
                       {"me": me, "fid": feed_id, "pid": person_id}).fetchone()
    return row is not None


@app.get("/api/feed")
@login_required
def feed():
    me = uid()
    params = {"me": me}
    rows = db().execute(f"SELECT f.*, u.username, u.avatar, u.avatar_card, u.avatar_variant, (SELECT username FROM users WHERE id = f.to_user_id) AS to_name "
                        f"{visible_feed_sql()} ORDER BY f.id DESC LIMIT 60", params).fetchall()
    out = []
    found = discovered()
    for r in rows:
        p = catalog.PEOPLE.get(r["person_id"])
        if p is None:
            continue
        # tajną kartę znajomego widać w aktywności, nawet jeśli samemu jej jeszcze nie odkryłeś
        reveal = public_person(p, {p["id"]}) if p["rarity"] == "secret" and p["id"] not in found else None
        out.append({"id": r["id"], "kind": r["kind"], "person": r["person_id"], "variant": r["variant"], "reveal": reveal,
                    "message": r["message"], "created": r["created_at"], "mine": r["author_id"] == me,
                    "author": {"username": r["username"], "avatar": r["avatar"],
                               "avatarCard": r["avatar_card"] if r["avatar_card"] in catalog.PEOPLE else None,
                               "avatarRarity": catalog.PEOPLE[r["avatar_card"]]["rarity"] if r["avatar_card"] in catalog.PEOPLE else None,
                               "avatarVariant": r["avatar_variant"] if r["avatar_variant"] in VARIANTS else "normal"},
                    "to": r["to_name"],
                    "value": card_value(catalog.PEOPLE[r["person_id"]], r["variant"])})
    return jsonify({"feed": out, "seen": get_state()["feed_seen"]})


@app.post("/api/feed/seen")
@login_required
def feed_seen():
    last = db().execute("SELECT MAX(id) FROM feed").fetchone()[0] or 0
    set_state("feed_seen", last)
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/show")
@login_required
def show_card():
    body = request.get_json(force=True)
    rows = owned_rows([int(body.get("item_id", 0))])
    if rows is None:
        return jsonify({"error": "Nie masz tej karty"}), 400
    to = body.get("to") or "all"
    to_id = None
    if to != "all":
        other = find_user(to)
        if other is None or other["id"] not in friend_ids(uid()):
            return jsonify({"error": "Możesz pokazywać karty tylko znajomym"}), 400
        to_id = other["id"]
    elif not friend_ids(uid()):
        return jsonify({"error": "Nie masz jeszcze znajomych 🙂"}), 400
    msg = (body.get("message") or "").strip()[:140]
    r = rows[0]
    db().execute("INSERT INTO feed (author_id, to_user_id, kind, person_id, variant, message, created_at) "
                 "VALUES (?, ?, 'show', ?, ?, ?, ?)", (uid(), to_id, r["person_id"], r["variant"], msg, time.time()))
    db().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- wymiany z przyjaciółmi

TRADE_MAX_LINES = 30
# Wymiany są tylko na karty - pieniędzy nie da się przekazać (kolumny money_give / money_want zostają dla starych wymian).
TRADE_NO_MONEY = "W wymianach można dawać tylko karty — bez pieniędzy"


def trade_json(t, me):
    users = {u["id"]: u for u in db().execute("SELECT * FROM users WHERE id IN (?, ?)", (t["from_id"], t["to_id"]))}
    found = discovered()
    lines = {"give": [], "want": []}
    for r in db().execute("SELECT * FROM trade_lines WHERE trade_id = ?", (t["id"],)):
        p = catalog.PEOPLE.get(r["person_id"])
        if p is None:
            continue
        owner = users.get(t["from_id"] if r["side"] == "give" else t["to_id"])
        line = {"person": p["id"], "variant": r["variant"], "count": r["count"], "value": card_value(p, r["variant"]),
                "owner": owner["username"] if owner else None}
        # tajną kartę znajomego widać w ofercie (jak na jego profilu)
        if p["rarity"] == "secret" and p["id"] not in found:
            line["reveal"] = public_person(p, {p["id"]})
        lines[r["side"]].append(line)
    out = {"id": t["id"], "status": t["status"], "message": t["message"], "created": t["created_at"],
           "updated": t["updated_at"], "moneyGive": t["money_give"], "moneyWant": t["money_want"],
           "from": user_json(users[t["from_id"]]) if t["from_id"] in users else None,
           "to": user_json(users[t["to_id"]]) if t["to_id"] in users else None,
           "mine": t["from_id"] == me, **lines}
    if t["status"] == "pending":
        out["problem"] = trade_problem(t)
    return out


def pick_want_items(user_id, person_id, variant, count):
    """Wybiera konkretne karty gracza do oddania (najpierw te spoza gabloty)."""
    rows = db().execute("""SELECT i.id FROM items i LEFT JOIN showcase s ON s.item_id = i.id AND s.user_id = i.user_id
                           WHERE i.user_id = ? AND i.person_id = ? AND i.variant = ?
                           ORDER BY (s.item_id IS NOT NULL), i.id LIMIT ?""", (user_id, person_id, variant, count)).fetchall()
    return [r[0] for r in rows] if len(rows) == count else None


def trade_problem(t):
    """Opis, dlaczego wymiany nie da się już zrealizować, albo None."""
    give = db().execute("SELECT item_id FROM trade_lines WHERE trade_id = ? AND side = 'give'", (t["id"],)).fetchall()
    for r in give:
        if db().execute("SELECT 1 FROM items WHERE id = ? AND user_id = ?", (r[0], t["from_id"])).fetchone() is None:
            return "Oferujący nie ma już wszystkich kart z oferty"
    for r in db().execute("SELECT * FROM trade_lines WHERE trade_id = ? AND side = 'want'", (t["id"],)).fetchall():
        if pick_want_items(t["to_id"], r["person_id"], r["variant"], r["count"]) is None:
            return "Odbiorca nie ma już wszystkich chcianych kart"
    if t["money_give"] or t["money_want"]:   # stara oferta z pieniędzmi - już nie do przyjęcia
        return TRADE_NO_MONEY
    return None


@app.get("/api/trades")
@login_required
def trades_list():
    me = uid()
    pending = db().execute("SELECT * FROM trades WHERE status = 'pending' AND (from_id = ? OR to_id = ?) "
                           "ORDER BY id DESC", (me, me)).fetchall()
    history = db().execute("SELECT * FROM trades WHERE status != 'pending' AND (from_id = ? OR to_id = ?) "
                           "ORDER BY updated_at DESC LIMIT 15", (me, me)).fetchall()
    return jsonify({"incoming": [trade_json(t, me) for t in pending if t["to_id"] == me],
                    "outgoing": [trade_json(t, me) for t in pending if t["from_id"] == me],
                    "history": [trade_json(t, me) for t in history]})


@app.post("/api/trades")
@login_required
def trade_create():
    lock_me()
    body = request.get_json(force=True)
    me = uid()
    other = find_user(body.get("to"))
    if other is None or other["id"] not in friend_ids(me):
        return jsonify({"error": "Wymieniać się możesz tylko ze znajomymi"}), 400
    if other["banned"]:
        return jsonify({"error": "To konto jest zablokowane"}), 400
    try:
        give_ids = [int(i) for i in body.get("give", [])]
        want = [{"person": w["person"], "variant": w.get("variant", "normal"), "count": int(w.get("count", 1))}
                for w in body.get("want", [])]
    except (TypeError, ValueError, KeyError):
        return jsonify({"error": "Nieprawidłowa oferta"}), 400
    if body.get("moneyGive") or body.get("moneyWant"):
        return jsonify({"error": TRADE_NO_MONEY}), 400
    if not (give_ids or want):
        return jsonify({"error": "Oferta jest pusta"}), 400
    if not give_ids or not want:
        return jsonify({"error": "Coś dajesz i coś chcesz w zamian — obie strony muszą mieć karty"}), 400
    if len(give_ids) + len(want) > TRADE_MAX_LINES:
        return jsonify({"error": "Oferta jest za duża"}), 400
    rows = owned_rows(give_ids)
    if rows is None:
        return jsonify({"error": "Nie masz wszystkich kart, które chcesz dać"}), 400
    for w in want:
        if w["person"] not in catalog.PEOPLE or w["variant"] not in VARIANTS or not 1 <= w["count"] <= 100:
            return jsonify({"error": "Nieprawidłowa karta w ofercie"}), 400
        if pick_want_items(other["id"], w["person"], w["variant"], w["count"]) is None:
            return jsonify({"error": f"{other['username']} nie ma tylu kart: {catalog.PEOPLE[w['person']]['name']}"}), 400
    now = time.time()
    tid = db().execute("INSERT INTO trades (from_id, to_id, message, money_give, money_want, created_at, updated_at) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                       (me, other["id"], (body.get("message") or "").strip()[:140], 0, 0, now, now)
                       ).fetchone()[0]
    for r in rows:
        db().execute("INSERT INTO trade_lines (trade_id, side, item_id, person_id, variant, count) VALUES (?, 'give', ?, ?, ?, 1)",
                     (tid, r["id"], r["person_id"], r["variant"]))
    for w in want:
        db().execute("INSERT INTO trade_lines (trade_id, side, item_id, person_id, variant, count) VALUES (?, 'want', NULL, ?, ?, ?)",
                     (tid, w["person"], w["variant"], w["count"]))
    db().commit()
    return jsonify({"ok": True, "id": tid})


def get_trade(tid):
    return db().execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone()


@app.post("/api/trades/<int:tid>/accept")
@login_required
def trade_accept(tid):
    t = get_trade(tid)
    me = uid()
    if t is not None:  # blokujemy obie strony wymiany, potem czytamy świeży stan oferty
        db().lock_users(t["from_id"], t["to_id"])
        t = get_trade(tid)
    if t is None or t["to_id"] != me or t["status"] != "pending":
        return jsonify({"error": "Tej oferty nie można już przyjąć"}), 400
    problem = trade_problem(t)
    if problem:
        return jsonify({"error": problem}), 400
    conn = db()
    give = [r[0] for r in conn.execute("SELECT item_id FROM trade_lines WHERE trade_id = ? AND side = 'give'", (tid,))]
    want = []
    for r in conn.execute("SELECT * FROM trade_lines WHERE trade_id = ? AND side = 'want'", (tid,)).fetchall():
        want += pick_want_items(t["to_id"], r["person_id"], r["variant"], r["count"])
    moved = give + want
    if give:
        marks = ",".join("?" * len(give))
        # nowy właściciel dostaje kartę bez gwiazdki
        conn.execute(f"UPDATE items SET user_id = ?, favorite = 0 WHERE id IN ({marks})", [t["to_id"], *give])
    if want:
        marks = ",".join("?" * len(want))
        conn.execute(f"UPDATE items SET user_id = ?, favorite = 0 WHERE id IN ({marks})", [t["from_id"], *want])
    if moved:
        marks = ",".join("?" * len(moved))
        conn.execute(f"DELETE FROM showcase WHERE item_id IN ({marks})", moved)
    # tajne karty, które ktoś dostał w wymianie, są dla niego odkryte
    for item_ids, user_id in ((give, t["to_id"]), (want, t["from_id"])):
        for item_id in item_ids:
            pid, var = conn.execute("SELECT person_id, variant FROM items WHERE id = ?", (item_id,)).fetchone()
            note_collected(user_id, pid, var, "trade")
            if catalog.PEOPLE.get(pid, {}).get("rarity") == "secret":
                conn.execute("INSERT INTO user_discovered (user_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING", (user_id, pid))
    conn.execute("UPDATE trades SET status = 'accepted', updated_at = ? WHERE id = ?", (time.time(), tid))
    conn.commit()
    return jsonify({"ok": True, "state": get_state(), "items": my_items(), "showcase": showcase_ids(me)})


@app.post("/api/trades/<int:tid>/<action>")
@login_required
def trade_close(tid, action):
    lock_me()
    t = get_trade(tid)
    me = uid()
    if t is None or t["status"] != "pending" or action not in ("decline", "cancel"):
        return jsonify({"error": "Nieprawidłowa operacja"}), 400
    if (action == "decline" and t["to_id"] != me) or (action == "cancel" and t["from_id"] != me):
        return jsonify({"error": "To nie twoja oferta"}), 403
    db().execute("UPDATE trades SET status = ?, updated_at = ? WHERE id = ?",
                 ("declined" if action == "decline" else "cancelled", time.time(), tid))
    db().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- profile, gablota, ranking

def showcase_ids(user_id):
    rows = db().execute("""SELECT s.item_id FROM showcase s JOIN items i ON i.id = s.item_id AND i.user_id = s.user_id
                           WHERE s.user_id = ? ORDER BY s.pos""", (user_id,))
    return [r[0] for r in rows]


@app.post("/api/showcase")
@login_required
def set_showcase():
    lock_me()
    ids = [int(i) for i in request.get_json(force=True).get("ids", [])][:SHOWCASE_SIZE]
    if ids and owned_rows(ids) is None:
        return jsonify({"error": "Nie masz tych kart"}), 400
    db().execute("DELETE FROM showcase WHERE user_id = ?", (uid(),))
    for pos, item_id in enumerate(ids):
        db().execute("INSERT INTO showcase (user_id, pos, item_id) VALUES (?, ?, ?)", (uid(), pos, item_id))
    db().commit()
    return jsonify({"ok": True, "showcase": ids})


@app.post("/api/profile")
@login_required
def set_profile():
    lock_me()
    body = request.get_json(force=True)
    if "avatarCard" in body:  # ikona ze zdjęcia karty - tylko z kart, które gracz ma (żadnych własnych plików)
        pid = body.get("avatarCard") or ""
        variant = body.get("avatarVariant") or "normal"
        if variant not in VARIANTS:
            return jsonify({"error": "Nieznany wariant"}), 400
        if pid and (pid not in catalog.PEOPLE or db().execute(
                "SELECT 1 FROM items WHERE user_id = ? AND person_id = ? AND variant = ? LIMIT 1",
                (uid(), pid, variant)).fetchone() is None):
            return jsonify({"error": "Możesz ustawić tylko kartę (w wariancie), którą masz"}), 400
        db().execute("UPDATE users SET avatar_card = ?, avatar_variant = ? WHERE id = ?", (pid, variant, uid()))
    if "avatar" in body:
        avatar = (body.get("avatar") or "").strip()
        if not 1 <= len(avatar) <= 8:
            return jsonify({"error": "Nieprawidłowy awatar"}), 400
        db().execute("UPDATE users SET avatar = ?, avatar_card = '' WHERE id = ?", (avatar, uid()))
    db().commit()
    return jsonify({"ok": True, "user": user_json(db().execute("SELECT * FROM users WHERE id = ?", (uid(),)).fetchone())})


@app.route("/avatar/<name>")
@login_required
def avatar_image(name):
    u = find_user(name)
    pid = avatar_card(u) if u else None
    if pid is None:
        return "", 404
    p = catalog.PEOPLE[pid]
    # tajna karta jako ikona: widzą ją tylko ci, którzy ją odkryli, sam gracz i jego znajomi
    if p["rarity"] == "secret" and pid not in discovered() and u["id"] != uid() and u["id"] not in friend_ids(uid()):
        return svg_response(MYSTERY_SVG)
    path = images.web_version(images.ensure(pid), thumb=True)   # ikona gracza jest mała - wystarczy miniatura
    if not path:
        return "", 404
    resp = send_file(path, mimetype=images.mimetype(path), max_age=300)
    resp.headers["Cache-Control"] = "private, max-age=300"
    return resp


@app.get("/api/users/<name>")
@login_required
def profile(name):
    u = find_user(name)
    if u is None:
        return jsonify({"error": "Nie ma takiego gracza"}), 404
    st = get_state(u["id"])
    stats = collection_stats()
    collection = [{"person": r[0], "variant": r[1], "count": r[2]} for r in db().execute(
        "SELECT person_id, variant, COUNT(*) FROM items WHERE user_id = ? GROUP BY person_id, variant", (u["id"],))
        if r[0] in catalog.PEOPLE]
    show = []
    for item_id in showcase_ids(u["id"]):
        r = db().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        it = item_json(r)
        if it:
            show.append(it)
    rel = relation(uid(), u["id"])
    collected = collected_list(u["id"])
    # tajne karty znajomego widać na jego profilu, nawet jeśli samemu się ich jeszcze nie odkryło
    reveal = {}
    if rel == "friend":
        found = discovered()
        for pid in {c["person"] for c in collection} | {c[0] for c in collected}:
            p = catalog.PEOPLE[pid]
            if p["rarity"] == "secret" and p["id"] not in found:
                reveal[p["id"]] = public_person(p, {p["id"]})
    return jsonify({
        "user": brief(u, stats) | {"created": u["created_at"]},
        "relation": rel,
        "reveal": reveal,
        "stats": {"opened": st.get("opened", 0), "contracts": st.get("contracts", 0),
                  "upgradesWon": st.get("upgrades_won", 0), "upgradesLost": st.get("upgrades_lost", 0)},
        "collection": collection,
        "collected": collected,
        "showcase": show,
    })


@app.get("/api/ranking")
@login_required
def ranking():
    stats = collection_stats()
    opened = {r[0]: r[1] for r in db().execute("SELECT user_id, value FROM user_state WHERE key = 'opened'")}
    friends_of_me = friend_ids(uid())
    players = []
    # bez zablokowanych, ukrytych przez admina i tych, którzy dostali pieniądze / skrzynki od admina
    for u in db().execute("SELECT * FROM users WHERE banned = 0 AND ranking_hidden = 0 AND money_generated = 0"):
        b = brief(u, stats)
        b["opened"] = opened.get(u["id"], 0)
        b["friend"] = u["id"] in friends_of_me
        b["me"] = u["id"] == uid()
        players.append(b)
    total_cards = len(catalog.PEOPLE)
    accounts = db().execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return jsonify({"players": players, "totalCards": total_cards, "online": online_count(), "accounts": accounts})


@app.get("/api/me")
@login_required
def me():
    settle_market()   # sprawdzane co 30 s przez każdego gracza w grze - licytacje kończą się na czas
    u = current_user()
    me_id = u["id"]
    incoming = db().execute("SELECT COUNT(*) FROM friendships WHERE addressee_id = ? AND status = 'pending'",
                            (me_id,)).fetchone()[0]
    params = {"me": me_id}
    unread = db().execute(f"SELECT COUNT(*) {visible_feed_sql()} AND f.author_id != :me AND f.id > :seen",
                          dict(params, seen=get_state()["feed_seen"])).fetchone()[0]
    trades_in = db().execute("SELECT COUNT(*) FROM trades WHERE to_id = ? AND status = 'pending'", (me_id,)).fetchone()[0]
    st = get_state()
    seen = st["patch_seen"]
    # "odcisk" ekwipunku i saldo: przeglądarka porównuje je ze swoimi i pobiera świeży ekwipunek, gdy coś zmieniło się
    # bez jej udziału (wygrana w jackpocie, wygrana licytacja, sprzedaż na rynku, przyjęta wymiana)
    inv = db().execute("SELECT COUNT(*), COALESCE(SUM(id), 0) FROM items WHERE user_id = ?", (me_id,)).fetchone()
    lobby = my_lobby(me_id)
    invites = db().execute("SELECT COUNT(*) FROM jackpots j JOIN jackpot_invites i ON i.jackpot_id = j.id WHERE i.user_id = ? "
                           "AND j.status = 'open' AND j.joiner_id IS NULL AND j.creator_id != ?", (me_id, me_id)).fetchone()[0]
    return jsonify({"user": user_json(u), "dailyClaimable": daily_info(me_id)["claimable"],
                    "incoming": incoming, "unread": unread, "trades": trades_in, "market": market_badge(me_id),
                    "inv": [inv[0], inv[1]], "balance": st["balance"],
                    "jackpot": jackpot_news(me_id, st["jackpot_seen"]),   # wynik gry w jackpot, którego jeszcze nie widział
                    "jackpotLobby": lobby["id"] if lobby else None, "jackpotInvites": invites,
                    "patchNotes": [n for n in PATCH_NOTES if n["v"] > seen][:3],  # nowości od ostatniej wizyty
                    "messages": active_messages(me_id)})   # wiadomości od adminów, których jeszcze nie widział


def active_messages(user_id):
    """Wiadomości od adminów, które gracz ma teraz zobaczyć: trwa ich czas (starts_at - ends_at) i jeszcze ich nie widział."""
    now = time.time()
    rows = db().execute("SELECT * FROM admin_messages m WHERE starts_at <= ? AND ends_at > ? AND NOT EXISTS "
                        "(SELECT 1 FROM admin_message_seen s WHERE s.message_id = m.id AND s.user_id = ?) ORDER BY starts_at",
                        (now, now, user_id)).fetchall()
    return [{"id": r["id"], "title": r["title"], "body": r["body"], "at": r["starts_at"]} for r in rows]


@app.post("/api/messages/seen")
@login_required
def messages_seen():
    """Gracz zobaczył wiadomości od adminów - w tym czasie już mu się nie pokażą."""
    for mid in (request.get_json(force=True) or {}).get("ids") or []:
        if isinstance(mid, int) and db().execute("SELECT 1 FROM admin_messages WHERE id = ?", (mid,)).fetchone():
            db().execute("INSERT INTO admin_message_seen (message_id, user_id, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                         (mid, uid(), time.time()))
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/halloffame")
@login_required
def hall_of_fame():
    """Hall of Fame: dla każdej karty i wariantu - kto pierwszy ją zdobył, kiedy, skąd i ile ich wypadło."""
    rows = [r for r in db().execute("SELECT * FROM hall_of_fame") if r["person_id"] in catalog.PEOPLE]
    all_users = {u["id"]: u for u in db().execute("SELECT * FROM users")}
    hidden = {i for i, u in all_users.items() if hidden_from_ranking(u)}
    out = []
    for r in rows:
        first = (r["first_user_id"], r["first_at"], r["source"])
        if r["first_user_id"] in hidden:   # gracz poza rankingiem - pokazujemy pierwszego widocznego (albo nikogo)
            first = hof_first(r["person_id"], r["variant"], hidden) or (None, r["first_at"], r["source"])
        out.append({"p": r["person_id"], "v": r["variant"], "u": first[0], "t": first[1], "s": first[2], "n": r["drops"]})
    ids = {r["u"] for r in out if r["u"]}
    return jsonify({"rows": out, "users": {i: user_json(u) for i, u in all_users.items() if i in ids}})


def hof_first(person_id, variant, hidden=None):
    """Pierwszy widoczny gracz (nie ukryty w rankingu), który zdobył tę kartę z dropu, kontraktu albo ulepszacza:
    (id, kiedy, skąd) albo None. Starsze wpisy bez źródła też się liczą (nieznane źródło = skrzynka)."""
    if hidden is None:
        hidden = {u["id"] for u in db().execute("SELECT * FROM users") if hidden_from_ranking(u)}
    for c in db().execute("SELECT user_id, at, source FROM user_collected WHERE person_id = ? AND variant = ? AND at IS NOT NULL "
                          "AND (source IS NULL OR source IN ('drop', 'contract', 'upgrade', 'joker', 'link')) ORDER BY at",
                          (person_id, variant)).fetchall():
        if c["user_id"] not in hidden:
            return c["user_id"], c["at"], c["source"] or "drop"
    return None


@app.get("/api/patchnotes")
@login_required
def patch_notes():
    return jsonify({"notes": PATCH_NOTES})


@app.post("/api/patchnotes/seen")
@login_required
def patch_notes_seen():
    set_state("patch_seen", PATCH_NOTES[0]["v"])
    db().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- karty w transakcjach (rynek, kasyno)
# Karta wystawiona na rynek albo postawiona w jackpocie należy do ESCROW (user_id = 0), aż transakcja się skończy -
# wtedy nie da się jej sprzedać, zużyć w kuźni ani dać w wymianie. Pieniądze z ofert kupna, licytacji i zleceń
# "Szukam" są od razu zabierane kupującemu (i oddawane, gdy oferta przepada), więc zawarta transakcja zawsze się uda.

def take_my_items(ids, stake=False):
    """(wiersze moich kart, None) albo (None, komunikat błędu) - karty muszą być moje i bez gwiazdki.
    stake: karty stawiane w kasynie (mogą przepaść) - bez kart specjalnych."""
    rows = owned_rows(ids)
    if rows is None:
        return None, "Nie masz tych kart"
    if any(r["favorite"] for r in rows):
        return None, FAV_ERROR
    if stake and any(catalog.is_special(catalog.PEOPLE[r["person_id"]]) for r in rows):
        return None, SPECIAL_ERROR
    return rows, None


def escrow_items(ids):
    marks = ",".join("?" * len(ids))
    db().execute(f"UPDATE items SET user_id = ?, favorite = 0 WHERE user_id = ? AND id IN ({marks})", [ESCROW, uid(), *ids])
    db().execute(f"DELETE FROM showcase WHERE item_id IN ({marks})", ids)


def give_items(item_ids, user_id):
    """Karty przechodzą do gracza: bez gwiazdki, poza gablotą, trafiają do klasera, tajne są od razu odkryte."""
    if not item_ids:
        return
    marks = ",".join("?" * len(item_ids))
    db().execute(f"UPDATE items SET user_id = ?, favorite = 0 WHERE id IN ({marks})", [user_id, *item_ids])
    db().execute(f"DELETE FROM showcase WHERE item_id IN ({marks})", item_ids)
    for r in db().execute(f"SELECT person_id, variant FROM items WHERE id IN ({marks})", item_ids).fetchall():
        note_collected(user_id, r[0], r[1])
        if catalog.PEOPLE.get(r[0], {}).get("rarity") == "secret":
            db().execute("INSERT INTO user_discovered (user_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                         (user_id, r[0]))


def users_by_id(ids):
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    return {u["id"]: user_json(u) for u in db().execute(f"SELECT * FROM users WHERE id IN ({marks})", ids)}


def card_json(person_id, variant, found):
    """Karta w ofercie rynku / na stole jackpota (tajną kartę widać, nawet jeśli jej jeszcze nie odkryłem)."""
    p = catalog.PEOPLE[person_id]
    out = {"person": person_id, "variant": variant if variant in VARIANTS else "normal", "value": card_value(p, variant)}
    if p["rarity"] == "secret" and person_id not in found:
        out["reveal"] = public_person(p, {person_id})
    return out


def bad(msg, code=400):
    """Błąd w trakcie zmian: cofamy wszystko, co ta transakcja zdążyła zmienić."""
    db().rollback()
    return jsonify({"error": msg}), code


# ---------------------------------------------------------------- rynek kart

MARKET_GONE = "Ta oferta jest już nieaktualna"


def market_price(raw, lo=1):
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return None
    return v if lo <= v <= MARKET["maxPrice"] else None


def price_error():
    return f"Cena: od 1 do {MARKET['maxPrice']:,} gr".replace(",", " ")


def after_fee(price):
    return price - int(price * MARKET["fee"])


def get_listing(lid):
    return db().execute("SELECT * FROM market_listings WHERE id = ?", (lid,)).fetchone()


def claim_listing(lid, extra="", params=()):
    """Blokuje ofertę do końca transakcji (PostgreSQL: blokada wiersza; SQLite: i tak jeden zapisujący naraz).
    Zwraca świeży wiersz albo None, jeśli oferta nie jest już aktywna (albo nie spełnia warunku extra)."""
    cur = db().execute(f"UPDATE market_listings SET updated_at = ? WHERE id = ? AND status = 'active' {extra}",
                       (time.time(), lid, *params))
    return get_listing(lid) if cur.rowcount else None


def top_bid(lid):
    return db().execute("SELECT * FROM market_bids WHERE listing_id = ? AND status = 'active' "
                        "ORDER BY amount DESC, id LIMIT 1", (lid,)).fetchone()


def refund_offers(lid, now, status="lost"):
    """Propozycje cen do tej oferty przepadają - pieniądze wracają do kupujących."""
    for o in db().execute("SELECT * FROM market_offers WHERE listing_id = ? AND status = 'pending'", (lid,)).fetchall():
        cur = db().execute("UPDATE market_offers SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
                           (status, now, o["id"]))
        if cur.rowcount:
            add_state("balance", o["price"], o["buyer_id"])


def settle_market():
    """Koniec licytacji i porzucone lobby jackpota. Nie ma osobnego zegara - sprawdzamy przy zapytaniach graczy
    (rynek, kasyno i /api/me, które każdy otwarty ekran gry odpytuje co 30 s)."""
    now = time.time()
    ended = [r[0] for r in db().execute("SELECT id FROM market_listings WHERE status = 'active' AND kind = 'auction' "
                                        "AND ends_at <= ?", (now,))]
    old = [r[0] for r in db().execute("SELECT id FROM jackpots WHERE status = 'open' AND COALESCE(updated_at, created_at) <= ?",
                                      (now - JACKPOT["expireHours"] * 3600,))]
    if not ended and not old:
        return
    for lid in ended:
        L = claim_listing(lid, "AND ends_at <= ?", (now,))
        if L is None:
            continue
        top = top_bid(lid)
        if top:   # karta dla najwyższej oferty, pieniądze dla sprzedającego
            db().execute("UPDATE market_listings SET status = 'sold', buyer_id = ?, final_price = ?, updated_at = ? "
                         "WHERE id = ?", (top["bidder_id"], top["amount"], now, lid))
            db().execute("UPDATE market_bids SET status = 'won', updated_at = ? WHERE id = ?", (now, top["id"]))
            give_items([L["item_id"]], top["bidder_id"])
            add_state("balance", after_fee(top["amount"]), L["seller_id"])
        else:     # nikt nie licytował - karta wraca
            db().execute("UPDATE market_listings SET status = 'expired', updated_at = ? WHERE id = ?", (now, lid))
            give_items([L["item_id"]], L["seller_id"])
    for jid in old:   # karty w lobby nie są blokowane - wystarczy zamknąć lobby
        db().execute("UPDATE jackpots SET status = 'expired', finished_at = ? WHERE id = ? AND status = 'open'", (now, jid))
    db().commit()


def market_badge(me):
    """Znaczek na zakładce Rynek: propozycje cen do moich ofert + nowości od ostatniej wizyty (sprzedane, kupione,
    przebite, odrzucone, zrealizowane zlecenia)."""
    seen = get_state(me)["market_seen"]
    q = lambda sql, *p: db().execute(sql, p).fetchone()[0]
    return (q("SELECT COUNT(*) FROM market_offers o JOIN market_listings l ON l.id = o.listing_id "
              "WHERE l.seller_id = ? AND l.status = 'active' AND o.status = 'pending'", me)
            + q("SELECT COUNT(*) FROM market_listings WHERE status IN ('sold', 'expired') AND updated_at > ? "
                "AND (seller_id = ? OR buyer_id = ?)", seen, me, me)
            + q("SELECT COUNT(*) FROM market_wanted WHERE status = 'filled' AND buyer_id = ? AND updated_at > ?", me, seen)
            + q("SELECT COUNT(*) FROM market_offers WHERE buyer_id = ? AND status IN ('declined', 'lost') "
                "AND updated_at > ?", me, seen)
            + q("SELECT COUNT(*) FROM market_bids WHERE bidder_id = ? AND status = 'outbid' AND updated_at > ?", me, seen))


def market_shows(lid, person_id):
    """Tajna karta w ofercie na rynku - jej zdjęcie widać (aktywna oferta albo moja transakcja)."""
    try:
        L = get_listing(int(lid))
    except (TypeError, ValueError):
        return False
    return bool(L and L["person_id"] == person_id and (L["status"] == "active" or uid() in (L["seller_id"], L["buyer_id"])))


@app.get("/api/market")
@login_required
def market():
    settle_market()
    me, now, found = uid(), time.time(), discovered()
    listings = [r for r in db().execute("SELECT * FROM market_listings WHERE status = 'active' ORDER BY id DESC LIMIT 1000")
                if r["person_id"] in catalog.PEOPLE]
    history = [r for r in db().execute("SELECT * FROM market_listings WHERE status != 'active' AND (seller_id = ? OR "
                                       "buyer_id = ?) ORDER BY updated_at DESC LIMIT 40", (me, me))
               if r["person_id"] in catalog.PEOPLE]
    wanted = [r for r in db().execute("SELECT * FROM market_wanted WHERE status = 'active' ORDER BY id DESC LIMIT 500")
              if r["person_id"] in catalog.PEOPLE]
    filled = [r for r in db().execute("SELECT * FROM market_wanted WHERE status = 'filled' AND (buyer_id = ? OR seller_id = ?) "
                                      "ORDER BY updated_at DESC LIMIT 20", (me, me)) if r["person_id"] in catalog.PEOPLE]
    my_offers = db().execute("SELECT o.*, l.person_id, l.variant, l.price AS list_price, l.seller_id, l.status AS list_status "
                             "FROM market_offers o JOIN market_listings l ON l.id = o.listing_id WHERE o.buyer_id = ? "
                             "AND (o.status = 'pending' OR o.updated_at > ?) ORDER BY o.id DESC LIMIT 40",
                             (me, now - 7 * 86400)).fetchall()
    lids = [r["id"] for r in listings]
    tops, counts, offers = {}, {}, {}
    for chunk in (lids[i:i + 500] for i in range(0, len(lids), 500)):
        marks = ",".join("?" * len(chunk))
        for b in db().execute(f"SELECT * FROM market_bids WHERE status = 'active' AND listing_id IN ({marks})", chunk):
            if b["listing_id"] not in tops or b["amount"] > tops[b["listing_id"]]["amount"]:
                tops[b["listing_id"]] = b
        for r in db().execute(f"SELECT listing_id, COUNT(*) FROM market_bids WHERE listing_id IN ({marks}) "
                              f"GROUP BY listing_id", chunk):
            counts[r[0]] = r[1]
        for o in db().execute(f"SELECT * FROM market_offers WHERE status = 'pending' AND listing_id IN ({marks}) "
                              f"ORDER BY price DESC", chunk):
            offers.setdefault(o["listing_id"], []).append(o)
    users = users_by_id([r["seller_id"] for r in listings + history] + [r["buyer_id"] for r in history]
                        + [b["bidder_id"] for b in tops.values()] + [o["buyer_id"] for os_ in offers.values() for o in os_]
                        + [r["buyer_id"] for r in wanted + filled] + [r["seller_id"] for r in filled + list(my_offers)])

    def listing_json(r):
        top, mine = tops.get(r["id"]), r["seller_id"] == me
        own_offer = next((o for o in offers.get(r["id"], []) if o["buyer_id"] == me), None)
        return dict(card_json(r["person_id"], r["variant"], found), id=r["id"], kind=r["kind"], price=r["price"],
                    step=r["step"], endsAt=r["ends_at"], created=r["created_at"], seller=users.get(r["seller_id"]), mine=mine,
                    topBid=top["amount"] if top else None, topBidder=(users.get(top["bidder_id"]) or {}).get("username") if top else None,
                    myTop=bool(top and top["bidder_id"] == me), bids=counts.get(r["id"], 0),
                    offers=[{"id": o["id"], "price": o["price"], "buyer": users.get(o["buyer_id"]), "created": o["created_at"]}
                            for o in offers.get(r["id"], [])] if mine else [],
                    myOffer={"id": own_offer["id"], "price": own_offer["price"]} if own_offer else None)

    out = {
        "now": now,
        "listings": [listing_json(r) for r in listings],
        "wanted": [dict(card_json(r["person_id"], r["variant"], {r["person_id"]} if r["buyer_id"] == me else found),
                        id=r["id"], price=r["price"], created=r["created_at"], buyer=users.get(r["buyer_id"]),
                        mine=r["buyer_id"] == me) for r in wanted],
        "history": sorted(
            [dict(card_json(r["person_id"], r["variant"], found), id=r["id"], type=r["kind"], status=r["status"],
                  role="seller" if r["seller_id"] == me else "buyer", price=r["final_price"] or r["price"], at=r["updated_at"],
                  other=users.get(r["buyer_id"] if r["seller_id"] == me else r["seller_id"])) for r in history]
            + [dict(card_json(r["person_id"], r["variant"], found), id=r["id"], type="wanted", status="filled",
                    role="buyer" if r["buyer_id"] == me else "seller", price=r["price"], at=r["updated_at"],
                    other=users.get(r["seller_id"] if r["buyer_id"] == me else r["buyer_id"])) for r in filled],
            key=lambda h: -h["at"])[:50],
        "myOffers": [dict(card_json(o["person_id"], o["variant"], found), id=o["id"], listing=o["listing_id"], price=o["price"],
                          listPrice=o["list_price"], status=o["status"], at=o["updated_at"], seller=users.get(o["seller_id"]))
                     for o in my_offers if o["person_id"] in catalog.PEOPLE],
    }
    set_state("market_seen", int(now))
    db().commit()
    return jsonify(out)


@app.post("/api/market/list")
@login_required
def market_list():
    """Wystawienie karty: kind = fixed (stała cena) albo auction (licytacja: cena wywoławcza, min. przebicie, czas)."""
    settle_market()
    lock_me()
    body = request.get_json(force=True)
    kind = body.get("kind")
    try:
        item_id = int(body.get("item"))
    except (TypeError, ValueError):
        return bad("Wybierz kartę")
    if kind not in ("fixed", "auction"):
        return bad("Nieprawidłowy rodzaj oferty")
    rows, err = take_my_items([item_id])
    if err:
        return bad(err)
    price = market_price(body.get("price"))
    if price is None:
        return bad(price_error())
    now, step, ends = time.time(), 0, None
    if kind == "auction":
        step = market_price(body.get("step") or 1)
        if step is None:
            return bad("Minimalne przebicie: od 1 $")
        try:
            hours = int(body.get("hours") or 24)
        except (TypeError, ValueError):
            hours = 0
        if hours not in MARKET["auctionHours"]:
            return bad("Nieprawidłowy czas licytacji")
        ends = now + hours * 3600
    active = db().execute("SELECT COUNT(*) FROM market_listings WHERE seller_id = ? AND status = 'active'",
                          (uid(),)).fetchone()[0]
    if active >= MARKET["maxListings"]:
        return bad(f"Możesz mieć najwyżej {MARKET['maxListings']} ofert naraz")
    r = rows[0]
    escrow_items([item_id])
    lid = db().execute("INSERT INTO market_listings (seller_id, item_id, person_id, variant, kind, price, step, created_at, "
                       "ends_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                       (uid(), item_id, r["person_id"], r["variant"], kind, price, step, now, ends, now)).fetchone()[0]
    db().commit()
    return jsonify({"ok": True, "id": lid, "consumed": [item_id]})


@app.post("/api/market/<int:lid>/buy")
@login_required
def market_buy(lid):
    settle_market()
    lock_me()
    L = claim_listing(lid, "AND kind = 'fixed'")
    if L is None or L["person_id"] not in catalog.PEOPLE:
        return bad(MARKET_GONE)
    if L["seller_id"] == uid():
        return bad("To twoja oferta")
    if get_state()["balance"] < L["price"]:
        return bad("Za mało pieniędzy!")
    now = time.time()
    db().execute("UPDATE market_listings SET status = 'sold', buyer_id = ?, final_price = ?, updated_at = ? WHERE id = ?",
                 (uid(), L["price"], now, lid))
    add_state("balance", -L["price"])
    add_state("balance", after_fee(L["price"]), L["seller_id"])
    give_items([L["item_id"]], uid())
    refund_offers(lid, now)
    db().commit()
    item = item_json(db().execute("SELECT * FROM items WHERE id = ?", (L["item_id"],)).fetchone())
    return jsonify({"ok": True, "item": item, "state": get_state()})


@app.post("/api/market/<int:lid>/offer")
@login_required
def market_offer(lid):
    """Propozycja niższej ceny - pieniądze są od razu blokowane; sprzedający może ją przyjąć albo odrzucić."""
    settle_market()
    lock_me()
    price = market_price(request.get_json(force=True).get("price"))
    L = claim_listing(lid, "AND kind = 'fixed'")
    if L is None or L["person_id"] not in catalog.PEOPLE:
        return bad(MARKET_GONE)
    if L["seller_id"] == uid():
        return bad("To twoja oferta")
    if price is None or price >= L["price"]:
        return bad(f"Zaproponuj cenę niższą niż {fmt_money(L['price'])} (albo po prostu kup kartę)")
    now = time.time()
    old = db().execute("SELECT * FROM market_offers WHERE listing_id = ? AND buyer_id = ? AND status = 'pending'",
                       (lid, uid())).fetchone()
    if get_state()["balance"] + (old["price"] if old else 0) < price:
        return bad("Za mało pieniędzy!")
    if old:   # nowa propozycja zastępuje poprzednią
        db().execute("UPDATE market_offers SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, old["id"]))
        add_state("balance", old["price"])
    add_state("balance", -price)
    db().execute("INSERT INTO market_offers (listing_id, buyer_id, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                 (lid, uid(), price, now, now))
    db().commit()
    return jsonify({"ok": True, "state": get_state()})


@app.post("/api/market/offers/<int:oid>/<any(accept, decline, cancel):action>")
@login_required
def market_offer_action(oid, action):
    """accept / decline - sprzedający; cancel - kupujący wycofuje swoją propozycję."""
    settle_market()
    lock_me()
    me, now = uid(), time.time()
    O = db().execute("SELECT * FROM market_offers WHERE id = ?", (oid,)).fetchone()
    L = get_listing(O["listing_id"]) if O else None
    if O is None or L is None or O["status"] != "pending":
        return bad(MARKET_GONE)
    if action == "cancel":
        if O["buyer_id"] != me:
            return bad("To nie twoja propozycja", 403)
        if db().execute("UPDATE market_offers SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'",
                        (now, oid)).rowcount:
            add_state("balance", O["price"])
    elif L["seller_id"] != me:
        return bad("To nie twoja oferta", 403)
    elif action == "decline":
        if db().execute("UPDATE market_offers SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'pending'",
                        (now, oid)).rowcount:
            add_state("balance", O["price"], O["buyer_id"])
    else:
        L = claim_listing(L["id"])
        if L is None or L["person_id"] not in catalog.PEOPLE:
            return bad(MARKET_GONE)
        if not db().execute("UPDATE market_offers SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'pending'",
                            (now, oid)).rowcount:
            return bad("Kupujący wycofał już tę propozycję")
        db().execute("UPDATE market_listings SET status = 'sold', buyer_id = ?, final_price = ?, updated_at = ? WHERE id = ?",
                     (O["buyer_id"], O["price"], now, L["id"]))
        add_state("balance", after_fee(O["price"]))
        give_items([L["item_id"]], O["buyer_id"])
        refund_offers(L["id"], now)
    db().commit()
    return jsonify({"ok": True, "state": get_state()})


@app.post("/api/market/<int:lid>/bid")
@login_required
def market_bid(lid):
    settle_market()
    lock_me()
    now = time.time()
    amount = market_price(request.get_json(force=True).get("amount"))
    L = claim_listing(lid, "AND kind = 'auction' AND ends_at > ?", (now,))
    if L is None or L["person_id"] not in catalog.PEOPLE:
        return bad("Ta licytacja już się skończyła")
    if L["seller_id"] == uid():
        return bad("Nie możesz licytować własnej karty")
    top = top_bid(lid)
    if top and top["bidder_id"] == uid():
        return bad("Twoja oferta jest już najwyższa")
    need = top["amount"] + max(1, L["step"]) if top else L["price"]
    if amount is None or amount < need:
        return bad(f"Najmniejsza możliwa oferta: {fmt_money(need)}")
    if get_state()["balance"] < amount:
        return bad("Za mało pieniędzy!")
    add_state("balance", -amount)
    db().execute("INSERT INTO market_bids (listing_id, bidder_id, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                 (lid, uid(), amount, now, now))
    if top:   # przebity gracz dostaje pieniądze z powrotem
        db().execute("UPDATE market_bids SET status = 'outbid', updated_at = ? WHERE id = ?", (now, top["id"]))
        add_state("balance", top["amount"], top["bidder_id"])
    if L["ends_at"] - now < MARKET["snipeSeconds"]:
        db().execute("UPDATE market_listings SET ends_at = ? WHERE id = ?", (now + MARKET["snipeSeconds"], lid))
    db().commit()
    return jsonify({"ok": True, "state": get_state()})


@app.post("/api/market/<int:lid>/cancel")
@login_required
def market_cancel(lid):
    """Wycofanie mojej oferty - karta wraca do ekwipunku (licytacji, w której ktoś już licytuje, nie da się wycofać)."""
    settle_market()
    lock_me()
    L = claim_listing(lid, "AND seller_id = ?", (uid(),))
    if L is None:
        return bad(MARKET_GONE)
    if top_bid(lid):
        return bad("Ktoś już licytuje — tej licytacji nie można wycofać")
    now = time.time()
    db().execute("UPDATE market_listings SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, lid))
    give_items([L["item_id"]], uid())
    refund_offers(lid, now)
    db().commit()
    item = item_json(db().execute("SELECT * FROM items WHERE id = ?", (L["item_id"],)).fetchone())
    return jsonify({"ok": True, "item": item})


@app.post("/api/market/wanted")
@login_required
def market_wanted_create():
    """Zlecenie "Szukam": kupię tę kartę (w tym wariancie) za tyle - pieniądze są blokowane do realizacji / wycofania."""
    settle_market()
    lock_me()
    body = request.get_json(force=True)
    p = catalog.PEOPLE.get(body.get("person"))
    variant = body.get("variant") or "normal"
    if p is None or variant not in VARIANTS:
        return bad("Wybierz kartę")
    if variant not in catalog.possible_variants(p):   # np. Rzulty tylko dla Jana Pawła II, Królewska tylko ze Skrzyni Królów
        return bad("Ta karta nie występuje w tym wariancie")
    if p["rarity"] == "secret" and p["id"] not in discovered():
        return bad("Tej tajnej karty jeszcze nie znasz")
    price = market_price(body.get("price"))
    if price is None:
        return bad(price_error())
    active = db().execute("SELECT COUNT(*) FROM market_wanted WHERE buyer_id = ? AND status = 'active'", (uid(),)).fetchone()[0]
    if active >= MARKET["maxWanted"]:
        return bad(f"Możesz mieć najwyżej {MARKET['maxWanted']} zleceń naraz")
    if get_state()["balance"] < price:
        return bad("Za mało pieniędzy!")
    now = time.time()
    add_state("balance", -price)
    db().execute("INSERT INTO market_wanted (buyer_id, person_id, variant, price, created_at, updated_at) "
                 "VALUES (?, ?, ?, ?, ?, ?)", (uid(), p["id"], variant, price, now, now))
    db().commit()
    return jsonify({"ok": True, "state": get_state()})


@app.post("/api/market/wanted/<int:wid>/cancel")
@login_required
def market_wanted_cancel(wid):
    settle_market()
    lock_me()
    W = db().execute("SELECT * FROM market_wanted WHERE id = ? AND buyer_id = ?", (wid, uid())).fetchone()
    if W is None or not db().execute("UPDATE market_wanted SET status = 'cancelled', updated_at = ? WHERE id = ? "
                                     "AND status = 'active'", (time.time(), wid)).rowcount:
        return bad(MARKET_GONE)
    add_state("balance", W["price"])
    db().commit()
    return jsonify({"ok": True, "state": get_state()})


@app.post("/api/market/wanted/<int:wid>/fill")
@login_required
def market_wanted_fill(wid):
    """Sprzedaję moją kartę komuś, kto jej szuka - od razu, za cenę ze zlecenia."""
    settle_market()
    lock_me()
    try:
        item_id = int(request.get_json(force=True).get("item"))
    except (TypeError, ValueError):
        return bad("Wybierz kartę")
    W = db().execute("SELECT * FROM market_wanted WHERE id = ?", (wid,)).fetchone()
    if W is None or W["status"] != "active":
        return bad(MARKET_GONE)
    if W["buyer_id"] == uid():
        return bad("To twoje zlecenie")
    rows, err = take_my_items([item_id])
    if err:
        return bad(err)
    if rows[0]["person_id"] != W["person_id"] or rows[0]["variant"] != W["variant"]:
        return bad("Ta karta nie pasuje do zlecenia")
    if not db().execute("UPDATE market_wanted SET status = 'filled', seller_id = ?, updated_at = ? WHERE id = ? "
                        "AND status = 'active'", (uid(), time.time(), wid)).rowcount:
        return bad(MARKET_GONE)
    give_items([item_id], W["buyer_id"])
    add_state("balance", after_fee(W["price"]))
    db().commit()
    return jsonify({"ok": True, "consumed": [item_id], "state": get_state()})


def fmt_money(amount):
    return f"{amount:,} gr".replace(",", " ")


# ---------------------------------------------------------------- kasyno: ruletka

def house_cards(value):
    """Wygrana w kartach o łącznej wartości value: losowe karty ze skrzynek w sklepie (bez tajnych) w wariantach
    z CASINO_VARIANTS - za każdym razem jedna z najdroższych, które się mieszczą (CASINO_TOP).
    Zwraca ([(karta, wariant)], reszta w pieniądzach)."""
    pool = sorted(((card_value(p, v), p, v) for p in catalog.PEOPLE.values() if p.get("forge") and p["rarity"] != "secret"
                   for v in CASINO_VARIANTS if v == "normal" or catalog.variant_enabled(v)), key=lambda x: -x[0])
    out, left = [], value
    while len(out) < ROULETTE["maxPayoutCards"]:
        fit = [x for x in pool if x[0] <= left]
        if not fit:
            break
        price, p, v = rng.choice([x for x in fit if x[0] >= fit[0][0] * CASINO_TOP])
        out.append((p, v))
        left -= price
    return out, left


def casino_special_pool():
    """Karty specjalne, które wypadają w kasynie (pole karty "source" = casino, panel admina)."""
    return [p for p in catalog.PEOPLE.values() if catalog.is_special(p) and p["source"] == "casino"]


def casino_special_drop(payout):
    """Wygrana w grze kasyna, która daje nowe karty (ruletka, kolejne gry): z szansą wygrana / CASINO_SPECIAL["per"]
    (najwyżej "max") gracz dostaje dodatkowo kartę specjalną z kasyna - zawsze w jej jedynym wariancie (np. Jokerowa).
    Zwraca nową kartę albo None."""
    pool = casino_special_pool()
    if not pool or rng.random() >= min(CASINO_SPECIAL["max"], payout / CASINO_SPECIAL["per"]):
        return None
    p = rng.choice(pool)
    item = insert_item(p["id"], p["fixedVariant"], "joker")
    note_drops([item], "joker")
    return item


@app.post("/api/casino/roulette")
@login_required
def casino_roulette():
    lock_me()
    body = request.get_json(force=True)
    bet = body.get("bet")
    try:
        ids = [int(i) for i in body.get("ids") or []]
    except (TypeError, ValueError):
        ids = []
    if bet not in ROULETTE_BETS:
        return bad("Wybierz zakład na stole")
    if not 1 <= len(ids) <= ROULETTE["maxCards"]:
        return bad(f"Postaw od 1 do {ROULETTE['maxCards']} kart")
    rows, err = take_my_items(ids, stake=True)
    if err:
        return bad(err)
    stake = sum(row_value(r) for r in rows)
    _name, numbers, pays = ROULETTE_BETS[bet]
    number = rng.randrange(37)
    out = {"number": number, "win": number in numbers, "bet": bet, "stake": stake}
    if out["win"]:   # karty zostają u gracza + wygrana w kartach
        cards, money = house_cards(stake * pays)
        out["items"] = [insert_item(p["id"], v, "casino") for p, v in cards]
        out["money"] = money
        out["payout"] = stake * pays
        add_state("balance", money)
        note_drops(out["items"], "casino")
        out["special"] = casino_special_drop(out["payout"])   # karta specjalna z kasyna (Joker) albo None
    else:
        delete_items(ids)
        out["consumed"] = ids
    db().commit()
    out["state"] = get_state()
    return jsonify(out)


# ---------------------------------------------------------------- kasyno: blackjack
# Gracz przeciw krupierowi, stawką są karty (jak w ruletce), zasady w BLACKJACK (data.py). Rozdanie trwa kilka zapytań
# (dobierz / stój / podwój), więc czeka w blackjack_games, a postawione karty są w ESCROW - w tym czasie nie da się ich
# sprzedać ani zużyć. Z gabloty ich nie zdejmujemy: karta w ESCROW się w niej nie pokazuje, a po remisie albo wygranej
# wraca na swoje miejsce. Talię i zakrytą kartę krupiera zna tylko serwer.

BJ_RANKS, BJ_SUITS = "A23456789TJQK", "SHDC"   # T = dziesiątka; piki, kiery, kara, trefle
BJ_GONE = "To rozdanie już się skończyło"


def bj_total(hand):
    """(suma punktów, miękka?) - as liczy się za 11, dopóki suma nie przekracza 21."""
    total = sum(11 if c[0] == "A" else 10 if c[0] in "TJQK" else int(c[0]) for c in hand)
    aces = sum(c[0] == "A" for c in hand)
    while total > 21 and aces:
        total, aces = total - 10, aces - 1
    return total, aces > 0


def bj_blackjack(hand):
    return len(hand) == 2 and bj_total(hand)[0] == 21


def my_blackjack():
    return db().execute("SELECT * FROM blackjack_games WHERE user_id = ?", (uid(),)).fetchone()


def bj_hold(ids):
    """Postawione karty do ESCROW na czas rozdania."""
    marks = ",".join("?" * len(ids))
    db().execute(f"UPDATE items SET user_id = ? WHERE user_id = ? AND id IN ({marks})", [ESCROW, uid(), *ids])


def bj_cards(ids):
    """Postawione karty (w ESCROW) do pokazania przy stole."""
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    rows = db().execute(f"SELECT * FROM items WHERE user_id = ? AND id IN ({marks}) ORDER BY id DESC", [ESCROW, *ids])
    return [i for i in (item_json(r) for r in rows) if i]


def bj_json(G):
    """Rozdanie w trakcie dla przeglądarki - druga karta krupiera jest zakryta ("??")."""
    player = json.loads(G["player"])
    return {"player": player, "dealer": [json.loads(G["dealer"])[0], "??"],
            "stake": G["stake"], "doubleStake": G["double_stake"],
            "items": bj_cards(json.loads(G["item_ids"])), "doubleItems": bj_cards(json.loads(G["double_ids"])),
            "canDouble": len(player) == 2 and not G["double_stake"]}


def bj_end(G, player, dealer, deck):
    """Koniec rozdania: krupier dobiera (jeśli trzeba), rozliczenie kart i wygranej, rozdanie znika."""
    ids = json.loads(G["item_ids"]) + json.loads(G["double_ids"])
    stake = G["stake"] + G["double_stake"]
    total = bj_total(player)[0]
    if total <= 21 and not bj_blackjack(player) and not bj_blackjack(dealer):
        while bj_total(dealer)[0] < 17:   # krupier dobiera do 16 i staje na każdej 17
            dealer.append(deck.pop())
    dealer_total = bj_total(dealer)[0]
    if total > 21:
        result = "lose"
    elif bj_blackjack(player):
        result = "push" if bj_blackjack(dealer) else "blackjack"
    elif bj_blackjack(dealer) or total < dealer_total <= 21:
        result = "lose"
    else:
        result = "push" if total == dealer_total else "win"
    out = {"result": result, "player": player, "dealer": dealer, "stake": stake, "items": [], "money": 0, "special": None}
    marks = ",".join("?" * len(ids))
    if result == "lose":
        db().execute(f"DELETE FROM items WHERE user_id = ? AND id IN ({marks})", [ESCROW, *ids])
        db().execute(f"DELETE FROM showcase WHERE item_id IN ({marks})", ids)
    else:   # remis / wygrana - postawione karty wracają do gracza
        out["returned"] = bj_cards(ids)
        db().execute(f"UPDATE items SET user_id = ? WHERE user_id = ? AND id IN ({marks})", [uid(), ESCROW, *ids])
    if result in ("win", "blackjack"):   # + wygrana w kartach, jak w ruletce
        payout = int(stake * BLACKJACK["blackjackPays"]) if result == "blackjack" else stake
        cards, money = house_cards(payout)
        out["items"] = [insert_item(p["id"], v, "casino") for p, v in cards]
        out["money"], out["payout"] = money, payout
        add_state("balance", money)
        note_drops(out["items"], "blackjack")
        out["special"] = casino_special_drop(payout)   # karta specjalna z kasyna (Joker) albo None
    db().execute("DELETE FROM blackjack_games WHERE user_id = ?", (uid(),))
    db().commit()
    return jsonify({"game": None, "end": out, "state": get_state()})


def bj_load():
    """Moje rozdanie w trakcie: (wiersz, karty gracza, karty krupiera, talia) - jak argumenty bj_end - albo None."""
    G = my_blackjack()
    return G and (G, json.loads(G["player"]), json.loads(G["dealer"]), json.loads(G["deck"]))


def blackjack_forget_user(user_id):
    """Usuwany gracz: jego rozdanie znika razem z postawionymi kartami (są w ESCROW)."""
    G = db().execute("SELECT * FROM blackjack_games WHERE user_id = ?", (user_id,)).fetchone()
    if G is None:
        return
    ids = json.loads(G["item_ids"]) + json.loads(G["double_ids"])
    db().execute(f"DELETE FROM items WHERE user_id = ? AND id IN ({','.join('?' * len(ids))})", [ESCROW, *ids])
    db().execute("DELETE FROM blackjack_games WHERE user_id = ?", (user_id,))


@app.get("/api/casino/blackjack")
@login_required
def casino_blackjack():
    G = my_blackjack()
    return jsonify({"game": bj_json(G) if G else None})


@app.post("/api/casino/blackjack/deal")
@login_required
def casino_blackjack_deal():
    lock_me()
    if my_blackjack():
        return bad("Najpierw dokończ rozdanie")
    ids = int_ids(request.get_json(force=True).get("ids"))
    if not 1 <= len(ids) <= BLACKJACK["maxCards"]:
        return bad(f"Postaw od 1 do {BLACKJACK['maxCards']} kart")
    rows, err = take_my_items(ids, stake=True)
    if err:
        return bad(err)
    bj_hold(ids)
    deck = [r + s for r in BJ_RANKS for s in BJ_SUITS] * BLACKJACK["decks"]
    rng.shuffle(deck)
    player, dealer = [deck.pop()], [deck.pop()]   # na zmianę: gracz, krupier, gracz, krupier (zakryta)
    player.append(deck.pop())
    dealer.append(deck.pop())
    db().execute("INSERT INTO blackjack_games (user_id, item_ids, stake, deck, player, dealer, created_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)", (uid(), json.dumps(ids), sum(row_value(r) for r in rows),
                                                  json.dumps(deck), json.dumps(player), json.dumps(dealer), time.time()))
    if bj_blackjack(player) or bj_blackjack(dealer):   # krupier od razu sprawdza blackjacka - koniec rozdania
        return bj_end(my_blackjack(), player, dealer, deck)
    db().commit()
    return jsonify({"game": bj_json(my_blackjack()), "end": None, "state": get_state()})


@app.post("/api/casino/blackjack/hit")
@login_required
def casino_blackjack_hit():
    lock_me()
    game = bj_load()
    if not game:
        return bad(BJ_GONE)
    G, player, dealer, deck = game
    player.append(deck.pop())
    if bj_total(player)[0] >= 21:   # fura albo 21 - nie ma już czego dobierać
        return bj_end(G, player, dealer, deck)
    db().execute("UPDATE blackjack_games SET deck = ?, player = ? WHERE user_id = ?",
                 (json.dumps(deck), json.dumps(player), uid()))
    db().commit()
    return jsonify({"game": bj_json(my_blackjack()), "end": None, "state": get_state()})


@app.post("/api/casino/blackjack/stand")
@login_required
def casino_blackjack_stand():
    lock_me()
    game = bj_load()
    if not game:
        return bad(BJ_GONE)
    return bj_end(*game)


@app.post("/api/casino/blackjack/double")
@login_required
def casino_blackjack_double():
    """Podwojenie: dokładam karty warte najwyżej tyle, co stawka, dostaję dokładnie jedną kartę i krupier gra."""
    lock_me()
    game = bj_load()
    if not game:
        return bad(BJ_GONE)
    G, player, dealer, deck = game
    if len(player) != 2 or G["double_stake"]:
        return bad("Podwoić można tylko na dwóch pierwszych kartach")
    ids = int_ids(request.get_json(force=True).get("ids"))
    if not 1 <= len(ids) <= BLACKJACK["maxCards"]:
        return bad(f"Dołóż od 1 do {BLACKJACK['maxCards']} kart")
    rows, err = take_my_items(ids, stake=True)
    if err:
        return bad(err)
    extra = sum(row_value(r) for r in rows)
    if extra > G["stake"]:
        return bad(f"Dołożone karty mogą być warte najwyżej tyle, co stawka ({fmt_money(G['stake'])})")
    bj_hold(ids)
    db().execute("UPDATE blackjack_games SET double_ids = ?, double_stake = ? WHERE user_id = ?",
                 (json.dumps(ids), extra, uid()))
    player.append(deck.pop())
    return bj_end(my_blackjack(), player, dealer, deck)


# ---------------------------------------------------------------- kasyno: jackpot (lobby dla 2 graczy)
# Gracz zakłada lobby: publiczne (każdy może dołączyć) albo prywatne (tylko zaproszeni po nicku) - założyciel może to
# później zmienić i zapraszać kolejnych graczy. Obaj gracze wybierają karty w lobby i mogą je zmieniać (każda zmiana
# cofa akceptację obu - zmieniły się szanse). Gdy obaj zaakceptują, serwer od razu losuje zwycięzcę (szansa = wartość
# moich kart / wartość wszystkich kart), a zwycięzca bierze wszystkie karty - swoje i rywala.
# Karty w lobby NIE są blokowane: przy losowaniu sprawdzamy, czy gracze nadal je mają.

JACKPOT_GONE = "To lobby jest już nieaktualne"


def jackpot_cards(jid):
    return db().execute("SELECT * FROM jackpot_items WHERE jackpot_id = ?", (jid,)).fetchall()


def get_jackpot(jid):
    return db().execute("SELECT * FROM jackpots WHERE id = ?", (jid,)).fetchone()


def jackpot_invited(jid):
    return [r[0] for r in db().execute("SELECT user_id FROM jackpot_invites WHERE jackpot_id = ?", (jid,))]


def my_lobby(user_id):
    """Otwarte lobby, w którym siedzi gracz (najwyżej jedno naraz), albo None."""
    return db().execute("SELECT * FROM jackpots WHERE status = 'open' AND (creator_id = ? OR joiner_id = ?) "
                        "ORDER BY id DESC LIMIT 1", (user_id, user_id)).fetchone()


def jackpot_side(J, user_id):
    """Miejsce gracza w lobby: "a" (założyciel), "b" (drugi gracz) albo None."""
    return "a" if J["creator_id"] == user_id else "b" if J["joiner_id"] == user_id else None


def jackpot_can_see(J, user_id):
    return bool(J["is_public"] or jackpot_side(J, user_id) or user_id in jackpot_invited(J["id"]))


def jackpot_shows(jid, person_id):
    """Tajna karta w lobby jackpota - jej zdjęcie widać (lobby, które widzę, moja gra albo gra z ostatniej doby)."""
    try:
        J = get_jackpot(int(jid))
    except (TypeError, ValueError):
        return False
    if J is None or not any(r["person_id"] == person_id for r in jackpot_cards(J["id"])):
        return False
    if J["status"] == "open":
        return jackpot_can_see(J, uid())
    return bool(jackpot_side(J, uid())) or (J["finished_at"] or 0) > time.time() - 86400


def jackpots_json(rows):
    """Lobby / gry dla przeglądarki: gracze, zaproszeni, karty i wartość obu stron, akceptacje, wynik."""
    rows = [J for J in rows if J is not None]
    invited = {J["id"]: jackpot_invited(J["id"]) for J in rows}
    users = users_by_id([x for J in rows for x in (J["creator_id"], J["joiner_id"], J["winner_id"])]
                        + [i for ids in invited.values() for i in ids])
    me, found, out = uid(), discovered(), []
    for J in rows:
        cards, value = {"a": [], "b": []}, {"a": 0, "b": 0}
        for r in jackpot_cards(J["id"]):
            value[r["side"]] += r["value"]
            if r["person_id"] in catalog.PEOPLE:
                cards[r["side"]].append(dict(card_json(r["person_id"], r["variant"], found), id=r["item_id"], value=r["value"]))
        out.append({
            "id": J["id"], "status": J["status"], "public": bool(J["is_public"]),
            "creator": users.get(J["creator_id"]), "joiner": users.get(J["joiner_id"]),
            "invites": [users[i] for i in invited[J["id"]] if i in users], "invited": me in invited[J["id"]],
            "side": jackpot_side(J, me), "a": cards["a"], "b": cards["b"], "valueA": value["a"], "valueB": value["b"],
            "readyA": bool(J["ready_a"]), "readyB": bool(J["ready_b"]),
            "winner": None if J["winner_id"] is None else ("a" if J["winner_id"] == J["creator_id"] else "b"),
            "roll": J["roll"], "created": J["created_at"], "finished": J["finished_at"],
        })
    return out


def lobby_reply(jid, **extra):
    return jsonify(dict(extra, jackpot=jackpots_json([get_jackpot(jid)])[0]))


def jackpot_news(me, seen_ms):
    """Ostatnia rozstrzygnięta gra gracza, której wyniku jeszcze nie widział (np. był w innej zakładce albo poza grą)."""
    J = db().execute("SELECT * FROM jackpots WHERE status = 'done' AND (creator_id = ? OR joiner_id = ?) AND finished_at > ? "
                     "ORDER BY finished_at DESC LIMIT 1", (me, me, seen_ms / 1000)).fetchone()
    return jackpots_json([J])[0] if J else None


def int_ids(raw):
    try:
        return [int(i) for i in raw or []]
    except (TypeError, ValueError):
        return []


def jackpot_invite_ids(raw):
    """Nicki do zaproszenia ("ala, bartek" albo lista) -> (lista id, None) albo (None, błąd)."""
    names = raw if isinstance(raw, list) else re.split(r"[,;\s]+", str(raw or ""))
    out = []
    for name in [n.strip() for n in names if str(n).strip()][:10]:
        u = find_user(name)
        if u is None or u["banned"]:
            return None, f"Nie ma gracza „{name}”"
        if u["id"] == uid():
            return None, "Nie możesz zaprosić samego siebie 🙂"
        out.append(u["id"])
    return list(dict.fromkeys(out)), None


def open_lobby(jid, side_needed=True):
    """Moje otwarte lobby o tym id (świeży wiersz) albo None."""
    J = get_jackpot(jid)
    if J is None or J["status"] != "open" or (side_needed and not jackpot_side(J, uid())):
        return None
    return J


@app.get("/api/casino/jackpot")
@login_required
def casino_jackpot():
    """Lobby, które widzę (publiczne, z zaproszeniem dla mnie, moje), moje lobby, ostatnie gry i moja historia."""
    settle_market()
    me = uid()
    lobbies = db().execute("SELECT * FROM jackpots j WHERE status = 'open' AND (is_public = 1 OR creator_id = ? OR joiner_id = ? "
                           "OR EXISTS (SELECT 1 FROM jackpot_invites i WHERE i.jackpot_id = j.id AND i.user_id = ?)) "
                           "ORDER BY id DESC LIMIT 60", (me, me, me)).fetchall()
    recent = db().execute("SELECT * FROM jackpots WHERE status = 'done' ORDER BY finished_at DESC LIMIT 12").fetchall()
    mine = db().execute("SELECT * FROM jackpots WHERE status != 'open' AND (creator_id = ? OR joiner_id = ?) "
                        "ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 12", (me, me)).fetchall()
    current = my_lobby(me)
    return jsonify({"lobbies": jackpots_json(lobbies), "current": jackpots_json([current])[0] if current else None,
                    "recent": jackpots_json(recent), "mine": jackpots_json(mine)})


@app.post("/api/casino/jackpot")
@login_required
def casino_jackpot_create():
    """Nowe lobby: public (bool) i invites (nicki graczy). Karty wybiera się już w lobby."""
    settle_market()
    lock_me()
    body = request.get_json(force=True)
    if my_lobby(uid()):
        return bad("Jesteś już w lobby — najpierw je opuść")
    invites, err = jackpot_invite_ids(body.get("invites"))
    if err:
        return bad(err)
    now = time.time()
    jid = db().execute("INSERT INTO jackpots (creator_id, is_public, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
                       (uid(), int(bool(body.get("public", True))), now, now)).fetchone()[0]
    for user_id in invites:
        db().execute("INSERT INTO jackpot_invites (jackpot_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", (jid, user_id))
    db().commit()
    return lobby_reply(jid)


@app.post("/api/casino/jackpot/<int:jid>/join")
@login_required
def casino_jackpot_join(jid):
    """Zajęcie wolnego miejsca w lobby (publicznym albo z zaproszeniem dla mnie)."""
    settle_market()
    lock_me()
    J = open_lobby(jid, side_needed=False)
    if J is None:
        return bad(JACKPOT_GONE)
    if jackpot_side(J, uid()):
        return lobby_reply(jid)
    if not jackpot_can_see(J, uid()):
        return bad("To lobby jest prywatne — potrzebujesz zaproszenia", 403)
    if my_lobby(uid()):
        return bad("Jesteś już w innym lobby — najpierw je opuść")
    if not db().execute("UPDATE jackpots SET joiner_id = ?, ready_a = 0, ready_b = 0, updated_at = ? WHERE id = ? "
                        "AND status = 'open' AND joiner_id IS NULL", (uid(), time.time(), jid)).rowcount:
        return bad("Ktoś był szybszy — w tym lobby nie ma już miejsca")
    db().commit()
    return lobby_reply(jid)


def free_seat(jid):
    """Drugi gracz wychodzi (albo założyciel go wyprasza): jego karty znikają z lobby, akceptacje się cofają."""
    db().execute("DELETE FROM jackpot_items WHERE jackpot_id = ? AND side = 'b'", (jid,))
    db().execute("UPDATE jackpots SET joiner_id = NULL, ready_a = 0, ready_b = 0, updated_at = ? WHERE id = ?",
                 (time.time(), jid))


@app.post("/api/casino/jackpot/<int:jid>/leave")
@login_required
def casino_jackpot_leave(jid):
    """Wyjście z lobby - założyciel zamyka całe lobby (karty niczyje nie były zablokowane)."""
    settle_market()
    lock_me()
    J = open_lobby(jid)
    if J is None:
        return bad(JACKPOT_GONE)
    if jackpot_side(J, uid()) == "a":
        db().execute("UPDATE jackpots SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
                     (time.time(), time.time(), jid))
    else:
        free_seat(jid)
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/casino/jackpot/<int:jid>/kick")
@login_required
def casino_jackpot_kick(jid):
    settle_market()
    lock_me()
    J = open_lobby(jid)
    if J is None or jackpot_side(J, uid()) != "a":
        return bad(JACKPOT_GONE)
    if J["joiner_id"]:
        free_seat(jid)
    db().commit()
    return lobby_reply(jid)


@app.post("/api/casino/jackpot/<int:jid>/settings")
@login_required
def casino_jackpot_settings(jid):
    """Założyciel: public (bool), invite (nicki do zaproszenia), uninvite (id gracza do usunięcia z zaproszonych)."""
    settle_market()
    lock_me()
    body = request.get_json(force=True)
    J = open_lobby(jid)
    if J is None or jackpot_side(J, uid()) != "a":
        return bad(JACKPOT_GONE)
    if "public" in body:
        db().execute("UPDATE jackpots SET is_public = ? WHERE id = ?", (int(bool(body["public"])), jid))
    if body.get("invite"):
        invites, err = jackpot_invite_ids(body["invite"])
        if err:
            return bad(err)
        for user_id in invites:
            db().execute("INSERT INTO jackpot_invites (jackpot_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", (jid, user_id))
    if body.get("uninvite"):
        db().execute("DELETE FROM jackpot_invites WHERE jackpot_id = ? AND user_id = ?", (jid, int(body["uninvite"])))
    db().execute("UPDATE jackpots SET updated_at = ? WHERE id = ?", (time.time(), jid))
    db().commit()
    return lobby_reply(jid)


def lock_lobby(jid):
    """Blokuje obu graczy lobby (zawsze w tej samej kolejności) i zwraca świeży wiersz mojego otwartego lobby albo None."""
    J = open_lobby(jid)
    if J is None:
        return None
    db().lock_users(J["creator_id"], J["joiner_id"])
    return open_lobby(jid)


@app.post("/api/casino/jackpot/<int:jid>/cards")
@login_required
def casino_jackpot_cards(jid):
    """Moje karty w lobby (cała nowa lista). Każda zmiana cofa akceptację obu graczy."""
    settle_market()
    J = lock_lobby(jid)
    if J is None:
        return bad(JACKPOT_GONE)
    side = jackpot_side(J, uid())
    ids = int_ids(request.get_json(force=True).get("ids"))
    if len(ids) > JACKPOT["maxCards"]:
        return bad(f"Najwyżej {JACKPOT['maxCards']} kart")
    rows, err = take_my_items(ids, stake=True) if ids else ([], None)
    if err:
        return bad(err)
    db().execute("DELETE FROM jackpot_items WHERE jackpot_id = ? AND side = ?", (jid, side))
    for r in rows:
        db().execute("INSERT INTO jackpot_items (jackpot_id, side, item_id, person_id, variant, value) VALUES (?, ?, ?, ?, ?, ?)",
                     (jid, side, r["id"], r["person_id"], r["variant"], row_value(r)))
    db().execute("UPDATE jackpots SET ready_a = 0, ready_b = 0, updated_at = ? WHERE id = ?", (time.time(), jid))
    db().commit()
    return lobby_reply(jid)


def jackpot_play(J):
    """Obaj zaakceptowali: sprawdzamy, czy gracze nadal mają swoje karty, losujemy zwycięzcę i dajemy mu wszystkie karty.
    Zwraca komunikat błędu (wtedy brakujące karty znikają z lobby, a akceptacje się cofają) albo None."""
    now = time.time()
    owners = {"a": J["creator_id"], "b": J["joiner_id"]}
    rows, gone, values = jackpot_cards(J["id"]), [], {"a": 0, "b": 0}
    for r in rows:
        it = db().execute("SELECT * FROM items WHERE id = ? AND user_id = ? AND favorite = 0",
                          (r["item_id"], owners[r["side"]])).fetchone()
        if it is None or it["person_id"] not in catalog.PEOPLE or catalog.is_special(catalog.PEOPLE[it["person_id"]]):
            gone.append(r["item_id"])
            continue
        values[r["side"]] += row_value(it)
        db().execute("UPDATE jackpot_items SET value = ? WHERE jackpot_id = ? AND item_id = ?", (row_value(it), J["id"], it["id"]))
    if gone or not values["a"] or not values["b"]:
        for item_id in gone:
            db().execute("DELETE FROM jackpot_items WHERE jackpot_id = ? AND item_id = ?", (J["id"], item_id))
        db().execute("UPDATE jackpots SET ready_a = 0, ready_b = 0, updated_at = ? WHERE id = ?", (now, J["id"]))
        return ("Część kart z lobby nie jest już u graczy (sprzedane, oznaczone ⭐ albo użyte gdzie indziej) — usunęliśmy je, "
                "zaakceptujcie jeszcze raz") if gone else "Obaj gracze muszą postawić karty"
    roll = rng.random()
    winner = J["creator_id"] if roll < values["a"] / (values["a"] + values["b"]) else J["joiner_id"]
    if not db().execute("UPDATE jackpots SET status = 'done', value_a = ?, value_b = ?, winner_id = ?, roll = ?, finished_at = ?, "
                        "updated_at = ? WHERE id = ? AND status = 'open'",
                        (values["a"], values["b"], winner, roll, now, now, J["id"])).rowcount:
        return JACKPOT_GONE
    give_items([r["item_id"] for r in rows], winner)   # zwycięzca: swoje karty z powrotem + karty rywala
    return None


@app.post("/api/casino/jackpot/<int:jid>/ready")
@login_required
def casino_jackpot_ready(jid):
    """Akceptacja (ready: true / false). Gdy zaakceptują obaj - od razu losowanie."""
    settle_market()
    J = lock_lobby(jid)
    if J is None:
        return bad(JACKPOT_GONE)
    side = jackpot_side(J, uid())
    want = bool(request.get_json(force=True).get("ready", True))
    if want and not J["joiner_id"]:
        return bad("Poczekaj na drugiego gracza")
    if want and not any(r["side"] == side for r in jackpot_cards(jid)):
        return bad("Najpierw wybierz swoje karty")
    db().execute(f"UPDATE jackpots SET ready_{side} = ?, updated_at = ? WHERE id = ?", (int(want), time.time(), jid))
    J = get_jackpot(jid)
    if J["ready_a"] and J["ready_b"]:
        err = jackpot_play(J)
        db().commit()
        if err:
            return lobby_reply(jid, error=err), 409
        return lobby_reply(jid, items=my_items(), state=get_state())
    db().commit()
    return lobby_reply(jid)


@app.post("/api/casino/jackpot/<int:jid>/seen")
@login_required
def casino_jackpot_seen(jid):
    """Gracz obejrzał wynik gry - nie pokazujemy go ponownie (zapamiętany koniec gry w ms)."""
    J = get_jackpot(jid)
    if J and J["status"] == "done" and jackpot_side(J, uid()):
        ms = int(J["finished_at"] * 1000) + 1
        if ms > get_state()["jackpot_seen"]:
            set_state("jackpot_seen", ms)
            db().commit()
    return jsonify({"ok": True})


def market_forget_user(user_id):
    """Usuwany gracz: jego karty z rynku znikają razem z nim, pieniądze innych graczy wracają,
    jego własne propozycje, licytacje i zlecenia przepadają (pieniądze były już zabrane z jego konta)."""
    now = time.time()
    for L in db().execute("SELECT * FROM market_listings WHERE seller_id = ? AND status = 'active'", (user_id,)).fetchall():
        db().execute("UPDATE market_listings SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, L["id"]))
        refund_offers(L["id"], now)
        for b in db().execute("SELECT * FROM market_bids WHERE listing_id = ? AND status = 'active'", (L["id"],)).fetchall():
            db().execute("UPDATE market_bids SET status = 'refunded', updated_at = ? WHERE id = ?", (now, b["id"]))
            add_state("balance", b["amount"], b["bidder_id"])
        db().execute("DELETE FROM items WHERE id = ? AND user_id = ?", (L["item_id"], ESCROW))
    db().execute("UPDATE market_offers SET status = 'cancelled', updated_at = ? WHERE buyer_id = ? AND status = 'pending'",
                 (now, user_id))
    db().execute("UPDATE market_bids SET status = 'refunded', updated_at = ? WHERE bidder_id = ? AND status = 'active'",
                 (now, user_id))
    db().execute("UPDATE market_wanted SET status = 'cancelled', updated_at = ? WHERE buyer_id = ? AND status = 'active'",
                 (now, user_id))
    # jego lobby jackpota: założone - zamykamy, w cudzym - zwalniamy miejsce; znika też z zaproszeń
    db().execute("UPDATE jackpots SET status = 'cancelled', finished_at = ? WHERE creator_id = ? AND status = 'open'",
                 (now, user_id))
    for J in db().execute("SELECT id FROM jackpots WHERE joiner_id = ? AND status = 'open'", (user_id,)).fetchall():
        free_seat(J["id"])
    db().execute("DELETE FROM jackpot_invites WHERE user_id = ?", (user_id,))


# ---------------------------------------------------------------- arena (wersja testowa - TYLKO DLA ADMINÓW)
# Walkę liczy serwer (arena.py) - przeglądarka wysyła ruchy i odtwarza kroki walki z animacjami.
# Na czas testów wszystkie /api/arena/* są dostępne tylko dla adminów (gracze nie widzą zakładki).

def arena_hero(u):
    """Portret gracza w walce (None = komputer)."""
    if u is None:
        return {"username": "Komputer", "bot": True}
    return {k: v for k, v in user_json(u).items() if k != "isAdmin"}


def arena_deck(pids):
    """Talia z moich kart: osoby bez powtórzeń, każda w najlepszym posiadanym wariancie (wariant to tylko wygląd)."""
    n = ARENA["deckSize"]
    if not isinstance(pids, list) or len(pids) != n:
        return None
    pids = [str(p) for p in pids]
    if len(set(pids)) != n:
        return None
    best = {}
    marks = ",".join("?" * n)
    for r in db().execute(f"SELECT person_id, variant FROM items WHERE user_id = ? AND person_id IN ({marks})",
                          [uid(), *pids]):
        p = catalog.PEOPLE.get(r["person_id"])
        if p and p.get("hp", 0) > 0:
            v = r["variant"] if r["variant"] in VARIANTS else "normal"
            if VARIANT_ORDER.index(v) >= VARIANT_ORDER.index(best.get(p["id"], "normal")):
                best[p["id"]] = v
    if len(best) != n:
        return None
    return [{"pid": p, "variant": best[p]} for p in pids]


DECK_ERROR = f"Talia musi mieć {ARENA['deckSize']} różnych kart z twojej kolekcji"


def arena_wins_today(user_id):
    r = db().execute("SELECT wins FROM arena_daily WHERE user_id = ? AND day = ?",
                     (user_id, datetime.date.today().isoformat())).fetchone()
    return r["wins"] if r else 0


def arena_reward_info(wins, chest=None):
    return {"wins": wins, "chest": chest, "rewardWins": ARENA["rewardWins"],
            "next": next((w for w in ARENA["rewardWins"] if w > wins), None)}


def arena_record(b):
    """Koniec walki: wygrana liczy się do dziennych nagród - skrzynka z pieniędzmi za 1., 3. i 9. wygraną dnia.
    Wywoływane pod b.lock, więc nagroda nie zostanie przyznana dwa razy."""
    if not b.over or b.recorded:
        return
    b.recorded = True
    day = datetime.date.today().isoformat()
    for k in ("a", "b"):
        user_id = b.sides[k]["user"]
        if not user_id:
            continue
        chest = None
        if k == b.over and not b.no_reward:
            db().execute("INSERT INTO arena_daily (user_id, day, wins) VALUES (?, ?, 0) ON CONFLICT (user_id, day) DO NOTHING",
                         (user_id, day))
            db().execute("UPDATE arena_daily SET wins = wins + 1 WHERE user_id = ? AND day = ?", (user_id, day))
            if arena_wins_today(user_id) in ARENA["rewardWins"]:
                chest = ARENA["rewardChest"]
                add_chests("money_" + chest, 1, user_id)
        b.rewards[k] = arena_reward_info(arena_wins_today(user_id), chest)
    db().commit()


def arena_shows(bid, person_id):
    """Tajna karta biorąca udział w mojej walce - jej zdjęcie widać, nawet jeśli jej nie odkryłem."""
    b = arena.get_battle(bid) if bid else None
    return bool(b and b.side_of_user(uid()) and person_id in b.pids())


def arena_reply(b, me, since=0):
    arena_record(b)
    out = b.view(me, since)
    # tajne karty widoczne w walce (moje, na planszy, pokonane) - prawdziwe dane, choć ich jeszcze nie odkryłem
    found, seen = discovered(), set()
    for st in [out["state"]] + [s["state"] for s in out["steps"]]:
        for s in st["sides"].values():
            seen.update(u["pid"] for u in s["board"] + s["bench"] + s["ko"] if "pid" in u)
    out["reveal"] = {pid: public_person(catalog.PEOPLE[pid], {pid}) for pid in seen
                     if pid in catalog.PEOPLE and catalog.PEOPLE[pid]["rarity"] == "secret" and pid not in found}
    if (b.rewards.get(me) or {}).get("chest"):
        out["chests"] = get_chests()
    return jsonify(out)


def arena_open(bid):
    """Moja walka o tym id i moja strona w niej ("a" / "b") albo (None, None)."""
    b = arena.get_battle(bid)
    me = b.side_of_user(uid()) if b else None
    return (b, me) if me else (None, None)


def arena_abandon(user_id):
    """Nowa walka kończy porzuconą walkę z komputerem (porażka, bez nagród). Zwraca trwający pojedynek z graczem."""
    old = arena.active_battle(user_id)
    while old and old.mode == "ai":
        with old.lock:
            old.surrender(old.side_of_user(user_id))
            arena_record(old)
        old = arena.active_battle(user_id)
    return old


@app.get("/api/arena/inbox")
@admin_required
def arena_inbox():
    """Sprawdzane co kilka sekund: wyzwania od innych graczy, odpowiedź na moje wyzwanie, trwająca walka."""
    me = uid()
    b = arena.active_battle(me)
    if b:
        with b.lock:
            b.seen[b.side_of_user(me)] = time.time()
    incoming, outgoing = arena.challenges_for(me)
    return jsonify({"incoming": [arena.challenge_json(c) for c in incoming],
                    "outgoing": arena.challenge_json(outgoing) if outgoing else None,
                    "battle": {"id": b.id, "mode": b.mode} if b else None,
                    "rewards": arena_reward_info(arena_wins_today(me))})


@app.post("/api/arena/start")
@admin_required
def arena_start():
    """Nowa walka z komputerem."""
    me = current_user()
    deck = arena_deck(request.get_json(force=True).get("deck"))
    if deck is None:
        return jsonify({"error": DECK_ERROR}), 400
    if arena_abandon(me["id"]):
        return jsonify({"error": "Masz trwający pojedynek z graczem"}), 400
    arena.cleanup()
    b = arena.add_battle(arena.Battle(
        "ai", {"name": me["username"], "user": me["id"], "deck": deck, "hero": arena_hero(me)},
        {"name": "Komputer", "user": None, "deck": arena.ai_deck(deck, discovered()), "hero": arena_hero(None)}))
    with b.lock:
        b.start()
        return arena_reply(b, "a")


@app.get("/api/arena/battle/<bid>")
@admin_required
def arena_battle(bid):
    b, me = arena_open(bid)
    if b is None:
        return jsonify({"error": "Ta walka już się skończyła"}), 404
    with b.lock:
        b.seen[me] = time.time()
        b.tick()
        return arena_reply(b, me, max(0, request.args.get("since", 0, type=int)))


@app.post("/api/arena/battle/<bid>/act")
@admin_required
def arena_act(bid):
    """Ruch gracza: place / retreat / use / end / surrender (+ auto - tylko admin, wtedy walka bez nagród)."""
    b, me = arena_open(bid)
    if b is None:
        return jsonify({"error": "Ta walka już się skończyła"}), 404
    body = request.get_json(force=True)
    kind = body.get("type")
    with b.lock:
        b.seen[me] = time.time()
        b.tick()
        try:
            if kind == "surrender":
                b.surrender(me)
            elif kind == "auto":
                if not current_user()["is_admin"]:
                    return jsonify({"error": "Tylko dla admina"}), 403
                b.auto[me] = bool(body.get("on"))
                b.no_reward = b.no_reward or b.auto[me]
            elif b.over:
                raise arena.ArenaError("Walka już się skończyła")
            elif kind == "place":
                b.place(me, int(body["uid"]))
            elif kind == "retreat":
                b.retreat(me, int(body["uid"]))
            elif kind == "use":
                target = body.get("target")
                b.use(me, int(body["uid"]), int(body["ab"]), int(target) if target is not None else None)
            elif kind == "end":
                b.end_turn(me)
            else:
                raise arena.ArenaError("Nieznany ruch")
            b.run_bots()
        except arena.ArenaError as e:
            return jsonify({"error": str(e)}), 400
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "Nieprawidłowy ruch"}), 400
        return arena_reply(b, me, max(0, int(body.get("since") or 0)))


@app.post("/api/arena/challenge")
@admin_required
def arena_challenge():
    """Wyzwanie innego gracza na pojedynek (z jego profilu)."""
    me = current_user()
    body = request.get_json(force=True)
    target = find_user(body.get("username"))
    if target is None or target["banned"]:
        return jsonify({"error": "Nie ma takiego gracza"}), 404
    if target["id"] == me["id"]:
        return jsonify({"error": "Nie możesz wyzwać samego siebie"}), 400
    if not target["is_admin"]:  # wersja testowa: walczą tylko admini
        return jsonify({"error": f"Arena jest na razie tylko dla adminów — {target['username']} nie ma do niej dostępu"}), 400
    deck = arena_deck(body.get("deck"))
    if deck is None:
        return jsonify({"error": DECK_ERROR}), 400
    for user_id in (me["id"], target["id"]):
        b = arena.active_battle(user_id)
        if b and b.mode == "pvp":
            return jsonify({"error": "Masz trwający pojedynek" if user_id == me["id"] else
                            f"{target['username']} właśnie walczy z kimś innym"}), 400
    c = arena.new_challenge(arena_hero(me), arena_hero(target), deck)
    return jsonify(arena.challenge_json(c))


@app.post("/api/arena/challenge/<cid>/accept")
@admin_required
def arena_accept(cid):
    me = current_user()
    arena.cleanup()
    c = arena.get_challenge(cid)
    if c is None or c["to"] != me["id"]:
        return jsonify({"error": "To wyzwanie już wygasło"}), 404
    deck = arena_deck(request.get_json(force=True).get("deck"))
    if deck is None:
        return jsonify({"error": DECK_ERROR}), 400
    rival = db().execute("SELECT * FROM users WHERE id = ?", (c["from"],)).fetchone()
    with arena._lock:
        if c["status"] != "pending":
            return jsonify({"error": "To wyzwanie jest już nieaktualne"}), 400
        if rival is None or rival["banned"]:
            return jsonify({"error": "Nie ma takiego gracza"}), 404
        for user_id in (me["id"], rival["id"]):
            if arena_abandon(user_id):
                return jsonify({"error": "Ktoś z was ma już trwający pojedynek"}), 400
        c["status"] = "accepted"
        b = arena.add_battle(arena.Battle(
            "pvp", {"name": rival["username"], "user": rival["id"], "deck": c["deck"], "hero": arena_hero(rival)},
            {"name": me["username"], "user": me["id"], "deck": deck, "hero": arena_hero(me)}, first=random.choice("ab")))
        with b.lock:
            b.start()
        c["battle"] = b.id
    return jsonify({"battle": b.id})


@app.post("/api/arena/challenge/<cid>/decline")
@admin_required
def arena_decline(cid):
    """Odrzucenie wyzwania (przez wyzwanego) albo wycofanie (przez wyzywającego)."""
    c = arena.get_challenge(cid)
    if c is None or uid() not in (c["from"], c["to"]):
        return jsonify({"error": "To wyzwanie już wygasło"}), 404
    with arena._lock:
        if c["status"] == "pending":
            c["status"] = "declined" if uid() == c["to"] else "cancelled"
    return jsonify(arena.challenge_json(c))


# ---------------------------------------------------------------- API admina

def slug(text):
    t = unicodedata.normalize("NFKD", text.replace("ł", "l").replace("Ł", "L"))
    t = re.sub(r"[^a-zA-Z0-9]+", "_", t.encode("ascii", "ignore").decode()).strip("_").lower()
    return t or "x"


def unique_id(base, taken):
    i, key = 2, base
    while key in taken:
        key, i = f"{base}_{i}", i + 1
    return key


def admin_card_json(p):
    return dict({k: p.get(k) for k in ("id", "name", "rarity", "type", "hp", "attack", "dmg", "attack2", "dmg2",
                                       "kind1", "kind2", "abilities", "arena", "country", "source", "fixedVariant", "style",
                                       "subtitle", "desc", "crate", "crates", "number", "builtin", "modified")},
                wiki=list(p["wiki"]) if p.get("wiki") else None,
                hasImage=bool(images.find(p["id"])), hasAlt=bool(images.find(p["id"], True)),
                cardVariants=catalog.photo_variants(p["id"]), variantPhotos=variant_photos(p["id"]),
                imgv=img_version(p["id"]))


def refresh_catalog():
    catalog.rebuild(db())


# ---------------------------------------------------------------- dziennik działań adminów

def log_admin(action, target_id=None, details=""):
    """Zapisuje działanie admina (kto, co, komu) - widać je w panelu admina w "Dzienniku adminów"."""
    target = db().execute("SELECT username FROM users WHERE id = ?", (target_id,)).fetchone() if target_id else None
    db().execute("INSERT INTO admin_log (created_at, admin_id, admin_name, action, target_id, target_name, details) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)", (time.time(), uid(), current_user()["username"], action, target_id,
                                                  target[0] if target else "", str(details)[:300]))


def mark_money_generated(user_id):
    """Gracz dostał pieniądze / skrzynki od admina - na stałe znika z rankingu."""
    db().execute("UPDATE users SET money_generated = 1 WHERE id = ?", (user_id,))


def money_txt(amount):
    return f"{amount:+,} gr".replace(",", " ")


def chest_name(kind):
    m = money_kind(kind)
    return MONEY_CHESTS[m]["name"] if m else catalog.CRATES[kind]["name"]


# ---------------------------------------------------------------- wiadomości do graczy (panel admina)
# Admin wybiera od kiedy do kiedy wiadomość jest aktywna (godziny w strefie czasowej przeglądarki admina - przeglądarka
# wysyła gotowe znaczniki czasu); każdy gracz, który wejdzie do gry w tym czasie, zobaczy ją raz (active_messages).

@app.get("/api/admin/messages")
@admin_required
def admin_messages_list():
    rows = db().execute("SELECT m.*, (SELECT COUNT(*) FROM admin_message_seen s WHERE s.message_id = m.id) AS seen "
                        "FROM admin_messages m ORDER BY starts_at DESC").fetchall()
    return jsonify({"messages": [{"id": r["id"], "title": r["title"], "body": r["body"], "start": r["starts_at"],
                                  "end": r["ends_at"], "admin": r["admin_name"], "seen": r["seen"]} for r in rows]})


@app.post("/api/admin/messages")
@admin_required
def admin_messages_add():
    d = request.get_json(force=True) or {}
    title, body = str(d.get("title") or "").strip()[:100], str(d.get("body") or "").replace("\r\n", "\n").strip()[:2000]
    try:
        start, end = float(d.get("start")), float(d.get("end"))
    except (TypeError, ValueError):
        return jsonify({"error": "Podaj początek i koniec wyświetlania"}), 400
    if not title or not body:
        return jsonify({"error": "Podaj tytuł i treść wiadomości"}), 400
    if end <= start:
        return jsonify({"error": "Koniec musi być później niż początek"}), 400
    if end <= time.time():
        return jsonify({"error": "Ta wiadomość już by się skończyła - wybierz późniejszy koniec"}), 400
    db().execute("INSERT INTO admin_messages (title, body, starts_at, ends_at, created_at, admin_name) VALUES (?, ?, ?, ?, ?, ?)",
                 (title, body, start, end, time.time(), current_user()["username"]))
    log_admin("message_add", details=title)
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/admin/messages/<int:mid>")
@admin_required
def admin_messages_delete(mid):
    row = db().execute("SELECT title FROM admin_messages WHERE id = ?", (mid,)).fetchone()
    if not row:
        return jsonify({"error": "Nie ma takiej wiadomości"}), 404
    db().execute("DELETE FROM admin_message_seen WHERE message_id = ?", (mid,))
    db().execute("DELETE FROM admin_messages WHERE id = ?", (mid,))
    log_admin("message_delete", details=row[0])
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/admin/log")
@admin_required
def admin_log_list():
    limit = max(1, min(1000, int(request.args.get("limit") or 300)))
    rows = db().execute("SELECT * FROM admin_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return jsonify({"log": [{"id": r["id"], "time": r["created_at"], "admin": r["admin_name"], "action": r["action"],
                             "target": r["target_name"], "details": r["details"]} for r in rows]})


@app.get("/api/admin/catalog")
@admin_required
def admin_catalog():
    counts = {r[0]: r[1] for r in db().execute("SELECT person_id, COUNT(*) FROM items GROUP BY person_id")}
    access = {}
    for r in db().execute("SELECT user_id, crate_id FROM crate_access"):
        access.setdefault(r[1], []).append(r[0])
    crates = [dict(crate_json(c), builtin=c["builtin"], modified=c["modified"], hidden=False,
                   customWeights={r: w for r, w in c["weights"].items() if not (r == "secret" and c.get("autoSecret"))},
                   allowed=access.get(c["id"], []))
              for c in catalog.CRATES.values()]
    crates += [dict(crate_json(dict(c, people=[])), builtin=True, modified=False, hidden=True,
                    customWeights=c.get("weights") or {}, allowed=access.get(c["id"], []))
               for c in catalog.HIDDEN_CRATES.values()]
    cards = [dict(admin_card_json(p), owned=counts.get(p["id"], 0), hidden=False) for p in catalog.PEOPLE.values()]
    cards += [dict(admin_card_json(dict(p, number=0)), owned=counts.get(p["id"], 0), hidden=True)
              for p in catalog.HIDDEN_CARDS.values() if p.get("crate") in catalog.CRATES]
    users = [user_json(u) for u in db().execute("SELECT * FROM users ORDER BY LOWER(username)")]
    return jsonify({"crates": crates, "cards": cards, "rarities": RARITIES, "rarityOrder": RARITY_ORDER,
                    "types": TYPES, "abilityKinds": ABILITY_KINDS, "maxExtraAbilities": MAX_EXTRA_ABILITIES,
                    "arena": {"effects": ARENA_EFFECTS, "visuals": ARENA_VISUALS, "targets": ARENA_TARGETS,
                              "effectTargets": ARENA_EFFECT_TARGETS, "maxEffects": MAX_ABILITY_EFFECTS},
                    "variants": VARIANTS, "exclusiveVariants": CRATE_VARIANTS,
                    "specialVariants": SPECIAL_VARIANTS, "specialSources": SPECIAL_SOURCES, "specialCrate": SPECIAL_CRATE,
                    "defaultPrice": CRATE_PRICE, "users": users})


@app.post("/api/admin/crates")
@admin_required
def admin_save_crate():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Podaj nazwę skrzynki"}), 400
    try:
        price = max(1, min(1_000_000, int(body.get("price") or CRATE_PRICE)))
    except (TypeError, ValueError):
        return jsonify({"error": "Nieprawidłowa cena"}), 400
    fields = {
        "name": name[:60],
        "short": (body.get("short") or name).strip()[:24],
        "code": (body.get("code") or name[:2]).strip().upper()[:4],
        "emoji": (body.get("emoji") or "📦").strip()[:8],
        "color1": body.get("color1") or "#888888",
        "color2": body.get("color2") or "#333333",
        "price": price,
        "desc": (body.get("desc") or "").strip()[:120],
        "shop": bool(body.get("shop", True)),
        "restricted": bool(body.get("restricted", False)),
        # warianty wyjątkowe (Królewski, Flagowy...) - wypadają tylko ze skrzynek, w których są włączone
        "variants": [v for v in CRATE_VARIANTS if v in (body.get("variants") or [])],
    }
    weights = {}
    for r, w in (body.get("weights") or {}).items():
        if r in RARITIES and w not in (None, ""):
            try:
                weights[r] = max(0.0, min(1000.0, float(w)))
            except (TypeError, ValueError):
                return jsonify({"error": "Szanse muszą być liczbami"}), 400
    fields["weights"] = weights
    cid = body.get("id")
    if not cid:
        cid = unique_id(slug(name), set(catalog.CRATES) | set(catalog.HIDDEN_CRATES))
    log_admin("crate_save", details=f"{'nowa: ' if not body.get('id') else ''}{fields['name']} · cena {price} $")
    catalog.save_override(db(), "catalog_crates", cid, fields)
    if "allowed" in body:  # lista graczy z dostępem do skrzynki
        db().execute("DELETE FROM crate_access WHERE crate_id = ?", (cid,))
        for user_id in {int(x) for x in body.get("allowed") or []}:
            db().execute("INSERT INTO crate_access (user_id, crate_id) VALUES (?, ?) ON CONFLICT DO NOTHING", (user_id, cid))
    db().commit()
    refresh_catalog()
    return jsonify({"ok": True, "id": cid})


@app.delete("/api/admin/crates/<cid>")
@admin_required
def admin_delete_crate(cid):
    conn = db()
    crate = catalog.CRATES.get(cid)
    if crate is None:
        return jsonify({"error": "Nie ma takiej skrzynki"}), 404
    log_admin("crate_delete", details=f"{crate['name']}{' (ukryta)' if crate['builtin'] else ''}")
    if crate["builtin"]:
        catalog.mark_deleted(conn, "catalog_crates", cid)  # wbudowaną tylko ukrywamy
    else:
        catalog.remove_row(conn, "catalog_crates", cid)
        conn.execute("DELETE FROM crate_access WHERE crate_id = ?", (cid,))
        for p in crate["people"]:
            if not p["builtin"] and p["crates"] == [cid]:  # karty tylko z tej skrzynki
                catalog.remove_row(conn, "catalog_cards", p["id"])
    conn.commit()
    refresh_catalog()
    return jsonify({"ok": True})


@app.post("/api/admin/crates/<cid>/restore")
@admin_required
def admin_restore_crate(cid):
    if catalog.builtin_crate(cid) is None:
        return jsonify({"error": "To nie jest wbudowana skrzynka"}), 400
    catalog.remove_row(db(), "catalog_crates", cid)
    log_admin("crate_restore", details=catalog.builtin_crate(cid)["name"])
    db().commit()
    refresh_catalog()
    return jsonify({"ok": True})


@app.post("/api/admin/cards")
@admin_required
def admin_save_card():
    f = request.form
    name = (f.get("name") or "").strip()
    crates = [c for c in dict.fromkeys(f.getlist("crates") or [f.get("crate")]) if c in catalog.CRATES]
    # karta specjalna jest tylko w skrzynce kart specjalnych (której nie da się otworzyć), a zwykła karta - nigdy
    crates = [SPECIAL_CRATE] if f.get("rarity") == "special" and SPECIAL_CRATE in catalog.CRATES         else [c for c in crates if not catalog.CRATES[c]["special"]]
    crate = crates[0] if crates else None
    if not name:
        return jsonify({"error": "Podaj nazwę karty"}), 400
    if crate is None:
        return jsonify({"error": "Wybierz co najmniej jedną skrzynkę"}), 400
    if f.get("rarity") not in RARITIES or f.get("type") not in TYPES:
        return jsonify({"error": "Nieprawidłowa rzadkość lub typ"}), 400
    try:
        hp, dmg = int(f.get("hp") or 50), int(f.get("dmg") or 30)
    except ValueError:
        return jsonify({"error": "HP i obrażenia muszą być liczbami"}), 400
    wiki_title = (f.get("wiki_title") or "").strip()
    fields = {
        "name": name[:60], "crate": crate, "crates": crates, "rarity": f["rarity"], "type": f["type"],
        "hp": max(0, min(9999, hp)), "dmg": max(0, min(9999, dmg)),
        "attack": (f.get("attack") or "Atak").strip()[:40],
        "attack2": (f.get("attack2") or "").strip()[:40] or None,
        "dmg2": max(0, min(9999, int(f.get("dmg2") or 0))) if (f.get("dmg2") or "").strip().lstrip("-").isdigit() else 0,
        "wiki": [(f.get("wiki_lang") or "pl").strip()[:5], wiki_title] if wiki_title else None,
        "kind1": f.get("kind1") if f.get("kind1") in ABILITY_KINDS else "off",
        "kind2": f.get("kind2") if f.get("kind2") in ABILITY_KINDS else "off",
        "abilities": catalog.clean_abilities([{"name": n, "kind": k, "value": v} for n, k, v in
                                              zip(f.getlist("ab_name"), f.getlist("ab_kind"), f.getlist("ab_value"))]),
        "country": catalog.clean_country(f.get("country")),   # kod kraju do wariantu flagowego (np. PL)
        # podtytuł - krótki tekst na karcie; opis - dłuższy tekst obok karty w podglądzie
        "subtitle": (f.get("subtitle") or "").strip()[:catalog.SUBTITLE_MAX],
        "desc": (f.get("desc") or "").replace("\r\n", "\n").strip()[:catalog.DESC_MAX],
        # karta specjalna: skąd (kasyno / link), jedyny wariant (Jokerowa, Dżinsowa) i wygląd 1-6 (catalog.rebuild sprawdza)
        "source": f.get("source"), "fixedVariant": f.get("fixed_variant"), "style": f.get("style"),
        # skrzynki istniejące w chwili zapisu - nowe wbudowane skrzynki dodane później dopiszą tę kartę (catalog.rebuild)
        "crates_seen": sorted(set(catalog.CRATES) | set(catalog.HIDDEN_CRATES)),
    }
    try:  # Arena: animacja, koszt, cel i efekty każdej zdolności (z panelu admina jako JSON)
        fields["arena"] = catalog.clean_arena(json.loads(f.get("arena_json") or "[]"))
    except ValueError:
        return jsonify({"error": "Nieprawidłowe ustawienia Areny"}), 400
    # efekt unikalny może mieć tylko jedna karta
    pid_now = f.get("id")
    for cfg in fields["arena"]:
        for e in cfg["effects"]:
            if ARENA_EFFECTS[e["id"]].get("unique"):
                other = next((p for p in catalog.PEOPLE.values() if p["id"] != pid_now and
                              any(x["id"] == e["id"] for c in p.get("arena", []) for x in c["effects"])), None)
                if other:
                    return jsonify({"error": f"Efekt „{ARENA_EFFECTS[e['id']]['name']}” jest unikalny - ma go już "
                                             f"karta {other['name']}"}), 400
    pid = f.get("id")
    old = catalog.PEOPLE.get(pid) if pid else None
    if not pid:
        prefix = {"world": "w"}.get(crate, crate)
        pid = unique_id(f"{prefix}_{slug(name)}", set(catalog.PEOPLE) | set(catalog.HIDDEN_CARDS))
    catalog.save_override(db(), "catalog_cards", pid, fields)
    log_admin("card_save", details=f"{'nowa: ' if not old else ''}{fields['name']} · {RARITIES[fields['rarity']]['name']}")
    db().commit()
    refresh_catalog()

    # zdjęcia: plik > URL > Wikipedia (gdy zmienił się artykuł albo brak zdjęcia)
    warnings = []
    for alt in (False, True):
        suffix = "_alt" if alt else ""
        try:
            upload = request.files.get("image" + suffix)
            url = (f.get("image_url" + suffix) or "").strip()
            if upload and upload.filename:
                images.save(pid, upload.read(), alt)
            elif url:
                images.save_url(pid, url, alt)
            elif f.get("remove" + suffix) == "1":
                images.delete(pid, alt)
            elif not alt and fields["wiki"] and (not images.find(pid) or
                                                 (old and tuple(old.get("wiki") or ()) != tuple(fields["wiki"]))):
                if not images.fetch([pid], force=True).get(pid):
                    warnings.append("Nie znaleziono zdjęcia w artykule Wikipedii")
        except Exception as e:
            warnings.append(f"Zdjęcie{' alt' if alt else ''}: {e}")
    for v in catalog.photo_variants(pid):  # własne zdjęcie wariantu tej karty (Rzulty, Halloweenowa...)
        try:
            upload = request.files.get("image_v_" + v)
            url = (f.get("image_url_v_" + v) or "").strip()
            if upload and upload.filename:
                images.save(pid, upload.read(), v)
            elif url:
                images.save_url(pid, url, v)
            elif f.get("remove_v_" + v) == "1":
                images.delete(pid, v)
        except Exception as e:
            warnings.append(f"Zdjęcie wariantu {VARIANTS[v]['name']}: {e}")
    return jsonify({"ok": True, "id": pid, "warnings": warnings})


@app.delete("/api/admin/cards/<pid>")
@admin_required
def admin_delete_card(pid):
    p = catalog.PEOPLE.get(pid)
    if p is None:
        return jsonify({"error": "Nie ma takiej karty"}), 404
    log_admin("card_delete", details=f"{p['name']}{' (ukryta)' if p['builtin'] else ''}")
    if p["builtin"]:
        catalog.mark_deleted(db(), "catalog_cards", pid)
    else:
        catalog.remove_row(db(), "catalog_cards", pid)
        images.delete(pid)
        images.delete(pid, True)
    db().commit()
    refresh_catalog()
    return jsonify({"ok": True})


@app.post("/api/admin/cards/<pid>/restore")
@admin_required
def admin_restore_card(pid):
    if catalog.builtin_card(pid) is None:
        return jsonify({"error": "To nie jest wbudowana karta"}), 400
    catalog.remove_row(db(), "catalog_cards", pid)
    log_admin("card_restore", details=catalog.builtin_card(pid)["name"])
    db().commit()
    refresh_catalog()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- ustawienia wariantów (strona /variants)

def variant_settings_row(variant):
    row = db().execute("SELECT data FROM catalog_variants WHERE id = ?", (variant,)).fetchone()
    return (json.loads(row[0] or "{}") if row else {}).get("settings") or {}


def save_variant_settings(variant, settings):
    catalog.save_override(db(), "catalog_variants", variant, {"settings": catalog.clean_variant_settings(variant, settings)})
    db().commit()
    refresh_catalog()


def admin_variant_json(variant):
    """Wariant po zmianie - przeglądarka podmienia go w S.cfg (variants, variantCfg)."""
    return {"ok": True, "variant": VARIANTS[variant], "cfg": catalog.variant_cfg_json(variant, admin=True)}


def admin_variant_or_404(variant):
    if variant not in VARIANT_DEFAULTS:
        return jsonify({"error": "Nie ma takiego wariantu"}), 404
    return None


@app.post("/api/admin/variants/<variant>")
@admin_required
def admin_variant_save(variant):
    """Włączony / wyłączony, szansa (albo waga przy wariantach "always") i opis. null = wartość z kodu (data.py)."""
    err = admin_variant_or_404(variant)
    if err:
        return err
    if VARIANTS[variant].get("special"):
        return bad("Warianty kart specjalnych ustawia się przy samych kartach")
    body = request.get_json(force=True) or {}
    settings = variant_settings_row(variant)
    for k in ("enabled", "chance", "weight", "desc"):
        if k in body:
            settings[k] = body[k]
    save_variant_settings(variant, settings)
    s = catalog.VARIANT_CFG[variant]
    log_admin("variant_save", details=f"{VARIANTS[variant]['name']}: {'włączony' if catalog.variant_enabled(variant) else 'wyłączony'}"
                                      f" · szansa {VARIANTS[variant]['chance'] * 100:.3g}%"
                                      + (f" · waga {s['weight']}" if s["weight"] is not None else ""))
    db().commit()
    return jsonify(admin_variant_json(variant))


@app.post("/api/admin/variants/<variant>/events")
@admin_required
def admin_variant_event_add(variant):
    """Nowe wydarzenie: od - do (sekundy unix) wariant wypada z wybranych skrzynek (pusta lista = ze wszystkich)."""
    err = admin_variant_or_404(variant)
    if err:
        return err
    x = VARIANTS[variant]
    if x.get("special"):
        return bad("Warianty kart specjalnych nie wypadają ze skrzynek")
    body = request.get_json(force=True) or {}
    crates = [c for c in body.get("crates") or [] if c in catalog.CRATES and not catalog.CRATES[c]["special"]]
    ev = catalog.clean_variant_events([{**body, "crates": crates, "id": secrets.token_hex(4)}])
    if not ev:
        return bad("Ustaw początek i koniec (koniec po początku)")
    ev = ev[0]
    if ev["end"] <= time.time():
        return bad("To wydarzenie już by się skończyło")
    settings, now = variant_settings_row(variant), time.time()
    # wydarzenia skończone ponad 30 dni temu nie są już potrzebne - wystarczy jedno, żeby wariant był "w grze"
    events = settings.get("events") or []
    recent = [e for e in events if e.get("end", 0) > now - 30 * 86400]
    settings["events"] = [e for e in events if e not in recent][-1:] + recent + [ev]
    save_variant_settings(variant, settings)
    where = ", ".join(catalog.CRATES[c]["name"] for c in ev["crates"]) or "wszystkie skrzynki"
    log_admin("variant_event", details=f"{x['name']}: {datetime.datetime.fromtimestamp(ev['start']):%d.%m %H:%M} - "
                                       f"{datetime.datetime.fromtimestamp(ev['end']):%d.%m %H:%M} · {where}"
                                       + (f" · szansa ×{ev['boost']:g}" if ev["boost"] != 1 else ""))
    db().commit()
    return jsonify(admin_variant_json(variant))


@app.post("/api/admin/variants/<variant>/events/<eid>/delete")
@admin_required
def admin_variant_event_delete(variant, eid):
    """Usuwa zaplanowane wydarzenie; trwające - kończy teraz (zostaje w historii, żeby wariant był nadal "w grze")."""
    err = admin_variant_or_404(variant)
    if err:
        return err
    settings, now = variant_settings_row(variant), int(time.time())
    events = []
    for e in settings.get("events") or []:
        if e.get("id") != eid:
            events.append(e)
        elif e.get("start", 0) <= now:
            events.append(dict(e, end=max(e["start"] + 1, now)))
    settings["events"] = events
    save_variant_settings(variant, settings)
    log_admin("variant_event_stop", details=VARIANTS[variant]["name"])
    db().commit()
    return jsonify(admin_variant_json(variant))


# ---------------------------------------------------------------- naklejki wariantów (strona /stickers)
# Admin nakleja na wariant (np. MLG) wbudowane grafiki albo własne pliki PNG i ustawia je na karcie. Wgrany plik od razu
# trafia do image_cache (__stk_<wariant>__<id>.png), ale gracze widzą go dopiero po zapisaniu układu naklejek.

@app.post("/api/admin/stickers/<variant>/upload")
@admin_required
def admin_sticker_upload(variant):
    if variant not in STICKER_VARIANTS:
        return jsonify({"error": "Ten wariant nie ma naklejek"}), 404
    upload = request.files.get("image")
    if not upload or not upload.filename:
        return jsonify({"error": "Wybierz plik"}), 400
    sid = secrets.token_hex(4)
    try:
        images.save(catalog.sticker_file_id(variant), upload.read(), sid)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    path = images.find(catalog.sticker_file_id(variant), sid)
    v = int(os.path.getmtime(path)) % 10 ** 9
    return jsonify({"ok": True, "sticker": sticker_json(variant, catalog.clean_stickers([{"id": sid, "src": "upload", "v": v}])[0])})


@app.post("/api/admin/stickers/<variant>")
@admin_required
def admin_stickers_save(variant):
    """Standardowy układ naklejek wariantu naraz (kolejność = od spodu) - zmiany na pojedynczych kartach zostają."""
    if variant not in STICKER_VARIANTS:
        return jsonify({"error": "Ten wariant nie ma naklejek"}), 404
    stickers = with_sticker_files(variant, catalog.clean_stickers((request.get_json(force=True) or {}).get("stickers")))
    catalog.save_override(db(), "catalog_variants", variant, {"stickers": stickers})
    log_admin("stickers_save", details=f"{VARIANTS[variant]['name']}: {len(stickers)} naklejek")
    db().commit()
    refresh_catalog()
    drop_unused_stickers(variant)
    return jsonify({"ok": True, "stickers": [sticker_json(variant, s) for s in catalog.STICKERS.get(variant, [])],
                    # karty z własnymi naklejkami - ich listy po zmianie standardu
                    "cardStickers": {pid: [sticker_json(variant, s) for s in catalog.card_stickers(variant, pid)]
                                     for pid in catalog.STICKER_CARDS.get(variant, {}) if pid in catalog.PEOPLE}})


@app.post("/api/admin/stickers/<variant>/card/<pid>")
@admin_required
def admin_card_stickers_save(variant, pid):
    """Naklejki jednej karty: zmiany standardowych naklejek ("edits") i naklejki tylko tej karty ("extra").
    Pusty zapis = karta wraca do samych standardowych naklejek."""
    if variant not in STICKER_VARIANTS:
        return jsonify({"error": "Ten wariant nie ma naklejek"}), 404
    if pid not in catalog.PEOPLE:
        return jsonify({"error": "Nie ma takiej karty"}), 404
    own = catalog.clean_card_stickers(request.get_json(force=True))
    if own:
        own["extra"] = with_sticker_files(variant, own["extra"])
    row = db().execute("SELECT data FROM catalog_variants WHERE id = ?", (variant,)).fetchone()
    cards = (json.loads(row[0] or "{}").get("cards") or {}) if row else {}
    if own:
        cards[pid] = own
    else:
        cards.pop(pid, None)
    catalog.save_override(db(), "catalog_variants", variant, {"cards": cards})
    log_admin("stickers_card", details=f"{VARIANTS[variant]['name']} · {catalog.PEOPLE[pid]['name']}: "
                                       + (f"{len(own['edits'])} zmian, {len(own['extra'])} własnych" if own else "standardowe"))
    db().commit()
    refresh_catalog()
    drop_unused_stickers(variant)
    return jsonify({"ok": True, "card": admin_card_stickers_json(variant, pid),
                    "stickers": [sticker_json(variant, s) for s in catalog.card_stickers(variant, pid)]})


@app.get("/api/admin/stickers/<variant>")
@admin_required
def admin_stickers_get(variant):
    """Do edytora: standardowe naklejki i zmiany na pojedynczych kartach (surowe - edytor sam je nakłada)."""
    if variant not in STICKER_VARIANTS:
        return jsonify({"error": "Ten wariant nie ma naklejek"}), 404
    return jsonify({"stickers": [sticker_json(variant, s) for s in catalog.STICKERS.get(variant, [])],
                    "cards": {pid: admin_card_stickers_json(variant, pid) for pid in catalog.STICKER_CARDS.get(variant, {})}})


def admin_card_stickers_json(variant, pid):
    own = catalog.STICKER_CARDS.get(variant, {}).get(pid)
    return {"edits": own["edits"], "extra": [sticker_json(variant, s) for s in own["extra"]]} if own else None


def with_sticker_files(variant, stickers):
    """Wgrane naklejki tylko z istniejącym plikiem (mógł zniknąć, np. usunięty w innej karcie przeglądarki) i jego wersją."""
    out = []
    for s in stickers:
        if s["src"] == "upload":
            path = images.find(catalog.sticker_file_id(variant), s["id"])
            if not path:
                continue
            s["v"] = int(os.path.getmtime(path)) % 10 ** 9
        out.append(s)
    return out


def drop_unused_stickers(variant):
    """Usuwa wgrane pliki naklejek, których nie używa już żadna naklejka (także wgrane, ale niezapisane)."""
    images.delete_other_alts(catalog.sticker_file_id(variant), catalog.sticker_uploads(variant))


# ---------------------------------------------------------------- linki do kart specjalnych
# Admin tworzy link do karty specjalnej (źródło "link"): każdy gracz, który go otworzy, dostaje tę kartę - raz na link
# (tabela card_link_claims). max_uses = 0 - bez limitu graczy. Wyłączony link przestaje działać.

def link_card(person_id):
    p = catalog.PEOPLE.get(person_id)
    return p if catalog.is_special(p) and p["source"] == "link" else None


def link_json(r, users):
    p = catalog.PEOPLE.get(r["person_id"])
    return {"id": r["id"], "token": r["token"], "path": f"/link/{r['token']}", "person": r["person_id"],
            "name": p["name"] if p else r["person_id"], "variant": p["fixedVariant"] if p else None,
            "note": r["note"], "created": r["created_at"], "createdBy": users.get(r["created_by"]),
            "active": bool(r["active"]), "maxUses": r["max_uses"], "uses": r["uses"]}


@app.get("/api/admin/links")
@admin_required
def admin_links():
    users = {u["id"]: u["username"] for u in db().execute("SELECT id, username FROM users")}
    rows = db().execute("SELECT * FROM card_links ORDER BY id DESC").fetchall()
    claims = {}
    for c in db().execute("SELECT link_id, user_id, claimed_at FROM card_link_claims ORDER BY claimed_at DESC"):
        claims.setdefault(c["link_id"], []).append(users.get(c["user_id"], "?"))
    cards = [{"id": p["id"], "name": p["name"], "variant": p["fixedVariant"]}
             for p in catalog.PEOPLE.values() if link_card(p["id"])]
    return jsonify({"links": [dict(link_json(r, users), claimedBy=claims.get(r["id"], [])) for r in rows], "cards": cards})


@app.post("/api/admin/links")
@admin_required
def admin_link_create():
    body = request.get_json(force=True)
    p = link_card(body.get("person"))
    if p is None:
        return jsonify({"error": "Wybierz kartę specjalną ze źródłem „Link od admina”"}), 400
    try:
        max_uses = max(0, min(100_000, int(body.get("maxUses") or 0)))
    except (TypeError, ValueError):
        return jsonify({"error": "Limit graczy musi być liczbą"}), 400
    note = str(body.get("note") or "").strip()[:80]
    token = secrets.token_urlsafe(9)
    db().execute("INSERT INTO card_links (token, person_id, note, created_by, created_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)",
                 (token, p["id"], note, uid(), time.time(), max_uses))
    log_admin("link_create", details=f"{p['name']}{f' · {note}' if note else ''}{f' · max {max_uses}' if max_uses else ''}")
    db().commit()
    return jsonify({"ok": True, "path": f"/link/{token}"})


@app.post("/api/admin/links/<int:link_id>")
@admin_required
def admin_link_toggle(link_id):
    r = db().execute("SELECT * FROM card_links WHERE id = ?", (link_id,)).fetchone()
    if r is None:
        return jsonify({"error": "Nie ma takiego linku"}), 404
    active = bool(request.get_json(force=True).get("active"))
    db().execute("UPDATE card_links SET active = ? WHERE id = ?", (int(active), link_id))
    name = (catalog.PEOPLE.get(r["person_id"]) or {}).get("name", r["person_id"])
    log_admin("link_on" if active else "link_off", details=name + (f" · {r['note']}" if r["note"] else ""))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/links/<token>/claim")
@login_required
def link_claim(token):
    """Gracz otworzył link od admina: dostaje kartę specjalną (w jej jedynym wariancie) - każdy gracz raz na link."""
    lock_me()
    r = db().execute("SELECT * FROM card_links WHERE token = ?", (token,)).fetchone()
    p = link_card(r["person_id"]) if r else None
    if r is None or p is None or not r["active"]:
        return bad("Ten link nie działa (wyłączony albo nieprawidłowy)", 404)
    if db().execute("SELECT 1 FROM card_link_claims WHERE link_id = ? AND user_id = ?", (r["id"], uid())).fetchone():
        return bad("Ten link już wykorzystałeś — każdy gracz może go użyć tylko raz")
    if not db().execute("UPDATE card_links SET uses = uses + 1 WHERE id = ? AND (max_uses = 0 OR uses < max_uses)",
                        (r["id"],)).rowcount:
        return bad("Limit graczy dla tego linku już się wyczerpał")
    item = insert_item(p["id"], p["fixedVariant"], "link")
    db().execute("INSERT INTO card_link_claims (link_id, user_id, item_id, claimed_at) VALUES (?, ?, ?, ?)",
                 (r["id"], uid(), item["id"], time.time()))
    note_drops([item], "link")
    db().commit()
    return jsonify({"item": item, "state": get_state()})


@app.post("/api/admin/cards/<pid>/refetch")
@admin_required
def admin_refetch(pid):
    if pid not in catalog.PEOPLE:
        return jsonify({"error": "Nie ma takiej karty"}), 404
    main = images.fetch([pid], force=True).get(pid)
    return jsonify({"ok": True, "main": bool(main)})


@app.get("/api/admin/users")
@admin_required
def admin_users():
    stats = collection_stats()
    bal = {r[0]: r[1] for r in db().execute("SELECT user_id, value FROM user_state WHERE key = 'balance'")}
    access = {}
    for r in db().execute("SELECT user_id, crate_id FROM crate_access"):
        access.setdefault(r[0], []).append(r[1])
    users = [dict(brief(u, stats), balance=bal.get(u["id"], 0), created=u["created_at"], chests=get_chests(u["id"]),
                  banned=bool(u["banned"]), banReason=u["ban_reason"], access=access.get(u["id"], []),
                  rankingHidden=bool(u["ranking_hidden"]), moneyGenerated=bool(u["money_generated"]))
             for u in db().execute("SELECT * FROM users ORDER BY id")]
    restricted = [{"id": c["id"], "name": c["name"], "emoji": c["emoji"], "shop": c["shop"]}
                  for c in catalog.CRATES.values() if c["restricted"]]
    kinds = [{"kind": c["id"], "name": c["name"], "emoji": c["emoji"]} for c in catalog.CRATES.values() if not c["special"]]
    kinds += [{"kind": "money_" + k, "name": m["name"], "emoji": m["emoji"]} for k, m in MONEY_CHESTS.items()]
    return jsonify({"users": users, "me": uid(), "chestKinds": kinds, "restrictedCrates": restricted})


@app.post("/api/admin/users/<int:user_id>/ban")
@admin_required
def admin_ban(user_id):
    if user_id == uid():
        return jsonify({"error": "Nie możesz zablokować samego siebie"}), 400
    body = request.get_json(force=True)
    ban = bool(body.get("ban", True))
    reason = (body.get("reason") or "").strip()[:200] if ban else ""
    db().execute("UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?", (int(ban), reason, user_id))
    log_admin("ban" if ban else "unban", user_id, reason)
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/admin/users/<int:user_id>/ranking")
@admin_required
def admin_ranking_hidden(user_id):
    hidden = bool(request.get_json(force=True).get("hidden", True))
    db().execute("UPDATE users SET ranking_hidden = ? WHERE id = ?", (int(hidden), user_id))
    log_admin("ranking_hide" if hidden else "ranking_show", user_id)
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/admin/users/<int:user_id>/cards")
@admin_required
def admin_user_cards(user_id):
    rows = db().execute("SELECT person_id, variant, COUNT(*) AS n FROM items WHERE user_id = ? "
                        "GROUP BY person_id, variant", (user_id,)).fetchall()
    cards = []
    for r in rows:
        p = catalog.PEOPLE.get(r["person_id"])
        if p:
            cards.append({"person": p["id"], "name": p["name"], "rarity": p["rarity"], "variant": r["variant"],
                          "count": r["n"], "value": card_value(p, r["variant"])})
    order = RARITY_ORDER
    cards.sort(key=lambda c: (-order.index(c["rarity"]), c["name"], c["variant"]))
    return jsonify({"cards": cards, "variants": {k: v["name"] for k, v in VARIANTS.items()}})


@app.post("/api/admin/users/<int:user_id>/cards/delete")
@admin_required
def admin_delete_user_cards(user_id):
    body = request.get_json(force=True)
    conn = db()
    if body.get("all"):
        ids = [r[0] for r in conn.execute("SELECT id FROM items WHERE user_id = ?", (user_id,))]
    else:
        n = max(1, int(body.get("count") or 1))
        ids = [r[0] for r in conn.execute("SELECT id FROM items WHERE user_id = ? AND person_id = ? AND variant = ? "
                                          "ORDER BY id DESC LIMIT ?", (user_id, body.get("person"), body.get("variant"), n))]
    if ids:
        marks = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM items WHERE id IN ({marks})", ids)
        conn.execute(f"DELETE FROM showcase WHERE item_id IN ({marks})", ids)
        p = catalog.PEOPLE.get(body.get("person"))
        what = "wszystkie karty" if body.get("all") else \
            f"{p['name'] if p else body.get('person')} · {VARIANTS.get(body.get('variant'), {}).get('name', '?')}"
        log_admin("cards_delete", user_id, f"{len(ids)} szt. ({what})")
    conn.commit()
    return jsonify({"ok": True, "deleted": len(ids)})


@app.post("/api/admin/users/<int:user_id>/access")
@admin_required
def admin_set_access(user_id):
    crates = [c for c in request.get_json(force=True).get("crates", []) if c in catalog.CRATES]
    db().execute("DELETE FROM crate_access WHERE user_id = ?", (user_id,))
    for cid in crates:
        db().execute("INSERT INTO crate_access (user_id, crate_id) VALUES (?, ?) ON CONFLICT DO NOTHING", (user_id, cid))
    log_admin("access", user_id, ", ".join(catalog.CRATES[c]["name"] for c in crates) or "brak")
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/admin/users/<int:user_id>/chests")
@admin_required
def admin_give_chests(user_id):
    body = request.get_json(force=True)
    kind = body.get("kind") or ""
    try:
        count = int(body.get("count", 0))
    except (TypeError, ValueError):
        count = 0
    if not valid_chest_kind(kind) or not -1000 <= count <= 1000 or count == 0:
        return jsonify({"error": "Nieprawidłowa skrzynka lub ilość"}), 400
    if db().execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
        return jsonify({"error": "Nie ma takiego gracza"}), 404
    add_chests(kind, count, user_id)
    if count > 0:  # skrzynki od admina to darmowe pieniądze / karty
        mark_money_generated(user_id)
    log_admin("chests", user_id, f"{chest_name(kind)} {count:+}")
    db().commit()
    return jsonify({"ok": True, "chests": get_chests(user_id)})


@app.post("/api/admin/users/<int:user_id>/money")
@admin_required
def admin_money(user_id):
    try:
        amount = int(request.get_json(force=True).get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not -MAX_DEPOSIT <= amount <= MAX_DEPOSIT or amount == 0:
        return jsonify({"error": "Nieprawidłowa kwota"}), 400
    ensure_state(db(), user_id)
    add_state("balance", amount, user_id)
    if amount > 0:
        add_state("deposited", amount, user_id)
        mark_money_generated(user_id)
    log_admin("money", user_id, money_txt(amount))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/admin/users/<int:user_id>/admin")
@admin_required
def admin_toggle(user_id):
    if user_id == uid():
        return jsonify({"error": "Nie możesz odebrać uprawnień samemu sobie"}), 400
    db().execute("UPDATE users SET is_admin = 1 - is_admin WHERE id = ?", (user_id,))
    now_admin = db().execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
    log_admin("admin_grant" if now_admin and now_admin[0] else "admin_revoke", user_id)
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/admin/users/<int:user_id>/password")
@admin_required
def admin_password(user_id):
    pw = request.get_json(force=True).get("password") or ""
    if len(pw) < MIN_PASSWORD:
        return jsonify({"error": PASSWORD_ERROR}), 400
    db().execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(pw), user_id))
    log_admin("password", user_id)
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/admin/users/<int:user_id>")
@admin_required
def admin_delete_user(user_id):
    if user_id == uid():
        return jsonify({"error": "Nie możesz usunąć samego siebie"}), 400
    conn = db()
    log_admin("user_delete", user_id)  # przed usunięciem - żeby zapisać nazwę gracza
    market_forget_user(user_id)        # jego oferty na rynku i stół jackpota (pieniądze innych graczy wracają)
    blackjack_forget_user(user_id)     # rozdanie w trakcie i postawione w nim karty
    for sql in ("DELETE FROM items WHERE user_id = ?", "DELETE FROM user_state WHERE user_id = ?",
                "DELETE FROM user_discovered WHERE user_id = ?", "DELETE FROM daily_claims WHERE user_id = ?",
                "DELETE FROM user_collected WHERE user_id = ?",
                "DELETE FROM showcase WHERE user_id = ?", "DELETE FROM feed WHERE author_id = ? OR to_user_id = ?",
                "DELETE FROM user_chests WHERE user_id = ?", "DELETE FROM crate_access WHERE user_id = ?",
                "DELETE FROM arena_daily WHERE user_id = ?", "DELETE FROM card_link_claims WHERE user_id = ?",
                "DELETE FROM admin_message_seen WHERE user_id = ?",
                "DELETE FROM trade_lines WHERE trade_id IN (SELECT id FROM trades WHERE from_id = ? OR to_id = ?)",
                "DELETE FROM trades WHERE from_id = ? OR to_id = ?",
                "DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?", "DELETE FROM users WHERE id = ?"):
        conn.execute(sql, (user_id,) * sql.count("?"))
    conn.commit()
    return jsonify({"ok": True})


init_db()


def lan_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "?"


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    port = 5001 if TEST_MODE else 5000
    if "--port" in sys.argv:   # np. --port 5002, gdy domyślny port zajmuje inny program
        port = int(sys.argv[sys.argv.index("--port") + 1])
    # na Windowsie kilka kopii gry może słuchać na tym samym porcie - wtedy część zapytań trafia do starej wersji
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true" and port_in_use(port):
        print(f"\n  !!! Gra już działa (port {port} jest zajęty) - prawdopodobnie w innym czarnym oknie.")
        print("  Zamknij tamto okno (Ctrl+C) i uruchom grę jeszcze raz. To okno możesz zamknąć.\n")
        input("  Naciśnij Enter, aby zamknąć...")
        sys.exit(1)
    # w trybie debug Flask uruchamia proces dwa razy - pobieramy zdjęcia tylko w procesie roboczym
    if not DEV_MODE or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        images.prefetch_all_async()
        if LAN_MODE:
            print(f"\n  Znajomi w tej samej sieci wchodzą na:  http://{lan_address()}:{port}\n")
    if not DEV_MODE or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        print(f"\n  Gra działa na:  http://127.0.0.1:{port}   (baza: {database.describe(DB_PATH)})\n")
    app.run(host="0.0.0.0" if LAN_MODE else "127.0.0.1", port=port, debug=DEV_MODE and not LAN_MODE, threaded=True)
