//! Wyścigi konne: symulacja przebiegu wyścigu na okrągłym torze (jak horses.py).
//!
//! Wynik zależy tylko od ziarna (seed) - ten sam wyścig da się policzyć ponownie (wspólny wyścig co kilka minut jest
//! liczony z ziarna wyprowadzonego z tajnego klucza serwera). Pozycje koni to liczba okrążeń od linii startu (ułamek =
//! miejsce na torze), co "dt" sekund. Przeglądarka tylko odtwarza przebieg i zdarzenia (turbo, zawrócenie, upadek, śmierć,
//! samochód, przedmioty ze skrzynek). Ustawienia w game.json (horseRace, horses, horseItems).
//! Generator liczb losowych jest inny niż w Pythonie - ten sam numer wyścigu daje inny przebieg niż wersja Python.

use indexmap::IndexMap;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::data::g;

/// Pozycje w odpowiedzi jako liczby całkowite (1 okrążenie = SCALE), żeby JSON był mały
const SCALE: f64 = 10000.0;

/// horseRace z game.json
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaceRules {
    pub period: i64,
    pub min_players: i64,
    pub bet_open: f64,
    pub bet_close: f64,
    pub max_cards: usize,
    pub max_bets: i64,
    laps: usize,
    dt: f64,
    duration: (f64, f64),
    tail: f64,
    form_spread: f64,
    strength: f64,
    noise: f64,
    noise_tau: f64,
    turbo_mult: f64,
    turbo_laps: f64,
    turn_chance: f64,
    die_chance: f64,
    car_chance: f64,
    trip_chance: f64,
    trip_gap: f64,
    trip_death: f64,
    car_speed: f64,
    car_entry: f64,
    box_rows: Vec<f64>,
    box_respawn: f64,
    item_delay: (f64, f64),
}

pub fn rules() -> RaceRules {
    serde_json::from_value(g().horse_race.clone()).expect("HORSE_RACE w game.json")
}

/// Przebieg wyścigu (odpowiedź jak horses.simulate)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Race {
    pub dt: f64,
    pub laps: usize,
    pub rows: Vec<f64>,
    pub bx0: Vec<Vec<Vec<u8>>>,
    pub dur: f64,
    pub x: Vec<Vec<i64>>,
    pub car: Option<Vec<Option<i64>>>,
    pub events: Vec<Value>,
    /// -1 = nikt nie wygrał (stawki wracają)
    pub winner: i64,
    pub out: IndexMap<String, &'static str>,
    pub scale: i64,
    pub car_kill: bool,
}

fn r2(t: f64) -> f64 {
    (t * 100.0).round() / 100.0
}

fn r1(t: f64) -> f64 {
    (t * 10.0).round() / 10.0
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum St {
    Run,
    Fin,
    Dead,
    Left,
}

struct Car {
    x: f64,
    go: f64,
    done: bool,
    hit: f64,
}

struct Rocket {
    id: i64,
    x: f64,
    to: usize,
    t: f64,
    ev: usize,
}

struct Banana {
    id: i64,
    x: f64,
    lane: usize,
    t: f64,
}

struct Sim<'a> {
    r: &'a RaceRules,
    rnd: ChaCha8Rng,
    state: Vec<St>,
    down: Vec<f64>,
    events: Vec<Value>,
}

impl Sim<'_> {
    fn random(&mut self) -> f64 {
        self.rnd.gen::<f64>()
    }

    fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.random()
    }

    /// rozkład normalny (Box-Muller)
    fn gauss(&mut self, mu: f64, sigma: f64) -> f64 {
        let u1 = 1.0 - self.random();
        let u2 = self.random();
        mu + sigma * (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    fn ev(&mut self, mut e: Value) -> usize {
        e["t"] = json!(r2(e["t"].as_f64().unwrap_or(0.0)));
        self.events.push(e);
        self.events.len() - 1
    }

    /// Koń przewraca się na d sekund (banan, rakieta, potknięcie) - z szansą tripDeath ginie na torze (nagrobek)
    fn hurt(&mut self, j: usize, d: f64, cause: &str, t: f64, other: Option<usize>) {
        if self.random() < self.r.trip_death {
            self.state[j] = St::Dead;
            self.ev(json!({"t": t, "k": "die", "h": j, "by": cause}));
        } else {
            self.down[j] = t + d;
            let mut e = json!({"t": t, "k": "trip", "h": j, "by": cause, "d": d});
            if let Some(o) = other {
                e["o"] = json!(o);
            }
            self.ev(e);
        }
    }
}

/// force (tryb debug, tylko admin): zdarzenia, które mają się wydarzyć na pewno - "car", "turbo", "turn", "die"
pub fn simulate(seed: u64, force: &[&str]) -> Race {
    let r = rules();
    let g = g();
    let horses = &g.horses;
    let items: Vec<(String, [f64; 3])> = g
        .horse_items
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| {
            let w = |i: usize| v["w"][i].as_f64().unwrap_or(0.0);
            (k.clone(), [w(0), w(1), w(2)])
        })
        .collect();
    let n = horses.len();
    let (dt, laps) = (r.dt, r.laps);
    let mut sim = Sim { r: &r, rnd: ChaCha8Rng::seed_from_u64(seed), state: vec![St::Run; n], down: vec![0.0; n], events: vec![] };
    let forced = |name: &str| force.contains(&name);

    let dur = sim.uniform(r.duration.0, r.duration.1); // mniej więcej tyle jedzie lider
    let v0 = laps as f64 / dur;
    let strength: Vec<f64> = horses.iter().map(|h| h.speed + sim.gauss(0.0, r.form_spread)).collect();
    let sigma = r.noise * (2.0 / r.noise_tau).sqrt(); // szum "formy": stały odchył noise, pamięć noiseTau s

    // zaplanowane zdarzenia: (czas, rodzaj, koń) - wykonują się, jeśli koń jeszcze jedzie
    let mut plan: Vec<(f64, &str, usize)> = vec![];
    if forced("turbo") {
        // turbo tylko ze skrzynki z przedmiotem; w trybie debug (admin) można je wymusić
        let t = dur * sim.uniform(0.1, 0.7);
        plan.push((t, "turbo", sim.rnd.gen_range(0..n)));
    }
    if forced("turn") || sim.random() < r.turn_chance {
        let t = dur * sim.uniform(0.1, 0.8);
        plan.push((t, "turn", sim.rnd.gen_range(0..n)));
    }
    if forced("die") || sim.random() < r.die_chance {
        let t = dur * sim.uniform(0.1, 0.9);
        plan.push((t, "die", sim.rnd.gen_range(0..n)));
    }
    let car_at = if forced("car") || sim.random() < r.car_chance {
        Some(dur * if forced("car") { sim.uniform(0.12, 0.3) } else { sim.uniform(0.15, 0.45) })
    } else {
        None
    };
    plan.sort_by(|a, b| a.0.total_cmp(&b.0));

    // skrzynki z przedmiotami: bx[koń][okrążenie][rząd] - czy jest (pierwsze okrążenie zawsze, potem losowo)
    let rows = r.box_rows.clone();
    let mut bx: Vec<Vec<Vec<bool>>> = (0..n)
        .map(|_| (0..laps).map(|lap| rows.iter().map(|_| lap == 0 || sim.random() < r.box_respawn).collect()).collect())
        .collect();
    let bx0: Vec<Vec<Vec<u8>>> = bx.iter().map(|b| b.iter().map(|lap| lap.iter().map(|v| *v as u8).collect()).collect()).collect();
    let mut held: Vec<Option<String>> = vec![None; n]; // przedmiot w "kieszeni"
    let mut use_at = vec![0.0; n];
    let (mut boost_until, mut boost_mult) = (vec![0.0; n], vec![1.0; n]);
    let (mut slow_until, mut slow_mult) = (vec![0.0; n], vec![1.0; n]);
    let mut star_until = vec![0.0; n];
    let mut bananas: Vec<Banana> = vec![]; // leżące skórki
    let mut rockets: Vec<Rocket> = vec![]; // lecące rakiety
    let mut item_seq = 0i64;

    let mut x = vec![0.0f64; n];
    let mut f = vec![0.0f64; n]; // odchył formy (szum)
    let mut dr = vec![1.0f64; n]; // kierunek: 1 do przodu, -1 zawrócił
    let mut burst = vec![(0.0f64, 1.0f64); n]; // (do kiedy, mnożnik) - zryw albo potknięcie
    let mut turbo = vec![0.0f64; n]; // ile okrążeń turbo jeszcze zostało
    let mut fin_t: Vec<Option<f64>> = vec![None; n];
    let mut xs: Vec<Vec<i64>> = vec![vec![]; n];
    let mut car: Option<Car> = None; // x = okrążenia od linii startu (jedzie od zera, jak konie), go = kiedy rusza
    let mut car_xs: Vec<Option<i64>> = vec![];
    let mut car_dead = false;
    let mut had_car = false;
    let (mut winner, mut end_t): (i64, Option<f64>) = (-1, None);
    let max_t = dur * 2.2;
    let mut i = 0usize;
    loop {
        let t = i as f64 * dt;
        for h in 0..n {
            xs[h].push((x[h] * SCALE).round() as i64);
        }
        car_xs.push(car.as_ref().map(|c| (c.x * SCALE).round() as i64));
        if end_t.is_some_and(|e| t >= e) || t > max_t {
            break;
        }
        // --- zdarzenia z planu
        while plan.first().is_some_and(|p| p.0 <= t) {
            let (_, kind, h) = plan.remove(0);
            if sim.state[h] != St::Run || dr[h] < 0.0 {
                continue;
            }
            match kind {
                "turbo" if turbo[h] <= 0.0 => {
                    turbo[h] = r.turbo_laps;
                    sim.ev(json!({"t": t, "k": "turbo", "h": h}));
                }
                "turn" => {
                    dr[h] = -1.0;
                    sim.state[h] = St::Left;
                    sim.ev(json!({"t": t, "k": "turn", "h": h}));
                }
                "die" => {
                    sim.state[h] = St::Dead;
                    sim.ev(json!({"t": t, "k": "die", "h": h}));
                }
                _ => {}
            }
        }
        if car_at.is_some_and(|at| t >= at) && car.is_none() {
            // zajeżdża spoza toru na linię startu
            car = Some(Car { x: 0.0, go: t + r.car_entry, done: false, hit: 0.0 });
            had_car = true;
            sim.ev(json!({"t": t, "k": "car", "go": r2(t + r.car_entry)}));
        }
        // --- ruch koni
        let prev = x.clone();
        for h in 0..n {
            if sim.state[h] == St::Dead {
                continue;
            }
            let noise = sim.gauss(0.0, 1.0);
            f[h] += -f[h] / r.noise_tau * dt + sigma * dt.sqrt() * noise;
            if burst[h].0 <= t {
                burst[h] = (0.0, 1.0);
                let roll = sim.random();
                if roll < dt / 35.0 {
                    burst[h] = (t + sim.uniform(2.0, 5.0), 1.14); // zryw
                } else if roll < dt / 35.0 + dt / 70.0 {
                    burst[h] = (t + sim.uniform(1.5, 3.0), 0.55); // potknięcie
                }
            }
            let mut mult = (1.0 + r.strength * strength[h] + f[h]).max(0.25) * burst[h].1;
            if t < boost_until[h] {
                mult *= boost_mult[h];
            }
            if t < slow_until[h] {
                mult *= slow_mult[h];
            }
            if t < star_until[h] {
                mult *= 1.5;
            }
            let mut v = if t < sim.down[h] {
                0.0
            } else if turbo[h] > 0.0 {
                let v = v0 * r.turbo_mult;
                turbo[h] -= v * dt;
                if turbo[h] <= 0.0 {
                    sim.ev(json!({"t": t, "k": "turbo_end", "h": h}));
                }
                v
            } else {
                v0 * mult
            };
            if sim.state[h] == St::Fin {
                v = v0 * 0.5; // po mecie truchta
            }
            x[h] += dr[h] * v * dt;
            if sim.state[h] == St::Run && dr[h] > 0.0 && x[h] >= laps as f64 {
                sim.state[h] = St::Fin;
                let ft = t + (laps as f64 - prev[h]) / (x[h] - prev[h]).max(1e-9) * dt;
                fin_t[h] = Some(ft);
                if winner < 0 || fin_t[winner as usize].is_some_and(|w| ft < w) {
                    winner = h as i64;
                }
                if end_t.is_none() {
                    end_t = Some(t + r.tail);
                }
            }
        }
        // --- skrzynki: koń, który przejechał przez rząd, dostaje przedmiot (rzadsze dla liderów)
        let mut order: Vec<usize> = (0..n).filter(|&h| sim.state[h] == St::Run && dr[h] > 0.0).collect();
        order.sort_by(|a, b| x[*b].total_cmp(&x[*a]));
        for (rank, &h) in order.iter().enumerate() {
            if held[h].is_some() || t < sim.down[h] {
                continue;
            }
            for lap in 0..laps {
                for (ri, pos) in rows.iter().enumerate() {
                    let at = lap as f64 + pos;
                    if bx[h][lap][ri] && prev[h] < at && at <= x[h] {
                        bx[h][lap][ri] = false;
                        let grp = (rank * 3 / n).min(2);
                        let weights: Vec<f64> = items.iter().map(|(_, w)| w[grp]).collect();
                        let total: f64 = weights.iter().sum();
                        let mut pick = sim.random() * total;
                        let mut item = items.last().map(|(k, _)| k.clone()).unwrap_or_default();
                        for ((k, _), w) in items.iter().zip(&weights) {
                            if pick < *w {
                                item = k.clone();
                                break;
                            }
                            pick -= w;
                        }
                        use_at[h] = t + sim.uniform(r.item_delay.0, r.item_delay.1);
                        sim.ev(json!({"t": t, "k": "box", "h": h, "it": item, "lap": lap, "row": ri}));
                        held[h] = Some(item);
                    }
                }
            }
        }
        // --- używanie przedmiotów (konie są "sterowane" przez komputer)
        let immune = |k: usize, turbo: &[f64], star_until: &[f64]| t < star_until[k] || turbo[k] > 0.0;
        let ahead = |h: usize, lim: f64, x: &[f64]| {
            order.iter().copied().filter(|&k| k != h && 0.004 < x[k] - x[h] && x[k] - x[h] < lim).min_by(|a, b| {
                (x[*a] - x[h]).total_cmp(&(x[*b] - x[h]))
            })
        };
        let behind = |h: usize, lim: f64, x: &[f64]| {
            order.iter().copied().filter(|&k| k != h && 0.004 < x[h] - x[k] && x[h] - x[k] < lim).min_by(|a, b| {
                (x[h] - x[*a]).total_cmp(&(x[h] - x[*b]))
            })
        };
        for h in 0..n {
            let Some(it) = held[h].clone() else { continue };
            if t < use_at[h] || sim.state[h] != St::Run || t < sim.down[h] {
                continue;
            }
            let tgt = match it.as_str() {
                "banana" => behind(h, 0.3, &x),
                "rocket" | "snail" => ahead(h, 0.5, &x),
                _ => None,
            };
            if matches!(it.as_str(), "banana" | "rocket" | "snail") && tgt.is_none() {
                if t > use_at[h] + 8.0 {
                    // nikt w zasięgu - przedmiot się marnuje
                    held[h] = None;
                    sim.ev(json!({"t": t, "k": "use", "h": h, "it": ""}));
                }
                continue;
            }
            held[h] = None;
            sim.ev(json!({"t": t, "k": "use", "h": h, "it": it}));
            match it.as_str() {
                "banana" => {
                    item_seq += 1;
                    let lane = tgt.unwrap_or(h);
                    bananas.push(Banana { id: item_seq, x: x[h] - 0.004, lane, t });
                    let bx_ = ((x[h] - 0.004) * 10000.0).round() / 10000.0;
                    sim.ev(json!({"t": t, "k": "banana", "h": h, "id": item_seq, "lane": lane, "x": bx_}));
                }
                "rocket" => {
                    item_seq += 1;
                    let to = tgt.unwrap_or(h);
                    let x0 = (x[h] * 10000.0).round() / 10000.0;
                    let ev = sim.ev(json!({"t": t, "k": "rocket", "h": h, "to": to, "id": item_seq, "x0": x0}));
                    rockets.push(Rocket { id: item_seq, x: x[h], to, t, ev });
                }
                "turbo" => {
                    // tęczowe turbo: ok. ćwierć okrążenia bardzo szybko, nic nie ruszy konia
                    turbo[h] = r.turbo_laps;
                    sim.ev(json!({"t": t, "k": "turbo", "h": h}));
                }
                "mushroom" => {
                    let d = r1(sim.uniform(2.5, 3.5));
                    (boost_until[h], boost_mult[h]) = (t + d, 2.2);
                    sim.ev(json!({"t": t, "k": "boost", "h": h, "d": d}));
                }
                "snail" => {
                    let k = tgt.unwrap_or(h);
                    if immune(k, &turbo, &star_until) {
                        sim.ev(json!({"t": t, "k": "slow", "h": k, "by": h, "d": 0, "blocked": true}));
                    } else {
                        let d = r1(sim.uniform(3.0, 4.5));
                        (slow_until[k], slow_mult[k]) = (t + d, 0.45);
                        sim.ev(json!({"t": t, "k": "slow", "h": k, "by": h, "d": d}));
                    }
                }
                "lightning" => {
                    let d = r1(sim.uniform(2.5, 3.5));
                    for k in 0..n {
                        if k != h && sim.state[k] == St::Run && !immune(k, &turbo, &star_until) {
                            (slow_until[k], slow_mult[k]) = (t + d, 0.5);
                        }
                    }
                    sim.ev(json!({"t": t, "k": "bolt", "h": h, "d": d}));
                }
                "star" => {
                    star_until[h] = t + 5.0;
                    sim.ev(json!({"t": t, "k": "star", "h": h, "d": 5}));
                }
                _ => {}
            }
        }
        // --- skórki leżą na torze, dopóki ktoś się o nie nie poślizgnie
        let mut keep = vec![];
        for b in std::mem::take(&mut bananas) {
            let j = b.lane;
            let ended = if sim.state[j] == St::Run && dr[j] > 0.0 && prev[j] < b.x && b.x <= x[j] {
                if immune(j, &turbo, &star_until) {
                    Some(false)
                } else {
                    let d = r1(sim.uniform(1.6, 2.6));
                    sim.hurt(j, d, "banana", t, None);
                    Some(true)
                }
            } else if t - b.t > 25.0 || sim.state[j] != St::Run {
                Some(false)
            } else {
                None
            };
            match ended {
                Some(hit) => {
                    sim.ev(json!({"t": t, "k": "banana_end", "id": b.id, "hit": hit}));
                }
                None => keep.push(b),
            }
        }
        bananas = keep;
        // --- rakiety lecą do konia przed sobą
        let mut keep = vec![];
        for mut rk in std::mem::take(&mut rockets) {
            rk.x += 0.3 * dt;
            let j = rk.to;
            let res = if sim.state[j] != St::Run || dr[j] < 0.0 || t - rk.t > 8.0 {
                Some("gone")
            } else if rk.x >= x[j] {
                Some(if immune(j, &turbo, &star_until) { "blocked" } else { "hit" })
            } else {
                None
            };
            match res {
                Some(res) => {
                    sim.events[rk.ev]["t1"] = json!(r2(t));
                    sim.events[rk.ev]["res"] = json!(res);
                    let _ = rk.id;
                    if res == "hit" {
                        let d = r1(sim.uniform(2.2, 3.6));
                        sim.hurt(j, d, "rocket", t, None);
                    }
                }
                None => keep.push(rk),
            }
        }
        rockets = keep;
        // --- potknięcia o siebie: koń tuż za innym koniem jadącym w tę samą stronę może upaść
        let run: Vec<usize> = if t > 10.0 {
            (0..n).filter(|&h| sim.state[h] == St::Run && dr[h] > 0.0 && t >= sim.down[h]).collect()
        } else {
            vec![] // na starcie tłok - bez upadków
        };
        for &a in &run {
            for &b in &run {
                if a == b || t < sim.down[b] || t < sim.down[a] {
                    continue;
                }
                let gap = (x[a] - x[b]).rem_euclid(1.0); // b jest tuż za a
                if 0.0 < gap && gap < r.trip_gap && turbo[a] <= 0.0 && turbo[b] <= 0.0 && sim.random() < r.trip_chance {
                    let d = r1(sim.uniform(2.5, 4.5));
                    sim.hurt(b, d, "horse", t, Some(a));
                    if sim.random() < 0.3 && sim.state[a] == St::Run {
                        sim.hurt(a, r1(d * 0.7), "horse", t, Some(b));
                    }
                }
            }
        }
        // --- samochód zajeżdża na tor, jedzie do najbliższego żywego konia (do przodu albo wstecz), przejeżdża go i rusza
        // do następnego; gdy wszystkie leżą - sam kończy wyścig, dojeżdżając do mety (nikt nie wygrywa, stawki wracają)
        if let Some(cr) = car.as_mut().filter(|c| !c.done && t >= c.go) {
            let step = r.car_speed * v0 * dt;
            let alive: Vec<usize> = (0..n).filter(|&h| !matches!(sim.state[h], St::Dead | St::Fin)).collect();
            if !alive.is_empty() {
                if t >= cr.hit {
                    let tgt = alive.iter().copied().min_by(|a, b| (x[*a] - cr.x).abs().total_cmp(&(x[*b] - cr.x).abs())).unwrap();
                    let dx = x[tgt] - cr.x;
                    if dx.abs() <= step.max(0.01) {
                        cr.x = x[tgt];
                        sim.state[tgt] = St::Dead;
                        car_dead = true;
                        cr.hit = t + 0.4;
                        sim.ev(json!({"t": t, "k": "die", "h": tgt, "by": "car"}));
                    } else {
                        cr.x += if dx > 0.0 { step } else { -step };
                    }
                }
            } else {
                cr.x += step;
            }
            if alive.is_empty() && cr.x >= laps as f64 {
                (cr.x, cr.done) = (laps as f64, true);
                sim.ev(json!({"t": t, "k": "car_end"}));
                if end_t.is_none() {
                    end_t = Some(t + r.tail);
                }
            }
        }
        // --- koniec: nikt już nie jedzie do mety
        if end_t.is_none() && car.is_none() && !(0..n).any(|h| sim.state[h] == St::Run && dr[h] > 0.0) {
            end_t = Some(t + 4.0);
        }
        i += 1;
    }
    let out: IndexMap<String, &'static str> = (0..n)
        .filter_map(|h| match sim.state[h] {
            St::Dead => Some((h.to_string(), "dead")),
            St::Left => Some((h.to_string(), "left")),
            _ => None,
        })
        .collect();
    let all_dead = sim.state.iter().all(|s| *s == St::Dead);
    Race {
        dt,
        laps,
        rows,
        bx0,
        dur: r2(i as f64 * dt),
        x: xs,
        car: had_car.then_some(car_xs),
        events: sim.events,
        winner: if all_dead { -1 } else { winner },
        out,
        scale: SCALE as i64,
        car_kill: car_dead && winner < 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_race() {
        let a = simulate(42, &[]);
        let b = simulate(42, &[]);
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
        assert!(a.dur > 10.0 && a.x.len() == g().horses.len());
        let forced = simulate(7, &["car", "turn", "die"]);
        let kinds: Vec<&str> = forced.events.iter().filter_map(|e| e["k"].as_str()).collect();
        assert!(kinds.contains(&"car"));
    }

    #[test]
    fn odds_are_spread() {
        let mut wins = vec![0; g().horses.len()];
        for s in 0..200 {
            let r = simulate(10_000 + s, &[]);
            if r.winner >= 0 {
                wins[r.winner as usize] += 1;
            }
        }
        // najszybszy koń wygrywa częściej niż najwolniejszy
        assert!(wins[0] > wins[wins.len() - 1], "{wins:?}");
    }
}
