"use strict";
// Jednoręki bandyta (zakładka w Kasynie): 3 bębny, jedna linia (środkowy rząd), stawką są karty - jak w ruletce.
// Losuje serwer (/api/casino/slots), przeglądarka kręci bębnami i zatrzymuje je po kolei na wylosowanych symbolach.
// Wygrana: karty zostają + karty o wartości stawka × mnożnik (i szansa na kartę specjalną z kasyna); przegrana: przepadają.

const SL = { sel: new Set(), q: "", last: null, reels: null, history: [] };
const SL_ROWS = 3;          // widoczne rzędy na bębnie (środkowy = linia wygranej)
const SL_STRIP = 34;        // ile symboli przewija się na bębnie (ostatnie trzy = wynik)

const slSym = id => S.cfg.slots.symbols.find(s => s.id === id) || S.cfg.slots.symbols[0];
function slRandom() {
  const syms = S.cfg.slots.symbols, total = syms.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (const s of syms) if ((r -= s.weight) < 0) return s.id;
  return syms[0].id;
}
const slSymHTML = id => `<i class="sl-sym sl-${esc(id)}">${esc(slSym(id).icon)}</i>`;
// bęben: losowe symbole, na końcu trzy widoczne po zatrzymaniu (środkowy = wynik)
function slStrip(result, len = SL_STRIP) {
  const ids = Array.from({ length: len }, slRandom);
  ids[len - 2] = result;
  return ids;
}

function drawSlots() {
  const stake = csStake(SL.sel), C = S.cfg.slots, last = SL.last;
  const reels = SL.reels || [0, 1, 2].map(() => slStrip(slRandom(), SL_ROWS));
  keepScroll($("#casinoBody"), () => $("#casinoBody").innerHTML = `
  <div class="rl-cols">
    <div class="panel rl-left">
      <div class="sl-machine${CS.spinning ? " spinning" : ""}">
        <div class="sl-top"><b>JEDNORĘKI BANDYTA</b><span class="sl-bulbs"></span></div>
        <div class="sl-window">
          ${reels.map((ids, k) => `<div class="sl-reel"><div class="sl-strip" id="slStrip${k}">${ids.slice(-SL_ROWS).map(slSymHTML).join("")}</div></div>`).join("")}
          <i class="sl-line"></i>
        </div>
        <button class="sl-lever" id="slLever" title="Pociągnij dźwignię"${SL.sel.size && !CS.spinning ? "" : " disabled"}><i></i><b></b></button>
      </div>
      <div class="rl-result" id="slResult">${last ? slResultHTML(last) : '<span class="muted">Postaw karty i pociągnij za dźwignię!</span>'}</div>
      <div class="rl-history">${SL.history.map(h => `<span class="sl-h ${h.win ? "win" : ""}">${h.reels.map(id => esc(slSym(id).icon)).join("")}</span>`).join("") || '<span class="muted small">Tu pojawią się ostatnie wyniki</span>'}</div>
    </div>
    <div class="rl-right">
      <div class="panel">
        <h3 class="sl-title">Wypłaty <small class="muted">(środkowa linia)</small></h3>
        <div class="sl-pays">${C.symbols.slice().reverse().map(s => `<div><span>${[0, 1, 2].map(() => slSymHTML(s.id)).join("")}</span><b>×${s.pays}</b>${stake ? `<small>${fmt(stake * s.pays)}</small>` : ""}</div>`).join("")}
          <div><span>${slSymHTML(C.pair)}${slSymHTML(C.pair)}<i class="sl-sym sl-any">?</i></span><b>×${C.pairPays}</b>${stake ? `<small>${fmt(stake * C.pairPays)}</small>` : ""}</div></div>
        ${stake && csSpecialChance(stake) ? `<div class="rl-bet-info"><span class="rl-joker">🃏 Przy wygranej szansa na kartę specjalną (rośnie z wygraną)</span></div>` : ""}
        <button class="big-btn rl-spin" id="slSpin"${SL.sel.size && !CS.spinning ? "" : " disabled"}>🎰 ZAGRAJ${stake ? ` · stawka ${fmt(stake)}` : ""}</button>
        <div class="muted small">Wygrana: twoje karty zostają, a dostajesz karty o wartości stawki × mnożnik (losowe karty ze skrzynek w sklepie, przy większych wygranych w droższych wariantach). Przegrana: postawione karty przepadają.</div>
      </div>
      <div class="panel cs-pick">${csPickerHTML(SL.sel, SL.q, C.maxCards, "sl")}</div>
    </div>
  </div>`);
}

function slResultHTML(r) {
  return `<div class="rl-res ${r.win ? "win" : "lose"}">
    <span class="sl-big">${r.reels.map(id => esc(slSym(id).icon)).join("")}</span>
    <div>${r.win ? `<b class="pos-txt">WYGRANA ×${r.pays}! +${fmt(r.payout)}</b><div class="muted small">${r.items.length} ${plural(r.items.length, "karta", "karty", "kart")}${r.money ? ` + ${fmt(r.money)}` : ""} · kliknij kartę, aby obejrzeć</div>`
      : `<b class="neg-txt">PRZEGRANA −${fmt(r.stake)}</b>`}</div>
  </div>
  ${r.special ? `<div class="rl-special">🃏 <b>Karta specjalna!</b> ${esc(person(r.special.person).name)} — ${esc(variantName(r.special.variant))}</div>` : ""}
  ${r.win && (r.items.length || r.special) ? `<div class="pick-grid rl-won">${[...(r.special ? [r.special] : []), ...r.items].map(i => pickHTML(i)).join("")}</div>` : ""}`;
}

async function spinSlots() {
  if (CS.spinning || !SL.sel.size) return;
  const ids = [...SL.sel], stake = csStake(SL.sel);
  if (stake >= 5000 && !confirm(`Postawić ${ids.length} ${plural(ids.length, "kartę", "karty", "kart")} o wartości ${fmt(stake)}?`)) return;
  CS.spinning = true;
  Sound.unlock();
  const lever = $("#slLever");
  lever?.classList.add("pulled");
  let res;
  try { res = await api("/api/casino/slots", { ids }); }
  catch (e) { CS.spinning = false; Sound.error(); toast(e.message, true); return drawSlots(); }
  $$("#casinoBody button, #casinoBody input").forEach(b => { b.disabled = true; });
  $(".sl-machine")?.classList.add("spinning");

  // każdy bęben dostaje długi pasek symboli zakończony wynikiem i zatrzymuje się chwilę po poprzednim
  const fast = S.fast;
  const full = res.reels.map(r => slStrip(r));
  const strips = [0, 1, 2].map(k => $(`#slStrip${k}`));
  strips.forEach((el, k) => { el.innerHTML = full[k].map(slSymHTML).join(""); });
  const symH = strips[0].firstElementChild.getBoundingClientRect().height;
  const endY = -(SL_STRIP - SL_ROWS) * symH;
  const durs = fast ? [700, 900, 1100] : [1500, 2100, 2700];
  const t0 = performance.now();
  const ticks = [-1, -1, -1], stopped = [false, false, false];
  await new Promise(done => {
    const frame = now => {
      let all = true;
      strips.forEach((el, k) => {
        const t = Math.min(1, (now - t0) / durs[k]);
        const e = t < 1 ? 1 - Math.pow(1 - t, 3) : 1;
        const y = endY * e;
        el.style.transform = `translateY(${y.toFixed(1)}px)`;
        const sym = Math.floor(-y / symH);
        if (sym !== ticks[k] && k === strips.findIndex((_, i) => !stopped[i])) { ticks[k] = sym; Sound.tick(1 - t); }
        if (t >= 1 && !stopped[k]) { stopped[k] = true; el.parentElement.classList.add("stop"); Sound.land("blue"); }
        if (t < 1) all = false;
      });
      if (all) done(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  SL.last = res;
  SL.history = [{ reels: res.reels, win: res.win }, ...SL.history].slice(0, 12);
  SL.reels = full.map(ids => ids.slice(-SL_ROWS));   // po przerysowaniu widać te same trzy symbole, na których stanął bęben
  if (res.win) {
    S.items = [...res.items.slice().reverse(), ...S.items];
    noteCollected(res.items);
    Sound.win();
    $(".sl-machine")?.classList.add("won");
    confetti(["#ffcf3f", "#ff3b5c", "#fff", "#3ddc84"], res.pays >= 14 ? 240 : 110);
  } else {
    removeItems(res.consumed);
    SL.sel.clear();
    Sound.fail();
  }
  if (res.special) { S.items = [res.special, ...S.items]; noteCollected([res.special]); }
  applyState(res.state);
  if (res.special) {   // karta specjalna z kasyna (Joker) - wielkie odsłonięcie
    await sleep(fast ? 300 : 700);
    await epicReveal(res.special, { fast });
    announceFirsts([res.special]);
  }
  await sleep(fast ? 150 : 500);
  CS.spinning = false;
  if (currentView() === "casino" && CS.tab === "slots") drawSlots();
}

function bindSlots() {
  $("#casinoBody").addEventListener("click", e => {
    if (CS.tab !== "slots" || CS.spinning) return;
    if (e.target.closest("#slSpin, #slLever")) spinSlots();
  });
}
