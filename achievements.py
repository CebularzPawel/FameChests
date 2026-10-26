"""Osiągnięcia: definicje (z panelu admina, tabela `achievements`), liczniki zdarzeń gracza (`user_counters`) i sprawdzanie
warunków. Moduł nie zna bazy - liczniki i katalog podaje app.py. Osiągnięcie ma 1-2 warunki (oba muszą być spełnione) i
dowolnie wiele nagród (pieniądze, skrzynki, karty).

Warunek (`criteria`): {"type": ..., "count": n, ...}
  cards          karty zdobyte (każda zdobyta karta liczy się osobno, także duplikat): person / variant (albo oba) / rarity /
                 crate (rarity + crate razem); bez filtrów = wszystkie karty. "unique": różne osoby z klasera zamiast liczby zdobyć
  open           otwarte skrzynki: "crate" (puste = wszystkie)
  casino_plays   rozegrane gry w kasynie: "game" (puste = dowolna)
  casino_plays   ... "weekday" (0 = poniedziałek ... 6 = niedziela, puste = dowolny dzień): gry w ten dzień tygodnia
  casino_win     wygrane w kasynie: "game", opcjonalnie wygrana z postawioną kartą "person" / "variant"
  casino_streak  wygrane w kasynie z rzędu ("game" albo dowolna gra; remis / zwrot nie przerywa serii) - liczy się najlepsza seria
  drop_together  "persons": 2-4 karty, które wypadły naraz przy jednym otwieraniu skrzynek (ta sama karta może się powtarzać:
                 [kwaśniewski, kwaśniewski] = dwie takie karty naraz)

Warunki z kartami ("cards" bez "unique") liczą zdobyte karty (liczniki) albo karty, które gracz ma teraz w ekwipunku - co
większe; dzięki temu liczą się też karty z wymiany, rynku, jackpota i od admina (app.py: ach_owned).
  arena          "mode": win (wygrane walki) albo finisher (wygrana, a ostatni cios zadała karta "person")
"""

GAMES = {"roulette": "Ruletka", "blackjack": "Blackjack", "slots": "Jednoręki bandyta", "jackpot": "Jackpot",
         "horses": "Wyścigi konne"}
TYPES = {"cards": "Zdobyte karty", "open": "Otwarte skrzynki", "casino_plays": "Gry w kasynie",
         "casino_win": "Wygrane w kasynie", "casino_streak": "Wygrane w kasynie z rzędu",
         "drop_together": "Wypadnięcie kart naraz", "arena": "Arena"}
WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]
WEEKDAYS_IN = ["w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę", "w niedzielę"]
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


def play_events(game, weekday):
    """weekday: dzień tygodnia gry (0 = poniedziałek)."""
    return ["play:any", f"play:{game}", f"play:any:wd{weekday}", f"play:{game}:wd{weekday}"]


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
    return "dt:" + ",".join(sorted(persons))   # powtórzenia zostają: "dt:a,a" = dwie karty a naraz


def weekday_of(c):
    wd = c.get("weekday")
    return wd if isinstance(wd, int) and 0 <= wd <= 6 else None


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
        wd = weekday_of(c)
        return f"play:{c.get('game') or 'any'}" + (f":wd{wd}" if wd is not None else "")
    if t == "casino_streak":
        return f"beststreak:{c.get('game') or 'any'}"
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


def progress(c, counters, collected=(), owned=None):
    """(ile jest, ile trzeba) dla jednego warunku. collected: różne osoby z klasera - tylko dla "unique";
    owned: liczniki kart, które gracz ma teraz w ekwipunku (te same klucze co card_events) - dla "cards"."""
    need = max(1, int(c.get("count") or 1))
    if c.get("type") == "cards" and c.get("unique"):
        return min(len(collected), need), need
    key = criterion_key(c)
    cur = int(counters.get(key, 0))
    if c.get("type") == "cards" and owned:
        cur = max(cur, int(owned.get(key, 0)))
    return min(cur, need), need


def done(d, counters, collected_fn, owned=None):
    for c in d["criteria"]:
        cur, need = progress(c, counters, collected_fn(c) if c.get("unique") else (), owned)
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
        wd = weekday_of(c)
        return ("Zagraj w kasynie" + (f" ({achievements_game(c)})" if c.get("game") else "") +
                (f" {WEEKDAYS_IN[wd]}" if wd is not None else "") + f": {n}×")
    if t == "casino_streak":
        return f"Wygraj w kasynie {n} razy z rzędu" + (f" ({achievements_game(c)})" if c.get("game") else "")
    if t == "casino_win":
        extra = (f", stawiając kartę {person}" if person else "") + (f" w wariancie {variant}" if variant else "")
        return "Wygraj w kasynie" + (f" ({achievements_game(c)})" if c.get("game") else "") + extra + f": {n}×"
    if t == "drop_together":
        ps = c.get("persons") or []
        return "Wylosuj naraz (przy otwieraniu kilku skrzynek): " + ", ".join(
            (f"{ps.count(p)}× " if ps.count(p) > 1 else "") + names["person"](p) for p in dict.fromkeys(ps))
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
        wd = c.get("weekday")
        out["weekday"] = int(wd) if str(wd).isdigit() and 0 <= int(wd) <= 6 else ""
    elif t == "casino_streak":
        out["game"] = c.get("game") if c.get("game") in GAMES else ""
    elif t == "casino_win":
        out.update(game=c.get("game") if c.get("game") in GAMES else "", person=pid, variant=var)
    elif t == "drop_together":
        persons = [p for p in (c.get("persons") or []) if p in ctx["people"]]
        if not 2 <= len(persons) <= 4:
            return None, "Wybierz od 2 do 4 kart (ta sama karta może się powtarzać - np. dwie takie same naraz)"
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
    # ogólne (karty, skrzynki, kasyno, Arena) i z listy życzeń
    {'id': 'pierwsza_karta', 'name': 'Pierwsza karta', 'desc': 'Zdobądź swoją pierwszą kartę.', 'icon': '🃏', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 500}]},
    {'id': 'zbieracz_100', 'name': 'Zbieracz', 'desc': 'Zdobądź 100 kart.', 'icon': '🧺', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 100}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'chomik_500', 'name': 'Chomik', 'desc': 'Zdobądź 500 kart.', 'icon': '🐹', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 500}], 'rewards': [{'type': 'money', 'amount': 20000}]},
    {'id': 'kolekcjoner_2000', 'name': 'Kolekcjoner absolutny', 'desc': 'Zdobądź 2000 kart.', 'icon': '🏛️', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 2000}], 'rewards': [{'type': 'chest', 'kind': 'money_mega', 'count': 1}]},
    {'id': 'album_25', 'name': 'Album się zapełnia', 'desc': 'Miej w klaserze 25 różnych osób.', 'icon': '📖', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 25, 'unique': True}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'album_75', 'name': 'Prawie komplet', 'desc': 'Miej w klaserze 75 różnych osób.', 'icon': '📚', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'count': 75, 'unique': True}], 'rewards': [{'type': 'money', 'amount': 25000}]},
    {'id': 'epicka', 'name': 'Epicko!', 'desc': 'Wylosuj kartę Epicką.', 'icon': '💜', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'rarity': 'purple', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 1000}]},
    {'id': 'mityczna', 'name': 'Mit czy prawda?', 'desc': 'Wylosuj kartę Mityczną.', 'icon': '❤️\u200d🔥', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'rarity': 'red', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 3000}]},
    {'id': 'legendarna', 'name': 'Legenda', 'desc': 'Wylosuj kartę Legendarną.', 'icon': '🌟', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'rarity': 'gold', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 10000}]},
    {'id': 'ultra', 'name': 'ULTRA!', 'desc': 'Wylosuj kartę ULTRA.', 'icon': '🌈', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'rarity': 'ultra', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 25000}]},
    {'id': 'tajna', 'name': 'Tajemnica', 'desc': 'Zdobądź tajną kartę.', 'icon': '🕵️', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'cards', 'rarity': 'secret', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 50000}]},
    {'id': 'holo', 'name': 'Błyszczy się', 'desc': 'Zdobądź kartę Holo.', 'icon': '✨', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'holo', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 1000}]},
    {'id': 'zlota', 'name': 'Złota rączka', 'desc': 'Zdobądź Złotą kartę.', 'icon': '🥇', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'gold', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 2000}]},
    {'id': 'diament', 'name': 'Diamenty są wieczne', 'desc': 'Zdobądź Diamentową kartę.', 'icon': '💎', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'diamond', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 15000}]},
    {'id': 'galaktyka', 'name': 'Gwiezdny pył', 'desc': 'Zdobądź Galaktyczną kartę.', 'icon': '🌌', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'galaxy', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 20000}]},
    {'id': 'negatyw', 'name': 'Ciemna strona', 'desc': 'Zdobądź kartę Negatyw.', 'icon': '◐', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'negative', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 30000}]},
    {'id': 'pierwsza_skrzynka', 'name': 'Pierwsza skrzynka', 'desc': 'Otwórz swoją pierwszą skrzynkę.', 'icon': '📦', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'open', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 300}]},
    {'id': 'hazardzista_100', 'name': 'Hazardzista', 'desc': 'Otwórz 100 skrzynek.', 'icon': '🎁', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'open', 'count': 100}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'uzalezniony_1000', 'name': 'Uzależniony', 'desc': 'Otwórz 1000 skrzynek.', 'icon': '🫠', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'open', 'count': 1000}], 'rewards': [{'type': 'chest', 'kind': 'money_mega', 'count': 2}]},
    {'id': 'za_komuny', 'name': 'Za komuny było lepiej', 'desc': 'Otwórz 50 Skrzynek PRL.', 'icon': '☭', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'open', 'crate': 'prl', 'count': 50}], 'rewards': [{'type': 'money', 'amount': 3000}]},
    {'id': 'witamy_w_kasynie', 'name': 'Witamy w kasynie', 'desc': 'Zagraj w dowolną grę w kasynie.', 'icon': '🎰', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_plays', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 500}]},
    {'id': 'staly_bywalec', 'name': 'Stały bywalec', 'desc': 'Zagraj w kasynie 100 razy.', 'icon': '🍸', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_plays', 'count': 100}], 'rewards': [{'type': 'money', 'amount': 10000}]},
    {'id': 'pierwsza_wygrana', 'name': 'Dom nie zawsze wygrywa', 'desc': 'Wygraj grę w kasynie.', 'icon': '💸', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_win', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 1000}]},
    {'id': 'szczesciarz_50', 'name': 'Szczęściarz', 'desc': 'Wygraj w kasynie 50 razy.', 'icon': '🍀', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_win', 'count': 50}], 'rewards': [{'type': 'money', 'amount': 15000}]},
    {'id': 'czerwone_czarne', 'name': 'Czerwone czy czarne', 'desc': 'Zagraj w ruletkę 25 razy.', 'icon': '🎡', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_plays', 'game': 'roulette', 'count': 25}], 'rewards': [{'type': 'money', 'amount': 3000}]},
    {'id': 'oczko', 'name': 'Oczko', 'desc': 'Wygraj 10 rozdań w blackjacku.', 'icon': '🂡', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_win', 'game': 'blackjack', 'count': 10}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'na_koniku', 'name': 'Na koniku', 'desc': 'Wygraj zakład na wyścigach konnych.', 'icon': '🐎', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_win', 'game': 'horses', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 3000}]},
    {'id': 'zwyciezca_bierze_wszystko', 'name': 'Zwycięzca bierze wszystko', 'desc': 'Wygraj grę w jackpot.', 'icon': '💰', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'casino_win', 'game': 'jackpot', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'gladiator', 'name': 'Gladiator', 'desc': 'Wygraj walkę w Arenie.', 'icon': '⚔️', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'arena', 'mode': 'win', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 2000}]},
    {'id': 'karta_mi_zre', 'name': 'Karta mi dzisiaj żre', 'desc': 'Wygraj 3 gry w kasynie z rzędu.', 'icon': '🔥', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'casino_streak', 'count': 3}], 'rewards': [{'type': 'money', 'amount': 10000}]},
    {'id': 'wtorek_automaty', 'name': 'Wtorek automaty', 'desc': 'Zagraj w jednorękiego bandytę we wtorek.', 'icon': '📅', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'casino_plays', 'game': 'slots', 'weekday': 1, 'count': 1}], 'rewards': [{'type': 'money', 'amount': 2000}]},
    {'id': 'maga', 'name': 'Make America Great Again', 'desc': 'Wylosuj Flagową kartę Donalda Trumpa (w dowolnym połączeniu).', 'icon': '🇺🇸', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'cards', 'person': 'w_trump', 'variant': 'flag', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 20000}]},
    {'id': 'patriota', 'name': 'Patriota', 'desc': 'Wylosuj dowolną kartę Flagową.', 'icon': '🏳️', 'hidden': False, 'enabled': True, 'criteria': [{'type': 'cards', 'variant': 'flag', 'count': 1}], 'rewards': [{'type': 'money', 'amount': 5000}]},
    {'id': 'caly_litr', 'name': 'Cały litr', 'desc': 'Wylosuj dwie karty Aleksandra Kwaśniewskiego przy jednym otwieraniu skrzynek.', 'icon': '🍾', 'hidden': True, 'enabled': True, 'criteria': [{'type': 'drop_together', 'persons': ['pl_aleksander_kwasniewski', 'pl_aleksander_kwasniewski'], 'count': 1}], 'rewards': [{'type': 'money', 'amount': 10000}]},
]
