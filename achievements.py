"""Osiągnięcia: definicje (z panelu admina, tabela `achievements`), liczniki zdarzeń gracza (`user_counters`) i sprawdzanie
warunków. Moduł nie zna bazy - liczniki i katalog podaje app.py. Osiągnięcie ma 1-2 warunki (oba muszą być spełnione) i
dowolnie wiele nagród (pieniądze, skrzynki, karty).

Warunek (`criteria`): {"type": ..., "count": n, ...}
  cards          karty zdobyte (każda zdobyta karta liczy się osobno, także duplikat): person / variant (albo oba) / rarity /
                 crate (rarity + crate razem); bez filtrów = wszystkie karty. "unique": różne osoby z klasera zamiast liczby zdobyć
  open           otwarte skrzynki: "crate" (puste = wszystkie)
  casino_plays   rozegrane gry w kasynie: "game" (puste = dowolna)
  casino_win     wygrane w kasynie: "game", opcjonalnie wygrana z postawioną kartą "person" / "variant"
  drop_together  "persons": 2-4 karty, które wypadły naraz przy jednym otwieraniu skrzynek
  arena          "mode": win (wygrane walki) albo finisher (wygrana, a ostatni cios zadała karta "person")
"""

GAMES = {"roulette": "Ruletka", "blackjack": "Blackjack", "slots": "Jednoręki bandyta", "jackpot": "Jackpot",
         "horses": "Wyścigi konne"}
TYPES = {"cards": "Zdobyte karty", "open": "Otwarte skrzynki", "casino_plays": "Gry w kasynie",
         "casino_win": "Wygrane w kasynie", "drop_together": "Wypadnięcie kart naraz", "arena": "Arena"}
REWARD_TYPES = {"money": "Pieniądze", "chest": "Skrzynki", "card": "Karta"}
NAME_MAX, DESC_MAX, MAX_CRITERIA, MAX_REWARDS, MAX_COUNT = 60, 300, 2, 8, 10_000_000


def parts(variant):
    """Warianty składowe ("flag+gold" -> flag, gold)."""
    return [x for x in str(variant).split("+") if x]


# ---------------------------------------------------------------- liczniki

def card_events(person, variant):
    """Klucze liczników zwiększane, gdy gracz zdobywa kartę (person: słownik z katalogu)."""
    keys = ["cards", f"p:{person['id']}", f"r:{person['rarity']}"]
    vs = parts(variant)
    if len(vs) > 1:
        vs.append(variant)
    for v in vs:
        keys += [f"v:{v}", f"pv:{person['id']}:{v}"]
    for c in person.get("crates") or [person.get("crate")]:
        if c:
            keys += [f"c:{c}", f"rc:{person['rarity']}:{c}"]
    return keys


def play_events(game):
    return ["play:any", f"play:{game}"]


def win_events(game, cards):
    """Gracz wygrał grę w kasynie; cards = [(person_id, variant)] - karty, które postawił."""
    keys = ["win:any", f"win:{game}"]
    for g in ("any", game):
        for pid, variant in set(cards):
            keys.append(f"winp:{g}:{pid}")
            vs = parts(variant)
            if len(vs) > 1:
                vs.append(variant)
            for v in vs:
                keys += [f"winv:{g}:{v}", f"winpv:{g}:{pid}:{v}"]
    return list(dict.fromkeys(keys))


def open_events(crate_id, n):
    return {"open": n, f"open:{crate_id}": n}


def together_key(persons):
    return "dt:" + ",".join(sorted(persons))


def criterion_key(c):
    """Klucz licznika, z którego liczy się warunek (None - warunek liczony z klasera: "unique")."""
    t = c.get("type")
    if t == "cards":
        p, v, r, cr = (c.get(k) or "" for k in ("person", "variant", "rarity", "crate"))
        if p and v:
            return f"pv:{p}:{v}"
        return (f"p:{p}" if p else f"v:{v}" if v else f"rc:{r}:{cr}" if r and cr else f"r:{r}" if r
                else f"c:{cr}" if cr else "cards")
    if t == "open":
        return f"open:{c['crate']}" if c.get("crate") else "open"
    if t == "casino_plays":
        return f"play:{c.get('game') or 'any'}"
    if t == "casino_win":
        g, p, v = c.get("game") or "any", c.get("person") or "", c.get("variant") or ""
        return f"winpv:{g}:{p}:{v}" if p and v else f"winp:{g}:{p}" if p else f"winv:{g}:{v}" if v else f"win:{g}"
    if t == "drop_together":
        return together_key(c.get("persons") or [])
    if t == "arena":
        if c.get("mode") == "finisher":
            return f"arena:fin:{c['person']}" if c.get("person") else "arena:fin"
        return "arena:win"
    return None


def progress(c, counters, collected=()):
    """(ile jest, ile trzeba) dla jednego warunku. collected: [(person_id, variant)] z klasera - tylko dla "unique"."""
    need = max(1, int(c.get("count") or 1))
    if c.get("type") == "cards" and c.get("unique"):
        return min(len(collected), need), need
    return min(int(counters.get(criterion_key(c), 0)), need), need


def done(d, counters, collected_fn):
    for c in d["criteria"]:
        cur, need = progress(c, counters, collected_fn(c) if c.get("unique") else ())
        if cur < need:
            return False
    return True


# ---------------------------------------------------------------- opisy

def describe(c, names):
    """Opis warunku po polsku; names: {"person": f(id), "variant": f(key), "crate": f(id), "rarity": f(key)}."""
    n, t = int(c.get("count") or 1), c.get("type")
    person = names["person"](c["person"]) if c.get("person") else ""
    variant = names["variant"](c["variant"]) if c.get("variant") else ""
    if t == "cards":
        what = "kartę " + person if person else "karty"
        if variant:
            what += f" w wariancie {variant}"
        if not person and c.get("rarity"):
            what += f" rzadkości {names['rarity'](c['rarity'])}"
        if not person and c.get("crate"):
            what += f" ze skrzynki {names['crate'](c['crate'])}"
        return f"Zdobądź różne karty{what[5:]}: {n}" if c.get("unique") else f"Zdobądź {what}: {n}×"
    if t == "open":
        return "Otwórz skrzynki" + (f" „{names['crate'](c['crate'])}”" if c.get("crate") else "") + f": {n}×"
    if t == "casino_plays":
        return "Zagraj w kasynie" + (f" ({achievements_game(c)})" if c.get("game") else "") + f": {n}×"
    if t == "casino_win":
        extra = (f", stawiając kartę {person}" if person else "") + (f" w wariancie {variant}" if variant else "")
        return "Wygraj w kasynie" + (f" ({achievements_game(c)})" if c.get("game") else "") + extra + f": {n}×"
    if t == "drop_together":
        return "Wylosuj naraz (przy otwieraniu kilku skrzynek): " + ", ".join(names["person"](p) for p in c.get("persons") or [])
    if t == "arena":
        if c.get("mode") == "finisher":
            return f"Wygraj walkę w Arenie, zadając ostatni cios kartą {person or 'dowolną'}" + (f": {n}×" if n > 1 else "")
        return f"Wygraj walki w Arenie: {n}×"
    return "?"


def achievements_game(c):
    return GAMES.get(c.get("game"), "")


def reward_text(r, names):
    if r["type"] == "money":
        return f"{r['amount']} gr"
    if r["type"] == "chest":
        return f"{r['count']}× {names['crate'](r['kind'])}"
    return f"{r['count']}× {names['person'](r['person'])}" + (f" ({names['variant'](r['variant'])})" if r.get("variant") not in (None, "", "normal") else "")


# ---------------------------------------------------------------- walidacja (zapis z panelu admina)

def _num(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(float(str(v).replace(",", ".")))))
    except (TypeError, ValueError):
        return default


def clean_criterion(c, ctx):
    t = c.get("type")
    if t not in TYPES:
        return None, "Nieznany rodzaj warunku"
    out = {"type": t, "count": _num(c.get("count"), 1, MAX_COUNT, 1)}
    pid, var = c.get("person") or "", c.get("variant") or ""
    if pid and pid not in ctx["people"]:
        return None, "Warunek wskazuje kartę, której nie ma w grze"
    if var and var not in ctx["variants"]:
        return None, "Warunek wskazuje nieistniejący wariant"
    if t == "cards":
        out.update(person=pid, variant=var, rarity=c.get("rarity") if c.get("rarity") in ctx["rarities"] else "",
                   crate=c.get("crate") if c.get("crate") in ctx["crates"] else "", unique=bool(c.get("unique")))
        if out["unique"] and pid:    # "różne karty" nie ma sensu dla jednej konkretnej osoby
            out["unique"] = False
    elif t == "open":
        out["crate"] = c.get("crate") if c.get("crate") in ctx["crates"] else ""
    elif t == "casino_plays":
        out["game"] = c.get("game") if c.get("game") in GAMES else ""
    elif t == "casino_win":
        out.update(game=c.get("game") if c.get("game") in GAMES else "", person=pid, variant=var)
    elif t == "drop_together":
        persons = [p for p in dict.fromkeys(c.get("persons") or []) if p in ctx["people"]]
        if not 2 <= len(persons) <= 4:
            return None, "Wybierz od 2 do 4 różnych kart"
        out["persons"], out["count"] = persons, 1
    elif t == "arena":
        out.update(mode="finisher" if c.get("mode") == "finisher" else "win", person=pid if c.get("mode") == "finisher" else "")
    return out, None


def clean_reward(r, ctx):
    t = r.get("type")
    if t == "money":
        amount = _num(r.get("amount"), 1, 1_000_000_000, 0)
        return ({"type": "money", "amount": amount}, None) if amount else (None, "Podaj kwotę nagrody")
    if t == "chest":
        if r.get("kind") not in ctx["chests"]:
            return None, "Nieznana skrzynka w nagrodzie"
        return {"type": "chest", "kind": r["kind"], "count": _num(r.get("count"), 1, 1000, 1)}, None
    if t == "card":
        if r.get("person") not in ctx["people"]:
            return None, "Nagroda wskazuje kartę, której nie ma w grze"
        variant = r.get("variant") or "normal"
        if variant not in ctx["variants"] and variant != "normal":
            return None, "Nagroda wskazuje nieistniejący wariant"
        return {"type": "card", "person": r["person"], "variant": variant, "count": _num(r.get("count"), 1, 100, 1)}, None
    return None, "Nieznany rodzaj nagrody"


def clean(raw, ctx):
    """(definicja, None) albo (None, komunikat błędu). ctx: zbiory "people", "variants", "rarities", "crates", "chests"."""
    name = str(raw.get("name") or "").strip()[:NAME_MAX]
    if not name:
        return None, "Podaj nazwę osiągnięcia"
    crit = []
    for c in (raw.get("criteria") or [])[:MAX_CRITERIA]:
        cc, err = clean_criterion(c if isinstance(c, dict) else {}, ctx)
        if err:
            return None, err
        crit.append(cc)
    if not crit:
        return None, "Dodaj przynajmniej jeden warunek"
    rewards = []
    for r in (raw.get("rewards") or [])[:MAX_REWARDS]:
        rr, err = clean_reward(r if isinstance(r, dict) else {}, ctx)
        if err:
            return None, err
        rewards.append(rr)
    return {"name": name, "desc": str(raw.get("desc") or "").strip()[:DESC_MAX], "icon": (str(raw.get("icon") or "🏆").strip() or "🏆")[:8],
            "hidden": bool(raw.get("hidden")), "enabled": bool(raw.get("enabled", True)),
            "criteria": crit, "rewards": rewards}, None


# ---------------------------------------------------------------- wbudowane osiągnięcia (dopisywane raz, admin może je zmienić / usunąć)
# Osiągnięcia bez wskazanej karty ("person": "") są wyłączone, dopóki admin nie wybierze karty w panelu.

DEFAULTS = [
    {"id": "dwoch_papiezy", "name": "Dwóch papieży", "desc": "Zdobądź dwie karty Jan Paweł II.", "icon": "✝️", "hidden": False,
     "enabled": True, "criteria": [{"type": "cards", "person": "pl_secret", "count": 2}],
     "rewards": [{"type": "money", "amount": 50_000}]},
    {"id": "bestia_z_wadowic", "name": "Bestia z Wadowic",
     "desc": "Wygraj walkę w Arenie, zadając ostatni cios kartą Jana Pawła II.", "icon": "🥊", "hidden": True, "enabled": True,
     "criteria": [{"type": "arena", "mode": "finisher", "person": "pl_secret", "count": 1}],
     "rewards": [{"type": "money", "amount": 50_000}]},
    {"id": "o_dwoch_takich", "name": "O dwóch takich co ukradli księżyc",
     "desc": "Przy otwieraniu kilku skrzynek naraz wylosuj Lecha i Jarosława Kaczyńskich.", "icon": "🌙", "hidden": True,
     "enabled": False, "criteria": [{"type": "drop_together", "persons": ["", "pl_kaczynski"], "count": 1}],
     "rewards": [{"type": "card", "person": "pl_tusk", "variant": "normal", "count": 1}]},
    {"id": "3000_lat_temu", "name": "3000 lat temu", "desc": "Wylosuj Diamentowego Netanjahu.", "icon": "💎", "hidden": True,
     "enabled": False, "criteria": [{"type": "cards", "person": "", "variant": "diamond", "count": 1}],
     "rewards": [{"type": "money", "amount": 100_000}]},
]
