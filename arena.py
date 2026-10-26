"""Arena (mock-up minigry): silnik walki kartami liczony na serwerze.

Przeglądarka wysyła tylko ruchy (wystaw kartę, użyj zdolności, wróć na ławkę, koniec tury, poddanie),
serwer sprawdza zasady, liczy skutki i zapisuje kolejne "kroki" walki. Każdy krok ma zdarzenia do animacji
i stan planszy po ruchu - przeglądarka odtwarza je po kolei. Dzięki temu wynik jest pewny (nagrody za wygrane)
i dwóch graczy widzi tę samą walkę (pojedynki z innymi graczami).

Walki i wyzwania trzymamy w pamięci procesu (jak katalog - gunicorn ma 1 workera): restart serwera kończy
trwające walki. Strony w walce to "a" i "b"; gracz zawsze widzi siebie jako "me", a rywala jako "ai".
"""
import copy
import random
import secrets
import threading
import time

import catalog
from data import ARENA, ARENA_EFFECTS, TYPES, VARIANT_ORDER, VARIANTS

TURN_LIMIT = 80            # po tylu turach (obu graczy razem) remis
PVP_TURN_SECONDS = 90      # czas na turę w pojedynku z graczem - potem tura kończy się sama
PVP_AWAY_SECONDS = 120     # gracz bez kontaktu z serwerem tak długo przegrywa walkowerem
CHALLENGE_SECONDS = 120    # wyzwanie bez odpowiedzi wygasa
KEEP_FINISHED = 10 * 60    # zakończona walka zostaje w pamięci (wynik, nagrody) jeszcze 10 minut
KEEP_IDLE = 30 * 60        # porzucona walka z komputerem znika po 30 minutach
OWN_TICK = ("stun", "boost", "weaken", "burn", "poison")   # odliczane na końcu tury właściciela karty
OPP_TICK = ("taunt", "shield")                              # odliczane na końcu tury rywala (chronią przed nim)
OTHER = {"a": "b", "b": "a"}

_lock = threading.RLock()
BATTLES = {}      # id -> Battle
CHALLENGES = {}   # id -> wyzwanie (słownik)


class ArenaError(Exception):
    """Ruch niezgodny z zasadami - komunikat trafia do gracza."""


def person(pid):
    return catalog.PEOPLE[pid]


def card_cost(p):
    return ARENA["cardCost"].get(p["rarity"], 1)


def auto_cost(value):
    cost = 0
    for minimum, c in ARENA["abilityCost"]:
        if value >= minimum:
            cost = c
    return cost


def abilities(p):
    """Zdolności karty w walce - te same miejsca co w przeglądarce (0, 1 = zdolności karty, 2+ = dodatkowe)."""
    cfg = p.get("arena") or []
    raw = [{"slot": 0, "name": p.get("attack"), "kind": p.get("kind1") or "off", "value": p.get("dmg") or 0}]
    if p.get("attack2"):
        raw.append({"slot": 1, "name": p["attack2"], "kind": p.get("kind2") or "off", "value": p.get("dmg2") or 0})
    for i, a in enumerate(p.get("abilities") or []):
        raw.append({"slot": 2 + i, "name": a["name"], "kind": a["kind"], "value": a["value"]})
    out = []
    for a in raw:
        c = (cfg[a["slot"]] if a["slot"] < len(cfg) else None) or {}
        out.append(dict(a, visual=c.get("visual") or KIND_VISUAL.get(a["kind"], "hit"),
                        cost=c["cost"] if c.get("cost") is not None else auto_cost(a["value"]),
                        target=c.get("target") or ("enemy" if a["kind"] == "off" else "self"),
                        effects=c.get("effects") or []))
    return out


# domyślna animacja zdolności z jej rodzaju (admin może ustawić inną)
KIND_VISUAL = {"off": "hit", "def": "bubble", "heal": "hearts", "eco": "money"}


def has(u, sid):
    return any(x["id"] == sid for x in u["st"])


def st_val(u, sid):
    return sum(x.get("value") or 0 for x in u["st"] if x["id"] == sid)


def add_status(u, sid, value, turns):
    old = next((x for x in u["st"] if x["id"] == sid), None)
    if old:
        old["value"] = max(old["value"], value)
        old["turns"] = max(old["turns"], turns)
    else:
        u["st"].append({"id": sid, "value": value, "turns": turns})


def damage(u, amount, ev, pierce=False):
    """Obrażenia: najpierw tarcza, potem HP. Zwraca obrażenia, które trafiły w HP."""
    amount = max(0, round(amount))
    left = amount
    if not pierce:
        for s in [x for x in u["st"] if x["id"] == "shield"]:
            take = min(s["value"], left)
            s["value"] -= take
            left -= take
            if take:
                ev.append({"uid": u["uid"], "kind": "block", "amount": take})
    u["st"] = [x for x in u["st"] if not (x["id"] == "shield" and x["value"] <= 0)]
    hit = min(u["hp"], left)
    u["hp"] -= hit
    if left or not amount:
        ev.append({"uid": u["uid"], "kind": "dmg", "amount": left})
    return hit


def heal(u, amount, ev):
    if has(u, "poison"):
        ev.append({"uid": u["uid"], "kind": "text", "text": "☠️ nie leczy"})
        return
    h = min(u["maxHp"] - u["hp"], round(amount))
    u["hp"] += h
    ev.append({"uid": u["uid"], "kind": "heal", "amount": h})


def type_mult(attacker, target, dmg):
    tt = TYPES.get(person(target["pid"])["type"]) or {}
    at = person(attacker["pid"])["type"]
    if tt.get("weak") == at:
        return dmg * 2, "słabość ×2"
    if tt.get("resist") == at:
        return max(0, dmg - 20), "odporność −20"
    return dmg, ""


def needs_target(ab):
    return ab["target"] in ("enemy", "ally")


def new_side(name, user_id, deck, key, uid_start):
    bench = []
    for i, c in enumerate(deck):
        hp = person(c["pid"])["hp"]
        bench.append({"uid": uid_start + i, "pid": c["pid"], "variant": c["variant"], "side": key,
                      "hp": hp, "maxHp": hp, "st": [], "acted": False})
    return {"name": name, "user": user_id, "board": [], "bench": bench, "ko": [],
            "coins": 0, "maxCoins": 0, "actions": 0, "turnNo": 0, "coinPenalty": 0}


def ai_deck(deck, allowed_secret=()):
    """Talia komputera: te same rzadkości co talia gracza, losowe osoby, wariant tylko dla wyglądu."""
    used = {c["pid"] for c in deck}
    pool = [p for p in catalog.PEOPLE.values() if p.get("hp", 0) > 0
            and (p["rarity"] != "secret" or p["id"] in allowed_secret)]
    out = []
    for c in deck:
        r = person(c["pid"])["rarity"]
        opts = [p for p in pool if p["rarity"] == r and p["id"] not in used] or [p for p in pool if p["id"] not in used]
        p = random.choice(opts) if opts else pool[0]
        used.add(p["id"])
        variant = "normal" if random.random() < 0.7 else random.choice(
            [v for v in VARIANT_ORDER[1:] if not VARIANTS[v].get("exclusive")])  # bez wariantów wyjątkowych
        out.append({"pid": p["id"], "variant": variant})
    return out


class Battle:
    def __init__(self, mode, a, b, first="a"):
        """a / b: {"name", "user" (id albo None dla komputera), "deck", "hero" (dane do portretu)}"""
        now = time.time()
        self.id = secrets.token_urlsafe(9)
        self.mode = mode                      # "ai" (z komputerem) albo "pvp" (z innym graczem)
        self.lock = threading.RLock()
        self.sides = {"a": new_side(a["name"], a["user"], a["deck"], "a", 1),
                      "b": new_side(b["name"], b["user"], b["deck"], "b", 101)}
        self.heroes = {"a": a.get("hero"), "b": b.get("hero")}
        self.first = first
        self.active = first
        self.turn = 0
        self.over = None                      # None, "a", "b" albo "draw"
        self.reason = None
        self.steps = []
        self.auto = {"a": False, "b": False}  # admin: komputer gra za gracza (wtedy bez nagród)
        self.no_reward = False
        self.rewards = {}                     # strona -> nagroda (wpisuje app.py po zakończeniu)
        self.recorded = False
        self.last_use = None                  # (strona, id karty) ostatniego użytego ataku - do osiągnięć (kto zadał ostatni cios)
        self.seen = {"a": now, "b": now}
        self.turn_started = now
        self.created = self.touched = now
        self.finished_at = None

    # ------------------------------------------------------------ pomocnicze

    def all(self, k):
        s = self.sides[k]
        return s["board"] + s["bench"]

    def find(self, uid):
        for k in ("a", "b"):
            for u in self.all(k):
                if u["uid"] == uid:
                    return u
        return None

    def side_of_user(self, user_id):
        for k in ("a", "b"):
            if self.sides[k]["user"] == user_id:
                return k
        return None

    def pids(self):
        return {u["pid"] for k in ("a", "b") for u in self.all(k) + self.sides[k]["ko"]}

    def snapshot(self):
        return {"sides": copy.deepcopy({k: {kk: v for kk, v in s.items() if kk != "user"} for k, s in self.sides.items()}),
                "active": self.active, "first": self.first, "turn": self.turn, "over": self.over, "reason": self.reason}

    def push(self, kind, side=None, **data):
        self.steps.append(dict(data, n=len(self.steps) + 1, type=kind, side=side, state=self.snapshot()))

    def is_bot(self, k):
        return (self.mode == "ai" and k == "b") or self.auto[k]

    # ------------------------------------------------------------ zasady

    def why_cant_act(self, k, u):
        s = self.sides[k]
        if self.over or self.active != k:
            return "To nie twoja tura"
        if u not in s["board"]:
            return "Karta musi być na planszy"
        if u["acted"]:
            return "Ta karta już działała w tej turze"
        if has(u, "stun"):
            return "Karta jest ogłuszona 💫"
        if s["actions"] <= 0:
            return "Brak akcji ⚡"
        return None

    def valid_targets(self, k, u, ab):
        foe, own = self.sides[OTHER[k]]["board"], self.sides[k]["board"]
        if ab["target"] == "enemy":
            taunt = [t for t in foe if has(t, "taunt")]
            return taunt or list(foe)
        if ab["target"] == "ally":
            return list(own)
        return []

    def why_cant_use(self, k, u, ab):
        why = self.why_cant_act(k, u)
        if why:
            return why
        if self.sides[k]["coins"] < ab["cost"]:
            return f"Za mało monet (potrzeba {ab['cost']} 🪙)"
        if needs_target(ab) and not self.valid_targets(k, u, ab):
            return "Brak celu"
        return None

    def primary(self, k, u, ab, target):
        foe, own = list(self.sides[OTHER[k]]["board"]), list(self.sides[k]["board"])
        return [t for t in {"enemy": [target], "ally": [target], "self": [u], "all_enemies": foe,
                            "all_allies": own}[ab["target"]] if t]

    def resolve(self, k, u, ab, primary):
        s, foe_side, ev = self.sides[k], self.sides[OTHER[k]], []
        s["coins"] -= ab["cost"]
        s["actions"] -= 1
        u["acted"] = True
        dealt = 0
        if ab["kind"] == "off":
            for t in primary:
                base = max(0, ab["value"] + st_val(u, "boost") - st_val(u, "weaken"))
                dmg, note = type_mult(u, t, base)
                if note:
                    ev.append({"uid": t["uid"], "kind": "text", "text": note})
                dealt += damage(t, dmg, ev)
        elif ab["kind"] == "heal":     # lecząca: wartość = leczone HP
            for t in primary:
                heal(t, ab["value"], ev)
        elif ab["kind"] == "eco":      # ekonomiczna: wartość = monety na tę turę (najwyżej limit monet)
            gain = max(0, min(ab["value"], ARENA["maxCoins"] - s["coins"]))
            s["coins"] += gain
            ev.append({"uid": u["uid"], "kind": "text", "text": f"🪙 +{gain}"})
        else:                          # defensywna: wartość = osłona
            for t in primary:
                add_status(t, "shield", ab["value"], 1)
                ev.append({"uid": t["uid"], "kind": "shield", "amount": ab["value"]})
        for e in ab["effects"]:
            foe, own = foe_side["board"], s["board"]
            targets = {"target": primary, "self": [u], "all_allies": list(own), "all_enemies": list(foe),
                       "random_enemy": [random.choice(foe)] if foe else []}.get(e.get("target"), primary)
            info = ARENA_EFFECTS.get(e["id"], {"name": e["id"], "icon": "❔"})
            value = e.get("value") or 0
            if e["id"] == "heal":
                for t in targets:
                    heal(t, value, ev)
            elif e["id"] == "lifesteal":
                heal(u, dealt * value / 100, ev)
            elif e["id"] == "splash":
                for t in targets:
                    board = self.sides[t["side"]]["board"]
                    if t in board:
                        i = board.index(t)
                        for n in (board[i - 1] if i > 0 else None, board[i + 1] if i + 1 < len(board) else None):
                            if n:
                                damage(n, value, ev)
            elif e["id"] == "steal_coins":
                foe_side["coinPenalty"] += value
                ev.append({"uid": u["uid"], "kind": "text", "text": f"💰 −{value} 🪙 rywalowi"})
            elif e["id"] == "extra_action":
                s["actions"] = min(5, s["actions"] + value)
                ev.append({"uid": u["uid"], "kind": "text", "text": f"⚡ +{value} akcja"})
            elif e["id"] == "knockback":
                for t in targets:
                    if t["side"] != k and t in self.sides[t["side"]]["board"] and t["hp"] > 0:
                        ev.append({"uid": t["uid"], "kind": "text", "text": "🔁 na ławkę!"})
                        t["knock"] = True
            else:
                for t in targets:
                    add_status(t, e["id"], value, e.get("turns") or 1)
                    ev.append({"uid": t["uid"], "kind": "status", "text": f"{info['icon']} {info['name']}"})
        return ev

    def collect_ko(self):
        """Karty bez HP schodzą z planszy (K.O.), odrzucone ("Do ławki!") wracają na ławkę."""
        kos = []
        for k in ("a", "b"):
            s = self.sides[k]
            for u in list(s["board"]):
                knock = u.pop("knock", False)
                if u["hp"] <= 0:
                    s["board"].remove(u)
                    s["ko"].append(u)
                    kos.append(u["uid"])
                elif knock:
                    s["board"].remove(u)
                    s["bench"].append(u)
        return kos

    def finish(self, winner, reason):
        if self.over:
            return
        self.over = winner
        self.reason = reason
        self.finished_at = time.time()
        self.push("over", None, winner=winner, reason=reason)

    def check_win(self):
        if self.over:
            return True
        dead = {k: not self.all(k) for k in ("a", "b")}
        if dead["a"] and dead["b"]:
            self.finish("draw", "ko")
        elif dead["a"] or dead["b"]:
            self.finish("b" if dead["a"] else "a", "ko")
        return bool(self.over)

    # ------------------------------------------------------------ tury

    def start(self):
        self.push("start", self.first)
        self.start_turn(self.first)
        self.run_bots()

    def start_turn(self, k):
        s = self.sides[k]
        self.active = k
        self.turn += 1
        if self.turn > TURN_LIMIT:
            return self.finish("draw", "limit")
        s["turnNo"] += 1
        bonus = 1 if s["turnNo"] == 1 and k != self.first else 0   # drugi gracz: +1 moneta na start
        s["maxCoins"] = min(ARENA["maxCoins"], s["turnNo"]) + bonus
        s["coins"] = max(0, s["maxCoins"] - s["coinPenalty"])
        s["coinPenalty"] = 0
        s["actions"] = ARENA["actions"]
        ev = []
        for u in s["board"]:
            u["acted"] = False
            for sid in ("burn", "poison"):
                if has(u, sid):
                    damage(u, st_val(u, sid), ev, pierce=True)
        for u in s["bench"]:
            u["acted"] = False
        kos = self.collect_ko()
        self.turn_started = time.time()
        self.push("turn", k, ev=ev, kos=kos, bonus=bonus)
        self.check_win()

    def end_turn(self, k, timeout=False):
        if self.over or self.active != k:
            raise ArenaError("To nie twoja tura")

        def tick(u, ids):
            for x in u["st"]:
                if x["id"] in ids:
                    x["turns"] -= 1
            u["st"] = [x for x in u["st"] if x["turns"] > 0]

        for u in self.all(k):
            tick(u, OWN_TICK)
        for u in self.all(OTHER[k]):
            tick(u, OPP_TICK)
        self.push("end", k, timeout=timeout)
        self.start_turn(OTHER[k])

    # ------------------------------------------------------------ ruchy

    def place(self, k, uid):
        s = self.sides[k]
        u = next((x for x in s["bench"] if x["uid"] == uid), None)
        if self.over or self.active != k:
            raise ArenaError("To nie twoja tura")
        if u is None:
            raise ArenaError("Tej karty nie ma na ławce")
        cost = card_cost(person(u["pid"]))
        if len(s["board"]) >= ARENA["boardSlots"]:
            raise ArenaError("Plansza jest pełna")
        if s["coins"] < cost:
            raise ArenaError(f"Za mało monet ({cost} 🪙)")
        s["coins"] -= cost
        s["bench"].remove(u)
        s["board"].append(u)
        u["acted"] = False
        self.push("place", k, uid=uid, cost=cost)

    def retreat(self, k, uid):
        s = self.sides[k]
        u = next((x for x in s["board"] if x["uid"] == uid), None)
        if self.over or self.active != k:
            raise ArenaError("To nie twoja tura")
        if u is None:
            raise ArenaError("Tej karty nie ma na planszy")
        if s["actions"] <= 0:
            raise ArenaError("Brak akcji ⚡")
        s["actions"] -= 1
        s["board"].remove(u)
        s["bench"].append(u)
        self.push("retreat", k, uid=uid)

    def use(self, k, uid, ab_index, target_uid=None):
        u = next((x for x in self.sides[k]["board"] if x["uid"] == uid), None)
        if u is None:
            raise ArenaError("Karta musi być na planszy")
        abl = abilities(person(u["pid"]))
        if not isinstance(ab_index, int) or not 0 <= ab_index < len(abl):
            raise ArenaError("Nie ma takiej zdolności")
        ab = abl[ab_index]
        why = self.why_cant_use(k, u, ab)
        if why:
            raise ArenaError(why)
        target = None
        if needs_target(ab):
            target = self.find(target_uid)
            if target not in self.valid_targets(k, u, ab):
                raise ArenaError("Ten cel jest niedostępny")
        primary = self.primary(k, u, ab, target)
        ev = self.resolve(k, u, ab, primary)
        kos = self.collect_ko()
        self.push("use", k, uid=uid, ab=ab_index, primary=[t["uid"] for t in primary], ev=ev, kos=kos)
        self.last_use = (k, u["pid"])
        self.check_win()

    def surrender(self, k):
        self.finish(OTHER[k], "surrender")

    # ------------------------------------------------------------ komputer

    def ai_score(self, k, u, ab, target):
        foe = self.sides[OTHER[k]]
        eff_bonus = sum(25 + (e.get("value") or 0) * 0.3 for e in ab["effects"])
        if ab["kind"] == "off":
            targets = self.primary(k, u, ab, target)
            if not targets:
                return -1
            score = 0
            for t in targets:
                base = max(0, ab["value"] + st_val(u, "boost") - st_val(u, "weaken"))
                dmg = max(0, type_mult(u, t, base)[0] - st_val(t, "shield"))
                score += min(dmg, t["hp"]) + (400 + card_cost(person(t["pid"])) * 40 if dmg >= t["hp"] else 0)
        elif ab["kind"] == "heal":
            score = sum(min(ab["value"], t["maxHp"] - t["hp"]) for t in self.primary(k, u, ab, target)
                        if not has(t, "poison")) * 0.9 or -1
        elif ab["kind"] == "eco":
            s = self.sides[k]
            want = any(card_cost(person(b["pid"])) > s["coins"] for b in s["bench"]) and len(s["board"]) < ARENA["boardSlots"]
            score = min(ab["value"], ARENA["maxCoins"] - s["coins"]) * (35 if want else 4)
        else:
            hurt = any(x["hp"] < x["maxHp"] * 0.5 for x in self.sides[k]["board"])
            score = ab["value"] * (0.8 if hurt else 0.25)
            if not foe["board"]:
                score *= 0.3
        return score + eff_bonus - ab["cost"] * 15

    def ai_turn(self, k):
        s = self.sides[k]

        def place_all():   # wystaw karty: najmocniejsze, na które stać
            while not self.over and self.active == k and len(s["board"]) < ARENA["boardSlots"]:
                options = [u for u in s["bench"] if card_cost(person(u["pid"])) <= s["coins"]]
                if not options:
                    break
                options.sort(key=lambda u: (-card_cost(person(u["pid"])), -person(u["pid"])["hp"]))
                self.place(k, options[0]["uid"])

        # 1) wystaw karty
        place_all()
        # 2) akcje: najlepsza zdolność albo ratowanie słabej karty (powrót na ławkę + wystawienie mocniejszej)
        while not self.over and self.active == k and s["actions"] > 0:
            best = None
            for u in s["board"]:
                for i, ab in enumerate(abilities(person(u["pid"]))):
                    if self.why_cant_use(k, u, ab):
                        continue
                    for t in (self.valid_targets(k, u, ab) if needs_target(ab) else [None]):
                        sc = self.ai_score(k, u, ab, t)
                        if best is None or sc > best[0]:
                            best = (sc, u, i, t)
            weak = next((u for u in s["board"] if u["hp"] < u["maxHp"] * 0.3 and not u["acted"]), None)
            fresh = max((u for u in s["bench"] if card_cost(person(u["pid"])) <= s["coins"]),
                        key=lambda u: u["hp"], default=None)
            if weak and fresh and fresh["hp"] > weak["hp"] * 2 and (best is None or best[0] < 120):
                self.retreat(k, weak["uid"])
                self.place(k, fresh["uid"])
            elif best and best[0] > 0:
                self.use(k, best[1]["uid"], best[2], best[3]["uid"] if best[3] else None)
                place_all()   # zdolność ekonomiczna mogła dać monety na kolejną kartę
            else:
                break
        if not self.over and self.active == k:
            self.end_turn(k)

    def run_bots(self):
        """Tury komputera (i gracza z włączoną auto-grą) liczą się od razu - przeglądarka pokaże je po kolei."""
        while not self.over and self.is_bot(self.active):
            self.ai_turn(self.active)

    # ------------------------------------------------------------ czas (pojedynki)

    def tick(self, now=None):
        """Wywoływane przy każdym zapytaniu: koniec czasu tury, walkower za brak kontaktu."""
        now = now or time.time()
        self.touched = now
        if self.over or self.mode != "pvp":
            return
        for k in ("a", "b"):
            if now - self.seen[k] > PVP_AWAY_SECONDS:
                return self.finish(OTHER[k], "away")
        if now - self.turn_started > PVP_TURN_SECONDS:
            self.end_turn(self.active, timeout=True)
            self.run_bots()

    def turn_left(self):
        if self.over or self.mode != "pvp":
            return None
        return max(0, round(PVP_TURN_SECONDS - (time.time() - self.turn_started)))

    # ------------------------------------------------------------ widok dla gracza

    def view_state(self, state, me):
        """Stan z perspektywy gracza: on = "me", rywal = "ai"; karty na ręce rywala są zakryte."""
        name = {me: "me", OTHER[me]: "ai"}
        out = {"active": name[state["active"]], "first": name[state["first"]], "turn": state["turn"],
               "over": name.get(state["over"], state["over"]), "reason": state["reason"], "sides": {}}
        for k, s in state["sides"].items():
            v = dict(s)
            conv = (lambda u, vk=name[k]: dict(u, side=vk))
            v["board"] = [conv(u) for u in s["board"]]
            v["ko"] = [conv(u) for u in s["ko"]]
            v["bench"] = [conv(u) if k == me else {"uid": u["uid"], "side": name[k], "hidden": True} for u in s["bench"]]
            out["sides"][name[k]] = v
        return out

    def view_step(self, step, me):
        name = {me: "me", OTHER[me]: "ai"}
        v = {kk: vv for kk, vv in step.items() if kk != "state"}
        v["side"] = name.get(step["side"])
        if "winner" in step:
            v["winner"] = name.get(step["winner"], step["winner"])
        v["state"] = self.view_state(step["state"], me)
        return v

    def view(self, me, since=0):
        name = {me: "me", OTHER[me]: "ai"}
        return {"id": self.id, "mode": self.mode, "seen": len(self.steps),
                "steps": [self.view_step(s, me) for s in self.steps[since:]],
                "state": self.view_state(self.snapshot(), me),
                "heroes": {name[k]: h for k, h in self.heroes.items()},
                "turnLeft": self.turn_left(), "auto": self.auto[me],
                "rewards": self.rewards.get(me)}


# ---------------------------------------------------------------- rejestr walk i wyzwań

def cleanup(now=None):
    now = now or time.time()
    with _lock:
        for bid, b in list(BATTLES.items()):
            if (b.over and now - (b.finished_at or now) > KEEP_FINISHED) or now - b.touched > KEEP_IDLE:
                del BATTLES[bid]
        for cid, c in list(CHALLENGES.items()):
            if c["status"] == "pending" and now - c["created"] > CHALLENGE_SECONDS:
                c["status"] = "expired"
            if now - c["created"] > KEEP_FINISHED:
                del CHALLENGES[cid]


def add_battle(b):
    with _lock:
        BATTLES[b.id] = b
    return b


def get_battle(bid):
    with _lock:
        return BATTLES.get(bid)


def active_battle(user_id):
    """Trwająca walka gracza (najnowsza)."""
    with _lock:
        mine = [b for b in BATTLES.values() if not b.over and b.side_of_user(user_id)]
    return max(mine, key=lambda b: b.created) if mine else None


def last_battle(user_id):
    """Ostatnia walka gracza (także zakończona) - żeby po odświeżeniu strony zobaczyć wynik."""
    with _lock:
        mine = [b for b in BATTLES.values() if b.side_of_user(user_id)]
    return max(mine, key=lambda b: b.created) if mine else None


def new_challenge(from_user, to_user, deck):
    cleanup()
    with _lock:
        for c in CHALLENGES.values():
            if c["status"] == "pending" and c["from"] == from_user["id"]:
                c["status"] = "cancelled"     # nowe wyzwanie zastępuje poprzednie
        c = {"id": secrets.token_urlsafe(9), "from": from_user["id"], "to": to_user["id"],
             "fromUser": from_user, "toUser": to_user, "deck": deck, "status": "pending",
             "created": time.time(), "battle": None}
        CHALLENGES[c["id"]] = c
    return c


def get_challenge(cid):
    with _lock:
        return CHALLENGES.get(cid)


def challenges_for(user_id):
    cleanup()
    with _lock:
        incoming = [c for c in CHALLENGES.values() if c["to"] == user_id and c["status"] == "pending"]
        outgoing = [c for c in CHALLENGES.values() if c["from"] == user_id]
    outgoing = max(outgoing, key=lambda c: c["created"]) if outgoing else None
    return incoming, outgoing


def challenge_json(c):
    return {"id": c["id"], "from": c["fromUser"], "to": c["toUser"], "status": c["status"], "battle": c["battle"],
            "left": max(0, round(CHALLENGE_SECONDS - (time.time() - c["created"])))}
