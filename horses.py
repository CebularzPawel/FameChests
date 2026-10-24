"""Wyścigi konne: symulacja przebiegu wyścigu na okrągłym torze.

Wynik zależy tylko od ziarna (seed) - ten sam wyścig da się policzyć ponownie (wspólny wyścig co kilka minut jest
liczony z ziarna wyprowadzonego z tajnego klucza serwera). Pozycje koni to liczba okrążeń od linii startu (ułamek =
miejsce na torze), co "dt" sekund. Przeglądarka tylko odtwarza przebieg i zdarzenia (turbo, zawrócenie, upadek, śmierć,
samochód). Ustawienia w data.py (HORSE_RACE, HORSES).

    python horses.py odds [liczba wyścigów]   - symulacja szans (do wpisania "pays" w data.py)
"""
import math
import random
import sys

from data import HORSES, HORSE_ITEMS, HORSE_RACE as R

SCALE = 10000   # pozycje w odpowiedzi jako liczby całkowite (1 okrążenie = SCALE), żeby JSON był mały


def _circ(d):
    """Różnica pozycji na okręgu, w zakresie [0, 1)."""
    return d % 1.0


def simulate(seed):
    rnd = random.Random(seed)
    n, dt, laps = len(HORSES), R["dt"], R["laps"]
    D = rnd.uniform(*R["duration"])          # mniej więcej tyle jedzie lider
    v0 = laps / D
    strength = [h["speed"] + rnd.gauss(0, R["formSpread"]) for h in HORSES]
    sigma = R["noise"] * math.sqrt(2 / R["noiseTau"])   # szum "formy": stały odchył R["noise"], pamięć noiseTau s

    # zaplanowane zdarzenia: (czas, rodzaj, koń) - wykonują się, jeśli koń jeszcze jedzie
    plan = []
    if rnd.random() < R["turboChance"]:
        h = rnd.randrange(n)
        plan.append((D * rnd.uniform(0.1, 0.7), "turbo", h))
        if rnd.random() < R["turboAgain"]:
            plan.append((D * rnd.uniform(0.1, 0.7), "turbo", rnd.choice([i for i in range(n) if i != h])))
    if rnd.random() < R["turnChance"]:
        plan.append((D * rnd.uniform(0.1, 0.8), "turn", rnd.randrange(n)))
    if rnd.random() < R["dieChance"]:
        plan.append((D * rnd.uniform(0.1, 0.9), "die", rnd.randrange(n)))
    car_at = D * rnd.uniform(0.25, 0.65) if rnd.random() < R["carChance"] else None
    car_x0 = rnd.random()
    plan.sort()

    # skrzynki z przedmiotami: bx[koń][okrążenie][rząd] - czy jest (pierwsze okrążenie zawsze, potem losowo)
    rows = R["boxRows"]
    bx = [[[L == 0 or rnd.random() < R["boxRespawn"] for _ in rows] for L in range(laps)] for _ in range(n)]
    bx0 = [[list(lap) for lap in b] for b in bx]
    held = [None] * n                          # przedmiot w "kieszeni"
    use_at = [0.0] * n
    boost_until, boost_mult = [0.0] * n, [1.0] * n
    slow_until, slow_mult = [0.0] * n, [1.0] * n
    star_until = [0.0] * n
    bananas, rockets = [], []                  # leżące skórki i lecące rakiety
    item_seq = 0
    item_names = list(HORSE_ITEMS)

    x = [0.0] * n
    f = [0.0] * n                              # odchył formy (szum)
    dr = [1] * n                               # kierunek: 1 do przodu, -1 zawrócił
    state = ["run"] * n                        # run / fin / dead / left
    down = [0.0] * n                           # do kiedy leży po upadku
    burst = [(0.0, 1.0)] * n                   # (do kiedy, mnożnik) - zryw albo potknięcie
    turbo = [0.0] * n                          # ile okrążeń turbo jeszcze zostało
    fin_t = [None] * n
    xs = [[] for _ in range(n)]
    events = []
    car = None                                 # [pozycja, czas wjazdu]
    car_xs = []
    car_dead = False
    winner, end_t = -1, None
    max_t = D * 2.2
    i = 0
    while True:
        t = i * dt
        for h in range(n):
            xs[h].append(round(x[h] * SCALE))
        car_xs.append(round(car[0] * SCALE) if car else None)
        if end_t is not None and t >= end_t:
            break
        if t > max_t:
            break
        # --- zdarzenia z planu
        while plan and plan[0][0] <= t:
            _t, kind, h = plan.pop(0)
            if state[h] != "run" or dr[h] < 0:
                continue
            if kind == "turbo" and turbo[h] <= 0:
                turbo[h] = rnd.uniform(*R["turboLaps"])
                events.append({"t": round(t, 2), "k": "turbo", "h": h})
            elif kind == "turn":
                dr[h] = -1
                state[h] = "left"
                events.append({"t": round(t, 2), "k": "turn", "h": h})
            elif kind == "die":
                state[h] = "dead"
                events.append({"t": round(t, 2), "k": "die", "h": h})
        if car_at is not None and car is None and t >= car_at:
            car = [car_x0, t]
            events.append({"t": round(t, 2), "k": "car", "x": round(car_x0, 3)})
        # --- ruch koni
        prev = x[:]
        for h in range(n):
            if state[h] in ("dead",):
                continue
            f[h] += -f[h] / R["noiseTau"] * dt + sigma * math.sqrt(dt) * rnd.gauss(0, 1)
            if burst[h][0] <= t:
                burst[h] = (0.0, 1.0)
                r = rnd.random()
                if r < dt / 35:
                    burst[h] = (t + rnd.uniform(2, 5), 1.14)       # zryw
                elif r < dt / 35 + dt / 70:
                    burst[h] = (t + rnd.uniform(1.5, 3), 0.55)     # potknięcie
            mult = max(0.25, 1 + R["strength"] * strength[h] + f[h]) * burst[h][1]
            if t < boost_until[h]:
                mult *= boost_mult[h]
            if t < slow_until[h]:
                mult *= slow_mult[h]
            if t < star_until[h]:
                mult *= 1.5
            if t < down[h]:
                v = 0.0
            elif turbo[h] > 0:
                v = v0 * R["turboMult"]
                turbo[h] -= v * dt
                if turbo[h] <= 0:
                    events.append({"t": round(t, 2), "k": "turbo_end", "h": h})
            else:
                v = v0 * mult
            if state[h] == "fin":
                v = v0 * 0.5      # po mecie truchta
            x[h] += dr[h] * v * dt
            if state[h] == "run" and dr[h] > 0 and x[h] >= laps:
                state[h] = "fin"
                fin_t[h] = t + (laps - prev[h]) / max(x[h] - prev[h], 1e-9) * dt
                if winner < 0 or fin_t[h] < fin_t[winner]:
                    winner = h
                if end_t is None:
                    end_t = t + R["tail"]
        # --- skrzynki: koń, który przejechał przez rząd, dostaje przedmiot (rzadsze dla liderów)
        order = sorted((h for h in range(n) if state[h] == "run" and dr[h] > 0), key=lambda k: -x[k])
        for h in order:
            if held[h] is not None or t < down[h]:
                continue
            for L in range(laps):
                for r, pos in enumerate(rows):
                    if bx[h][L][r] and prev[h] < L + pos <= x[h]:
                        bx[h][L][r] = False
                        grp = min(2, order.index(h) * 3 // n)
                        item = rnd.choices(item_names, weights=[HORSE_ITEMS[k]["w"][grp] for k in item_names])[0]
                        held[h] = item
                        use_at[h] = t + rnd.uniform(*R["itemDelay"])
                        events.append({"t": round(t, 2), "k": "box", "h": h, "it": item, "lap": L, "row": r})
        # --- używanie przedmiotów (konie są "sterowane" przez komputer)
        def immune(k):
            return t < star_until[k] or turbo[k] > 0
        def ahead(h, lim):
            c = [k for k in order if k != h and 0.004 < x[k] - x[h] < lim]
            return min(c, key=lambda k: x[k] - x[h]) if c else None
        def behind(h, lim):
            c = [k for k in order if k != h and 0.004 < x[h] - x[k] < lim]
            return min(c, key=lambda k: x[h] - x[k]) if c else None
        for h in range(n):
            it = held[h]
            if it is None or t < use_at[h] or state[h] != "run" or t < down[h]:
                continue
            tgt = None
            if it == "banana":
                tgt = behind(h, 0.3)
            elif it in ("rocket", "snail"):
                tgt = ahead(h, 0.5)
            if it in ("banana", "rocket", "snail") and tgt is None:
                if t > use_at[h] + 8:      # nikt w zasięgu - przedmiot się marnuje
                    held[h] = None
                    events.append({"t": round(t, 2), "k": "use", "h": h, "it": ""})
                continue
            held[h] = None
            events.append({"t": round(t, 2), "k": "use", "h": h, "it": it})
            if it == "banana":
                item_seq += 1
                bananas.append({"id": item_seq, "x": x[h] - 0.004, "lane": tgt, "t": t})
                events.append({"t": round(t, 2), "k": "banana", "h": h, "id": item_seq, "lane": tgt, "x": round(x[h] - 0.004, 4)})
            elif it == "rocket":
                item_seq += 1
                ev = {"t": round(t, 2), "k": "rocket", "h": h, "to": tgt, "id": item_seq, "x0": round(x[h], 4)}
                events.append(ev)
                rockets.append({"id": item_seq, "x": x[h], "to": tgt, "t": t, "ev": ev})
            elif it == "mushroom":
                d = round(rnd.uniform(2.5, 3.5), 1)
                boost_until[h], boost_mult[h] = t + d, 2.2
                events.append({"t": round(t, 2), "k": "boost", "h": h, "d": d})
            elif it == "snail":
                if immune(tgt):
                    events.append({"t": round(t, 2), "k": "slow", "h": tgt, "by": h, "d": 0, "blocked": True})
                else:
                    d = round(rnd.uniform(3, 4.5), 1)
                    slow_until[tgt], slow_mult[tgt] = t + d, 0.45
                    events.append({"t": round(t, 2), "k": "slow", "h": tgt, "by": h, "d": d})
            elif it == "lightning":
                d = round(rnd.uniform(2.5, 3.5), 1)
                for k in range(n):
                    if k != h and state[k] == "run" and not immune(k):
                        slow_until[k], slow_mult[k] = t + d, 0.5
                events.append({"t": round(t, 2), "k": "bolt", "h": h, "d": d})
            elif it == "star":
                star_until[h] = t + 5
                events.append({"t": round(t, 2), "k": "star", "h": h, "d": 5})
        # --- skórki leżą na torze, dopóki ktoś się o nie nie poślizgnie
        for b in bananas[:]:
            j = b["lane"]
            ended = None
            if state[j] == "run" and dr[j] > 0 and prev[j] < b["x"] <= x[j]:
                if immune(j):
                    ended = False
                else:
                    d = round(rnd.uniform(1.6, 2.6), 1)
                    down[j] = t + d
                    events.append({"t": round(t, 2), "k": "trip", "h": j, "by": "banana", "d": d})
                    ended = True
            elif t - b["t"] > 25 or state[j] != "run":
                ended = False
            if ended is not None:
                bananas.remove(b)
                events.append({"t": round(t, 2), "k": "banana_end", "id": b["id"], "hit": ended})
        # --- rakiety lecą do konia przed sobą
        for rk in rockets[:]:
            rk["x"] += 0.3 * dt
            j = rk["to"]
            res = None
            if state[j] != "run" or dr[j] < 0 or t - rk["t"] > 8:
                res = "gone"
            elif rk["x"] >= x[j]:
                res = "blocked" if immune(j) else "hit"
            if res:
                rockets.remove(rk)
                rk["ev"]["t1"] = round(t, 2)
                rk["ev"]["res"] = res
                if res == "hit":
                    d = round(rnd.uniform(2.2, 3.6), 1)
                    down[j] = t + d
                    events.append({"t": round(t, 2), "k": "trip", "h": j, "by": "rocket", "d": d})
        # --- potknięcia o siebie: koń tuż za innym koniem jadącym w tę samą stronę może upaść
        run = [h for h in range(n) if state[h] == "run" and dr[h] > 0 and t >= down[h]] if t > 10 else []   # na starcie tłok - bez upadków
        for a in run:
            for b in run:
                if a == b or t < down[b] or t < down[a]:
                    continue
                gap = _circ(x[a] - x[b])          # b jest tuż za a
                if 0 < gap < R["tripGap"] and turbo[a] <= 0 and turbo[b] <= 0 and rnd.random() < R["tripChance"]:
                    d = round(rnd.uniform(2.5, 4.5), 1)
                    down[b] = t + d
                    events.append({"t": round(t, 2), "k": "trip", "h": b, "o": a, "d": d})
                    if rnd.random() < 0.3:
                        down[a] = t + d * 0.7
                        events.append({"t": round(t, 2), "k": "trip", "h": a, "o": b, "d": round(d * 0.7, 1)})
        # --- samochód jedzie pod prąd i przejeżdża konie, które spotka
        if car is not None:
            old = car[0]
            car[0] = (car[0] - 0.42 * dt) % 1.0
            for h in range(n):
                if state[h] == "dead":
                    continue
                u_old, u_new = _circ(old - prev[h]), _circ(car[0] - x[h])
                if u_new > u_old or u_new < 0.025:
                    state[h] = "dead"
                    car_dead = True
                    events.append({"t": round(t, 2), "k": "die", "h": h, "by": "car"})
            if all(s == "dead" for s in state):
                car_dead = True
            if t - car[1] > 14 or all(s == "dead" for s in state):
                events.append({"t": round(t, 2), "k": "car_end"})
                car = None
                car_at = None
        # --- koniec: nikt już nie jedzie do mety
        if end_t is None and not any(s == "run" and dr[h] > 0 for h, s in enumerate(state)):
            end_t = t + 4
        i += 1
    out = {h: s for h, s in enumerate(state) if s in ("dead", "left")}
    return {"dt": dt, "laps": laps, "rows": list(rows), "bx0": [[[int(v) for v in lap] for lap in b] for b in bx0], "dur": round(i * dt, 2), "x": xs, "car": car_xs if any(e["k"] == "car" for e in events) else None,
            "events": events, "winner": winner if state.count("dead") < n else -1,
            "out": out, "scale": SCALE, "carKill": car_dead and winner < 0}


def odds(runs=400):
    """Szanse wygranej każdego konia i średnia liczba zdarzeń - do ustawienia "pays" (zwrot ok. 90%)."""
    wins = [0] * len(HORSES)
    none = 0
    kinds = {}
    dur = 0
    for s in range(runs):
        r = simulate(10_000 + s)
        dur += r["dur"]
        if r["winner"] < 0:
            none += 1
        else:
            wins[r["winner"]] += 1
        for e in r["events"]:
            kinds[e["k"]] = kinds.get(e["k"], 0) + 1
    print(f"{runs} wyścigów, średnio {dur / runs:.0f} s, bez zwycięzcy: {none / runs:.1%}")
    print("zdarzenia na wyścig:", {k: round(v / runs, 2) for k, v in sorted(kinds.items())})
    for h, w in zip(HORSES, wins):
        p = max(w, 1) / runs
        print(f"{h['id']} {h['name']:<22} p={p:6.1%}  pays={round(0.85 / p - 1, 1)}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "odds":
        odds(int(sys.argv[2]) if len(sys.argv) > 2 else 400)
