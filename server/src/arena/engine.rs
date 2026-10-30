//! Silnik walki kartami. Przeglądarka wysyła tylko ruchy (wystaw kartę, użyj zdolności, wróć na ławkę, koniec tury,
//! poddanie), serwer sprawdza zasady, liczy skutki i zapisuje kolejne kroki walki (`Step`) - każdy krok ma zdarzenia
//! do animacji i stan planszy po ruchu. Strony walki to `Side::A` i `Side::B`; gracz widzi siebie jako "me", a rywala
//! jako "ai" (arena/view.rs).

use std::collections::HashSet;

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};

use super::{Hero, Reward};
use crate::catalog::{ArenaEffectCfg, Catalog, Person};
use crate::data::g;
use crate::db::now;

pub const TURN_LIMIT: i64 = 80; // po tylu turach (obu graczy razem) remis
pub const PVP_TURN_SECONDS: f64 = 90.0; // czas na turę w pojedynku z graczem - potem tura kończy się sama
pub const PVP_AWAY_SECONDS: f64 = 120.0; // gracz bez kontaktu z serwerem tak długo przegrywa walkowerem
const OWN_TICK: &[&str] = &["stun", "boost", "weaken", "burn", "poison"]; // odliczane na końcu tury właściciela karty
const OPP_TICK: &[&str] = &["taunt", "shield"]; // odliczane na końcu tury rywala (chronią przed nim)

/// Strona walki
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    A,
    B,
}

impl Side {
    pub const BOTH: [Side; 2] = [Side::A, Side::B];

    pub fn other(self) -> Side {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }

    fn idx(self) -> usize {
        self as usize
    }
}

/// Walka z komputerem albo pojedynek z graczem
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Ai,
    Pvp,
}

/// Wynik walki
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Won(Side),
    Draw,
}

/// Dlaczego walka się skończyła
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// wszystkie karty rywala pokonane
    Ko,
    /// limit tur - remis
    Limit,
    Surrender,
    /// walkower za brak kontaktu
    Away,
}

/// Ruch niezgodny z zasadami - komunikat trafia do gracza
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ArenaError(pub String);

fn err<T>(msg: impl Into<String>) -> Result<T, ArenaError> {
    Err(ArenaError(msg.into()))
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub id: String,
    pub value: i64,
    pub turns: i64,
}

/// Karta w walce
#[derive(Debug, Clone, Serialize)]
pub struct Unit {
    pub uid: i64,
    pub pid: String,
    pub variant: String,
    /// widok dodaje stronę z perspektywy gracza ("me" / "ai")
    #[serde(skip)]
    pub side: Side,
    pub hp: i64,
    #[serde(rename = "maxHp")]
    pub max_hp: i64,
    pub st: Vec<Status>,
    pub acted: bool,
    #[serde(skip)]
    pub knock: bool,
}

/// Zdarzenie do animacji
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    Block { uid: i64, amount: i64 },
    Dmg { uid: i64, amount: i64 },
    Heal { uid: i64, amount: i64 },
    Shield { uid: i64, amount: i64 },
    Text { uid: i64, text: String },
    Status { uid: i64, text: String },
}

impl Unit {
    fn has(&self, sid: &str) -> bool {
        self.st.iter().any(|x| x.id == sid)
    }

    fn st_val(&self, sid: &str) -> i64 {
        self.st.iter().filter(|x| x.id == sid).map(|x| x.value).sum()
    }

    fn add_status(&mut self, sid: &str, value: i64, turns: i64) {
        match self.st.iter_mut().find(|x| x.id == sid) {
            Some(old) => {
                old.value = old.value.max(value);
                old.turns = old.turns.max(turns);
            }
            None => self.st.push(Status { id: sid.into(), value, turns }),
        }
    }

    /// Obrażenia: najpierw tarcza, potem HP. Zwraca obrażenia, które trafiły w HP.
    fn damage(&mut self, amount: f64, ev: &mut Vec<Event>, pierce: bool) -> i64 {
        let amount = (amount.round_ties_even() as i64).max(0);
        let mut left = amount;
        if !pierce {
            for s in self.st.iter_mut().filter(|x| x.id == "shield") {
                let take = s.value.min(left);
                s.value -= take;
                left -= take;
                if take != 0 {
                    ev.push(Event::Block { uid: self.uid, amount: take });
                }
            }
        }
        self.st.retain(|x| !(x.id == "shield" && x.value <= 0));
        let hit = self.hp.min(left);
        self.hp -= hit;
        if left != 0 || amount == 0 {
            ev.push(Event::Dmg { uid: self.uid, amount: left });
        }
        hit
    }

    fn heal(&mut self, amount: f64, ev: &mut Vec<Event>) {
        if self.has("poison") {
            ev.push(Event::Text { uid: self.uid, text: "☠️ nie leczy".into() });
            return;
        }
        let h = (self.max_hp - self.hp).min(amount.round_ties_even() as i64);
        self.hp += h;
        ev.push(Event::Heal { uid: self.uid, amount: h });
    }
}

/// Jedna strona walki: karty na planszy, na ławce i pokonane, monety i akcje
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub name: String,
    #[serde(skip)]
    pub user: Option<i64>,
    pub board: Vec<Unit>,
    pub bench: Vec<Unit>,
    pub ko: Vec<Unit>,
    pub coins: i64,
    pub max_coins: i64,
    pub actions: i64,
    pub turn_no: i64,
    pub coin_penalty: i64,
}

impl Team {
    fn new(cat: &Catalog, player: &Player, side: Side, uid_start: i64) -> Team {
        let bench = player
            .deck
            .iter()
            .zip(uid_start..)
            .map(|(c, uid)| {
                let hp = cat.people[&c.pid].hp;
                Unit {
                    uid,
                    pid: c.pid.clone(),
                    variant: c.variant.clone(),
                    side,
                    hp,
                    max_hp: hp,
                    st: vec![],
                    acted: false,
                    knock: false,
                }
            })
            .collect();
        Team {
            name: player.name.clone(),
            user: player.user,
            board: vec![],
            bench,
            ko: vec![],
            coins: 0,
            max_coins: 0,
            actions: 0,
            turn_no: 0,
            coin_penalty: 0,
        }
    }

    /// karty na planszy i na ławce
    fn alive(&self) -> usize {
        self.board.len() + self.bench.len()
    }

    fn board_uids(&self) -> Vec<i64> {
        self.board.iter().map(|u| u.uid).collect()
    }
}

/// Stan walki po ruchu
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub teams: [Team; 2],
    pub active: Side,
    pub first: Side,
    pub turn: i64,
    pub over: Option<Outcome>,
    pub reason: Option<EndReason>,
}

/// Ruch w kroku walki (pole "type")
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    Start,
    Turn { ev: Vec<Event>, kos: Vec<i64>, bonus: i64 },
    End { timeout: bool },
    Place { uid: i64, cost: i64 },
    Retreat { uid: i64 },
    Use { uid: i64, ab: i64, primary: Vec<i64>, ev: Vec<Event>, kos: Vec<i64> },
    Over { reason: EndReason },
}

#[derive(Debug, Clone)]
pub struct Step {
    pub n: usize,
    pub side: Option<Side>,
    pub winner: Option<Outcome>,
    pub action: Action,
    pub state: Snapshot,
}

/// Rodzaj zdolności
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbKind {
    /// ofensywna: wartość = obrażenia
    Off,
    /// defensywna: wartość = osłona
    Def,
    /// lecząca: wartość = leczone HP
    Heal,
    /// ekonomiczna: wartość = monety
    Eco,
}

impl AbKind {
    fn parse(kind: &str) -> AbKind {
        match kind {
            "off" => AbKind::Off,
            "heal" => AbKind::Heal,
            "eco" => AbKind::Eco,
            _ => AbKind::Def,
        }
    }
}

/// Cel zdolności
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Enemy,
    Ally,
    Me,
    AllEnemies,
    AllAllies,
}

impl Target {
    fn parse(target: &str) -> Option<Target> {
        Some(match target {
            "enemy" => Target::Enemy,
            "ally" => Target::Ally,
            "self" => Target::Me,
            "all_enemies" => Target::AllEnemies,
            "all_allies" => Target::AllAllies,
            _ => return None,
        })
    }

    /// cel wybierany przez gracza
    fn chosen(self) -> bool {
        matches!(self, Target::Enemy | Target::Ally)
    }
}

/// Zdolność karty w walce (te same miejsca co w przeglądarce: 0, 1 = zdolności karty, 2+ = dodatkowe)
#[derive(Debug, Clone)]
pub struct Ab {
    pub kind: AbKind,
    pub value: i64,
    pub cost: i64,
    pub target: Target,
    pub effects: Vec<ArenaEffectCfg>,
}

pub fn card_cost(p: &Person) -> i64 {
    g().arena.card_cost.get(&p.rarity).copied().unwrap_or(1)
}

/// Domyślny koszt zdolności z jej wartości (słabe za darmo)
fn auto_cost(value: i64) -> i64 {
    g().arena.ability_cost.iter().rev().find(|(minimum, _)| value >= *minimum).map_or(0, |(_, c)| *c)
}

pub fn abilities(p: &Person) -> Vec<Ab> {
    let first = std::iter::once((p.kind1.as_str(), p.dmg));
    let second = p.attack2.as_ref().map(|_| (p.kind2.as_str(), p.dmg2));
    let extra = p.abilities.iter().map(|a| (a.kind.as_str(), a.value));
    first
        .chain(second)
        .chain(extra)
        .enumerate()
        .map(|(slot, (kind, value))| {
            let cfg = p.arena.get(slot);
            let kind = AbKind::parse(kind);
            let default_target = if kind == AbKind::Off { Target::Enemy } else { Target::Me };
            Ab {
                cost: cfg.and_then(|c| c.cost).unwrap_or_else(|| auto_cost(value)),
                target: cfg.and_then(|c| c.target.as_deref()).and_then(Target::parse).unwrap_or(default_target),
                effects: cfg.map(|c| c.effects.clone()).unwrap_or_default(),
                kind,
                value,
            }
        })
        .collect()
}

fn type_mult(cat: &Catalog, attacker: &Unit, target: &Unit, dmg: i64) -> (i64, Option<&'static str>) {
    let tt = crate::data::base_game().types.get(&cat.people[&target.pid].type_);
    let at = &cat.people[&attacker.pid].type_;
    match tt {
        Some(t) if t.weak.as_ref() == Some(at) => (dmg * 2, Some("słabość ×2")),
        Some(t) if t.resist.as_ref() == Some(at) => ((dmg - 20).max(0), Some("odporność −20")),
        _ => (dmg, None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeckCard {
    pub pid: String,
    pub variant: String,
}

/// Talia komputera: te same rzadkości co talia gracza, losowe osoby, wariant tylko dla wyglądu
pub fn ai_deck(cat: &Catalog, deck: &[DeckCard], allowed_secret: &HashSet<String>) -> Vec<DeckCard> {
    let g = g();
    let mut used: HashSet<&str> = deck.iter().map(|c| c.pid.as_str()).collect();
    let pool: Vec<&Person> = cat
        .people
        .values()
        .map(AsRef::as_ref)
        .filter(|p| p.hp > 0 && (!p.is_secret() || allowed_secret.contains(&p.id)))
        .collect();
    let looks: Vec<&String> = g.variant_order[1..].iter().filter(|v| !g.variants[*v].exclusive).collect(); // bez wyjątkowych
    let mut rng = rand::thread_rng();
    let mut out = vec![];
    for c in deck {
        let rarity = &cat.people[&c.pid].rarity;
        let mut opts: Vec<&Person> =
            pool.iter().copied().filter(|p| &p.rarity == rarity && !used.contains(p.id.as_str())).collect();
        if opts.is_empty() {
            opts = pool.iter().copied().filter(|p| !used.contains(p.id.as_str())).collect();
        }
        let Some(p) = opts.choose(&mut rng).or(pool.first()).copied() else { break };
        used.insert(&p.id);
        let variant = if rng.gen::<f64>() < 0.7 {
            "normal".to_owned()
        } else {
            looks.choose(&mut rng).map(|v| (*v).clone()).unwrap_or_default()
        };
        out.push(DeckCard { pid: p.id.clone(), variant });
    }
    out
}

pub struct Player {
    pub name: String,
    pub user: Option<i64>,
    pub deck: Vec<DeckCard>,
    pub hero: Hero,
}

pub struct Battle {
    pub id: String,
    pub mode: Mode,
    pub teams: [Team; 2],
    pub heroes: [Hero; 2],
    pub first: Side,
    pub active: Side,
    pub turn: i64,
    pub over: Option<Outcome>,
    pub reason: Option<EndReason>,
    pub steps: Vec<Step>,
    /// admin: komputer gra za gracza (wtedy bez nagród)
    pub auto: [bool; 2],
    pub no_reward: bool,
    /// nagroda strony (wpisuje arena_record po zakończeniu)
    pub rewards: [Option<Reward>; 2],
    pub recorded: bool,
    /// strona i karta ostatniego użytego ataku - do osiągnięć (kto zadał ostatni cios)
    pub last_use: Option<(Side, String)>,
    pub seen: [f64; 2],
    pub turn_started: f64,
    pub created: f64,
    pub touched: f64,
    pub finished_at: Option<f64>,
}

/// Losowy identyfikator (jak secrets.token_urlsafe(9))
pub fn token() -> String {
    use base64::Engine;
    let bytes: [u8; 9] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Battle {
    pub fn new(cat: &Catalog, mode: Mode, a: Player, b: Player, first: Side) -> Battle {
        let now = now();
        Battle {
            id: token(),
            mode,
            teams: [Team::new(cat, &a, Side::A, 1), Team::new(cat, &b, Side::B, 101)],
            heroes: [a.hero, b.hero],
            first,
            active: first,
            turn: 0,
            over: None,
            reason: None,
            steps: vec![],
            auto: [false, false],
            no_reward: false,
            rewards: [None, None],
            recorded: false,
            last_use: None,
            seen: [now, now],
            turn_started: now,
            created: now,
            touched: now,
            finished_at: None,
        }
    }

    // ------------------------------------------------------------ pomocnicze

    pub fn team(&self, k: Side) -> &Team {
        &self.teams[k.idx()]
    }

    fn team_mut(&mut self, k: Side) -> &mut Team {
        &mut self.teams[k.idx()]
    }

    fn units(&self) -> impl Iterator<Item = &Unit> {
        self.teams.iter().flat_map(|t| t.board.iter().chain(&t.bench).chain(&t.ko))
    }

    fn unit(&self, uid: i64) -> Option<&Unit> {
        self.units().find(|u| u.uid == uid)
    }

    fn unit_mut(&mut self, uid: i64) -> Option<&mut Unit> {
        self.teams.iter_mut().flat_map(|t| t.board.iter_mut().chain(&mut t.bench).chain(&mut t.ko)).find(|u| u.uid == uid)
    }

    /// karta na planszy lub ławce (bez pokonanych)
    fn find(&self, uid: i64) -> Option<&Unit> {
        self.teams.iter().flat_map(|t| t.board.iter().chain(&t.bench)).find(|u| u.uid == uid)
    }

    fn on_board(&self, k: Side, uid: i64) -> bool {
        self.team(k).board.iter().any(|u| u.uid == uid)
    }

    pub fn side_of_user(&self, user: i64) -> Option<Side> {
        Side::BOTH.into_iter().find(|k| self.team(*k).user == Some(user))
    }

    pub fn user_of(&self, k: Side) -> Option<i64> {
        self.team(k).user
    }

    /// Wszystkie karty w walce
    pub fn pids(&self) -> HashSet<String> {
        self.units().map(|u| u.pid.clone()).collect()
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            teams: self.teams.clone(),
            active: self.active,
            first: self.first,
            turn: self.turn,
            over: self.over,
            reason: self.reason,
        }
    }

    fn push(&mut self, side: Option<Side>, action: Action) {
        let winner = if matches!(action, Action::Over { .. }) { self.over } else { None };
        let step = Step { n: self.steps.len() + 1, side, winner, action, state: self.snapshot() };
        self.steps.push(step);
    }

    pub fn is_bot(&self, k: Side) -> bool {
        (self.mode == Mode::Ai && k == Side::B) || self.auto[k.idx()]
    }

    pub fn set_auto(&mut self, k: Side, on: bool) {
        self.auto[k.idx()] = on;
        self.no_reward |= on;
    }

    pub fn auto_of(&self, k: Side) -> bool {
        self.auto[k.idx()]
    }

    pub fn touch_seen(&mut self, k: Side) {
        self.seen[k.idx()] = now();
    }

    pub fn reward(&self, k: Side) -> Option<&Reward> {
        self.rewards[k.idx()].as_ref()
    }

    pub fn set_reward(&mut self, k: Side, r: Reward) {
        self.rewards[k.idx()] = Some(r);
    }

    pub fn hero(&self, k: Side) -> &Hero {
        &self.heroes[k.idx()]
    }

    // ------------------------------------------------------------ zasady

    fn why_cant_act(&self, k: Side, u: &Unit) -> Option<String> {
        if self.over.is_some() || self.active != k {
            return Some("To nie twoja tura".into());
        }
        if !self.on_board(k, u.uid) {
            return Some("Karta musi być na planszy".into());
        }
        if u.acted {
            return Some("Ta karta już działała w tej turze".into());
        }
        if u.has("stun") {
            return Some("Karta jest ogłuszona 💫".into());
        }
        if self.team(k).actions <= 0 {
            return Some("Brak akcji ⚡".into());
        }
        None
    }

    fn valid_targets(&self, k: Side, ab: &Ab) -> Vec<i64> {
        let foe = &self.team(k.other()).board;
        match ab.target {
            Target::Enemy => {
                let taunt: Vec<i64> = foe.iter().filter(|t| t.has("taunt")).map(|t| t.uid).collect();
                if taunt.is_empty() {
                    foe.iter().map(|t| t.uid).collect()
                } else {
                    taunt
                }
            }
            Target::Ally => self.team(k).board_uids(),
            _ => vec![],
        }
    }

    fn why_cant_use(&self, k: Side, u: &Unit, ab: &Ab) -> Option<String> {
        if let Some(why) = self.why_cant_act(k, u) {
            return Some(why);
        }
        if self.team(k).coins < ab.cost {
            return Some(format!("Za mało monet (potrzeba {} 🪙)", ab.cost));
        }
        if ab.target.chosen() && self.valid_targets(k, ab).is_empty() {
            return Some("Brak celu".into());
        }
        None
    }

    fn primary(&self, k: Side, u: i64, ab: &Ab, target: Option<i64>) -> Vec<i64> {
        match ab.target {
            Target::Enemy | Target::Ally => target.into_iter().collect(),
            Target::Me => vec![u],
            Target::AllEnemies => self.team(k.other()).board_uids(),
            Target::AllAllies => self.team(k).board_uids(),
        }
    }

    fn resolve(&mut self, cat: &Catalog, k: Side, u: i64, ab: &Ab, primary: &[i64]) -> Vec<Event> {
        let mut ev = vec![];
        let team = self.team_mut(k);
        team.coins -= ab.cost;
        team.actions -= 1;
        if let Some(x) = self.unit_mut(u) {
            x.acted = true;
        }
        let mut dealt = 0;
        match ab.kind {
            AbKind::Off => {
                for &t in primary {
                    let (Some(att), Some(tu)) = (self.unit(u).cloned(), self.unit(t).cloned()) else { continue };
                    let base = (ab.value + att.st_val("boost") - att.st_val("weaken")).max(0);
                    let (dmg, note) = type_mult(cat, &att, &tu, base);
                    if let Some(note) = note {
                        ev.push(Event::Text { uid: t, text: note.into() });
                    }
                    if let Some(x) = self.unit_mut(t) {
                        dealt += x.damage(dmg as f64, &mut ev, false);
                    }
                }
            }
            AbKind::Heal => {
                for &t in primary {
                    if let Some(x) = self.unit_mut(t) {
                        x.heal(ab.value as f64, &mut ev);
                    }
                }
            }
            AbKind::Eco => {
                // monety na tę turę (najwyżej limit monet)
                let team = self.team_mut(k);
                let gain = ab.value.min(g().arena.max_coins - team.coins).max(0);
                team.coins += gain;
                ev.push(Event::Text { uid: u, text: format!("🪙 +{gain}") });
            }
            AbKind::Def => {
                for &t in primary {
                    if let Some(x) = self.unit_mut(t) {
                        x.add_status("shield", ab.value, 1);
                    }
                    ev.push(Event::Shield { uid: t, amount: ab.value });
                }
            }
        }
        for e in &ab.effects {
            self.apply_effect(k, u, e, primary, dealt, &mut ev);
        }
        ev
    }

    fn apply_effect(&mut self, k: Side, u: i64, e: &ArenaEffectCfg, primary: &[i64], dealt: i64, ev: &mut Vec<Event>) {
        let foe = self.team(k.other()).board_uids();
        let targets: Vec<i64> = match e.target.as_str() {
            "self" => vec![u],
            "all_allies" => self.team(k).board_uids(),
            "all_enemies" => foe,
            "random_enemy" => foe.choose(&mut rand::thread_rng()).copied().into_iter().collect(),
            _ => primary.to_vec(),
        };
        let value = e.value;
        match e.id.as_str() {
            "heal" => {
                for t in targets {
                    if let Some(x) = self.unit_mut(t) {
                        x.heal(value as f64, ev);
                    }
                }
            }
            "lifesteal" => {
                if let Some(x) = self.unit_mut(u) {
                    x.heal(dealt as f64 * value as f64 / 100.0, ev);
                }
            }
            "splash" => {
                for t in targets {
                    let Some(side) = self.unit(t).map(|x| x.side) else { continue };
                    let board = self.team(side).board_uids();
                    if let Some(i) = board.iter().position(|x| *x == t) {
                        let neighbours = [i.checked_sub(1).map(|j| board[j]), board.get(i + 1).copied()];
                        for n in neighbours.into_iter().flatten() {
                            if let Some(x) = self.unit_mut(n) {
                                x.damage(value as f64, ev, false);
                            }
                        }
                    }
                }
            }
            "steal_coins" => {
                self.team_mut(k.other()).coin_penalty += value;
                ev.push(Event::Text { uid: u, text: format!("💰 −{value} 🪙 rywalowi") });
            }
            "extra_action" => {
                let team = self.team_mut(k);
                team.actions = (team.actions + value).min(5);
                ev.push(Event::Text { uid: u, text: format!("⚡ +{value} akcja") });
            }
            "knockback" => {
                for t in targets {
                    let Some(x) = self.unit(t) else { continue };
                    if x.side != k && self.on_board(x.side, t) && x.hp > 0 {
                        ev.push(Event::Text { uid: t, text: "🔁 na ławkę!".into() });
                        if let Some(x) = self.unit_mut(t) {
                            x.knock = true;
                        }
                    }
                }
            }
            id => {
                let (icon, name) = crate::data::base_game().arena_effects.get(id).map_or(("❔", id), |i| (i.icon.as_str(), i.name.as_str()));
                let text = format!("{icon} {name}");
                for t in targets {
                    if let Some(x) = self.unit_mut(t) {
                        x.add_status(id, value, e.turns.max(1));
                    }
                    ev.push(Event::Status { uid: t, text: text.clone() });
                }
            }
        }
    }

    /// Karty bez HP schodzą z planszy (K.O.), odrzucone ("Do ławki!") wracają na ławkę
    fn collect_ko(&mut self) -> Vec<i64> {
        let mut kos = vec![];
        for team in &mut self.teams {
            for mut u in std::mem::take(&mut team.board) {
                let knock = std::mem::take(&mut u.knock);
                if u.hp <= 0 {
                    kos.push(u.uid);
                    team.ko.push(u);
                } else if knock {
                    team.bench.push(u);
                } else {
                    team.board.push(u);
                }
            }
        }
        kos
    }

    fn finish(&mut self, outcome: Outcome, reason: EndReason) {
        if self.over.is_some() {
            return;
        }
        self.over = Some(outcome);
        self.reason = Some(reason);
        self.finished_at = Some(now());
        self.push(None, Action::Over { reason });
    }

    fn check_win(&mut self) {
        if self.over.is_some() {
            return;
        }
        match (self.team(Side::A).alive() == 0, self.team(Side::B).alive() == 0) {
            (true, true) => self.finish(Outcome::Draw, EndReason::Ko),
            (true, false) => self.finish(Outcome::Won(Side::B), EndReason::Ko),
            (false, true) => self.finish(Outcome::Won(Side::A), EndReason::Ko),
            (false, false) => {}
        }
    }

    // ------------------------------------------------------------ tury

    pub fn start(&mut self, cat: &Catalog) {
        self.push(Some(self.first), Action::Start);
        self.start_turn(self.first);
        self.run_bots(cat);
    }

    fn start_turn(&mut self, k: Side) {
        self.active = k;
        self.turn += 1;
        if self.turn > TURN_LIMIT {
            return self.finish(Outcome::Draw, EndReason::Limit);
        }
        let rules = &g().arena;
        let first = self.first;
        let team = self.team_mut(k);
        team.turn_no += 1;
        let bonus = i64::from(team.turn_no == 1 && k != first); // drugi gracz: +1 moneta na start
        team.max_coins = rules.max_coins.min(team.turn_no) + bonus;
        team.coins = (team.max_coins - team.coin_penalty).max(0);
        team.coin_penalty = 0;
        team.actions = rules.actions;
        let mut ev = vec![];
        for u in &mut team.board {
            u.acted = false;
            for sid in ["burn", "poison"] {
                if u.has(sid) {
                    let v = u.st_val(sid);
                    u.damage(v as f64, &mut ev, true);
                }
            }
        }
        for u in &mut team.bench {
            u.acted = false;
        }
        let kos = self.collect_ko();
        self.turn_started = now();
        self.push(Some(k), Action::Turn { ev, kos, bonus });
        self.check_win();
    }

    pub fn end_turn(&mut self, k: Side, timeout: bool) -> Result<(), ArenaError> {
        if self.over.is_some() || self.active != k {
            return err("To nie twoja tura");
        }
        fn tick(team: &mut Team, ids: &[&str]) {
            for u in team.board.iter_mut().chain(&mut team.bench) {
                u.st.iter_mut().filter(|x| ids.contains(&x.id.as_str())).for_each(|x| x.turns -= 1);
                u.st.retain(|x| x.turns > 0);
            }
        }
        tick(self.team_mut(k), OWN_TICK);
        tick(self.team_mut(k.other()), OPP_TICK);
        self.push(Some(k), Action::End { timeout });
        self.start_turn(k.other());
        Ok(())
    }

    // ------------------------------------------------------------ ruchy

    pub fn place(&mut self, cat: &Catalog, k: Side, uid: i64) -> Result<(), ArenaError> {
        if self.over.is_some() || self.active != k {
            return err("To nie twoja tura");
        }
        let Some(pos) = self.team(k).bench.iter().position(|x| x.uid == uid) else { return err("Tej karty nie ma na ławce") };
        let cost = card_cost(&cat.people[&self.team(k).bench[pos].pid]);
        if self.team(k).board.len() >= g().arena.board_slots {
            return err("Plansza jest pełna");
        }
        if self.team(k).coins < cost {
            return err(format!("Za mało monet ({cost} 🪙)"));
        }
        let team = self.team_mut(k);
        team.coins -= cost;
        let mut u = team.bench.remove(pos);
        u.acted = false;
        team.board.push(u);
        self.push(Some(k), Action::Place { uid, cost });
        Ok(())
    }

    pub fn retreat(&mut self, k: Side, uid: i64) -> Result<(), ArenaError> {
        if self.over.is_some() || self.active != k {
            return err("To nie twoja tura");
        }
        let Some(pos) = self.team(k).board.iter().position(|x| x.uid == uid) else { return err("Tej karty nie ma na planszy") };
        if self.team(k).actions <= 0 {
            return err("Brak akcji ⚡");
        }
        let team = self.team_mut(k);
        team.actions -= 1;
        let u = team.board.remove(pos);
        team.bench.push(u);
        self.push(Some(k), Action::Retreat { uid });
        Ok(())
    }

    pub fn use_ability(
        &mut self,
        cat: &Catalog,
        k: Side,
        uid: i64,
        ab_index: i64,
        target: Option<i64>,
    ) -> Result<(), ArenaError> {
        let Some(u) = self.team(k).board.iter().find(|x| x.uid == uid).cloned() else { return err("Karta musi być na planszy") };
        let abl = abilities(&cat.people[&u.pid]);
        let Some(ab) = usize::try_from(ab_index).ok().and_then(|i| abl.get(i)) else { return err("Nie ma takiej zdolności") };
        if let Some(why) = self.why_cant_use(k, &u, ab) {
            return err(why);
        }
        let mut chosen = None;
        if ab.target.chosen() {
            let found = target.and_then(|t| self.find(t)).map(|x| x.uid);
            if !found.is_some_and(|t| self.valid_targets(k, ab).contains(&t)) {
                return err("Ten cel jest niedostępny");
            }
            chosen = found;
        }
        let primary = self.primary(k, uid, ab, chosen);
        let ev = self.resolve(cat, k, uid, ab, &primary);
        let kos = self.collect_ko();
        self.push(Some(k), Action::Use { uid, ab: ab_index, primary, ev, kos });
        self.last_use = Some((k, u.pid.clone()));
        self.check_win();
        Ok(())
    }

    pub fn surrender(&mut self, k: Side) {
        self.finish(Outcome::Won(k.other()), EndReason::Surrender);
    }

    // ------------------------------------------------------------ komputer

    fn ai_score(&self, cat: &Catalog, k: Side, u: &Unit, ab: &Ab, target: Option<i64>) -> f64 {
        let rules = &g().arena;
        let eff_bonus: f64 = ab.effects.iter().map(|e| 25.0 + e.value as f64 * 0.3).sum();
        let score = match ab.kind {
            AbKind::Off => {
                let targets = self.primary(k, u.uid, ab, target);
                if targets.is_empty() {
                    return -1.0;
                }
                let base = (ab.value + u.st_val("boost") - u.st_val("weaken")).max(0);
                targets
                    .into_iter()
                    .filter_map(|t| self.unit(t))
                    .map(|t| {
                        let dmg = (type_mult(cat, u, t, base).0 - t.st_val("shield")).max(0);
                        let kill = if dmg >= t.hp { 400.0 + card_cost(&cat.people[&t.pid]) as f64 * 40.0 } else { 0.0 };
                        dmg.min(t.hp) as f64 + kill
                    })
                    .sum()
            }
            AbKind::Heal => {
                let healed: i64 = self
                    .primary(k, u.uid, ab, target)
                    .into_iter()
                    .filter_map(|t| self.unit(t))
                    .filter(|t| !t.has("poison"))
                    .map(|t| ab.value.min(t.max_hp - t.hp))
                    .sum();
                if healed == 0 {
                    -1.0
                } else {
                    healed as f64 * 0.9
                }
            }
            AbKind::Eco => {
                let team = self.team(k);
                let want = team.bench.iter().any(|b| card_cost(&cat.people[&b.pid]) > team.coins)
                    && team.board.len() < rules.board_slots;
                (ab.value.min(rules.max_coins - team.coins) * if want { 35 } else { 4 }) as f64
            }
            AbKind::Def => {
                let hurt = self.team(k).board.iter().any(|x| (x.hp as f64) < x.max_hp as f64 * 0.5);
                let score = ab.value as f64 * if hurt { 0.8 } else { 0.25 };
                if self.team(k.other()).board.is_empty() {
                    score * 0.3
                } else {
                    score
                }
            }
        };
        score + eff_bonus - ab.cost as f64 * 15.0
    }

    /// Wystaw karty: najmocniejsze, na które stać
    fn place_all(&mut self, cat: &Catalog, k: Side) {
        while self.over.is_none() && self.active == k && self.team(k).board.len() < g().arena.board_slots {
            let coins = self.team(k).coins;
            let best = self
                .team(k)
                .bench
                .iter()
                .filter(|u| card_cost(&cat.people[&u.pid]) <= coins)
                .min_by_key(|u| (-card_cost(&cat.people[&u.pid]), -cat.people[&u.pid].hp))
                .map(|u| u.uid);
            match best {
                Some(uid) if self.place(cat, k, uid).is_ok() => {}
                _ => break,
            }
        }
    }

    fn ai_turn(&mut self, cat: &Catalog, k: Side) {
        // 1) wystaw karty
        self.place_all(cat, k);
        // 2) akcje: najlepsza zdolność albo ratowanie słabej karty (powrót na ławkę + wystawienie mocniejszej)
        while self.over.is_none() && self.active == k && self.team(k).actions > 0 {
            let mut best: Option<(f64, i64, usize, Option<i64>)> = None;
            for u in &self.team(k).board {
                for (i, ab) in abilities(&cat.people[&u.pid]).iter().enumerate() {
                    if self.why_cant_use(k, u, ab).is_some() {
                        continue;
                    }
                    let targets: Vec<Option<i64>> =
                        if ab.target.chosen() { self.valid_targets(k, ab).into_iter().map(Some).collect() } else { vec![None] };
                    for t in targets {
                        let sc = self.ai_score(cat, k, u, ab, t);
                        if best.is_none_or(|b| sc > b.0) {
                            best = Some((sc, u.uid, i, t));
                        }
                    }
                }
            }
            let team = self.team(k);
            let weak = team.board.iter().find(|u| (u.hp as f64) < u.max_hp as f64 * 0.3 && !u.acted).map(|u| (u.uid, u.hp));
            // najmocniejsza karta z ławki, na którą stać (pierwsza przy remisie)
            let fresh = team
                .bench
                .iter()
                .filter(|u| card_cost(&cat.people[&u.pid]) <= team.coins)
                .fold(None::<&Unit>, |acc, u| if acc.is_none_or(|a| u.hp > a.hp) { Some(u) } else { acc })
                .map(|u| (u.uid, u.hp));
            match (weak, fresh, best) {
                (Some((wu, whp)), Some((fu, fhp)), _) if fhp > whp * 2 && best.is_none_or(|b| b.0 < 120.0) => {
                    if self.retreat(k, wu).is_err() || self.place(cat, k, fu).is_err() {
                        break;
                    }
                }
                (_, _, Some((sc, uid, i, t))) if sc > 0.0 => {
                    if self.use_ability(cat, k, uid, i as i64, t).is_err() {
                        break;
                    }
                    self.place_all(cat, k); // zdolność ekonomiczna mogła dać monety na kolejną kartę
                }
                _ => break,
            }
        }
        if self.over.is_none() && self.active == k {
            let _ = self.end_turn(k, false);
        }
    }

    /// Tury komputera (i gracza z włączoną auto-grą) liczą się od razu - przeglądarka pokaże je po kolei
    pub fn run_bots(&mut self, cat: &Catalog) {
        while self.over.is_none() && self.is_bot(self.active) {
            self.ai_turn(cat, self.active);
        }
    }

    // ------------------------------------------------------------ czas (pojedynki)

    /// Przy każdym zapytaniu: koniec czasu tury, walkower za brak kontaktu
    pub fn tick(&mut self, cat: &Catalog) {
        let now = now();
        self.touched = now;
        if self.over.is_some() || self.mode != Mode::Pvp {
            return;
        }
        if let Some(away) = Side::BOTH.into_iter().find(|k| now - self.seen[k.idx()] > PVP_AWAY_SECONDS) {
            return self.finish(Outcome::Won(away.other()), EndReason::Away);
        }
        if now - self.turn_started > PVP_TURN_SECONDS {
            let _ = self.end_turn(self.active, true);
            self.run_bots(cat);
        }
    }

    pub fn turn_left(&self) -> Option<i64> {
        (self.over.is_none() && self.mode == Mode::Pvp)
            .then(|| ((PVP_TURN_SECONDS - (now() - self.turn_started)).round_ties_even() as i64).max(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bots_finish_a_battle() {
        let cat = crate::catalog::build(&[], &[]);
        let deck: Vec<DeckCard> = cat
            .people
            .values()
            .filter(|p| p.hp > 0 && !p.is_secret())
            .take(8)
            .map(|p| DeckCard { pid: p.id.clone(), variant: "normal".into() })
            .collect();
        let ai = ai_deck(&cat, &deck, &HashSet::new());
        assert_eq!(ai.len(), 8);
        let me = Player { name: "Ja".into(), user: Some(1), deck, hero: Hero::Bot { username: "Ja", bot: true } };
        let bot = Player { name: "Komputer".into(), user: None, deck: ai, hero: Hero::computer() };
        let mut b = Battle::new(&cat, Mode::Ai, me, bot, Side::A);
        b.start(&cat);
        b.set_auto(Side::A, true); // komputer gra za gracza - walka musi się skończyć
        b.run_bots(&cat);
        assert!(b.over.is_some(), "walka bez końca");
        assert!(b.steps.len() > 2);
        let view = serde_json::to_value(b.view(Side::A, 0)).unwrap();
        assert!(view["state"]["over"].is_string());
        assert_eq!(view["steps"][0]["type"], "start");
        assert!(view["state"]["sides"]["ai"]["bench"].as_array().unwrap().iter().all(|u| u["hidden"] == true));
    }
}
