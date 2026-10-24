"""Porównanie odpowiedzi API: wersja Python i wersja Rust na dwóch PUSTYCH bazach.

Ten sam scenariusz (2 graczy: skrzynki, kuźnia, znajomi, wymiana, rynek, kasyno, jackpot, admin, arena) na obu
serwerach, potem porównanie KSZTAŁTU odpowiedzi (klucze i typy - wartości są losowe).

    python server/tools/parity.py http://127.0.0.1:5057 http://127.0.0.1:5056
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, form=None):
        data, headers = None, {}
        if form is not None:
            boundary = "----parity"
            parts = []
            for k, v in form:
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n')
            data = ("".join(parts) + f"--{boundary}--\r\n").encode()
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req) as r:
                raw, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, None


def scenario(base):
    out = []
    a, b = Client(base), Client(base)

    def rec(name, who, method, path, body=None, form=None):
        status, data = who.call(method, path, body, form)
        out.append((name, status, data))
        return data or {}

    get = lambda name, who, path: rec(name, who, "GET", path)
    post = lambda name, who, path, body=None: rec(name, who, "POST", path, body if body is not None else {})

    post("register A", a, "/api/register", {"username": "Ala1", "password": "haslo1234"})
    post("register B", b, "/api/register", {"username": "Bob1", "password": "haslo1234"})
    post("register dup", b, "/api/register", {"username": "ala1", "password": "haslo1234"})
    post("login bad", Client(base), "/api/login", {"username": "Ala1", "password": "zle"})
    post("login ok", Client(base), "/api/login", {"username": "Bob1", "password": "haslo1234"})
    cfg = get("config", a, "/api/config")
    people = cfg.get("people", {})
    get("me", a, "/api/me")
    get("daily", a, "/api/daily")
    post("daily claim", a, "/api/daily/claim")
    post("daily claim again", a, "/api/daily/claim")
    post("money chest", a, "/api/chests/money", {"kind": "daily"})
    post("money chest none", a, "/api/chests/money", {"kind": "daily"})
    post("buy chests", a, "/api/chests/buy", {"crate": "pl", "count": 2})
    post("open owned", a, "/api/open", {"crate": "pl", "count": 2})
    post("open pl", a, "/api/open", {"crate": "pl", "count": 20})
    post("open world", a, "/api/open", {"crate": "world", "count": 20})
    post("open B", b, "/api/open", {"crate": "pl", "count": 20})
    post("open special", a, "/api/open", {"crate": "specjalne", "count": 1})
    post("open too many", a, "/api/open", {"crate": "pl", "count": 99})
    st = get("state", a, "/api/state")
    items = st.get("items", [])
    stb = get("state B", b, "/api/state")
    items_b = stb.get("items", [])
    rar = lambda it: people.get(it["person"], {}).get("rarity")

    post("favorite", a, "/api/favorite", {"ids": [items[-1]["id"]], "fav": True})
    post("sell fav", a, "/api/sell", {"ids": [items[-1]["id"]]})
    post("sell", a, "/api/sell", {"ids": [items[-2]["id"]]})
    greens = [it["id"] for it in items[:-2] if rar(it) == "green"]
    post("contract wrong", a, "/api/contract", {"ids": greens[:2]})
    if len(greens) >= 5:
        post("contract", a, "/api/contract", {"ids": greens[:5]})
    if len(greens) >= 10:
        post("contracts bulk", a, "/api/contracts", {"groups": [greens[5:10]]})
    st = get("state 2", a, "/api/state")
    items = [it for it in st.get("items", []) if not it["fav"]]
    post("upgrade", a, "/api/upgrade", {"ids": [items[0]["id"]], "mult": 2})
    post("upgrade wrong mult", a, "/api/upgrade", {"ids": [items[1]["id"]], "mult": 7})

    # znajomi, aktywność, wymiana
    post("friend req", a, "/api/friends/request", {"username": "Bob1"})
    get("friends B", b, "/api/friends")
    post("friend respond", b, "/api/friends/respond", {"username": "Ala1", "accept": True})
    post("friend req again", a, "/api/friends/request", {"username": "bob1"})
    get("search", a, "/api/users/search?q=bo")
    post("show", a, "/api/show", {"item_id": items[2]["id"], "to": "all", "message": "patrz"})
    get("feed B", b, "/api/feed")
    post("feed seen", b, "/api/feed/seen")
    st = get("state 3", a, "/api/state")
    items = [it for it in st.get("items", []) if not it["fav"]]
    want = items_b[0]
    post("trade money", a, "/api/trades", {"to": "Bob1", "give": [items[0]["id"]], "want": [], "moneyGive": 10})
    t = post("trade", a, "/api/trades", {"to": "Bob1", "give": [items[0]["id"]],
                                         "want": [{"person": want["person"], "variant": want["variant"], "count": 1}],
                                         "message": "wymiana?"})
    get("trades B", b, "/api/trades")
    post("trade accept", b, f"/api/trades/{t.get('id')}/accept")
    post("trade bad action", b, f"/api/trades/{t.get('id')}/decline")
    get("trades A", a, "/api/trades")
    post("showcase", a, "/api/showcase", {"ids": [items[1]["id"]]})
    post("profile", a, "/api/profile", {"avatar": "🐱"})
    post("profile card", a, "/api/profile", {"avatarCard": items[1]["person"], "avatarVariant": items[1]["variant"]})
    get("user profile", b, "/api/users/Ala1")
    get("user profile missing", b, "/api/users/nikt")
    get("ranking", a, "/api/ranking")
    get("hof", a, "/api/halloffame")
    get("patchnotes", a, "/api/patchnotes")
    post("patchnotes seen", a, "/api/patchnotes/seen")

    # rynek
    st = get("state 4", a, "/api/state")
    items = [it for it in st.get("items", []) if not it["fav"] and it["id"] not in st.get("showcase", [])]
    l1 = post("market list fixed", a, "/api/market/list", {"item": items[0]["id"], "kind": "fixed", "price": 50})
    post("market buy", b, f"/api/market/{l1.get('id')}/buy")
    l2 = post("market list auction", a, "/api/market/list", {"item": items[1]["id"], "kind": "auction", "price": 20,
                                                               "step": 5, "hours": 1})
    post("market bid low", b, f"/api/market/{l2.get('id')}/bid", {"amount": 1})
    post("market bid", b, f"/api/market/{l2.get('id')}/bid", {"amount": 25})
    post("market cancel bidded", a, f"/api/market/{l2.get('id')}/cancel")
    l3 = post("market list 3", a, "/api/market/list", {"item": items[2]["id"], "kind": "fixed", "price": 999})
    post("market offer", b, f"/api/market/{l3.get('id')}/offer", {"price": 100})
    mk = get("market A", a, "/api/market")
    offer = next((o for l in mk.get("listings", []) for o in l.get("offers", [])), {})
    post("market offer accept", a, f"/api/market/offers/{offer.get('id')}/accept")
    post("wanted", b, "/api/market/wanted", {"person": items[3]["person"], "variant": items[3]["variant"], "price": 40})
    mk = get("market B", b, "/api/market")
    wid = next((w["id"] for w in mk.get("wanted", [])), 0)
    post("wanted fill", a, f"/api/market/wanted/{wid}/fill", {"item": items[3]["id"]})
    post("wanted 2", b, "/api/market/wanted", {"person": items[4]["person"], "variant": "normal", "price": 10})
    mk = get("market B 2", b, "/api/market")
    wid = next((w["id"] for w in mk.get("wanted", []) if w["mine"]), 0)
    post("wanted cancel", b, f"/api/market/wanted/{wid}/cancel")
    get("market A final", a, "/api/market")

    # kasyno
    st = get("state 5", a, "/api/state")
    items = [it for it in st.get("items", []) if not it["fav"]]
    post("roulette", a, "/api/casino/roulette", {"ids": [items[0]["id"]], "bet": "red"})
    post("roulette bad", a, "/api/casino/roulette", {"ids": [items[1]["id"]], "bet": "nope"})
    post("bj deal", a, "/api/casino/blackjack/deal", {"ids": [items[2]["id"]]})
    get("bj state", a, "/api/casino/blackjack")
    post("bj stand", a, "/api/casino/blackjack/stand")
    post("bj stand gone", a, "/api/casino/blackjack/stand")
    j = post("jackpot create", a, "/api/casino/jackpot", {"public": True, "invites": "Bob1"})
    jid = (j.get("jackpot") or {}).get("id")
    post("jackpot join", b, f"/api/casino/jackpot/{jid}/join")
    get("jackpot list", b, "/api/casino/jackpot")
    post("jackpot ready early", a, f"/api/casino/jackpot/{jid}/ready", {"ready": True})
    post("jackpot cards A", a, f"/api/casino/jackpot/{jid}/cards", {"ids": [items[3]["id"]]})
    stb = get("state B 2", b, "/api/state")
    post("jackpot cards B", b, f"/api/casino/jackpot/{jid}/cards", {"ids": [stb["items"][0]["id"]]})
    post("jackpot settings", a, f"/api/casino/jackpot/{jid}/settings", {"public": False})
    post("jackpot ready A", a, f"/api/casino/jackpot/{jid}/ready", {"ready": True})
    post("jackpot ready B", b, f"/api/casino/jackpot/{jid}/ready", {"ready": True})
    post("jackpot seen", a, f"/api/casino/jackpot/{jid}/seen")
    get("me A", a, "/api/me")
    get("me B", b, "/api/me")

    # admin
    get("admin catalog", a, "/api/admin/catalog")
    get("admin users", a, "/api/admin/users")
    get("admin forbidden", b, "/api/admin/users")
    post("admin money", a, "/api/admin/users/2/money", {"amount": 500})
    post("admin chests", a, "/api/admin/users/2/chests", {"kind": "pl", "count": 2})
    post("admin ranking", a, "/api/admin/users/2/ranking", {"hidden": True})
    post("admin access", a, "/api/admin/users/2/access", {"crates": ["prl"]})
    get("admin user cards", a, "/api/admin/users/2/cards")
    post("admin msg", a, "/api/admin/messages", {"title": "Hej", "body": "Test", "start": 1, "end": 4102444800})
    get("admin msgs", a, "/api/admin/messages")
    get("me B msg", b, "/api/me")
    get("admin log", a, "/api/admin/log?limit=5")
    get("admin links", a, "/api/admin/links")
    post("admin link bad", a, "/api/admin/links", {"person": "pl_walesa"})
    c = post("admin crate", a, "/api/admin/crates", {"name": "Testowa Skrzynia", "price": 250, "weights": {"green": 50}})
    rec("admin card", a, "POST", "/api/admin/cards", form=[("name", "Testowa Karta"), ("crates", c.get("id", "")),
                                                    ("rarity", "blue"), ("type", "tv"), ("hp", "80"), ("dmg", "20"),
                                                    ("attack", "Cios"), ("country", "PL")])
    cat = get("admin catalog 2", a, "/api/admin/catalog")
    post("admin card restore bad", a, "/api/admin/cards/nie_ma/restore")
    rec("admin crate delete", a, "DELETE", f"/api/admin/crates/{c.get('id')}")
    rec("admin builtin card delete", a, "DELETE", "/api/admin/cards/pl_zenek")
    post("admin builtin card restore", a, "/api/admin/cards/pl_zenek/restore")

    # arena
    st = get("state 6", a, "/api/state")
    deck = []
    for it in st.get("items", []):
        if it["person"] not in deck and people.get(it["person"], {}).get("hp", 0) > 0:
            deck.append(it["person"])
    get("arena inbox", a, "/api/arena/inbox")
    post("arena bad deck", a, "/api/arena/start", {"deck": deck[:3]})
    bt = post("arena start", a, "/api/arena/start", {"deck": deck[:8]})
    post("arena end", a, f"/api/arena/battle/{bt.get('id')}/act", {"type": "end", "since": 1})
    get("arena battle", a, f"/api/arena/battle/{bt.get('id')}?since=0")
    post("arena surrender", a, f"/api/arena/battle/{bt.get('id')}/act", {"type": "surrender"})
    post("arena B forbidden", b, "/api/arena/start", {"deck": []})
    post("password", b, "/api/password", {"old": "haslo1234", "new": "nowehaslo1"})
    post("logout", b, "/api/logout")
    get("me after logout", b, "/api/me")
    return out


def shape(v):
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "str"
    if v is None:
        return "null"
    if isinstance(v, list):
        merged = None
        for x in v:
            merged = merge(merged, shape(x))
        return ["list", merged]
    return {k: shape(x) for k, x in v.items()}


def merge(a, b):
    if a is None:
        return b
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: merge(a.get(k), b.get(k)) for k in set(a) | set(b)}
    return a if a == b else a


def diff(a, b, path, out):
    if a == b:
        return
    if a == "null" or b == "null" or a is None or b is None:
        return  # losowe: np. "item": null przy przegranej
    if {a, b} <= {"int", "float"} if isinstance(a, str) and isinstance(b, str) else False:
        out.append(f"{path}: {a} vs {b}")
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: tylko w Rust")
            elif k not in b:
                out.append(f"{path}.{k}: tylko w Python")
            else:
                diff(a[k], b[k], f"{path}.{k}", out)
        return
    if isinstance(a, list) and isinstance(b, list):
        diff(a[1], b[1], path + "[]", out)
        return
    out.append(f"{path}: {a} vs {b}")


def main():
    py_base, rs_base = sys.argv[1], sys.argv[2]
    py, rs = scenario(py_base), scenario(rs_base)
    problems = 0
    for (name, s1, d1), (_, s2, d2) in zip(py, rs):
        out = []
        if s1 != s2:
            out.append(f"status {s1} vs {s2}")
        diff(shape(d1), shape(d2), "", out)
        if out:
            problems += 1
            print(f"--- {name}")
            for line in out[:25]:
                print("   ", line)
            if s1 != s2 or (isinstance(d1, dict) and "error" in d1) or (isinstance(d2, dict) and "error" in d2):
                print("    py:", json.dumps(d1, ensure_ascii=False)[:200])
                print("    rs:", json.dumps(d2, ensure_ascii=False)[:200])
    print(f"\n{len(py)} zapytań, różnice w {problems}")


if __name__ == "__main__":
    main()
