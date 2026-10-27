"use strict";
// Ulepszacz (zakładka w Kasynie) "w ciemno": stawiasz swoje karty i wybierasz mnożnik (×1,5 … ×20). Cel to losowa karta
// o najniższej wartości >= wkład × mnożnik - losuje ją serwer, a gracz widzi tylko jej wartość i szansę; jaka to karta,
// widać dopiero po wygranej. Wygrana może dać też kartę specjalną z kasyna (Joker) - jak w ruletce i blackjacku.

const UPG = { inputs: new Set(), mult: 2, angle: 0, sort: "value", q: "", busy: false, last: null };

function upgStake() {
  return S.items.filter(i => UPG.inputs.has(i.id)).reduce((a, i) => a + i.value, 0);
}

function upgChance(stake, goal) {
  if (!stake || !goal || goal <= stake) return 0;
  return Math.min(S.cfg.upgradeMax, stake / goal * S.cfg.upgradeEdge);
}

// wartości możliwych celów (jak upgrade_pool na serwerze): karty ze skrzynek w sklepie, bez tajnych i specjalnych,
// w zwykłym wariancie albo we włączonych, nie wyjątkowych wariantach
function upgPoolValues() {
  const vs = S.cfg.variantOrder.filter(v => v === "normal" || (isSpecial(v) && !isExclusive(v) && variantOn(v) &&
    !S.cfg.variants[v].combo && !S.cfg.variants[v].special && !S.cfg.variants[v].cards));
  const out = new Set();
  Object.values(S.cfg.people).filter(p => p.forge && p.rarity !== "secret" && p.rarity !== "special")
    .forEach(p => vs.forEach(v => out.add(cardValue(p.id, v))));
  return [...out].sort((a, b) => a - b);
}
// wartość celu dla wkładu i mnożnika (najniższa >= wkład × mnożnik) albo 0, gdy nie ma tak drogiej karty
function upgGoal(stake, mult, values = upgPoolValues()) {
  return stake ? values.find(v => v >= stake * mult && v > stake) || 0 : 0;
}

function renderUpgrader() {
  const box = $("#casinoBody");
  const owned = new Set(forgeItems().map(i => i.id));
  [...UPG.inputs].forEach(id => { if (!owned.has(id)) UPG.inputs.delete(id); });
  const stake = upgStake();
  const values = upgPoolValues();
  const goal = upgGoal(stake, UPG.mult, values);
  const chance = upgChance(stake, goal);
  const joker = goal ? csSpecialChance(goal) : 0;
  const max = S.cfg.upgradeMaxItems;
  // wybrane karty zostają na liście także wtedy, gdy nie pasują do wyszukiwania (żeby dało się je odznaczyć)
  const mine = sortCards(forgeItems().filter(i => UPG.inputs.has(i.id) || cardMatches(i, UPG.q)), UPG.sort);

  keepScroll(box, () => box.innerHTML = `
  <div class="muted cs-info">Postaw swoje karty i wybierz, ile razy droższą kartę chcesz wygrać. Jaka to będzie karta — losuje serwer
    i zobaczysz ją dopiero po wygranej. Im wyższy mnożnik, tym mniejsza szansa. Przegrana = karty przepadają!</div>
  <div class="upg-cols blind">
    <div class="panel upg-side">
      <h3>Twoje karty <small class="muted">(max ${max})</small></h3>
      <div class="upg-sum">Wkład: <b>${fmt(stake)}</b> · ${UPG.inputs.size} ${plural(UPG.inputs.size, "karta", "karty", "kart")}
        ${UPG.inputs.size ? '<button class="btn tiny" id="uClear">Wyczyść</button>' : ""}</div>
      <div class="upg-filters"><input type="text" data-uq placeholder="🔍 Szukaj…" value="${esc(UPG.q)}">${sortSelectHTML(UPG.sort, "data-usort")}</div>
      <div class="pick-grid upg-mine" data-keep="upg">${mine.length ? mine.slice(0, PICK_LIMIT).map(i => pickHTML(i, { sel: UPG.inputs.has(i.id) })).join("")
        : `<div class="empty">${UPG.q.trim() ? "Żadna karta nie pasuje do wyszukiwania." : "Nie masz kart (ulubionych ⭐ i specjalnych 🃏 nie można postawić)."}</div>`}</div>
    </div>

    <div class="panel upg-mid">
      <div class="upg-wheel" id="upgWheel">
        <svg viewBox="0 0 300 300">
          <defs>
            <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ddc84"/><stop offset="1" stop-color="#b6ff5c"/></linearGradient>
          </defs>
          <circle class="upg-track" cx="150" cy="150" r="128"/>
          <circle class="upg-arc" id="upgArc" cx="150" cy="150" r="128"/>
          ${Array.from({ length: 60 }, (_, k) => `<line class="upg-tick${k % 5 ? "" : " big"}" x1="150" y1="44" x2="150" y2="${k % 5 ? 50 : 56}" transform="rotate(${k * 6} 150 150)"/>`).join("")}
        </svg>
        <div class="upg-pointer" id="upgPointer"><i></i></div>
        <div class="upg-readout">
          <div class="upg-pct" id="upgPct">${pct(chance)}</div>
          <div class="muted small">szansa</div>
          <div class="upg-mult">×${String(UPG.mult).replace(".", ",")}</div>
        </div>
        <div class="upg-result" id="upgResult" hidden></div>
      </div>
      <div class="upg-pair">
        <div class="upg-stake"><b>${fmt(stake)}</b><small>${UPG.inputs.size} ${plural(UPG.inputs.size, "karta", "karty", "kart")}</small></div>
        <div class="upg-arrow">➜</div>
        <div class="upg-mystery${goal ? "" : " empty"}"><b>?</b><span>${goal ? fmt(goal) : "—"}</span></div>
      </div>
      <div class="upg-quick">${S.cfg.upgradeMults.map(m => {
        const ok = !stake || upgGoal(stake, m, values);
        return `<button class="chip${m === UPG.mult ? " active" : ""}" data-umult="${m}"${ok ? "" : " disabled"}>×${String(m).replace(".", ",")}</button>`;
      }).join("")}</div>
      <div class="muted small upg-note">${!stake ? "Wybierz karty do postawienia."
        : goal ? `Wygrasz losową kartę wartą <b>${fmt(goal)}</b> — jaką, zobaczysz dopiero po wygranej.${joker ? `<br>🃏 Szansa na kartę specjalną przy wygranej: <b>${csPct(joker)}</b>` : ""}`
        : "Nie ma tak drogiej karty — wybierz mniejszy mnożnik."}</div>
      <button class="big-btn" id="upgBtn"${goal && chance > 0 ? "" : " disabled"}>⬆️ ULEPSZ${chance ? ` (${pct(chance)})` : ""}</button>
    </div>
  </div>`);
  drawUpgWheel(chance);
}

function upgArcStart(chance) { return -chance * 180; } // łuk wyśrodkowany u góry

function drawUpgWheel(chance) {
  const arc = $("#upgArc");
  if (!arc) return;
  const C = 2 * Math.PI * 128;
  arc.style.strokeDasharray = `${chance * C} ${C}`;
  arc.setAttribute("transform", `rotate(${upgArcStart(chance) - 90} 150 150)`);
  $("#upgPointer").style.transform = `rotate(${UPG.angle}deg)`;
}

const upgVisible = () => currentView() === "casino" && CS.tab === "upgrade";

async function runUpgrade() {
  if (UPG.busy || !UPG.inputs.size) return;
  const ids = [...UPG.inputs];
  const stake = upgStake();
  if (ids.some(id => rarityIdx(person(S.items.find(i => i.id === id).person).rarity) >= rarityIdx("gold")) &&
      !confirm(`Stawiasz karty legendarne (${fmt(stake)}). Na pewno?`)) return;
  UPG.busy = CS.spinning = true;   // CS.spinning - w tym czasie nie da się przełączyć zakładki kasyna
  Sound.unlock();
  $$("#casinoBody button, #casinoBody input, #casinoBody select").forEach(b => b.disabled = true);
  let res;
  try {
    res = await api("/api/upgrade", { ids, mult: UPG.mult });
    if (res.discovered?.length) await refreshConfig();
  } catch (e) { UPG.busy = CS.spinning = false; Sound.error(); toast(e.message, true); renderUpgrader(); return; }

  const wheel = $("#upgWheel");
  wheel.classList.add("spinning");
  const chance = res.chance;
  drawUpgWheel(chance);
  $("#upgPct").textContent = pct(chance);
  const finalAngle = upgArcStart(chance) + res.roll * 360;
  const start = UPG.angle;
  const base = start - (((start % 360) + 360) % 360);
  const fast = S.fast;
  const end = base + 360 * (fast ? 3 : 6) + ((finalAngle % 360) + 360) % 360;
  const D = fast ? 1600 : 5200;
  const t0 = performance.now();
  const pointer = $("#upgPointer");
  const a0 = upgArcStart(chance);
  const inArc = a => { const n = (((a - a0) % 360) + 360) % 360; return n < chance * 360; };
  let lastTick = Math.floor(start / 10);
  await new Promise(done => {
    const frame = now => {
      const t = Math.min(1, (now - t0) / D);
      const e = 1 - Math.pow(1 - t, 4);
      const ang = start + (end - start) * e;
      pointer.style.transform = `rotate(${ang}deg)`;
      const tk = Math.floor(ang / 10);
      if (tk !== lastTick) { lastTick = tk; Sound.tick(1 - t); }
      wheel.classList.toggle("in-arc", inArc(ang));
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  UPG.angle = end;
  wheel.classList.remove("spinning");

  removeItems(res.consumed);
  UPG.inputs.clear();
  if (res.win) {
    S.items = [...(res.special ? [res.special] : []), res.item, ...S.items];
    noteCollected([res.item, ...(res.special ? [res.special] : [])]);
  }
  applyState(res.state);
  UPG.last = res;
  CS.lost = !res.win;

  const b = wheel.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const box = $("#upgResult");
  if (res.win) {
    wheel.classList.add("won");
    Sound.win();
    const rr = person(res.item.person).rarity;
    fx().burst(cx, cy, 180, rr === "ultra" ? RAINBOW : ["#3ddc84", "#b6ff5c", "#ffffff", S.cfg.rarities[rr].color], { speed: 14 });
    if (rarityIdx(rr) >= rarityIdx("gold")) { await sleep(600); await epicReveal(res.item, { fast }); }
    else confetti(["#3ddc84", "#b6ff5c", "#fff", S.cfg.rarities[rr].color], 120);
    if (res.special) { await sleep(300); await epicReveal(res.special, { fast }); }   // karta specjalna z kasyna (Joker)
    announceFirsts([res.item, ...(res.special ? [res.special] : [])]);
    box.innerHTML = `<div class="upg-res-label win">WYGRANA!</div>${cardHTML(res.item.person, res.item.variant)}
      ${res.special ? `<div class="upg-res-special">🃏 + ${esc(person(res.special.person).name)}</div>` : ""}<div class="muted small">kliknij kartę, aby ją obejrzeć</div>`;
  } else {
    wheel.classList.add("lost");
    Sound.fail();
    fx().burst(cx, cy, 90, ["#ff5468", "#ff9a9a", "#552"], { speed: 9, g: 0.3 });
    $$("#casinoBody .upg-mine .pick.sel").forEach(el => {
      el.style.setProperty("--dx", rand(-120, 120) + "px");
      el.style.setProperty("--dr", rand(-60, 60) + "deg");
      el.classList.add("shatter");
    });
    box.innerHTML = `<div class="upg-res-label lose">PRZEGRANA</div><div class="upg-lost">💥 ${fmt(stake)}</div>`;
  }
  box.hidden = false;
  // wynik znika sam (albo po kliknięciu) i ulepszacz jest od razu gotowy do kolejnej próby - mnożnik zostaje.
  // Odblokowujemy też wtedy, gdy gracz w międzyczasie przeszedł do innej zakładki.
  const finish = () => {
    if (!UPG.busy) return;
    UPG.busy = CS.spinning = false;
    if (upgVisible()) renderUpgrader();
  };
  setTimeout(finish, res.win ? 2600 : 1600);
  box.addEventListener("click", e => { if (!e.target.closest(".card")) finish(); });
}

function bindUpgrader() {
  const body = $("#casinoBody");
  body.addEventListener("click", e => {
    if (CS.tab !== "upgrade") return;
    const t = e.target;
    if (UPG.busy) {   // podgląd wygranej karty
      const c = t.closest("#upgResult .card");
      if (c) openViewer(c.dataset.pid, c.dataset.variant, c.dataset.uid);
      return;
    }
    const pick = t.closest(".upg-mine .pick");
    if (pick) {
      const id = +pick.dataset.id;
      if (UPG.inputs.has(id)) UPG.inputs.delete(id);
      else if (UPG.inputs.size >= S.cfg.upgradeMaxItems) { Sound.error(); return toast(`Maksymalnie ${S.cfg.upgradeMaxItems} kart`, true); }
      else UPG.inputs.add(id);
      Sound.click();
      return renderUpgrader();
    }
    const m = t.closest("[data-umult]");
    if (m) { UPG.mult = +m.dataset.umult; Sound.click(); return renderUpgrader(); }
    if (t.closest("#uClear")) { UPG.inputs.clear(); Sound.click(); return renderUpgrader(); }
    if (t.closest("#upgBtn")) return runUpgrade();
  });
  body.addEventListener("input", e => {
    if (CS.tab !== "upgrade" || !e.target.matches("[data-uq]")) return;
    UPG.q = e.target.value;
    const pos = e.target.selectionStart;
    resetKeep("upg");
    renderUpgrader();
    const inp = $("[data-uq]"); inp.focus(); inp.setSelectionRange(pos, pos);
  });
  body.addEventListener("change", e => {
    if (CS.tab !== "upgrade" || !e.target.matches("[data-usort]")) return;
    UPG.sort = e.target.value; resetKeep("upg"); renderUpgrader();
  });
}
