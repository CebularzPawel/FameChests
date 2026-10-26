"use strict";
// ARENA (wersja testowa - na razie TYLKO DLA ADMINÓW): turowa walka kartami z kolekcji - wygląd jak w Hearthstone.
// Złote monety rosną co turę (1..10; drugi gracz dostaje +1 w swojej pierwszej turze), 2 akcje na turę,
// 4 karty na planszy, reszta to ławka ("ręka" na dole ekranu). Wystawienie karty kosztuje tylko monety;
// zdolność i powrót karty na ławkę zużywają akcję. Wygrywa ten, kto pokona wszystkie karty rywala.
// Walkę liczy serwer (arena.py): przeglądarka wysyła ruchy i po kolei odtwarza "kroki" walki z animacjami.
// Rywal to komputer albo inny gracz (wyzwanie z jego profilu). Nagroda: skrzynka z pieniędzmi za 1., 3. i 9. wygraną dnia.
// Strony w przeglądarce: "me" = ja, "ai" = rywal (komputer albo drugi gracz).

const AR = { deck: [], battle: null, game: null, seen: 0, queue: [], busy: false, loading: null, starting: false,
             pending: null, selected: null, speed: 1, pointer: null, pollTimer: null,
             inbox: null, notified: new Set(), waiting: null, revealOrig: new Map() };
const AR_SIDES = { me: "ai", ai: "me" };
const AR_GONE = "Ta walka już się skończyła";
const arWait = ms => sleep(ms / AR.speed);

function arCfg() { return S.cfg.arena; }
function arRules() { return arCfg().rules; }
function arCardCost(p) { return arRules().cardCost[p.rarity] ?? 1; }
function arAutoCost(v) { let c = 0; for (const [min, cost] of arRules().abilityCost) if (v >= min) c = cost; return c; }
function arEffect(id) { return arCfg().effects[id] || { name: id, icon: "❔" }; }

// zdolności karty w walce - stałe miejsca: 0 = zdolność 1, 1 = zdolność 2, 2+ = dodatkowe (ustawienia z panelu admina)
// (serwer liczy je tak samo - arena.abilities)
function arAbilities(p) {
  const cfg = p.arena || [];
  const list = [{ slot: 0, name: p.attack, kind: p.kind1 || "off", value: p.dmg }];
  if (p.attack2) list.push({ slot: 1, name: p.attack2, kind: p.kind2 || "off", value: p.dmg2 });
  (p.abilities || []).forEach((a, i) => list.push({ slot: 2 + i, name: a.name, kind: a.kind, value: a.value }));
  return list.map(a => {
    const c = cfg[a.slot] || {};
    return { ...a, visual: c.visual || ({ def: "bubble", heal: "hearts", eco: "money" }[a.kind] || "hit"),
             cost: c.cost ?? arAutoCost(a.value), target: c.target || (a.kind === "off" ? "enemy" : "self"), effects: c.effects || [] };
  });
}

// ================================================================ STAN WALKI (tylko do odczytu - zasady sprawdza serwer)

const arSide = s => AR.game.sides[s];
const arAll = s => [...arSide(s).board, ...arSide(s).bench];
const arFind = uid => { for (const s of ["me", "ai"]) { const u = arAll(s).find(u => u.uid === uid); if (u) return u; } return null; };
const arHas = (u, id) => u.st.some(x => x.id === id);
const arStVal = (u, id) => u.st.filter(x => x.id === id).reduce((a, x) => a + (x.value || 0), 0);

// prawidłowe cele zdolności (podświetlenie celów przy wyborze)
function arValidTargets(side, unit, ab) {
  const foe = arSide(AR_SIDES[side]).board, own = arSide(side).board;
  if (ab.target === "enemy") { const t = foe.filter(u => arHas(u, "taunt")); return t.length ? t : foe.slice(); }
  if (ab.target === "ally") return own.slice();
  return [];
}
const arNeedsTarget = ab => ab.target === "enemy" || ab.target === "ally";

function arCanAct(side, unit) {
  const s = arSide(side);
  if (AR.game.over || AR.game.active !== side) return "To nie twoja tura";
  if (!s.board.includes(unit)) return "Karta musi być na planszy";
  if (unit.acted) return "Ta karta już działała w tej turze";
  if (arHas(unit, "stun")) return "Karta jest ogłuszona 💫";
  if (s.actions <= 0) return "Brak akcji ⚡";
  return null;
}
function arCanUse(side, unit, ab) {
  const why = arCanAct(side, unit);
  if (why) return why;
  if (arSide(side).coins < ab.cost) return `Za mało monet (potrzeba ${ab.cost} 🪙)`;
  if (arNeedsTarget(ab) && !arValidTargets(side, unit, ab).length) return "Brak celu";
  return null;
}

// ================================================================ SERWER: ruchy i kroki walki

// odpowiedź serwera: dane walki + nowe kroki do odtworzenia
function arTake(res) {
  const b = AR.battle;
  if (!b || b.id !== res.id) return;
  Object.assign(b, { mode: res.mode, heroes: res.heroes, auto: res.auto });
  if (res.rewards) b.rewards = res.rewards;
  b.deadline = res.turnLeft == null ? null : Date.now() + res.turnLeft * 1000;
  if (res.chests) S.chests = res.chests;
  arApplyReveal(res.reveal);
  for (const st of res.steps) if (st.n > AR.seen) { AR.queue.push(st); AR.seen = st.n; }
}

// tajne karty rywala, których jeszcze nie odkryłem - w walce widać ich prawdziwe dane (do jej końca)
function arApplyReveal(map) {
  for (const [pid, p] of Object.entries(map || {})) {
    if (!AR.revealOrig.has(pid)) AR.revealOrig.set(pid, S.cfg.people[pid]);
    S.cfg.people[pid] = { ...p, imgq: `battle=${AR.battle.id}` };
  }
}
function arRestoreReveal() {
  for (const [pid, p] of AR.revealOrig) S.cfg.people[pid] = p;
  AR.revealOrig.clear();
}

// otwarcie walki: fresh = od początku z animacjami (nowa walka), inaczej od razu obecny stan (powrót do walki)
function arOpenBattle(res, fresh) {
  clearTimeout(AR.pollTimer);
  arRestoreReveal();
  AR.battle = { id: res.id, mode: res.mode };
  AR.queue = []; AR.seen = 0; AR.pending = AR.selected = null; AR.busy = false;
  if (fresh) { AR.game = null; arTake(res); }
  else { arTake({ ...res, steps: [] }); AR.seen = res.seen; AR.game = res.state; arRender(); }
  arPollLoop();
  return arPlay();
}

async function arLoadBattle(id, fresh) {
  if (AR.loading === id || AR.battle?.id === id) return;
  AR.loading = id;
  try { await arOpenBattle(await api(`/api/arena/battle/${id}`), fresh); }
  catch (e) { toast(e.message, true); }
  finally { AR.loading = null; }
}

async function arSend(action) {
  const b = AR.battle;
  if (!b || AR.busy) return;
  AR.busy = true; AR.pending = AR.selected = null;
  arRender();
  try { arTake(await api(`/api/arena/battle/${b.id}/act`, { ...action, since: AR.seen })); }
  catch (e) {
    Sound.error(); toast(e.message, true);
    if (e.message === AR_GONE) return arLeave();
  }
  await arPlay();
}

// kolejne kroki walki - po jednym, z animacjami
async function arPlay() {
  const b = AR.battle;
  if (!b || b.playing) return;
  b.playing = AR.busy = true;
  while (AR.queue.length && AR.battle === b) {
    const st = AR.queue.shift();
    try { await arStep(st); } catch (e) { console.error(e); AR.game = st.state; }
  }
  b.playing = false;
  if (AR.battle !== b) return;
  AR.busy = false;
  if (AR.game) arRender();
}

// pojedynek z graczem: co sekundę nowe ruchy rywala i licznik czasu tury
function arPollLoop() {
  clearTimeout(AR.pollTimer);
  const b = AR.battle;
  if (!b || b.mode !== "pvp") return;
  AR.pollTimer = setTimeout(async () => {
    if (AR.battle !== b || (AR.game?.over && !AR.queue.length)) return;
    arTimerTick();
    if (!AR.busy && !document.hidden && currentView() === "arena") {
      try { arTake(await api(`/api/arena/battle/${b.id}?since=${AR.seen}`)); arPlay(); }
      catch (e) { if (e.message === AR_GONE) { toast("Walka przepadła (serwer mógł się zrestartować)", true); return arLeave(); } }
    }
    arPollLoop();
  }, 1000);
}

function arTimerLeft() { return AR.battle?.deadline ? Math.max(0, Math.ceil((AR.battle.deadline - Date.now()) / 1000)) : null; }
function arTimerTick() {
  const el = document.getElementById("hsTimer"), left = arTimerLeft();
  if (!el || left == null) return;
  el.querySelector("b").textContent = left;
  el.classList.toggle("low", left <= 15);
}

// koniec walki / wyjście z niej: z powrotem do wyboru talii
function arLeave() {
  clearTimeout(AR.pollTimer);
  AR.battle = AR.game = null;
  AR.queue = []; AR.pending = AR.selected = null; AR.busy = false;
  if (AR.inbox) AR.inbox.battle = null;
  arRestoreReveal();
  if (currentView() === "arena") arRenderDeck(); else document.body.classList.remove("hs-open");
  arInboxCheck();
}

// przycisk "Wyjdź": w trakcie walki to poddanie (z potwierdzeniem)
async function arExit() {
  const b = AR.battle, g = AR.game;
  if (b && g && !g.over) {
    const msg = b.mode === "pvp" ? "Wyjść z pojedynku? To oznacza poddanie — wygrywa rywal." : "Wyjść z walki? To oznacza poddanie (porażkę).";
    if (!confirm(msg)) return;
    try { await api(`/api/arena/battle/${b.id}/act`, { type: "surrender", since: AR.seen }); } catch (_) { /* walka i tak się kończy */ }
  }
  closeDialogs();
  arLeave();
}

async function arStartAi() {
  const deck = arValidDeck();
  if (!deck || AR.starting) return;
  AR.starting = true;
  try {
    const res = await api("/api/arena/start", { deck: deck.map(c => c.pid) });
    closeDialogs();
    await arOpenBattle(res, true);
  } catch (e) { Sound.error(); toast(e.message, true); }
  finally { AR.starting = false; }
}

// ================================================================ ODTWARZANIE KROKÓW

function arApply(st) { AR.game = st.state; arRender(); }

async function arStep(st) {
  const mine = st.side === "me";
  // rywal (i auto-gra) "myśli" chwilę przed każdym ruchem
  if (AR.game && ["place", "use", "retreat"].includes(st.type) && (!mine || AR.battle.auto)) await arWait(900);
  switch (st.type) {
    case "start":
      arApply(st); Sound.open(); return;
    case "turn":
      if (AR.game) await arBanner(mine ? "Twoja tura" : "Tura rywala", st.side);
      if (st.ev.length && AR.game) { arShowEvents(st.ev); await arWait(700); }
      if (st.kos.length && AR.game) await arKoFx(st.kos.map(arFind).filter(Boolean));
      arApply(st);
      if (st.bonus && mine) toast("Zaczynasz jako drugi: +1 🪙 na start");
      return;
    case "place":
      arApply(st);
      return arEnterFx(arFind(st.uid));
    case "retreat": {
      const el = arEl(st.uid);
      if (el) await arAnimate(el, [{ transform: "none", opacity: 1 }, { transform: `translateY(${mine ? 120 : -120}px) scale(.6) rotate(${mine ? 8 : -8}deg)`, opacity: 0 }],
                              { duration: 500 / AR.speed, easing: "ease-in", fill: "forwards" });
      Sound.whoosh();
      return arApply(st);
    }
    case "use": {
      const unit = arFind(st.uid), ab = unit && arAbilities(person(unit.pid))[st.ab];
      const primary = st.primary.map(arFind).filter(Boolean);
      if (unit && ab) {
        arCallout(unit, ab, primary);
        await arAttackAnim(unit, ab, primary);
      }
      arShowEvents(st.ev);
      await arWait(500);
      if (st.kos.length) await arKoFx(st.kos.map(arFind).filter(Boolean));
      return arApply(st);
    }
    case "end":
      if (st.timeout) toast(mine ? "⏳ Skończył się czas twojej tury" : "⏳ Rywalowi skończył się czas tury");
      return arApply(st);
    case "over":
      arApply(st);
      return arGameOver(st);
    default:
      return arApply(st);
  }
}

// ================================================================ ANIMACJE

function arEl(uid) { return document.querySelector(`.hs-unit[data-uid="${uid}"]`); }
function arCenter(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function arLayer() {
  let l = document.getElementById("arFx");
  if (!l) { l = document.createElement("div"); l.id = "arFx"; document.body.appendChild(l); }
  return l;
}
function arSpawn(html, x, y, cls = "") {
  const el = document.createElement("div");
  el.className = "ar-fx " + cls;
  el.innerHTML = html;
  el.style.left = x + "px"; el.style.top = y + "px";
  arLayer().appendChild(el);
  return el;
}
function arShake(el, cls = "ar-shake") { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 650); }
function arOverlay(el, cls, ms = 1000) {
  if (!el) return;
  const o = document.createElement("div"); o.className = "ar-overlay " + cls; el.appendChild(o);
  setTimeout(() => o.remove(), ms);
}
// animacja WAAPI z limitem czasu (w ukrytej karcie przeglądarki animacje stoją - gra ma iść dalej)
function arAnimate(el, frames, opts) {
  const a = el.animate(frames, opts);
  return Promise.race([a.finished, sleep(opts.duration + 200)]).catch(() => {});
}

// efekt trafienia - zależny od animacji zdolności (karta atakująca już dobiegła do celu)
const AR_IMPACT = {
  hit: t => { const [x, y] = arCenter(t); fx().burst(x, y, 40, ["#fff", "#ffd54a", "#ff9f1a"], { speed: 9 }); const p = arSpawn("👊", x, y, "ar-pop"); setTimeout(() => p.remove(), 700); Sound.tick(0.2); },
  tomato: t => {
    const [x, y] = arCenter(t);
    const p = arSpawn("🍅", x, y, "ar-pop"); setTimeout(() => p.remove(), 700);
    fx().burst(x, y, 80, ["#e8221b", "#ff4b3e", "#b30f0a", "#3a9b2a"], { speed: 11, g: 0.35 });
    arOverlay(t, "ar-splat", 1800);
    const s = arSpawn("SPLAT!", x, y - 30, "ar-word ar-word-red"); setTimeout(() => s.remove(), 1000);
    Sound.fail();
  },
  ball: t => { const [x, y] = arCenter(t); const p = arSpawn("⚽", x, y, "ar-pop ar-pop-spin"); setTimeout(() => p.remove(), 700); fx().burst(x, y, 45, ["#fff", "#2fd16b", "#1b8a3c"], { speed: 10 }); Sound.boom(false); },
  fire: t => { const [x, y] = arCenter(t); fx().burst(x, y, 90, ["#ff4d00", "#ffae00", "#ffe066", "#ff2a00"], { speed: 7, g: -0.15 }); arOverlay(t, "ar-flames", 1500); const p = arSpawn("🔥", x, y, "ar-pop"); setTimeout(() => p.remove(), 700); Sound.boom(false); },
  ice: t => { const [x, y] = arCenter(t); fx().burst(x, y, 70, ["#ffffff", "#bfefff", "#6fd3ff"], { speed: 9, g: 0.05 }); arOverlay(t, "ar-frost", 1700); const p = arSpawn("❄️", x, y, "ar-pop"); setTimeout(() => p.remove(), 700); Sound.tick(0.9); },
  lightning: t => {
    const [x, y] = arCenter(t);
    const bolt = arSpawn(`<svg viewBox="0 0 40 200" preserveAspectRatio="none"><polyline points="22,0 8,70 26,82 6,200" fill="none" stroke="#fff6a0" stroke-width="5"/><polyline points="22,0 8,70 26,82 6,200" fill="none" stroke="#ffe600" stroke-width="12" opacity=".35"/></svg>`, x, 0, "ar-bolt");
    bolt.style.height = y + "px"; bolt.style.transform = "translateX(-50%)";
    setTimeout(() => bolt.remove(), 500);
    const f = arSpawn("", 0, 0, "ar-flash"); setTimeout(() => f.remove(), 320);
    fx().burst(x, y, 70, ["#fff6a0", "#ffe600", "#ffffff"], { speed: 14 });
    Sound.boom(true);
  },
  explosion: t => {
    const [x, y] = arCenter(t);
    const b = arSpawn("💥", x, y, "ar-boom"); setTimeout(() => b.remove(), 800);
    fx().burst(x, y, 150, ["#ff3b00", "#ffb000", "#ffe86b", "#5a5a5a"], { speed: 16 });
    arShake(document.querySelector(".hs-field"), "ar-screen-shake");
    Sound.boom(true);
  },
  money: t => {
    const r = t.getBoundingClientRect();
    for (let i = 0; i < 14; i++) {
      const m = arSpawn(Math.random() < 0.5 ? "💸" : "💵", r.left + Math.random() * r.width, r.top - 50, "ar-rain");
      m.style.animationDelay = (Math.random() * 300) + "ms"; setTimeout(() => m.remove(), 1500);
    }
    const [x, y] = arCenter(t); fx().burst(x, y, 50, GOLDS, { speed: 9 });
    Sound.cash();
  },
  mic: t => {
    const [x, y] = arCenter(t);
    for (let i = 0; i < 3; i++) setTimeout(() => { const w = arSpawn("", x, y, "ar-wave"); setTimeout(() => w.remove(), 900); }, i * 140);
    ["🎵", "🎶", "🎤"].forEach((n, i) => { const e = arSpawn(n, x + (i - 1) * 34, y, "ar-rise"); setTimeout(() => e.remove(), 1300); });
    Sound.reveal("blue");
  },
  hearts: t => {
    const r = t.getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      const h = arSpawn(["💖", "💚", "💗"][i % 3], r.left + Math.random() * r.width, r.bottom - 20, "ar-rise");
      h.style.animationDelay = (i * 70) + "ms"; setTimeout(() => h.remove(), 1500);
    }
    Sound.reveal("green");
  },
  bubble: t => { arOverlay(t, "ar-bubble", 1300); Sound.tick(0.6); },
};

// ATAK: karta podbiega do celu, efekt trafienia, powrót. Obrona / leczenie: karta pulsuje, efekt na celach.
async function arAttackAnim(unit, ab, primary) {
  const from = arEl(unit.uid);
  const tos = primary.map(u => arEl(u.uid)).filter(Boolean);
  const impact = AR_IMPACT[ab.visual] || AR_IMPACT.hit;
  if (!from) return arWait(300);
  from.classList.add("hs-attacking");
  const enemyHit = ab.kind === "off" && primary.some(u => u.side !== unit.side);
  if (enemyHit && tos.length) {
    const [x0, y0] = arCenter(from);
    const pts = tos.map(arCenter);
    const tx = pts.reduce((a, p) => a + p[0], 0) / pts.length, ty = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const dx = (tx - x0) * (tos.length > 1 ? 0.6 : 0.8), dy = (ty - y0) * (tos.length > 1 ? 0.6 : 0.8);
    Sound.whoosh();
    // zamach (lekko do tyłu), szarża do celu
    await arAnimate(from, [{ transform: "none" }, { transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.1) rotate(${dx > 0 ? -6 : 6}deg)` }],
                    { duration: 260 / AR.speed, easing: "ease-out", fill: "forwards" });
    await arAnimate(from, [{ transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.1)` }, { transform: `translate(${dx}px, ${dy}px) scale(1.18)` }],
                    { duration: 340 / AR.speed, easing: "cubic-bezier(.5,0,.9,.6)", fill: "forwards" });
    tos.forEach(t => { impact(t); arShake(t, ab.visual === "explosion" || ab.visual === "ball" ? "ar-knock" : "ar-shake"); });
    await arWait(320);
    await arAnimate(from, [{ transform: `translate(${dx}px, ${dy}px) scale(1.18)` }, { transform: "none" }],
                    { duration: 420 / AR.speed, easing: "ease-out", fill: "forwards" });
  } else {
    await arAnimate(from, [{ transform: "none", filter: "none" }, { transform: "scale(1.15)", filter: "brightness(1.5) drop-shadow(0 0 18px #9ff6ff)" }, { transform: "none", filter: "none" }],
                    { duration: 600 / AR.speed, easing: "ease-in-out" });
    (tos.length ? tos : [from]).forEach(t => impact(t));
    await arWait(500);
  }
  from.getAnimations().forEach(a => a.cancel());
  from.classList.remove("hs-attacking");
}

// liczby nad kartami (jak w Hearthstone: czerwona gwiazda z obrażeniami)
function arShowEvents(ev) {
  const offsets = {};
  for (const e of ev) {
    const el = arEl(e.uid); if (!el) continue;
    const [x, y] = arCenter(el);
    const k = offsets[e.uid] = (offsets[e.uid] || 0) + 1;
    if (["dmg", "heal", "shield", "block"].includes(e.kind)) {
      const text = e.kind === "dmg" ? `−${e.amount}` : e.kind === "heal" ? `+${e.amount}` : e.kind === "shield" ? `+${e.amount}` : `−${e.amount}`;
      const n = arSpawn(`<span>${text}</span>`, x + (k - 1) * 18, y + (k - 1) * 14, `hs-burst hs-burst-${e.kind}`);
      setTimeout(() => n.remove(), 1600);
    } else {
      const n = arSpawn(e.text, x, y - 50 - (k - 1) * 24, "ar-num-text");
      setTimeout(() => n.remove(), 1700);
    }
  }
}

// napis z nazwą użytej zdolności (kto i czym atakuje) - nad środkiem planszy
function arCallout(unit, ab, primary) {
  const field = document.querySelector(".hs-field");
  if (!field) return;
  const r = field.getBoundingClientRect(), p = person(unit.pid);
  const vis = arCfg().visuals[ab.visual]?.icon || "👊";
  const target = primary.length === 1 && primary[0] !== unit ? person(primary[0].pid).name : primary.length > 1 ? (ab.kind === "off" ? "wszyscy wrogowie" : "wszyscy sojusznicy") : "";
  const el = arSpawn(`<div class="hs-call-who"><img src="${imgUrl(unit.pid, null, true)}" alt="">${esc(p.name)}${target ? ` <span>→ ${esc(target)}</span>` : ""}</div>
      <div class="hs-call-ab">${vis} ${esc(ab.name)} <b>${kindIcon(ab.kind)}${ab.value}</b></div>
      ${ab.effects.length ? `<div class="hs-call-eff">${ab.effects.map(e => `${arEffect(e.id).icon} ${esc(arEffect(e.id).name)}`).join(" · ")}</div>` : ""}`,
    r.left + r.width / 2, r.top + r.height / 2, `hs-callout ${unit.side}`);
  setTimeout(() => el.remove(), 2600 / AR.speed);
}

async function arKoFx(units) {
  units.forEach(u => {
    const el = arEl(u.uid); if (!el) return;
    el.classList.add("ar-ko");
    const [x, y] = arCenter(el);
    const t = arSpawn("K.O.", x, y, "ar-word ar-word-ko"); setTimeout(() => t.remove(), 1200);
    fx().burst(x, y, 70, ["#888", "#ccc", "#ff4040"], { speed: 9 });
  });
  Sound.fail();
  await arWait(900);
}

// wejście karty na planszę - efekt zależy od wariantu (tylko wygląd)
const AR_ENTER_COLORS = {
  normal: ["#ffffff", "#c9d6ff"], bw: ["#000", "#fff", "#888"], reverse: RAINBOW, silver: ["#e6ebf2", "#b8c2d0", "#fff"], platinum: ["#fff", "#e6ebff", "#c8cede"],
  bronze: ["#cd7f32", "#f0b27a", "#fff"], pearl: ["#fff", "#ffd1e4", "#d3fff1", "#d3e2ff"], vintage: ["#efe4cb", "#b8913d", "#6b4c22"],
  slime: ["#7dff3a", "#c6ff6c", "#3fbf1a"], matte: ["#2a2a2a", "#5c5c5c", "#fff"], racing: ["#c8202f", "#f2e6cf", "#161210"], bismuth: ["#ff4fb5", "#ffd23f", "#3fe0ff", "#7a5cff"],
  digital: ["#3dff6e", "#0f6a26", "#eaffea"], cyber: ["#ff2bd6", "#00e5ff", "#fcee0a"], fade: ["#f9e45b", "#f05ba5", "#5aa8f5"], wanted: ["#f2e2b8", "#b8955a", "#2a1608"],
  artdeco: ["#d4af37", "#fff3c4", "#0a0908"], cheese: ["#ffd34a", "#ffe680", "#b88512"],
  aero: ["#4cc2ff", "#ffffff", "#7ef03a"], honey: ["#ffd75e", "#f2a20f", "#b86a08"],
  chinese: ["#d81e1e", "#e2b13c", "#fff2b0"],
  moro: ["#4a4f2e", "#6a5a3a", "#a89a6a"], beer: ["#f7bf3a", "#fffdf6", "#cf7a0c"],
  electric: ["#9fdcff", "#fff", "#4fb8ff"], synthwave: ["#ff2bd6", "#00e5ff", "#ffe14a"], motor: ["#e8202f", "#f2f2f2", "#1b1b1b"],
  chocolate: ["#6b3a1f", "#d4a12a", "#ffe6c8"], candy: ["#ff5aa8", "#3ddc84", "#fff"], hollywood: ["#ffd08a", "#e0683a", "#8a3a5a"], cobalt: ["#3ab0ff", "#bfe6ff", "#1e4fd8"], banana: ["#ffe14a", "#9ab82a", "#7a5414"],
  uranium: ["#5dff1f", "#b6ff5a", "#d8ff8a"], mercury: ["#fff", "#c8d0d8", "#6a7480"], californium: ["#fff", "#dfe6f2", "#9aa2b0"], reflective: ["#e6ff2a", "#d8dde2", "#fff"], usa: ["#f2f2f2", "#141414", "#8a8a8a"],
  marble: ["#fff", "#d9d4c8", "#d4af37"], toxic: ["#5dff1f", "#b6ff3a", "#ffd400"], holo: RAINBOW, gold: GOLDS, clear: ["#ffffff", "#e0f7ff", "#bfefff"], emerald: ["#00c853", "#6dffb0", "#fff"],
  pixel: ["#3a5bd0", "#fff", "#7dff5a", "#ffe13b"], glass: ["#2f7fc0", "#3fa0a0", "#6a5aa8", "#e8a33a"], neon: ["#ff3df0", "#3de0ff", "#ffe63c"], thermal: ["#d8303a", "#f07a1a", "#ffd23f"], blueprint: ["#1f3a7a", "#e8f4ff", "#4a8ad8"], glitch: ["#ff2b5a", "#00e5ff", "#fff"], mosaic: ["#c91a09", "#f2cd37", "#0055bf"], noir: ["#e8e8e8", "#2a2a2a", "#fff"], popart: ["#ffe100", "#e8202f", "#ff4fa0", "#2fd0ff"], holo: RAINBOW, gold: GOLDS, clear: ["#ffffff", "#e0f7ff", "#bfefff"], emerald: ["#00c853", "#6dffb0", "#fff"],
  ruby: ["#ff1744", "#ff8a9c", "#fff"], amethyst: ["#9b3dff", "#c99bff", "#fff"], sapphire: ["#1c46d8", "#5a86ff", "#fff"],
  blackdiamond: ["#0a0a0e", "#6a6a7c", "#c8c8d8", "#fff"], steel: ["#d2d9df", "#8c969f", "#3e464d"], diamond: ["#e8fbff", "#9ff6ff", "#c9b8ff", "#fff"], negative: ["#000", "#fff", "#00e5ff"],
  royal: ["#ffd75e", "#fff3c4", "#e0115f", "#1e5bff", "#12b85c", "#9b30ff"], flag: ["#ffffff", "#ff3b3b", "#3b6bff", "#ffd54a"],
  rzulty: ["#ffe600", "#fff59d", "#ffd000", "#ffffff"], mlg: ["#9cff00", "#ffe100", "#ff7a00", "#ff2bd6", "#00e5ff"],
};
async function arEnterFx(unit) {
  const el = unit && arEl(unit.uid); if (!el) return;
  const v = unit.variant || "normal";
  el.classList.add("ar-enter", "ar-enter-" + v);
  await arWait(420);
  const [x, y] = arCenter(el);
  const special = v !== "normal";
  fx().burst(x, y, special ? 130 : 30, AR_ENTER_COLORS[v] || cvColors(v) || AR_ENTER_COLORS.normal, { speed: special ? 13 : 6, stars: special ? 0.4 : 0.1 });
  if (["gold", "platinum", "diamond", "emerald", "ruby", "amethyst", "sapphire", "blackdiamond", "negative", "royal", "flag", "rzulty"].includes(v)) Sound.gold(); else Sound.land(person(unit.pid).rarity === "secret" ? "ultra" : person(unit.pid).rarity);
  await arWait(380);
  el.classList.remove("ar-enter", "ar-enter-" + v);
}

async function arBanner(text, side) {
  const root = document.getElementById("hsRoot");
  if (!root) return;
  const b = document.createElement("div");
  b.className = "hs-banner " + (side === "me" ? "mine" : "theirs");
  b.innerHTML = `<span>${text}</span>`;
  root.appendChild(b);
  if (side === "me") Sound.reveal("gold"); else Sound.page();
  await arWait(1300);
  b.remove();
}

// ================================================================ WIDOK: TALIA (lobby areny)

function renderArena() {
  if (!S.cfg.arena) { $("#arenaBody").innerHTML = '<div class="empty">Arena jest niedostępna.</div>'; return; }
  if (AR.battle && AR.game) { arRender(); return arCatchUp(); }
  if (!AR.battle && AR.inbox?.battle) arLoadBattle(AR.inbox.battle.id, false);  // np. po odświeżeniu strony
  arRenderDeck();
}

// powrót do zakładki w trakcie walki: dogonienie tego, co się wydarzyło (bez długiego odtwarzania)
async function arCatchUp() {
  const b = AR.battle;
  if (!b || AR.busy || b.mode !== "pvp") return;
  let res;
  try { res = await api(`/api/arena/battle/${b.id}?since=${AR.seen}`); } catch (e) { if (e.message === AR_GONE) arLeave(); return; }
  if (AR.battle !== b) return;
  if (res.steps.length > 6 && !res.steps.some(s => s.type === "over")) {
    arTake({ ...res, steps: [] }); AR.seen = res.seen; AR.game = res.state; arRender();
  } else { arTake(res); arPlay(); }
  arPollLoop();
}

function arOwnedPeople() {
  const best = {};
  for (const i of S.items) {
    const p = person(i.person);
    if (!p || p.masked) continue;
    if (!best[i.person] || varRank(i.variant) > varRank(best[i.person])) best[i.person] = i.variant;
  }
  return Object.entries(best).map(([pid, variant]) => ({ pid, variant }))
    .sort((a, b) => rarityIdx(person(b.pid).rarity) - rarityIdx(person(a.pid).rarity) || person(a.pid).name.localeCompare(person(b.pid).name, "pl"));
}

function arLoadDeck() {
  if (AR.deck.length) return;
  try { AR.deck = JSON.parse(localStorage.getItem("arenaDeck") || "[]"); } catch (e) { AR.deck = []; }
}
function arSaveDeck() { try { localStorage.setItem("arenaDeck", JSON.stringify(AR.deck)); } catch (e) {} }

// zapisana talia, o ile nadal mam wszystkie jej karty i jest pełna - inaczej null
function arValidDeck() {
  arLoadDeck();
  const owned = Object.fromEntries(arOwnedPeople().map(o => [o.pid, o.variant]));
  AR.deck = AR.deck.filter(c => owned[c.pid]).map(c => ({ pid: c.pid, variant: owned[c.pid] }));
  return AR.deck.length === arRules().deckSize ? AR.deck : null;
}

function arRewardsHTML() {
  const r = AR.inbox?.rewards;
  if (!r) return "";
  return `<div class="ar-rewards" title="Codzienna skrzynka z pieniędzmi za ${r.rewardWins.join(".,  ")}. wygraną dnia">
    ${r.rewardWins.map(w => `<span class="ar-rw${r.wins >= w ? " on" : ""}">🎁<small>${w}.</small></span>`).join("")}
    <span class="ar-rw-text">Wygrane dziś: <b>${r.wins}</b><br><small class="muted">${r.next ? `skrzynka za ${r.next}. wygraną` : "wszystkie dzisiejsze skrzynki odebrane 🎉"}</small></span>
  </div>`;
}

function arInboxHTML() {
  const ib = AR.inbox;
  if (!ib) return "";
  const deckOk = AR.deck.length === arRules().deckSize, rows = [];
  if (ib.battle && !AR.battle)
    rows.push(`<div class="ar-ch"><span class="ar-ch-text">⚔️ ${ib.battle.mode === "pvp" ? "Masz trwający pojedynek z graczem" : "Masz niedokończoną walkę"}</span>
      <button class="btn primary" data-ar-resume="${ib.battle.id}">Wróć do walki</button></div>`);
  for (const c of ib.incoming)
    rows.push(`<div class="ar-ch in">${avatarHTML(c.from)}<span class="ar-ch-text"><b>${esc(c.from.username)}</b> wyzywa cię na pojedynek!
        ${deckOk ? "" : '<br><small class="muted">Najpierw ułóż pełną talię poniżej.</small>'}</span>
      <button class="btn primary" data-ar-accept="${c.id}" ${deckOk ? "" : "disabled"}>⚔️ Przyjmij</button>
      <button class="btn" data-ar-decline="${c.id}">Odrzuć</button></div>`);
  const o = ib.outgoing;
  if (o && o.status === "pending")
    rows.push(`<div class="ar-ch out">${avatarHTML(o.to)}<span class="ar-ch-text">⏳ Czekasz, aż <b>${esc(o.to.username)}</b> przyjmie wyzwanie…</span>
      <button class="btn" data-ar-decline="${o.id}">Anuluj</button></div>`);
  return rows.length ? `<div class="panel ar-inbox">${rows.join("")}</div>` : "";
}

function arRefreshLobby() {
  if (currentView() !== "arena" || AR.battle) return;
  const box = $("#arInboxBox"), rw = $("#arRewardsBox");
  if (box) box.innerHTML = arInboxHTML();
  if (rw) rw.innerHTML = arRewardsHTML();
}

function arRenderDeck() {
  document.body.classList.remove("hs-open");
  arValidDeck();
  const owned = arOwnedPeople();
  const n = arRules().deckSize, chosen = new Set(AR.deck.map(c => c.pid));
  const stats = p => `<span class="ar-chip-stats">🪙${arCardCost(p)} · ❤️${p.hp}</span>`;
  $("#arenaBody").innerHTML = `
    <div class="panel ar-intro">
      <div class="ar-intro-text">
        <h2>⚔️ Arena <span class="ar-beta" title="Na razie widzą ją tylko admini">test · admini</span></h2>
        <p class="muted">Wybierz <b>${n} kart</b> ze swojej kolekcji i walcz z komputerem albo wyzwij innego gracza
          (przycisk <b>⚔️ Wyzwij na pojedynek</b> na jego profilu). Złote monety rosną co turę (1–10, drugi gracz dostaje +1 na start),
          masz <b>2 akcje</b> na turę, na planszy mieszczą się <b>4 karty</b>. Wystawienie karty kosztuje tylko monety,
          zdolność i powrót karty na ławkę zużywają akcję. Wygrywa ten, kto pokona wszystkie karty rywala.</p>
      </div>
      <div id="arRewardsBox">${arRewardsHTML()}</div>
    </div>
    <div id="arInboxBox">${arInboxHTML()}</div>
    <div class="panel">
      <div class="ar-deck-head">
        <h3>Twoja talia ${AR.deck.length}/${n}</h3>
        <button class="btn" data-ar="random">🎲 Losowa talia</button>
        <button class="btn" data-ar="clear" ${AR.deck.length ? "" : "disabled"}>Wyczyść</button>
        <button class="big-btn" data-ar="start" ${AR.deck.length === n ? "" : "disabled"}>🤖 WALCZ Z KOMPUTEREM</button>
      </div>
      <div class="ar-deck">${Array.from({ length: n }, (_, i) => {
        const c = AR.deck[i];
        return c ? `<div class="ar-deck-slot" data-ar-remove="${c.pid}" title="Kliknij, aby usunąć">${cardHTML(c.pid, c.variant)}</div>`
                 : `<div class="ar-deck-slot empty">${i + 1}</div>`;
      }).join("")}</div>
    </div>
    <div class="panel">
      <h3>Twoja kolekcja <small class="muted">(${owned.length} ${plural(owned.length, "osoba", "osoby", "osób")})</small></h3>
      ${owned.length < n ? `<p class="muted">Potrzebujesz co najmniej ${n} różnych kart — otwórz jeszcze kilka skrzynek.</p>` : ""}
      <div class="ar-pick">${owned.map(o => {
        const p = person(o.pid);
        return `<button class="ar-chip${chosen.has(o.pid) ? " on" : ""}" data-ar-pick="${o.pid}" style="--rc:${S.cfg.rarities[p.rarity].color}">
          <img src="${imgUrl(o.pid, null, true)}" alt=""><span class="ar-chip-name">${esc(p.name)}</span>${stats(p)}</button>`;
      }).join("")}</div>
    </div>`;
}

// ================================================================ WIDOK: PLANSZA (styl Hearthstone)

const AR_STATUS_CLASSES = ["stun", "burn", "poison", "shield", "taunt", "boost", "weaken"];

// karta na planszy: zwykły wygląd karty, aktualne HP, efekty widoczne na karcie
function arUnitHTML(u) {
  const g = AR.game, p = person(u.pid), mine = u.side === "me";
  const canAct = mine && g.active === "me" && !AR.busy && !arCanAct("me", u) && arAbilities(p).some(ab => !arCanUse("me", u, ab));
  const cls = ["hs-unit", "r-" + p.rarity, "v-" + (u.variant || "normal"),
    canAct ? "can-act" : "", u.acted && g.active === u.side ? "acted" : "", AR.selected === u ? "selected" : "",
    AR.pending?.targets.includes(u) ? "targetable" : "",
    ...AR_STATUS_CLASSES.filter(id => arHas(u, id)).map(id => "st-" + id)].filter(Boolean).join(" ");
  const shield = arStVal(u, "shield"), hurt = u.hp < u.maxHp;
  // nadrukowane HP pokazuje aktualne zdrowie (np. 25/60 na czerwono po trafieniu)
  const hpHTML = `<span class="$1${hurt ? " ar-hurt" : ""}"><small>HP</small>${u.hp}${hurt ? `<small>/${u.maxHp}</small>` : ""}</span>`;
  const card = cardHTML(u.pid, u.variant).replace(/<span class="(card-hp|sc-hp)"><small>HP<\/small>\d+<\/span>/, hpHTML);
  return `<div class="${cls}" data-uid="${u.uid}" data-side="${u.side}" style="--rc:${S.cfg.rarities[p.rarity].color}">
    <div class="hs-taunt-plate"></div>
    ${card}
    <div class="hs-veil"></div><div class="hs-poison"></div><div class="hs-flames"></div>
    <div class="hs-bubble"></div>
    <div class="hs-stun"><i>⭐</i><i>💫</i><i>⭐</i></div>
    <div class="hs-hpbar${hurt ? " hurt" : ""}"><div style="width:${Math.max(0, u.hp / u.maxHp * 100)}%"></div></div>
    ${shield ? `<span class="hs-shield-val">🛡 ${shield}</span>` : ""}
    ${u.st.length ? `<div class="hs-st">${u.st.map(s => `<span title="${esc(arEffect(s.id).name)} — ${esc(arEffect(s.id).desc || "")} (${s.turns} t.)">${arEffect(s.id).icon}<small>${s.turns}</small></span>`).join("")}</div>` : ""}
  </div>`;
}

function arHeroHTML(side) {
  const s = arSide(side), left = arAll(side).length, h = AR.battle.heroes?.[side] || {};
  const portrait = h.bot ? `<span class="hs-hero-emoji">🤖</span>`
    : h.avatarCard ? `<img src="/avatar/${encodeURIComponent(h.username)}?c=${encodeURIComponent(h.avatarCard)}" alt="">`
    : `<span class="hs-hero-emoji">${esc(h.avatar || "😎")}</span>`;
  return `<div class="hs-hero ${side}${AR.game.active === side && !AR.game.over ? " active" : ""}">
    <div class="hs-hero-port"><div class="hs-hero-frame">${portrait}</div>
      <div class="hs-hero-life" title="Karty, które zostały (plansza + ławka)">${left}</div></div>
    <div class="hs-hero-name">${esc(s.name)}</div>
  </div>`;
}

function arManaHTML(side) {
  const s = arSide(side), shown = Math.max(s.maxCoins, s.coins);
  return `<div class="hs-mana ${side}">
    <div class="hs-mana-num">${s.coins}/${s.maxCoins}</div>
    <div class="hs-coins">${Array.from({ length: arRules().maxCoins + 1 }, (_, i) => i < shown ? `<i class="${i < s.coins ? "on" : "spent"}"></i>` : "").join("")}</div>
    <div class="hs-acts" title="Akcje">${Array.from({ length: Math.max(arRules().actions, s.actions) }, (_, i) => `<span class="${i < s.actions ? "on" : ""}">⚡</span>`).join("")}</div>
  </div>`;
}

// moja ławka = "ręka" na dole ekranu (wachlarz kart); ławka rywala = rewersy u góry
function arHandHTML() {
  const g = AR.game, me = arSide("me"), n = me.bench.length;
  return me.bench.map((u, i) => {
    const p = person(u.pid), cost = arCardCost(p), off = i - (n - 1) / 2;
    const playable = g.active === "me" && !AR.busy && !g.over && me.coins >= cost && me.board.length < arRules().boardSlots;
    return `<div class="hs-hcard${playable ? " playable" : ""}" data-bench="${u.uid}"
              style="--off:${off}; --rot:${off * 5}deg; --lift:${Math.abs(off) * Math.abs(off) * 3}px; z-index:${10 + i}">
      ${cardHTML(u.pid, u.variant)}
      <span class="hs-hcost">${cost}</span>
      ${u.hp < u.maxHp ? `<span class="hs-hhp">❤ ${u.hp}/${u.maxHp}</span>` : ""}
    </div>`;
  }).join("");
}
function arEnemyHandHTML() {
  const n = arSide("ai").bench.length;
  return Array.from({ length: n }, (_, i) => { const off = i - (n - 1) / 2; return `<div class="hs-ecard" style="--off:${off}; --rot:${-off * 5}deg">${cardBackHTML()}</div>`; }).join("");
}

function arPopoverHTML() {
  const u = AR.selected;
  if (!u || AR.pending) return "";
  const p = person(u.pid), me = arSide("me");
  return `<div class="hs-pop" id="hsPop">
    <div class="hs-pop-title">${esc(p.name)} <button class="hs-pop-x" data-ar="deselect" title="Anuluj">✕</button></div>
    <div class="hs-pop-list">
      ${arAbilities(p).map((ab, i) => {
        const why = arCanUse("me", u, ab);
        return `<button class="hs-ab${ab.kind !== "off" ? " " + ab.kind : ""}" data-ab="${i}" ${why ? `disabled title="${esc(why)}"` : ""}>
          <span class="hs-ab-vis">${arCfg().visuals[ab.visual]?.icon || "👊"}</span>
          <span class="hs-ab-name">${esc(ab.name)}</span>
          <span class="hs-ab-val">${kindIcon(ab.kind)} ${ab.value}</span>
          <span class="hs-ab-meta">${ab.cost ? `<b class="hs-ab-cost">${ab.cost} 🪙</b>` : "za darmo"} · ${esc(arCfg().targets[ab.target])}</span>
          ${ab.effects.length ? `<span class="hs-ab-eff">${ab.effects.map(e => `${arEffect(e.id).icon} ${esc(arEffect(e.id).name)}`).join(" · ")}</span>` : ""}
        </button>`;
      }).join("")}
      <button class="hs-ab swap" data-ar="retreat" ${me.actions > 0 ? "" : "disabled"}>
        <span class="hs-ab-vis">↩️</span><span class="hs-ab-name">Wróć na ławkę</span><span class="hs-ab-val">1 ⚡</span>
        <span class="hs-ab-meta">karta wraca do ręki z obecnym HP; możesz ją potem znów wystawić</span></button>
    </div>
  </div>`;
}

function arRender() {
  const g = AR.game;
  if (!g || !AR.battle) return arRenderDeck();
  if (currentView() !== "arena") return;
  document.body.classList.add("hs-open");
  const me = arSide("me"), ai = arSide("ai"), myTurn = g.active === "me" && !g.over, auto = AR.battle.auto;
  const noMoves = myTurn && !AR.busy && !me.board.some(u => !arCanAct("me", u) && arAbilities(person(u.pid)).some(ab => !arCanUse("me", u, ab)))
    && !(me.board.length < arRules().boardSlots && me.bench.some(u => arCardCost(person(u.pid)) <= me.coins));
  const left = arTimerLeft();
  $("#arenaBody").innerHTML = `
  <div class="hs" id="hsRoot">
    <div class="hs-table">
      <div class="hs-field${AR.pending ? " targeting" : ""}">
        <div class="hs-ehand">${arEnemyHandHTML()}</div>
        ${arHeroHTML("ai")}
        ${arManaHTML("ai")}
        <div class="hs-row ai">${ai.board.map(arUnitHTML).join("")}</div>
        <div class="hs-row me">${me.board.map(arUnitHTML).join("")}</div>
        ${arHeroHTML("me")}
        ${arManaHTML("me")}
        <button class="hs-end${myTurn ? "" : " wait"}${noMoves ? " ready" : ""}" data-ar="end" ${myTurn && !AR.busy && !auto ? "" : "disabled"}>
          ${myTurn ? "KONIEC TURY" : "TURA RYWALA"}</button>
        ${left != null && !g.over ? `<div class="hs-timer${myTurn ? " mine" : ""}${left <= 15 ? " low" : ""}" id="hsTimer" title="Czas na turę">⏳ <b>${left}</b> s</div>` : ""}
        <div class="hs-menu">
          <button class="hs-menu-btn hs-exit" data-ar="exit" title="${g.over ? "Wyjdź z areny" : "Wyjdź (poddanie walki)"}">🚪 Wyjdź</button>
          ${S.me.isAdmin ? `<label class="hs-auto" title="Admin: komputer gra za ciebie (walka bez nagród)"><input type="checkbox" data-ar-auto ${auto ? "checked" : ""}> 🤖</label>` : ""}
          ${AR.battle.mode === "pvp" ? `<span class="hs-menu-btn hs-mode" title="Pojedynek z graczem">👥 Pojedynek</span>` : ""}
        </div>
        ${AR.pending ? `<div class="hs-hint">🎯 Wybierz cel · prawy przycisk / Esc = anuluj</div>` : ""}
      </div>
    </div>
    <div class="hs-hand">${arHandHTML()}</div>
    ${arPopoverHTML()}
    <svg class="hs-arrow" id="hsArrow"></svg>
    <div class="hs-preview" id="hsPreview" hidden></div>
  </div>`;
  arPlacePopover();
  arDrawArrow();
}

// okienko zdolności nad wybraną kartą
function arPlacePopover() {
  const pop = document.getElementById("hsPop"), u = AR.selected;
  if (!pop || !u) return;
  const el = arEl(u.uid); if (!el) return;
  const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const top = r.top - h - 14 > 8 ? r.top - h - 14 : Math.min(innerHeight - h - 8, r.bottom + 14);
  pop.style.left = left + "px"; pop.style.top = top + "px";
}

// strzałka celowania (od karty do kursora), jak w Hearthstone
function arDrawArrow() {
  const svg = document.getElementById("hsArrow");
  if (!svg) return;
  if (!AR.pending || !AR.pointer) { svg.innerHTML = ""; return; }
  const from = arEl(AR.pending.unit.uid); if (!from) return;
  const [x0, y0] = arCenter(from), [x1, y1] = AR.pointer;
  const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 80;
  const over = document.elementFromPoint(x1, y1)?.closest(".hs-unit.targetable");
  const col = over ? "#ff3b3b" : "#ffd54a";
  svg.innerHTML = `<defs><marker id="hsHead" markerWidth="5" markerHeight="5" refX="2.5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" fill="${col}"/></marker></defs>
    <path d="M${x0},${y0} Q${mx},${my} ${x1},${y1}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="2 16" marker-end="url(#hsHead)"/>
    ${over ? `<circle cx="${x1}" cy="${y1}" r="26" fill="none" stroke="#ff3b3b" stroke-width="4"/><circle cx="${x1}" cy="${y1}" r="6" fill="#ff3b3b"/>` : ""}`;
}

function arPreview(el) {
  const box = document.getElementById("hsPreview");
  if (!box) return;
  if (!el || AR.pending || matchMedia("(hover: none)").matches) { box.hidden = true; return; }
  const u = arFind(+(el.dataset.uid || el.dataset.bench));
  if (!u || u.hidden) return;
  const p = person(u.pid);
  box.innerHTML = `${cardHTML(u.pid, u.variant)}
    <div class="hs-prev-info">${arAbilities(p).map(ab => `<div><b>${arCfg().visuals[ab.visual]?.icon || ""} ${esc(ab.name)}</b> ${kindIcon(ab.kind)}${ab.value}
      ${ab.cost ? ` · ${ab.cost}🪙` : ""}${ab.effects.length ? `<br><small>${ab.effects.map(e => `${arEffect(e.id).icon} ${esc(arEffect(e.id).name)}${e.value && arEffect(e.id).value ? " " + e.value : ""}${arEffect(e.id).turns ? ` (${e.turns} t.)` : ""}`).join(", ")}</small>` : ""}</div>`).join("")}
      ${u.st.length ? `<div class="hs-prev-st">${u.st.map(s => `${arEffect(s.id).icon} ${esc(arEffect(s.id).name)} (${s.turns} t.)`).join("<br>")}</div>` : ""}</div>`;
  const r = el.getBoundingClientRect();
  box.hidden = false;
  box.classList.toggle("left", r.left + r.width / 2 > innerWidth / 2);
}

function arGameOver(st) {
  const b = AR.battle, win = st.winner === "me", draw = st.winner === "draw", pvp = b.mode === "pvp";
  const rival = pvp ? esc(b.heroes?.ai?.username || "Rywal") : "Komputer";
  if (win) { confetti(GOLDS.concat(RAINBOW), 260); Sound.win(); } else Sound.fail();
  const why = {
    ko: win ? "Wszystkie karty rywala są pokonane." : draw ? "Obie strony straciły wszystkie karty." : "Wszystkie twoje karty są pokonane.",
    surrender: win ? `${rival} się poddaje.` : "Walka poddana.",
    away: win ? `${rival} opuszcza walkę — wygrana walkowerem.` : "Zbyt długo nie było cię w walce.",
    limit: "Walka trwała za długo.",
  }[st.reason] || "";
  const r = b.rewards, chest = r?.chest && S.cfg.moneyChests[r.chest];
  const reward = b.auto ? `<p class="muted small">🤖 Auto-gra — walka bez nagród.</p>`
    : chest ? `<div class="ar-reward got">${moneyChestArt(r.chest, "ar-reward-chest")}
        <div><b>🎁 ${esc(chest.name)}!</b><br><span class="muted small">Nagroda za ${r.wins}. wygraną dnia — czeka w ekwipunku (📦 Twoje skrzynki).</span></div></div>`
    : r ? `<p class="muted small">Wygrane dziś: <b>${r.wins}</b>${r.next ? ` · następna skrzynka za ${r.next}. wygraną` : " · dzisiejsze skrzynki odebrane 🎉"}</p>` : "";
  openDialog(`<div class="ar-over ${win ? "win" : "lose"}">
      <div class="ar-over-icon">${win ? "🏆" : draw ? "🤝" : "💀"}</div>
      <h2>${win ? "Wygrana!" : draw ? "Remis" : "Porażka"}</h2>
      <p class="muted">${pvp ? `Pojedynek z <b>${rival}</b>. ` : ""}${why}
        <br>Tur: ${Math.ceil(AR.game.turn / 2)} · twoje straty: ${arSide("me").ko.length}/${arRules().deckSize}</p>
      ${reward}
      <div class="daily-actions">
        ${pvp ? `<button class="btn primary" data-ar-rematch="${esc(b.heroes?.ai?.username || "")}">⚔️ Rewanż</button>`
              : `<button class="btn primary" data-ar-again>⚔️ Jeszcze raz</button>`}
        <button class="btn" data-ar-exit>🚪 Wyjdź</button></div>
    </div>`);
  if (chest && currentView() === "inventory") renderInventory();
  arInboxCheck();
}

// ================================================================ WYZWANIA (pojedynki z graczami)

// z profilu gracza: wyzwanie na pojedynek moją zapisaną talią
async function arChallenge(username) {
  const deck = arValidDeck();
  if (!deck) {
    toast(`Najpierw ułóż w Arenie talię ${arRules().deckSize} kart`, true);
    return switchView("arena");
  }
  try {
    const c = await api("/api/arena/challenge", { username, deck: deck.map(x => x.pid) });
    AR.waiting = c.id;
    openDialog(`<div class="ar-duel">
        <div class="ar-duel-av">${avatarHTML(c.to, "pf-av")}</div>
        <h3>⚔️ Wyzwanie wysłane</h3>
        <p class="muted">Czekam, aż <b>${esc(c.to.username)}</b> przyjmie pojedynek…</p>
        <div class="ar-wait-left" id="arWaitLeft">${arClock(c.left)}</div>
        <div class="daily-actions"><button class="btn" data-ar-decline="${c.id}" data-close>Anuluj wyzwanie</button></div>
      </div>`);
    Sound.click();
    arInboxSoon();
  } catch (e) { Sound.error(); toast(e.message, true); }
}

function arClock(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

async function arAccept(id) {
  const deck = arValidDeck();
  if (!deck) {
    closeDialogs();
    toast(`Ułóż talię ${arRules().deckSize} kart i przyjmij wyzwanie w Arenie`, true);
    return switchView("arena");
  }
  try {
    const r = await api(`/api/arena/challenge/${id}/accept`, { deck: deck.map(x => x.pid) });
    closeDialogs();
    switchView("arena");
    await arLoadBattle(r.battle, true);
  } catch (e) { Sound.error(); toast(e.message, true); arInboxCheck(); }
}

async function arDecline(id) {
  try { await api(`/api/arena/challenge/${id}/decline`, {}); } catch (_) { /* już nieaktualne */ }
  if (AR.waiting === id) AR.waiting = null;
  arInboxCheck();
}

// nowe wyzwanie od kogoś: okienko (albo tylko powiadomienie, gdy jestem zajęty)
function arNotifyChallenge(c) {
  Sound.reveal("gold");
  if ((AR.game && !AR.game.over) || dialogOpen() || epicOpen() || S.opening)
    return toast(`⚔️ ${c.from.username} wyzywa cię na pojedynek — odpowiedz w Arenie`);
  openDialog(`<div class="ar-duel">
      <div class="ar-duel-av">${avatarHTML(c.from, "pf-av")}</div>
      <h3>⚔️ Wyzwanie na pojedynek!</h3>
      <p class="muted"><b>${esc(c.from.username)}</b> chce zagrać z tobą w Arenie.</p>
      <div class="daily-actions"><button class="btn primary" data-ar-accept="${c.id}">⚔️ Przyjmij</button>
        <button class="btn" data-ar-decline="${c.id}" data-close>Odrzuć</button></div>
    </div>`);
}

// co kilka sekund: wyzwania, odpowiedź na moje wyzwanie, trwająca walka (np. po odświeżeniu strony)
async function arInboxCheck() {
  let ib;
  if (!S.cfg.arena) return;
  try { ib = await api("/api/arena/inbox"); } catch (_) { return; }
  AR.inbox = ib;
  for (const c of ib.incoming) if (!AR.notified.has(c.id)) { AR.notified.add(c.id); arNotifyChallenge(c); }
  const o = ib.outgoing;
  if (o && AR.waiting === o.id) {
    if (o.status === "accepted" && o.battle) {
      AR.waiting = null;
      closeDialogs();
      switchView("arena");
      await arLoadBattle(o.battle, true);
    } else if (o.status !== "pending") {
      AR.waiting = null;
      closeDialogs();
      toast({ declined: `${o.to.username} odrzuca wyzwanie`, expired: "Wyzwanie wygasło — brak odpowiedzi" }[o.status] || "Wyzwanie anulowane", true);
    } else {
      const el = $("#arWaitLeft");
      if (el) el.textContent = arClock(o.left);
    }
  }
  if (ib.battle && !AR.battle && currentView() === "arena") arLoadBattle(ib.battle.id, false);
  arReturnButton();
  arRefreshLobby();
}

let AR_INBOX_TIMER = null;
function arInboxLoop() {
  clearTimeout(AR_INBOX_TIMER);
  AR_INBOX_TIMER = setTimeout(async () => {
    if (!document.hidden) await arInboxCheck();
    arInboxLoop();
  }, AR.waiting ? 1500 : 4000);
}
function arInboxSoon() { clearTimeout(AR_INBOX_TIMER); AR_INBOX_TIMER = setTimeout(async () => { await arInboxCheck(); arInboxLoop(); }, 1500); }

// trwająca walka, a ja w innej zakładce: pływający przycisk powrotu
function arReturnButton() {
  let btn = document.getElementById("arReturn");
  const show = !!AR.inbox?.battle && currentView() !== "arena";
  if (!btn && !show) return;
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "arReturn"; btn.className = "ar-return";
    btn.innerHTML = "⚔️ Wróć do walki";
    btn.addEventListener("click", () => { btn.hidden = true; switchView("arena"); });
    document.body.appendChild(btn);
  }
  btn.hidden = !show;
}

// ================================================================ STEROWANIE

function arCancel() { AR.pending = AR.selected = null; arRender(); }

function arSelectAbility(i) {
  const u = AR.selected, ab = arAbilities(person(u.pid))[i];
  const why = arCanUse("me", u, ab);
  if (why) { Sound.error(); return toast(why, true); }
  if (arNeedsTarget(ab)) {
    AR.pending = { unit: u, ab, abIndex: i, targets: arValidTargets("me", u, ab) };
    Sound.click();
    return arRender();
  }
  arSend({ type: "use", uid: u.uid, ab: i });
}

function bindArena() {
  const body = $("#arenaBody");
  body.addEventListener("click", async e => {
    const t = e.target;
    const act = t.closest("[data-ar]")?.dataset.ar;
    // talia
    if (t.closest("[data-ar-pick]")) {
      const pid = t.closest("[data-ar-pick]").dataset.arPick, n = arRules().deckSize;
      const i = AR.deck.findIndex(c => c.pid === pid);
      if (i >= 0) AR.deck.splice(i, 1);
      else if (AR.deck.length < n) AR.deck.push({ pid, variant: "normal" });
      else return toast(`Talia ma już ${n} kart`, true);
      Sound.click(); arSaveDeck(); return arRenderDeck();
    }
    if (t.closest("[data-ar-remove]")) { AR.deck = AR.deck.filter(c => c.pid !== t.closest("[data-ar-remove]").dataset.arRemove); arSaveDeck(); return arRenderDeck(); }
    if (act === "random") {
      const owned = arOwnedPeople().sort(() => Math.random() - 0.5);
      AR.deck = owned.slice(0, arRules().deckSize).map(o => ({ pid: o.pid, variant: o.variant }));
      Sound.click(); arSaveDeck(); return arRenderDeck();
    }
    if (act === "clear") { AR.deck = []; arSaveDeck(); return arRenderDeck(); }
    if (act === "start") return arStartAi();
    if (act === "exit") return arExit();
    const g = AR.game;
    if (!g || AR.busy) return;
    if (g.active !== "me" || g.over) return;
    if (act === "end") { Sound.click(); return arSend({ type: "end" }); }
    if (act === "deselect") return arCancel();
    if (act === "retreat") return arSend({ type: "retreat", uid: AR.selected.uid });
    const ab = t.closest("[data-ab]");
    if (ab) return arSelectAbility(+ab.dataset.ab);
    const unitEl = t.closest(".hs-unit");
    // wybór celu
    if (AR.pending) {
      if (!unitEl) return arCancel();
      const target = arFind(+unitEl.dataset.uid);
      if (!AR.pending.targets.includes(target)) {
        Sound.error();
        return toast("Ten cel jest niedostępny" + (AR.pending.ab.target === "enemy" && arSide("ai").board.some(u => arHas(u, "taunt")) ? " — najpierw karta z 📢 prowokacją" : ""), true);
      }
      const { unit, abIndex } = AR.pending;
      return arSend({ type: "use", uid: unit.uid, ab: abIndex, target: target.uid });
    }
    // ręka (ławka): wystawienie karty
    const hand = t.closest("[data-bench]");
    if (hand) {
      const u = arFind(+hand.dataset.bench), me = arSide("me");
      if (me.board.length >= arRules().boardSlots) { Sound.error(); return toast("Plansza jest pełna — możesz odesłać kartę z planszy na ławkę („Wróć na ławkę”)", true); }
      if (me.coins < arCardCost(person(u.pid))) { Sound.error(); return toast(`Za mało monet (${arCardCost(person(u.pid))} 🪙)`, true); }
      return arSend({ type: "place", uid: u.uid });
    }
    // własna karta na planszy: okienko ze zdolnościami (nieużywalne są wyszarzone, "Wróć na ławkę" działa zawsze)
    if (unitEl && unitEl.dataset.side === "me") {
      const u = arFind(+unitEl.dataset.uid);
      AR.selected = AR.selected === u ? null : u; Sound.click(); return arRender();
    }
    if (AR.selected) arCancel();
  });
  body.addEventListener("contextmenu", e => { if (AR.game && (AR.pending || AR.selected)) { e.preventDefault(); arCancel(); } });
  body.addEventListener("pointermove", e => {
    if (AR.pending) { AR.pointer = [e.clientX, e.clientY]; arDrawArrow(); }
  });
  body.addEventListener("mouseover", e => {
    if (!AR.game) return;
    arPreview(e.target.closest(".hs-unit, .hs-hcard"));
  });
  body.addEventListener("change", e => {
    if (!e.target.matches("[data-ar-auto]") || !AR.battle) return;
    arSend({ type: "auto", on: e.target.checked });
  });
  // przyciski w okienkach (koniec walki, wyzwania) i w lobby
  document.addEventListener("click", e => {
    const t = e.target, q = sel => t.closest(sel);
    if (q("[data-ar-again]")) { closeDialogs(); return arStartAi(); }
    if (q("[data-ar-exit]")) { closeDialogs(); return arLeave(); }
    if (q("[data-ar-rematch]")) { const name = q("[data-ar-rematch]").dataset.arRematch; closeDialogs(); arLeave(); return arChallenge(name); }
    if (q("[data-ar-accept]")) return arAccept(q("[data-ar-accept]").dataset.arAccept);
    if (q("[data-ar-decline]")) return arDecline(q("[data-ar-decline]").dataset.arDecline);
    if (q("[data-ar-resume]")) return arLoadBattle(q("[data-ar-resume]").dataset.arResume, false);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && AR.game && (AR.pending || AR.selected) && currentView() === "arena") arCancel();
  });
  addEventListener("resize", () => { if (AR.game && currentView() === "arena") { arPlacePopover(); arDrawArrow(); } });
  if (S.cfg.arena) arInboxCheck().then(arInboxLoop);  // Arena tylko dla adminów - reszta graczy nie pyta serwera
}
