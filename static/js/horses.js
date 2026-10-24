"use strict";
// Wyścigi konne (zakładka w Kasynie): 10 koni na okrągłym torze. Co kilka minut jedzie wspólny wyścig dla wszystkich graczy
// (zakłady przyjmujemy z wyprzedzeniem, karty czekają u serwera aż do wyniku), a w każdej chwili można zagrać też solo.
// Przebieg liczy serwer (horses.py): pozycje koni co "dt" sekund + lista zdarzeń (turbo, zawrócenie, upadek, śmierć, samochód).
// Przeglądarka tylko odtwarza go na <canvas> zgodnie z zegarem serwera i gra odgłosy koni.
// Wygrana jak w ruletce: karty zostają + karty o wartości stawka × mnożnik konia; przegrana - karty przepadają;
// nikt nie wygrał (samochód na torze) - stawki wracają.

const HR = {
  sel: new Set(), q: "", horse: null,
  force: new Set(["car"]),   // tryb debug (admin): wymuszone zdarzenia
  d: null,                  // ostatnia odpowiedź /api/casino/horses
  offset: 0,                // zegar serwera - zegar przeglądarki (s)
  solo: null,               // wyścig solo w toku: { race, res, t0, done }
  last: null,               // ostatni wynik (solo albo rozliczony zakład) do pokazania pod torem
  raf: 0, fetching: false, fetchedAt: 0,
  cur: { key: null, T: 0 }, // do którego momentu odtworzyliśmy zdarzenia
  bubbles: [], face: [], bg: null, lastPos: "", lastGallop: 0, lastNeigh: 0, nextNeigh: 2, shown: new Set(),
};
CS.sorts.hr = "value";     // sortowanie moich kart do postawienia
const HR_INTRO = 3;         // odliczanie przed wyścigiem solo (s)
const HR_SIZE = 640, HR_C = 320, HR_R0 = 160, HR_DR = 13.4;
const HR_FONT = "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
const HR_FACES_LEFT = true;                    // czy emoji 🐎 patrzy w lewo
const HR_BUBBLE = {
  turn: ["Ja wychodzę!", "Nie bawię się!", "Spadam do domu!", "Koniec z tym!", "Zły kierunek!"],
  trip: ["Au!", "Ojej!", "Kto to postawił?!", "Moje kopyto!"],
  die: ["R.I.P.", "Żegnajcie…", "Nie żyje"],
};

const hrHorses = () => S.cfg.horses.list;
const hrNow = () => Date.now() / 1000 + HR.offset;
const hrR = i => HR_R0 + i * HR_DR;
const hrAng = x => -Math.PI / 2 + x * 2 * Math.PI;
const hrPick = arr => arr[Math.floor(Math.random() * arr.length)];
function hrClockText(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ================================================================ DANE

async function hrFetch() {
  if (HR.fetching) return;
  HR.fetching = true;
  try {
    const d = await api("/api/casino/horses");
    HR.offset = d.now - Date.now() / 1000;
    HR.d = d;
    if (d.horses) S.cfg.horses.list = d.horses;   // nazwy i mnożniki mogły zmienić się w panelu admina
    HR.fetchedAt = Date.now();
    if (d.news?.length) hrNews(d.news);
  } catch (_) { /* serwer chwilowo niedostępny */ }
  HR.fetching = false;
  // panel przerysowujemy tylko, gdy coś się zmieniło (inaczej znikałby kursor w polu wyszukiwania)
  const sig = JSON.stringify([HR.d?.horses?.map(h => [h.name, h.pays]), HR.d?.mine, HR.d?.others, HR.d?.last?.map(l => l.id), HR.d?.next.id, HR.d && hrBetsOpen()]);
  if (sig !== HR.sig && CS.tab === "horses" && currentView() === "casino") { HR.sig = sig; hrRenderPanel(); }
}

// rozliczone zakłady na wspólne wyścigi (przychodzą z /api/casino/horses i /api/me)
async function hrNews(list) {
  list = list.filter(n => !HR.shown.has(n.id));
  if (!list.length) return;
  list.forEach(n => HR.shown.add(n.id));
  await syncInventory(null, true);   // wygrane karty, zwrócone stawki
  const h = hrHorses();
  for (const n of list) {
    const name = h[n.horse].name;
    if (n.status === "won") {
      const r = n.result || {};
      const items = [...(r.special ? [r.special] : []), ...(r.items || [])];
      noteCollected(items);
      HR.last = { kind: "bet", status: "won", horse: n.horse, stake: n.stake, payout: n.payout, items, money: r.money, special: r.special };
      CS.lost = false;
      toast(`🐎 Wygrana! ${name} wygrywa wyścig: +${fmt(n.payout)}`);
      Sound.win();
      confetti(["#ffcf3f", "#ff3b5c", "#fff", "#3ddc84"], 140);
      if (r.special) { await sleep(400); await epicReveal(r.special, { fast: S.fast }); announceFirsts([r.special]); }
    } else if (n.status === "lost") {
      HR.last = { kind: "bet", status: "lost", horse: n.horse, stake: n.stake };
      CS.lost = true;
      toast(`🐎 ${name} nie wygrywa. Przepada ${fmt(n.stake)}`, true);
      Sound.fail();
    } else {
      HR.last = { kind: "bet", status: "refund", horse: n.horse, stake: n.stake };
      toast(`🚗 Nikt nie wygrał wyścigu — stawka ${fmt(n.stake)} wraca do ciebie`);
    }
  }
  try { await api("/api/casino/horses/seen", { ids: list.map(n => n.id) }); } catch (_) {}
  if (currentView() === "casino" && CS.tab === "horses") hrRenderPanel();
}

// ================================================================ PANEL (HTML)

function drawHorses() {
  if (!HR.d) { $("#casinoBody").innerHTML = '<div class="panel muted">Ładowanie wyścigów…</div>'; HR.sig = null; hrFetch().then(() => hrStart()); return; }
  hrRenderPanel(true);
  hrStart();
  if (Date.now() - HR.fetchedAt > 3000) hrFetch();
}

function hrBetsOpen() {
  const left = HR.d.next.start - hrNow(), C = S.cfg.horses.race;
  return left <= C.betOpen && left >= C.betClose;
}

function hrResultHTML(r) {
  if (!r) return '<span class="muted">Wybierz konia, postaw karty i kibicuj!</span>';
  if (r.kind === "debug") return `<div class="rl-res"><span class="sl-big">🛠</span><div><b>Wyścig testowy zakończony</b><div class="muted small">${r.winner >= 0 ? `Wygrał: ${esc(hrHorses()[r.winner].name)}` : "Nikt nie wygrał"} · bez stawki</div></div></div>`;
  const h = hrHorses()[r.horse];
  const name = `<i class="hr-dot" style="background:${h.color}"></i> <b>${esc(h.name)}</b>`;
  if (r.status === "won") {
    return `<div class="rl-res win"><span class="sl-big">🏆</span><div><b class="pos-txt">WYGRANA! +${fmt(r.payout)}</b>
        <div class="muted small">${name} · ${r.items.length} ${plural(r.items.length, "karta", "karty", "kart")}${r.money ? ` + ${fmt(r.money)}` : ""} · kliknij kartę, aby obejrzeć</div></div></div>
      ${r.special ? `<div class="rl-special">🃏 <b>Karta specjalna!</b> ${esc(person(r.special.person).name)} — ${esc(variantName(r.special.variant))}</div>` : ""}
      ${r.items.length ? `<div class="pick-grid rl-won">${r.items.map(i => pickHTML(i)).join("")}</div>` : ""}`;
  }
  if (r.status === "refund") {
    return `<div class="rl-res"><span class="sl-big">🚗</span><div><b>NIKT NIE WYGRAŁ</b><div class="muted small">Stawka ${fmt(r.stake)} wróciła do ciebie.</div></div></div>`;
  }
  return `<div class="rl-res lose"><span class="sl-big">💀</span><div><b class="neg-txt">PRZEGRANA −${fmt(r.stake)}</b><div class="muted small">${name} nie wygrał${r.why ? ` — ${esc(r.why)}` : ""}</div></div></div>`;
}

function hrPanelHTML() {
  const d = HR.d, C = S.cfg.horses.race, H = hrHorses();
  const stake = csStake(HR.sel), open = hrBetsOpen(), busy = CS.spinning || !!HR.solo;
  const mine = d.mine.filter(b => b.race === d.next.id), mineLive = d.live ? d.mine.filter(b => b.race === d.live.id) : [];
  const others = d.others.filter(b => b.race === d.next.id);
  const betOn = (arr, i) => arr.filter(b => b.horse === i);
  const sel = HR.horse != null ? H[HR.horse] : null;
  return { H, d, C, stake, open, busy, mine, mineLive, others, betOn, sel };
}

function hrRenderPanel(full = false) {
  if (CS.tab !== "horses") return;
  const { H, d, C, stake, open, busy, mine, mineLive, others, betOn, sel } = hrPanelHTML();
  const rows = H.map(h => {
    const m = betOn(mine, h.id), o = betOn(others, h.id), ml = betOn(mineLive, h.id);
    return `<button class="hr-row${HR.horse === h.id ? " sel" : ""}" data-hrhorse="${h.id}"${busy ? " disabled" : ""}>
      <i class="hr-dot" style="background:${h.color}">${h.id + 1}</i>
      <span class="hr-name">${esc(h.name)}</span>
      <span class="hr-state" data-hrstate="${h.id}"></span>
      <span class="hr-pos" data-hrpos="${h.id}"></span>
      <span class="hr-pays">×${h.pays}</span>
      <span class="hr-bets">${m.map(b => `<b class="hr-chip mine" title="Twój zakład">${fmt(b.stake)}</b>`).join("")}${ml.map(b => `<b class="hr-chip mine live" title="Twój zakład w trwającym wyścigu">🏁 ${fmt(b.stake)}</b>`).join("")}${o.map(b => `<b class="hr-chip" title="${esc(b.user)}">${esc(b.user)} ${fmt(b.stake)}</b>`).join("")}</span>
    </button>`;
  }).join("");
  const myBets = mine.length ? `<div class="hr-mybets"><b>Twoje zakłady na ten wyścig:</b> ${mine.map(b => {
    const h = H[b.horse];
    return `<span class="hr-chip mine"><i class="hr-dot sm" style="background:${h.color}"></i>${esc(h.name)} · ${b.cards} ${plural(b.cards, "karta", "karty", "kart")} · ${fmt(b.stake)}${open ? ` <button class="hr-x" data-hrcancel="${b.id}" title="Wycofaj zakład">✕</button>` : ""}</span>`;
  }).join("")}</div>` : "";
  const html = `
  <div class="rl-cols hr-cols">
    <div class="panel rl-left hr-left">
      <div class="hr-stage"><canvas id="hrCanvas" width="${HR_SIZE * 2}" height="${HR_SIZE * 2}"></canvas>
        ${HR.solo ? '<button class="btn tiny hr-skip" id="hrSkip">⏩ Przewiń do końca</button>' : ""}</div>
      <div class="rl-result" id="hrResult">${hrResultHTML(HR.last)}</div>
      <div class="rl-history hr-last">${d.last.map(l => `<span class="hr-h" title="${new Date(l.start * 1000).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}"${l.winner >= 0 ? ` style="background:${H[l.winner].color}"` : ""}>${l.winner >= 0 ? l.winner + 1 : "🚗"}</span>`).join("") || '<span class="muted small">Tu pojawią się wyniki ostatnich wyścigów</span>'}</div>
    </div>
    <div class="rl-right">
      <div class="panel">
        <h3 class="sl-title">🐎 Konie <small class="muted">(wygrana = stawka × mnożnik)</small></h3>
        <div class="hr-rows">${rows}</div>
        ${myBets}
        <div class="hr-actions">
          <button class="big-btn rl-spin" id="hrBet" data-open="${open}"${sel && HR.sel.size && open && !busy ? "" : " disabled"}>🎟 ${open ? `POSTAW NA WYŚCIG · start za <span data-hrcount>${hrClockText(d.next.start - hrNow())}</span>` : `ZAKŁADY ZAMKNIĘTE · start za <span data-hrcount>${hrClockText(d.next.start - hrNow())}</span>`}${stake ? ` · ${fmt(stake)}` : ""}</button>
          <button class="big-btn rl-spin hr-solo" id="hrSolo"${sel && HR.sel.size && !busy ? "" : " disabled"}>🐎 WYŚCIG SOLO${stake ? ` · ${fmt(stake)}` : ""}</button>
        </div>
        ${S.me?.isAdmin ? `<div class="hr-debug"><b>🛠 Debug (admin)</b>
          ${[["car", "🚗 samochód"], ["turbo", "🌈 turbo"], ["turn", "↩️ ucieczka"], ["die", "💀 śmierć"]].map(([k, n]) => `<label><input type="checkbox" data-hrforce="${k}"${HR.force.has(k) ? " checked" : ""}> ${n} 100%</label>`).join("")}
          <button class="btn tiny" id="hrDebug"${busy ? " disabled" : ""}>▶ Wyścig testowy (bez stawki)</button></div>` : ""}
        <div class="rl-bet-info">${sel ? `Wybrany: <b>${esc(sel.name)}</b> ×${sel.pays}${stake ? ` — wygrana ${fmt(Math.round(stake * sel.pays))}` : ""}` : "Kliknij konia, na którego stawiasz."}
          ${stake && csSpecialChance(Math.round(stake * (sel?.pays || 1))) ? ' <span class="rl-joker">🃏 Przy wygranej szansa na kartę specjalną</span>' : ""}</div>
        <div class="muted small">Wspólny wyścig startuje co ${Math.round(C.period / 60)} min (zakłady przyjmujemy do ${C.betClose} s przed startem, także w trakcie poprzedniego wyścigu), solo — od razu. Trwa 1–3 minuty. Jak w Mario Kart: konie zbierają skrzynki „?” i rzucają skórki od banana 🍌, strzelają rakietami 🚀, jedzą grzyby 🍄, zwalniają się ślimakiem 🐌 i piorunem ⚡ albo łapią gwiazdę ⭐. Uwaga na tęczowe turbo 🌈, konie, które zawracają, potykają się i padają… oraz na samochód 🚗: gdy wjedzie na tor, nikt nie wygrywa, a stawki wracają. Przegrana: postawione karty przepadają.</div>
      </div>
      <div class="panel cs-pick">${csPickerHTML(HR.sel, HR.q, C.maxCards, "hr")}</div>
    </div>
  </div>`;
  const inner = () => { $("#casinoBody").innerHTML = html; };
  keepScroll($("#casinoBody"), inner);
  HR.bg = null; HR.lastPos = "";
}

// ================================================================ TOR (canvas)

function hrBackground() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = HR_SIZE * 2;
  const g = cv.getContext("2d");
  g.scale(2, 2);
  const grass = g.createRadialGradient(HR_C, HR_C, 20, HR_C, HR_C, 450);
  grass.addColorStop(0, "#3f8f3a"); grass.addColorStop(1, "#1f5a22");
  g.fillStyle = grass; g.fillRect(0, 0, HR_SIZE, HR_SIZE);
  // pasy trawy
  g.strokeStyle = "#ffffff10"; g.lineWidth = 14;
  for (let r = 20; r < 450; r += 28) { g.beginPath(); g.arc(HR_C, HR_C, r, 0, Math.PI * 2); g.stroke(); }
  // tor
  const mid = (HR_R0 - 8 + hrR(9) + 8) / 2, width = hrR(9) - HR_R0 + 16;
  g.strokeStyle = "#7a5a34"; g.lineWidth = width + 8; g.beginPath(); g.arc(HR_C, HR_C, mid, 0, Math.PI * 2); g.stroke();
  const sand = g.createRadialGradient(HR_C, HR_C, HR_R0 - 8, HR_C, HR_C, hrR(9) + 8);
  sand.addColorStop(0, "#d9b983"); sand.addColorStop(1, "#c39a5e");
  g.strokeStyle = sand; g.lineWidth = width; g.beginPath(); g.arc(HR_C, HR_C, mid, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = "#00000022"; g.lineWidth = 1;
  for (let i = 0; i < 10; i++) { g.beginPath(); g.arc(HR_C, HR_C, hrR(i) + HR_DR / 2, 0, Math.PI * 2); g.stroke(); }
  // barierki
  g.strokeStyle = "#fff"; g.lineWidth = 3;
  [HR_R0 - 12, hrR(9) + 12].forEach(r => { g.beginPath(); g.arc(HR_C, HR_C, r, 0, Math.PI * 2); g.stroke(); });
  g.strokeStyle = "#e53935"; g.lineWidth = 3; g.setLineDash([10, 10]);
  [HR_R0 - 12, hrR(9) + 12].forEach(r => { g.beginPath(); g.arc(HR_C, HR_C, r, 0, Math.PI * 2); g.stroke(); });
  g.setLineDash([]);
  // meta (szachownica) na górze toru
  const r0 = HR_R0 - 8, r1 = hrR(9) + 8, n = 14, sq = (r1 - r0) / n;
  for (let k = 0; k < n; k++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (k + j) % 2 ? "#fff" : "#111";
    g.fillRect(HR_C - 5 + j * 5, HR_C - r1 + k * sq, 5, sq);
  }
  // ozdoby: drzewa i kwiaty w rogach i na polu w środku
  g.font = `30px ${HR_FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
  [[40, 40, "🌳"], [600, 44, "🌳"], [44, 596, "🌳"], [598, 598, "🌳"], [90, 24, "🌷"], [560, 30, "🌻"], [26, 560, "🌻"], [610, 560, "🌷"],
   [70, 610, "🌷"], [24, 90, "🌼"], [616, 100, "🌼"], [548, 612, "🌼"]].forEach(([x, y, e]) => g.fillText(e, x, y));
  g.font = `22px ${HR_FONT}`;
  [[250, 458, "🌿"], [392, 470, "🌿"], [236, 192, "🌼"], [410, 190, "🌷"], [330, 480, "🪨"]].forEach(([x, y, e]) => g.fillText(e, x, y));
  // wnętrze
  g.fillStyle = "#0b2a0e66"; g.beginPath(); g.arc(HR_C, HR_C, HR_R0 - 22, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#ffffff30"; g.lineWidth = 2; g.stroke();
  return cv;
}

function hrInterp(arr, T, dt, scale) {
  const f = Math.max(0, T) / dt, i = Math.min(arr.length - 1, Math.floor(f)), j = Math.min(arr.length - 1, i + 1), k = f - i;
  return (arr[i] + (arr[j] - arr[i]) * (f >= arr.length - 1 ? 0 : k)) / scale;
}
// samochód, nagrobek, wybuch i flaga rysowane kreską (bez czcionki z emoji - nie wszędzie jest dostępna), jak na canvasie 640 × 640
function hrDrawCar(g) {   // przodem w lewo
  g.save();
  g.fillStyle = "#0005"; g.beginPath(); g.ellipse(0, 14, 28, 4.5, 0, 0, Math.PI * 2); g.fill();
  g.lineJoin = "round"; g.lineWidth = 2; g.strokeStyle = "#5c0f0f";
  g.fillStyle = "#e53935"; g.beginPath(); g.roundRect(-27, -5, 54, 18, 6); g.fill(); g.stroke();
  g.fillStyle = "#c62828"; g.beginPath(); g.moveTo(-13, -5); g.lineTo(-7, -17); g.lineTo(12, -17); g.lineTo(19, -5); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#bfe8ff"; g.lineWidth = 1.2; g.strokeStyle = "#5c0f0f";
  g.beginPath(); g.moveTo(-10, -6); g.lineTo(-5.5, -14.5); g.lineTo(2, -14.5); g.lineTo(2, -6); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(5, -6); g.lineTo(5, -14.5); g.lineTo(11, -14.5); g.lineTo(15.5, -6); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#ffe066"; g.beginPath(); g.arc(-25, 2, 3.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#ffe06655"; g.beginPath(); g.moveTo(-28, 2); g.lineTo(-46, -4); g.lineTo(-46, 8); g.closePath(); g.fill();
  g.fillStyle = "#ff1744"; g.fillRect(24, -1, 4, 6);
  g.fillStyle = "#fff"; g.fillRect(-27, 8, 54, 2);
  [-15, 15].forEach(x => { g.fillStyle = "#111"; g.beginPath(); g.arc(x, 13, 6.5, 0, Math.PI * 2); g.fill(); g.fillStyle = "#b0b6bd"; g.beginPath(); g.arc(x, 13, 2.8, 0, Math.PI * 2); g.fill(); });
  g.restore();
}
function hrDrawGrave(g, color) {
  g.save();
  g.fillStyle = "#5a3a1a"; g.beginPath(); g.ellipse(0, 9, 11, 4, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#c3c7cf"; g.strokeStyle = "#4a4f57"; g.lineWidth = 1.5; g.lineJoin = "round";
  g.beginPath(); g.moveTo(-7, 9); g.lineTo(-7, -4); g.arc(0, -4, 7, Math.PI, 0); g.lineTo(7, 9); g.closePath(); g.fill(); g.stroke();
  g.strokeStyle = "#5d626b"; g.lineWidth = 1.8; g.beginPath(); g.moveTo(0, -9); g.lineTo(0, 2); g.moveTo(-3.5, -5.5); g.lineTo(3.5, -5.5); g.stroke();
  g.fillStyle = color; g.strokeStyle = "#000b"; g.lineWidth = 1; g.beginPath(); g.arc(0, 6, 2.6, 0, Math.PI * 2); g.fill(); g.stroke();
  g.restore();
}
function hrDrawBoom(g, size) {
  g.save();
  g.beginPath();
  for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, r = i % 2 ? size * 0.45 : size; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fillStyle = "#ff9a1f"; g.strokeStyle = "#c62828"; g.lineWidth = 2; g.fill(); g.stroke();
  g.fillStyle = "#ffe066"; g.beginPath(); g.arc(0, 0, size * 0.42, 0, Math.PI * 2); g.fill();
  g.restore();
}
function hrDrawFlag(g) {
  g.save();
  g.strokeStyle = "#ddd"; g.lineWidth = 2; g.beginPath(); g.moveTo(-8, 10); g.lineTo(-8, -12); g.stroke();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { g.fillStyle = (r + c) % 2 ? "#fff" : "#111"; g.fillRect(-7 + c * 4.5, -12 + r * 4.5, 4.5, 4.5); }
  g.restore();
}

// samochód: pozycja w okrążeniach od linii startu (jak konie), null - jeszcze go nie ma
function hrCarX(race, T) {
  const a = race.car, f = Math.max(0, T) / race.dt, i = Math.min(a.length - 1, Math.floor(f)), j = Math.min(a.length - 1, i + 1);
  if (a[i] == null) return null;
  const x0 = a[i] / race.scale, x1 = (a[j] ?? a[i]) / race.scale;
  return x0 + (x1 - x0) * (f >= a.length - 1 ? 0 : f - i);
}

// stan konia w chwili T, wyliczony ze zdarzeń
function hrHorseState(race, h, T) {
  const s = { dead: null, left: null, fall: null, turbo: false, turboAt: 0, carDeath: false, held: null, boost: false, slow: false, star: false };
  for (const e of race.events) {
    if (e.t > T) continue;
    if (e.k === "bolt") { if (e.h !== h && T < e.t + e.d) s.slow = true; continue; }
    if (e.h !== h) continue;
    if (e.k === "box") s.held = e.it;
    else if (e.k === "use") s.held = null;
    else if (e.k === "boost") { if (T < e.t + e.d) s.boost = true; }
    else if (e.k === "slow") { if (T < e.t + e.d) s.slow = true; }
    else if (e.k === "star") { if (T < e.t + e.d) s.star = true; }
    else if (e.k === "die") { s.dead = e.t; s.carDeath = e.by === "car"; }
    else if (e.k === "turn") s.left = e.t;
    else if (e.k === "trip" && T < e.t + e.d) s.fall = e;
    else if (e.k === "turbo") { s.turbo = true; s.turboAt = e.t; }
    else if (e.k === "turbo_end") s.turbo = false;
  }
  return s;
}

function hrFinishTime(race) {
  if (race._fin === undefined) {
    race._fin = null;
    if (race.winner >= 0) {
      const a = race.x[race.winner], lim = race.laps * race.scale, i = a.findIndex(v => v >= lim);
      race._fin = i < 0 ? null : i * race.dt;
    }
  }
  return race._fin;
}

function hrBubble(text, h, T, color = "#fff", x = null, life = 2.4) {
  HR.bubbles.push({ text, h, x, until: T + life, color });
  if (HR.bubbles.length > 12) HR.bubbles.shift();
}

// dźwięki i dymki dla zdarzeń, które właśnie nastąpiły
function hrFire(race, T, key) {
  const H = hrHorses();
  if (HR.cur.key !== key) HR.cur = { key, T: T > 3 ? T : Math.min(T, -0.5), lastSec: Math.ceil(T) };
  const from = HR.cur.T;
  if (from < 0 && T >= 0) {
    Sound.whistle(); Sound.neigh(1, 0.1); setTimeout(() => Sound.neigh(1.3, 0.08), 250); setTimeout(() => Sound.neigh(0.8, 0.09), 520);
  }
  if (T < 0 && T > -3.2 && Math.ceil(T) !== HR.cur.lastSec) { HR.cur.lastSec = Math.ceil(T); Sound.tick(0.6); }
  if (race) {
    for (const e of race.events) {
      if (e.t <= from || e.t > T) continue;
      const p = e.h != null ? H[e.h].pitch : 1;
      if (e.k === "turbo") { Sound.rainbow(); Sound.neigh(p * 1.25, 0.14, 1.3); hrBubble("TURBO!!!", e.h, T, "rainbow", null, 3); }
      else if (e.k === "turbo_end") hrBubble("uff…", e.h, T, "#fff", null, 1.8);
      else if (e.k === "turn") { Sound.neigh(p * 1.4, 0.13); hrBubble(hrPick(HR_BUBBLE.turn), e.h, T); }
      else if (e.k === "trip") {
        if (e.by === "banana") { Sound.slip(); Sound.neigh(p * 1.5, 0.08, 0.6); hrBubble("Poślizg!", e.h, T); }
        else if (e.by === "rocket") { Sound.boom(); Sound.neigh(p * 1.6, 0.1, 0.7); hrBubble("Trafiony!", e.h, T); }
        else { Sound.crash(); Sound.neigh(p * 1.5, 0.1, 0.6); hrBubble(hrPick(HR_BUBBLE.trip), e.h, T); }
      }
      else if (e.k === "box") Sound.pickup();
      else if (e.k === "banana") Sound.pop();
      else if (e.k === "rocket") { Sound.whoosh(); hrBubble("🚀 Rakieta!", e.h, T); }
      else if (e.k === "boost") Sound.boost();
      else if (e.k === "slow") { if (e.blocked) hrBubble("Nie ze mną!", e.h, T); else Sound.slowdown(); }
      else if (e.k === "bolt") { Sound.zap(); hrBubble("⚡ ZAP!", e.h, T, "#ffe11f"); }
      else if (e.k === "star") { Sound.starup(); hrBubble("⭐ Gwiazda!", e.h, T, "#ffb300"); }
      else if (e.k === "die") { if (e.by === "car") Sound.crash(); else { Sound.sadTrombone(); Sound.neigh(p * 0.7, 0.1, 1.4); hrBubble(hrPick(HR_BUBBLE.die), e.h, T); } }
      else if (e.k === "car") { Sound.carHorn(); hrBubble("UWAGA! SAMOCHÓD!", null, T, "#ff5252", 0, 3.2); }
      else if (e.k === "car_end") { Sound.carHorn(); Sound.win(); confetti(["#ff5252", "#fff", "#222"], 80); hrBubble("🏁 Samochód wygrywa!", null, T, "#ff5252", 0, 3); }
    }
    const fin = hrFinishTime(race);
    if (fin != null && from < fin && T >= fin) {
      Sound.win(); confetti(["#ffcf3f", "#ff3b5c", "#fff", "#3ddc84", H[race.winner].color], 160);
      Sound.neigh(H[race.winner].pitch * 1.1, 0.13, 1.4);
    }
    // tętent i rżenie w tle
    if (T >= 0 && T < race.dur && performance.now() - HR.lastGallop > 430) { HR.lastGallop = performance.now(); Sound.gallop(0.05); }
    if (T >= 0 && T < race.dur && T > HR.nextNeigh) {
      const alive = H.filter(h => !hrHorseState(race, h.id, T).dead);
      if (alive.length) { const h = hrPick(alive); Sound.neigh(h.pitch, 0.05 + Math.random() * 0.03); }
      HR.nextNeigh = T + 1.5 + Math.random() * 3;
    }
  } else if (T > -8 && T < 0 && performance.now() - HR.lastNeigh > 2600) {   // tuż przed startem konie się niecierpliwią
    HR.lastNeigh = performance.now();
    const h = hrPick(H); Sound.neigh(h.pitch, 0.05);
  }
  HR.cur.T = T;
}

function hrBubbleDraw(g, b, px, py, T) {
  const a = Math.min(1, (b.until - T) / 0.5);
  g.save();
  g.globalAlpha = Math.max(0, a);
  g.font = "700 13px Rubik, sans-serif";
  const w = g.measureText(b.text).width + 14, x = Math.min(HR_SIZE - w / 2 - 4, Math.max(w / 2 + 4, px)), y = Math.max(20, py - 26 - (1 - a) * 6);
  g.fillStyle = "#fffffff2"; g.strokeStyle = "#000a"; g.lineWidth = 1.5;
  g.beginPath(); g.roundRect(x - w / 2, y - 12, w, 22, 8); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(px - 4, y + 10); g.lineTo(px + 4, y + 10); g.lineTo(px, y + 16); g.closePath(); g.fill();
  if (b.color === "rainbow") {
    const gr = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    ["#ff3b3b", "#ff9a1f", "#ffe11f", "#3ddc84", "#1fa2ff", "#a35bff"].forEach((c, i) => gr.addColorStop(i / 5, c));
    g.fillStyle = gr;
  } else g.fillStyle = b.color === "#fff" ? "#222" : b.color;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(b.text, x, y - 1);
  g.restore();
}

function hrDrawFrame(g, race, T, solo) {
  const H = hrHorses(), now = performance.now();
  if (!HR.bg) HR.bg = hrBackground();
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.clearRect(0, 0, HR_SIZE, HR_SIZE);
  g.drawImage(HR.bg, 0, 0, HR_SIZE, HR_SIZE);
  const sprites = [];
  H.forEach(h => {
    const x = race ? hrInterp(race.x[h.id], T, race.dt, race.scale) : 0;
    const st = race ? hrHorseState(race, h.id, T) : { dead: null, left: null, fall: null, turbo: false };
    sprites.push({ h, x, st });
  });
  // tęczowy ślad turbo
  sprites.forEach(({ h, x, st }) => {
    if (!st.turbo || st.dead) return;
    for (let k = 0; k < 34; k++) {
      const [px, py] = hrPosXY(h.id, x - k * 0.0032);
      g.fillStyle = `hsla(${(now / 3 + k * 16) % 360}, 100%, 55%, ${(1 - k / 34) * 0.9})`;
      g.beginPath(); g.arc(px, py, 6.2 * (1 - k / 60), 0, Math.PI * 2); g.fill();
    }
  });
  hrBoxes(g, race, sprites, now);
  hrTrackItems(g, race, T, now);
  // martwe konie pod żywymi
  const dead = sprites.filter(s => s.st.dead), alive = sprites.filter(s => !s.st.dead);
  dead.forEach(s => hrDrawHorse(g, s, T, race, now));
  alive.sort((a, b) => hrPosXY(a.h.id, a.x)[1] - hrPosXY(b.h.id, b.x)[1]).forEach(s => hrDrawHorse(g, s, T, race, now));
  // samochód
  let carAt = null;
  if (race?.car) {
    const cx = hrCarX(race, T);
    if (cx != null) {
      // zajeżdża spoza toru (od góry, na linię startu), potem jedzie z kierunkiem wyścigu i przejeżdża konie
      const ev = race.events.find(e => e.k === "car"), entry = Math.min(1, Math.max(0, (T - ev.t) / (ev.go - ev.t)));
      // tor jazdy samochodu: dojeżdża do toru konia, którego zaraz przejedzie (płynnie między kolejnymi ofiarami)
      const kills = race.events.filter(e => e.k === "die" && e.by === "car");
      const prevK = kills.filter(e => e.t <= T).pop(), nextK = kills.find(e => e.t > T);
      const mid = (HR_R0 + hrR(9)) / 2, laneR = k => (k == null ? mid : hrR(k));
      const fromR = prevK ? laneR(prevK.h) : mid, toR = nextK ? laneR(nextK.h) : mid;
      const t0 = prevK ? prevK.t + 0.4 : ev.go, t1 = nextK ? nextK.t : (prevK ? prevK.t + 1.8 : ev.go + 1);
      const u = Math.min(1, Math.max(0, (T - t0) / Math.max(0.3, t1 - t0))), lane = fromR + (toR - fromR) * (u * u * (3 - 2 * u));
      const r = 360 + (lane - 360) * (1 - Math.pow(1 - entry, 2));
      const a = hrAng(cx), px = HR_C + r * Math.cos(a), py = HR_C + r * Math.sin(a);
      carAt = [px, py];
      const fwd = hrCarX(race, T + 0.2) - cx;   // jedzie do przodu (zgodnie z ruchem wskazówek) czy wstecz
      const right = fwd >= -1e-6 ? -Math.sin(a) > 0 : -Math.sin(a) < 0;
      g.save(); g.translate(px, py + Math.sin(now / 40) * 1.2);
      if (right) g.scale(-1, 1);              // 🚗 patrzy w lewo
      if (entry >= 1 && cx < race.laps) {     // kłęby spalin z tyłu
        g.fillStyle = "#ffffff55";
        for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(34 + k * 9 + ((now / 40) % 9), 6 - k * 2, 3 + k, 0, Math.PI * 2); g.fill(); }
      }
      hrDrawCar(g);
      g.restore();
      if (cx >= race.laps) { g.save(); g.translate(px, py - 34); g.scale(1.4, 1.4); hrDrawFlag(g); g.restore(); }   // meta
    }
    // wybuchy w miejscu śmierci pod kołami
    race.events.forEach(e => {
      if (e.k !== "die" || e.by !== "car" || T < e.t || T > e.t + 1.1) return;
      const k = (T - e.t) / 1.1, x = hrInterp(race.x[e.h], e.t, race.dt, race.scale), [px, py] = hrPosXY(e.h, x);
      g.save(); g.globalAlpha = 1 - k; g.translate(px, py - k * 8); g.rotate(k); hrDrawBoom(g, 13 + k * 12); g.restore();
    });
  }
  // dymki
  HR.bubbles = HR.bubbles.filter(b => b.until > T);
  HR.bubbles.forEach(b => {
    let p = null;
    if (b.h != null) { const s = sprites[b.h]; p = hrPosXY(b.h, s.x); }
    else if (b.x != null && carAt) p = carAt;
    if (p) hrBubbleDraw(g, b, p[0], p[1], T);
  });
  if (race) race.events.forEach(e => {   // piorun: biały błysk na całym torze
    if (e.k === "bolt" && T >= e.t && T < e.t + 0.5) { g.fillStyle = `rgba(255,255,255,${0.55 * (1 - (T - e.t) / 0.5)})`; g.fillRect(0, 0, HR_SIZE, HR_SIZE); }
  });
  hrInfield(g, race, T, solo, sprites);
}

// rzędy skrzynek "?" (jak w Mario Kart): każdy koń ma swoją na swoim torze; wracają co okrążenie tylko dla niektórych koni
function hrBoxes(g, race, sprites, now) {
  const rows = race ? race.rows : S.cfg.horses.race.boxRows;
  sprites.forEach(({ h, x, st }) => {
    if (st.dead || st.left != null) return;
    const L = race ? Math.min(race.laps - 1, Math.max(0, Math.floor(x))) : 0;
    rows.forEach((pos, r) => {
      if (race && !race.bx0[h.id][L][r]) return;
      const p = L + pos;
      if (x >= p) return;                                  // już przejechane
      const pop = L === 0 ? 1 : Math.min(1, (x - L) / 0.04 + 0.15);
      const [px, py, a] = hrPosXY(h.id, p);
      g.save();
      g.translate(px, py); g.scale(pop, pop);
      g.rotate(a + now / 700);
      const hue = (now / 8 + h.id * 36 + r * 90) % 360;
      g.fillStyle = `hsl(${hue}, 90%, 58%)`; g.strokeStyle = "#fff"; g.lineWidth = 1.6; g.shadowColor = `hsl(${hue}, 100%, 60%)`; g.shadowBlur = 6;
      g.beginPath(); g.roundRect(-6.5, -6.5, 13, 13, 3); g.fill(); g.stroke();
      g.restore();
      g.save(); g.translate(px, py); g.scale(pop, pop);
      g.fillStyle = "#fff"; g.font = "700 11px Rubik, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("?", 0, 0.5);
      g.restore();
    });
  });
}

// skórki od banana na torze i lecące rakiety
function hrTrackItems(g, race, T, now) {
  if (!race) return;
  const bananas = new Map();
  race.events.forEach(e => {
    if (e.t > T) return;
    if (e.k === "banana") bananas.set(e.id, e);
    else if (e.k === "banana_end") bananas.delete(e.id);
  });
  g.save(); g.textAlign = "center"; g.textBaseline = "middle"; g.font = `17px ${HR_FONT}`;
  bananas.forEach(b => { const [px, py] = hrPosXY(b.lane, b.x); g.save(); g.translate(px, py); g.rotate(b.id * 1.3); g.fillText("🍌", 0, 0); g.restore(); });
  race.events.forEach(e => {
    if (e.k !== "rocket" || T < e.t) return;
    const t1 = e.t1 ?? e.t + 3;
    if (T <= t1) {
      const u = Math.min(1, (T - e.t) / Math.max(0.05, t1 - e.t));
      const xe = hrInterp(race.x[e.to], t1, race.dt, race.scale);
      const rx = e.x0 + (xe - e.x0) * u, lane = e.h + (e.to - e.h) * u;
      const a = hrAng(rx), r = HR_R0 + lane * HR_DR, px = HR_C + r * Math.cos(a), py = HR_C + r * Math.sin(a);
      for (let k = 1; k < 7; k++) {   // ogon z ognia
        const ak = hrAng(rx - k * 0.004);
        g.fillStyle = `rgba(255, ${140 + k * 12}, 40, ${0.8 - k * 0.11})`;
        g.beginPath(); g.arc(HR_C + r * Math.cos(ak), HR_C + r * Math.sin(ak), 5 - k * 0.5, 0, Math.PI * 2); g.fill();
      }
      g.font = `20px ${HR_FONT}`; g.fillText("🚀", px, py);
    } else if (T < t1 + 0.9 && e.res !== "gone") {
      const k = (T - t1) / 0.9, [px, py] = hrPosXY(e.to, hrInterp(race.x[e.to], t1, race.dt, race.scale));
      g.save(); g.globalAlpha = 1 - k; g.font = `${22 + k * 26}px ${HR_FONT}`; g.fillText(e.res === "hit" ? "💥" : "🛡️", px, py - k * 6); g.restore();
    }
  });
  g.restore();
}

function hrPosXY(i, x) {
  const a = hrAng(x), r = hrR(i);
  return [HR_C + r * Math.cos(a), HR_C + r * Math.sin(a), a];
}

function hrDrawHorse(g, s, T, race, now) {
  const { h, x, st } = s, [px, py, a] = hrPosXY(h.id, x);
  g.save();
  g.translate(px, py);
  g.textAlign = "center"; g.textBaseline = "middle";
  if (st.dead) {
    const age = T - st.dead, pop = Math.min(1, age / 0.35);
    g.font = `20px ${HR_FONT}`;
    g.save(); g.translate(0, (1 - pop) * 8); g.scale(pop, pop); hrDrawGrave(g, h.color); g.restore();   // nagrobek zostaje do końca wyścigu
    if (age < 0.8) { g.fillStyle = `rgba(255,255,255,${0.6 - age * 0.7})`; for (let k = -1; k <= 1; k++) { g.beginPath(); g.arc(k * 8, 8 - age * 8, 3 + age * 5, 0, Math.PI * 2); g.fill(); } }
    if (age < 3.5) {   // duszek z aureolą unosi się do nieba
      g.globalAlpha = Math.max(0, 1 - age / 3.5);
      const ax = Math.sin(age * 3) * 3, ay = -12 - age * 14;
      g.fillStyle = "#fff"; g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill(); g.fillRect(ax - 3, ay + 2, 6, 6);
      g.strokeStyle = "#ffd54f"; g.lineWidth = 1.5; g.beginPath(); g.ellipse(ax, ay - 6, 3.5, 1.4, 0, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    return;
  }
  // kierunek patrzenia: zgodnie z ruchem (po zawróceniu odwrotnie)
  const rev = st.left != null;
  const comp = (-Math.sin(a)) * (rev ? -1 : 1);
  if (Math.abs(comp) > 0.2) HR.face[h.id] = comp > 0;
  else if (HR.face[h.id] == null) HR.face[h.id] = true;
  const right = HR.face[h.id];
  const flip = HR_FACES_LEFT ? right : !right;
  const running = race && T >= 0 && T < race.dur + 4 && !st.fall;
  const moving = running && !(x >= race.laps && race.winner !== h.id);
  const bob = moving ? Math.sin(now / (st.turbo ? 40 : 90) + h.id * 1.7) * (st.turbo ? 2.6 : 1.5) : 0;
  // kolorowy znacznik z numerem
  g.fillStyle = h.color; g.strokeStyle = "#000b"; g.lineWidth = 1.5;
  g.beginPath(); g.arc(0, 5, 9, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = h.color === "#fdd835" || h.color === "#b0bec5" ? "#222" : "#fff";
  g.font = "700 10px Rubik, sans-serif"; g.fillText(String(h.id + 1), 0, 5.5);
  g.translate(0, -3 + bob);
  if (st.turbo) {
    g.scale(1.45, 1.45);
    g.translate(Math.sin(now / 25) * 0.7, 0);
    if (g.filter !== undefined) g.filter = `hue-rotate(${(now / 2) % 360}deg) saturate(3) brightness(1.15)`;
  }
  if (flip) g.scale(-1, 1);
  if (st.fall) { g.rotate(Math.PI / 2 * (flip ? -1 : 1)); g.translate(0, 3); }
  g.font = `24px ${HR_FONT}`;
  g.fillText("🐎", 0, 0);
  g.restore();
  if (st.fall) {
    g.save(); g.font = `13px ${HR_FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("💫", px + Math.sin(now / 120) * 6, py - 16); g.restore();
  }
  if (st.turbo) {
    g.save(); g.font = `14px ${HR_FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(((now / 90) | 0) % 2 ? "✨" : "🌈", px, py - 22); g.restore();
  }
  g.save(); g.textAlign = "center"; g.textBaseline = "middle";
  if (st.star) {
    g.fillStyle = `rgba(255, 224, 80, ${0.35 + 0.2 * Math.sin(now / 80)})`;
    g.beginPath(); g.arc(px, py, 15, 0, Math.PI * 2); g.fill();
    g.font = `12px ${HR_FONT}`; g.fillText("⭐", px + Math.cos(now / 120) * 14, py + Math.sin(now / 120) * 14);
  }
  if (st.boost) { g.font = `12px ${HR_FONT}`; g.fillText("💨", px - Math.sign(Math.cos(a + Math.PI / 2) || 1) * 15, py + 4); }
  if (st.slow) { g.font = `13px ${HR_FONT}`; g.fillText("🐌", px, py - 18); }
  if (st.held) { g.font = `12px ${HR_FONT}`; g.fillText(S.cfg.horses.items[st.held].icon, px + 13, py - 12); }
  g.restore();
}

// napisy na polu w środku: odliczanie, okrążenie, zwycięzca
function hrInfield(g, race, T, solo, sprites) {
  const H = hrHorses(), d = HR.d;
  let top = "", big = "", sub = "", color = "#fff";
  if (!race || T < 0) {
    const left = solo ? -T : d.next.start - hrNow();
    if (solo) { top = "ZA CHWILĘ START"; big = String(Math.max(1, Math.ceil(-T))); }
    else {
      top = hrBetsOpen() ? "STAWIAJ! 🎟" : left < 0 ? "WYŚCIG STARTUJE…" : "ZAKŁADY ZAMKNIĘTE";
      big = hrClockText(left);
      sub = "do startu wspólnego wyścigu";
    }
  } else if (T < race.dur) {
    const live = sprites.filter(s => !s.st.dead && s.st.left == null);
    const lead = live.sort((a, b) => b.x - a.x)[0];
    const fin = hrFinishTime(race);
    if (fin != null && T >= fin) {
      const w = H[race.winner];
      top = "🏆 WYGRYWA"; big = w.name; sub = `numer ${w.id + 1} · ×${w.pays}`; color = w.color;
    } else if (race.car && race.events.some(e => e.k === "car_end" && e.t <= T)) {
      top = "🚗 SAMOCHÓD WYGRYWA"; big = ""; sub = "nikt inny nie dojechał · stawki wracają";
    } else if (race.car && race.events.some(e => e.k === "car" && e.t <= T)) {
      top = "🚨 NA TORZE SAMOCHÓD 🚨"; big = ""; sub = lead ? `ostatni żywy: ${lead.h.name}` : "pędzi po zwycięstwo…";
    } else {
      const lap = lead ? Math.min(race.laps, Math.floor(Math.max(0, lead.x)) + 1) : 1;
      top = "WYŚCIG TRWA"; big = `Okrążenie ${lap}/${race.laps}`; sub = lead ? `prowadzi: ${lead.h.name}` : "";
    }
  } else {
    if (race.winner >= 0) { const w = H[race.winner]; top = "🏆 WYGRAŁ"; big = w.name; sub = `numer ${w.id + 1} · ×${w.pays}`; color = w.color; }
    else { top = "🚗 SAMOCHÓD WYGRAŁ"; big = ""; sub = "nikt inny nie dojechał · stawki wracają"; }
  }
  g.save();
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "#000c"; g.shadowBlur = 6;
  g.fillStyle = "#ffe9a8"; g.font = "400 15px Bungee, Rubik, sans-serif"; g.fillText(top, HR_C, HR_C - 52);
  g.fillStyle = color;
  const size = big.length > 12 ? 24 : big.length > 4 ? 30 : 64;
  g.font = `400 ${size}px Bungee, Rubik, sans-serif`; g.fillText(big, HR_C, HR_C - 4);
  g.fillStyle = "#fff"; g.font = "600 13px Rubik, sans-serif"; g.fillText(sub, HR_C, HR_C + 44);
  if (!race && !solo && d.last[0]) {
    const l = d.last[0];
    g.font = "600 12px Rubik, sans-serif"; g.fillStyle = "#ffe9a8cc";
    g.fillText(`poprzedni: ${l.winner >= 0 ? H[l.winner].name : "samochód 🚗"}`, HR_C, HR_C + 66);
  }
  g.restore();
}

// ================================================================ PĘTLA

function hrStart() {
  if (HR.raf) return;
  HR.raf = requestAnimationFrame(hrLoop);
}

function hrVisible() { return currentView() === "casino" && CS.tab === "horses" && !!$("#hrCanvas"); }

function hrClock() {
  if (HR.solo) return { race: HR.solo.race, T: (performance.now() - HR.solo.t0) / 1000 - HR_INTRO, solo: true, key: "solo" + HR.solo.t0 };
  const L = HR.d?.live;
  if (L && hrNow() - L.start < L.dur + 12) return { race: L, T: hrNow() - L.start, solo: false, key: "r" + L.id };
  return { race: null, T: HR.d ? -(HR.d.next.start - hrNow()) : -1, solo: false, key: "idle" };
}

let hrFrameN = 0;
function hrLoop() {
  HR.raf = 0;
  if (!HR.d) return;
  const { race, T, solo, key } = hrClock();
  if (HR.solo && !HR.solo.done && T >= HR.solo.race.dur + 1.2) { hrSoloFinish(); }
  if (!hrVisible()) {
    if (HR.solo && !HR.solo.done) { hrSoloFinish(true); }
    return;   // zakładka zamknięta - pętla staje (wróci przy drawHorses)
  }
  hrFire(race, T, key);
  const cv = $("#hrCanvas");
  hrDrawFrame(cv.getContext("2d"), race, T, solo);
  hrUpdateRows(race, T);
  // odświeżanie danych: co kilka sekund, a po starcie / końcu wyścigu od razu
  const age = Date.now() - HR.fetchedAt, now = hrNow();
  const needLive = !HR.solo && !race && now >= HR.d.next.start;
  const ended = !HR.solo && HR.d.live && now >= HR.d.live.start + HR.d.live.dur && now < HR.d.live.start + HR.d.live.dur + 6;
  const L = HR.d.live, wantPoll = L && now >= L.start + L.dur && HR.d.mine.some(b => b.race === L.id && b.status === "open");
  if (!HR.fetching && (needLive && age > 900 || ended && age > 1500 || age > (hrBetsOpen() ? 6000 : 15000) || (wantPoll && age > 2500))) hrFetch();
  hrFrameN++;
  if (hrFrameN % 20 === 0) {   // odliczanie na przycisku
    const t = hrClockText(HR.d.next.start - now), open = hrBetsOpen();
    $$("[data-hrcount]").forEach(el => { if (el.textContent !== t) el.textContent = t; });
    const b = $("#hrBet");
    if (b && b.dataset.open !== String(open)) { b.dataset.open = String(open); hrRenderPanel(); }
  }
  HR.raf = requestAnimationFrame(hrLoop);
}

// miejsca i stany koni w tabelce
function hrUpdateRows(race, T) {
  if (performance.now() - (HR.rowsAt || 0) < 400) return;
  HR.rowsAt = performance.now();
  const H = hrHorses();
  const st = H.map(h => race ? hrHorseState(race, h.id, T) : null);
  const xs = H.map(h => race && T >= 0 ? hrInterp(race.x[h.id], T, race.dt, race.scale) : 0);
  const order = H.map(h => h.id).filter(i => st[i] && !st[i].dead && st[i].left == null).sort((a, b) => xs[b] - xs[a]);
  H.forEach(h => {
    const s = st[h.id];
    const pos = $(`[data-hrpos="${h.id}"]`), state = $(`[data-hrstate="${h.id}"]`);
    if (!pos) return;
    let p = "", t = "";
    if (s && T >= 0) {
      if (s.dead) t = s.carDeath ? "💥" : "💀";
      else if (s.left != null) t = "🏃";
      else if (s.fall) t = "💫";
      else if (s.turbo) t = "🌈";
      else if (s.star) t = "⭐";
      else if (s.boost) t = "🍄";
      else if (s.slow) t = "🐌";
      else if (s.held) t = S.cfg.horses.items[s.held].icon;
      if (!s.dead && s.left == null) p = `${order.indexOf(h.id) + 1}.`;
    }
    if (pos.textContent !== p) pos.textContent = p;
    if (state.textContent !== t) state.textContent = t;
  });
}

// ================================================================ AKCJE

async function hrBet() {
  if (HR.horse == null || !HR.sel.size || CS.spinning) return;
  const ids = [...HR.sel], stake = csStake(HR.sel), h = hrHorses()[HR.horse];
  if (stake >= 5000 && !confirm(`Postawić ${ids.length} ${plural(ids.length, "kartę", "karty", "kart")} o wartości ${fmt(stake)} na konia „${h.name}”?`)) return;
  try {
    const res = await api("/api/casino/horses/bet", { horse: HR.horse, ids });
    removeItems(res.consumed);
    HR.sel.clear();
    applyState(res.state);
    Sound.click();
    toast(`🎟 Postawiono na: ${h.name}`);
  } catch (e) { Sound.error(); toast(e.message, true); }
  await hrFetch();
}

async function hrCancel(id) {
  try {
    const res = await api(`/api/casino/horses/bet/${id}/cancel`, {});
    S.items = res.items; noteCollected(S.items);
    applyState(res.state);
    Sound.click();
  } catch (e) { Sound.error(); toast(e.message, true); }
  await hrFetch();
}

async function hrSolo() {
  if (HR.horse == null || !HR.sel.size || CS.spinning || HR.solo) return;
  const ids = [...HR.sel], stake = csStake(HR.sel), h = hrHorses()[HR.horse];
  if (stake >= 5000 && !confirm(`Postawić ${ids.length} ${plural(ids.length, "kartę", "karty", "kart")} o wartości ${fmt(stake)} na konia „${h.name}” w wyścigu solo?`)) return;
  Sound.unlock();
  let res;
  try { res = await api("/api/casino/horses/solo", { horse: HR.horse, ids }); }
  catch (e) { Sound.error(); toast(e.message, true); return; }
  CS.spinning = true;
  HR.last = null;
  HR.solo = { race: res.race, res, t0: performance.now(), done: false };
  HR.bubbles = []; HR.nextNeigh = 1;
  hrRenderPanel();
  hrStart();
}

async function hrDebug() {
  if (CS.spinning || HR.solo) return;
  Sound.unlock();
  let res;
  try { res = await api("/api/casino/horses/debug", { force: [...HR.force] }); }
  catch (e) { Sound.error(); toast(e.message, true); return; }
  CS.spinning = true;
  HR.last = null;
  HR.solo = { race: res.race, res: { debug: true }, t0: performance.now(), done: false };
  HR.bubbles = []; HR.nextNeigh = 1;
  hrRenderPanel();
  hrStart();
}

// koniec wyścigu solo: stosujemy wynik (serwer zapisał go od razu) i pokazujemy go pod torem
async function hrSoloFinish(silent = false) {
  const S0 = HR.solo;
  if (!S0 || S0.done) return;
  S0.done = true;
  const res = S0.res;
  if (res.debug) {   // wyścig testowy admina: nic się nie zmienia
    HR.last = { kind: "debug", winner: S0.race.winner };
    HR.solo = null; CS.spinning = false;
    if (currentView() === "casino" && CS.tab === "horses") hrRenderPanel();
    return;
  }
  const h = hrHorses()[res.horse];
  if (res.win) {
    S.items = [...res.items.slice().reverse(), ...S.items];
    noteCollected(res.items);
    CS.lost = false;
    if (!silent) { Sound.win(); confetti(["#ffcf3f", "#ff3b5c", "#fff", "#3ddc84"], 180); }
    HR.last = { kind: "solo", status: "won", horse: res.horse, stake: res.stake, payout: res.payout, items: res.items, money: res.money, special: res.special };
  } else if (res.refund) {
    HR.last = { kind: "solo", status: "refund", horse: res.horse, stake: res.stake };
  } else {
    removeItems(res.consumed);
    HR.sel.clear();
    CS.lost = true;
    if (!silent) Sound.fail();
    const why = (S0.race.out[res.horse] === "dead" ? "zdechł" : S0.race.out[res.horse] === "left" ? "uciekł z toru" : `wygrał: ${hrHorses()[S0.race.winner].name}`);
    HR.last = { kind: "solo", status: "lost", horse: res.horse, stake: res.stake, why };
  }
  if (res.special) { S.items = [res.special, ...S.items]; noteCollected([res.special]); }
  applyState(res.state);
  HR.solo = null;
  CS.spinning = false;
  if (hrVisible() || (currentView() === "casino" && CS.tab === "horses")) hrRenderPanel();
  if (res.special && !silent) {
    await sleep(S.fast ? 300 : 700);
    await epicReveal(res.special, { fast: S.fast });
    announceFirsts([res.special]);
  }
}

function bindHorses() {
  const body = $("#casinoBody");
  body.addEventListener("change", e => {
    const f = e.target.dataset?.hrforce;
    if (f) e.target.checked ? HR.force.add(f) : HR.force.delete(f);
  });
  body.addEventListener("click", e => {
    if (CS.tab !== "horses") return;
    const t = e.target;
    const row = t.closest("[data-hrhorse]");
    if (row && !CS.spinning) { HR.horse = +row.dataset.hrhorse; Sound.click(); Sound.neigh(hrHorses()[HR.horse].pitch, 0.06, 0.6); return hrRenderPanel(); }
    if (t.closest("#hrBet")) return hrBet();
    if (t.closest("#hrSolo")) return hrSolo();
    if (t.closest("#hrDebug")) return hrDebug();
    if (t.closest("#hrSkip") && HR.solo) { HR.solo.t0 = performance.now() - (HR.solo.race.dur + HR_INTRO) * 1000; return; }
    const cancel = t.closest("[data-hrcancel]");
    if (cancel) return hrCancel(+cancel.dataset.hrcancel);
    const won = t.closest(".hr-left .rl-won .pick");
    if (won) {
      const it = [HR.last?.special, ...(HR.last?.items || [])].find(i => i?.id === +won.dataset.id);
      if (it) openViewer(it.person, it.variant);
    }
  });
}
