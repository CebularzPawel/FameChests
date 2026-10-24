"use strict";
// Kuźnia: kontrakt (N kart -> 1 wyższej rzadkości) i ulepszacz (koło szans).

const FORGE = {
  mode: "contract",
  tier: "green",
  slots: [],
  busy: false,
  sort: "valueAsc",       // sortowanie kart do kontraktu
  q: "",                  // wyszukiwanie kart do kontraktu
  upg: { inputs: new Set(), target: null, variant: "all", search: "", angle: 0, sortMine: "value", sortTarget: "valueAsc", qMine: "" },
  bulk: { n: 1, dupes: true, keepSpecial: true },   // wiele kontraktów naraz
};
const MAX_BULK_CONTRACTS = 50;  // tyle przyjmie serwer w jednym zapytaniu
const PICK_LIMIT = 300;
// ulubione karty (⭐) i karty specjalne nie trafiają do kuźni
const forgeItems = () => S.items.filter(i => !i.fav && !isSpecialCard(i.person));
const PICK_TAGS = { bw: "B&W", reverse: "REV", bronze: "BRNZ", silver: "SILV", steel: "⚙️", sapphire: "💙", blackdiamond: "🖤", holo: "HOLO", pearl: "🦪", gold: "GOLD", vintage: "📷", marble: "🏛️", slime: "🟢", matte: "MAT", racing: "🏁", bismuth: "🌈", digital: "💻", cyber: "🌃", fade: "🎨", wanted: "🤠", artdeco: "DÉCO", cheese: "🧀", aero: "🫧", greek: "🏺", african: "🌍", honey: "🍯", street: "🎨", chinese: "🏮", moro: "🪖", beer: "🍺", neon: "💡", emo: "🖤", electric: "⚡", synthwave: "📼", motor: "🏎️", toxic: "☢️", pixel: "👾", popart: "💥", glass: "⛪", thermal: "🌡️", blueprint: "📐", glitch: "📺", dollar: "💵", mosaic: "🧱", noir: "🕵️", flag: "🏳️", halloween: "🎃", lantern: "🏮", devil: "😈", joker: "🃏", jeans: "👖", clear: "🫧", sketch: "✒️", emerald: "💚", amethyst: "💜", ruby: "❤️", mlg: "🎯", royal: "👑", diamond: "💎", galaxy: "🌌", negative: "◐", rzulty: "💛" };

function pickHTML(item, { sel = false, extra = "" } = {}) {
  const p = person(item.person);
  const v = item.variant || "normal";
  const img = p.rarity === "secret" && p.masked ? `/img/${p.id}` : imgUrl(p.id, v, true);
  return `<div class="pick r-${p.rarity} ${vClass(v)}${sel ? " sel" : ""}" data-id="${item.id}" style="--rc:${S.cfg.rarities[p.rarity].color}">
    <img src="${img}" alt="" loading="lazy" draggable="false">
    ${isSpecial(v) ? `<span class="ph ${vtClass(v)}">${isCombo(v) ? PICK_TAGS[variantParts(v)[0]] : ""}${PICK_TAGS[baseVariant(v)]}</span>` : ""}
    <span class="pn">${esc(p.name)}</span>
    <span class="pv">${fmt(item.value)}</span>${extra}
  </div>`;
}

function pct(x) { return (x * 100).toLocaleString("pl-PL", { maximumFractionDigits: x < 0.01 ? 2 : 1 }) + "%"; }

function renderForge() {
  $("#forgeSeg").innerHTML = [["contract", "📜 Kontrakt"], ["upgrade", "⬆️ Ulepszacz"]].map(([m, n]) =>
    `<button data-mode="${m}" class="${FORGE.mode === m ? "active" : ""}">${n}</button>`).join("");
  $("#forgeInfo").innerHTML = FORGE.mode === "contract"
    ? `Połącz kilka kart tej samej rzadkości w jedną kartę <b>wyższej</b> rzadkości. Karty w specjalnych wariantach zwiększają szansę na wariant.`
    : `Postaw swoje karty i wybierz cel. Im droższy cel, tym mniejsza szansa. Przegrana = karty przepadają!`;
  FORGE.mode === "contract" ? renderContract() : renderUpgrader();
}

// ================================================================ KONTRAKT

function contractVariantChance(specials) {
  // kontrakt nie daje wariantów wyjątkowych (Królewski, Flagowy) - te wypadają tylko ze skrzynek - ani wyłączonych
  const base = S.cfg.variantOrder.filter(v => isSpecial(v) && !isExclusive(v) && variantOn(v)).reduce((a, v) => a + S.cfg.variants[v].chance, 0);
  return Math.min(0.9, base * (1 + S.cfg.contractVariantBonus * specials));
}

// wynik kontraktu (jak na serwerze): tylko karty ze skrzynek, które są teraz w sklepie (p.forge), i nie "droższe"
// (valueMult) niż najtańsza z włożonych; crateId = null - ze wszystkich skrzynek w sklepie
function contractCandidates(crateId, target, maxMult) {
  const ids = crateId ? crateOf(crateId)?.people || [] : Object.keys(S.cfg.people);
  return ids.filter(id => { const p = person(id); return p.rarity === target && p.forge && (p.valueMult || 1) <= maxMult; });
}
// skrzynka, z której kontrakt losuje wynik za tę kartę (karta tylko ze skrzynek spoza sklepu - null)
function contractCrate(p, target, maxMult) {
  return (p.crates || [p.crate]).find(c => contractCandidates(c, target, maxMult).length) ?? null;
}

function renderContract() {
  const order = S.cfg.rarityOrder;
  // rzadkości bez kart (np. nowa Niepospolita) pomijamy; wynik kontraktu = następna rzadkość, która ma karty
  const tiers = order.filter(r => r in S.cfg.contractSize && S.cfg.contractNext[r] && Object.values(S.cfg.people).some(p => p.rarity === r));
  if (!tiers.includes(FORGE.tier)) FORGE.tier = tiers[0] || FORGE.tier;
  const tier = FORGE.tier;
  const need = S.cfg.contractSize[tier];
  const next = S.cfg.contractNext[tier];
  const R = S.cfg.rarities[tier], NR = S.cfg.rarities[next];

  const byId = new Map(forgeItems().map(i => [i.id, i]));
  FORGE.slots = FORGE.slots.filter(id => byId.has(id) && person(byId.get(id).person).rarity === tier).slice(0, need);
  const slotItems = FORGE.slots.map(id => byId.get(id));
  const inSlots = new Set(FORGE.slots);
  const eligible = sortCards(forgeItems().filter(i => person(i.person).rarity === tier && !inSlots.has(i.id) && cardMatches(i, FORGE.q)), FORGE.sort);

  const specials = slotItems.filter(i => isSpecial(i.variant)).length;
  const stake = slotItems.reduce((a, i) => a + i.value, 0);

  // możliwe wyniki
  let outcomes = "";
  if (slotItems.length) {
    const maxMult = Math.min(...slotItems.map(i => person(i.person).valueMult || 1));
    const pool = slotItems.map(i => contractCrate(person(i.person), next, maxMult)).filter(c => contractCandidates(c, next, maxMult).length);
    const share = {};
    pool.forEach(c => { share[c ?? ""] = (share[c ?? ""] || 0) + 1 / pool.length; });
    const chance = {};   // ta sama karta może wypaść z kilku skrzynek - sumujemy
    Object.entries(share).forEach(([c, sh]) => {
      const ids = contractCandidates(c || null, next, maxMult);
      ids.forEach(id => { chance[id] = (chance[id] || 0) + sh / ids.length; });
    });
    outcomes = Object.entries(chance).sort((a, b) => b[1] - a[1]).map(([id, ch]) =>
      `<div class="oc" title="${esc(person(id).name)}"><img src="${person(id).masked ? `/img/${id}` : imgUrl(id, null, true)}" alt=""><span>${pct(ch)}</span></div>`).join("")
      || `<div class="muted small">W skrzynkach ze sklepu nie ma kart wyższej rzadkości.</div>`;
  }

  keepScroll($("#forgeBody"), () => $("#forgeBody").innerHTML = `
  <div class="forge-cols">
    <div class="panel forge-pick">
      <div class="tier-chips">${tiers.map(t => {
        const n = forgeItems().filter(i => person(i.person).rarity === t).length;
        return `<button class="rf rf-${t}${t === tier ? " active" : ""}" data-tier="${t}" style="--rc:${S.cfg.rarities[t].color}"><i></i>${S.cfg.rarities[t].name} <small>${n}</small></button>`;
      }).join("")}</div>
      <div class="forge-pick-head"><span class="muted small">Kliknij kartę, aby dodać ją do kontraktu.</span>
        <input type="text" data-fq="contract" placeholder="🔍 Szukaj…" value="${esc(FORGE.q)}">${sortSelectHTML(FORGE.sort, 'data-fsort="contract"')}</div>
      <div class="pick-grid" data-keep="contract">${eligible.length ? eligible.slice(0, PICK_LIMIT).map(i => pickHTML(i)).join("") : FORGE.q.trim()
        ? '<div class="empty">Żadna karta nie pasuje do wyszukiwania.</div>' : `<div class="empty">Nie masz więcej kart rzadkości „${R.name}”.</div>`}</div>
    </div>
    <div class="panel contract" style="--rc:${R.color}; --nc:${NR.color}">
      <h3>${need} × <span style="color:${R.color}">${R.name}</span> ➜ 1 × <span class="${next === "ultra" ? "rainbow-text" : next === "secret" ? "secret-text" : ""}" style="color:${NR.color}">${NR.name}</span></h3>
      <div class="slots">${Array.from({ length: need }, (_, k) => slotItems[k]
        ? `<div class="slot filled" data-id="${slotItems[k].id}">${cardHTML(slotItems[k].person, slotItems[k].variant)}<span class="slot-x">✕</span></div>`
        : `<div class="slot"><span>${k + 1}</span></div>`).join("")}</div>
      <div class="contract-flow">
        <div class="contract-arrow">⬇</div>
        <div class="contract-out r-${next}"><div class="out-q">${next === "secret" ? "★" : "?"}</div><div class="out-name">${NR.name}</div></div>
      </div>
      <div class="contract-info">
        <span>Wkład: <b>${fmt(stake)}</b></span>
        <span>Wynik: <b>${fmt(NR.value)}</b>+</span>
        <span>Szansa na wariant: <b class="holo-txt">${pct(contractVariantChance(specials))}</b></span>
      </div>
      <div class="contract-btns">
        <button class="btn" id="cAuto">⚡ Auto-uzupełnij (duplikaty)</button>
        <button class="btn" id="cClear"${FORGE.slots.length ? "" : " disabled"}>Wyczyść</button>
      </div>
      <button class="big-btn" id="cSign"${slotItems.length === need ? "" : " disabled"}>✍️ PODPISZ KONTRAKT</button>
      ${bulkPanelHTML(tier, need)}
      ${outcomes ? `<div class="outcomes-title muted small">Możliwe wyniki:</div><div class="outcomes">${outcomes}</div>` : ""}
    </div>
  </div>`);
}

// ---------------------------------------------------------------- wiele kontraktów naraz
// karty dobierane automatycznie: nigdy ulubione ani z gabloty; domyślnie zostaje po 1 karcie każdej osoby (najlepszy
// wariant) i pomijamy warianty specjalne; najpierw najtańsze
function bulkPool(tier) {
  const { dupes, keepSpecial } = FORGE.bulk, show = new Set(S.showcase), byPerson = {};
  S.items.filter(i => person(i.person).rarity === tier).forEach(i => (byPerson[i.person] ||= []).push(i));
  const out = [];
  for (const list of Object.values(byPerson)) {
    list.sort((a, b) => (b.fav - a.fav) || (show.has(b.id) - show.has(a.id)) || varRank(b.variant) - varRank(a.variant) || a.id - b.id);
    list.forEach((it, k) => {
      if ((dupes && k === 0) || it.fav || show.has(it.id) || (keepSpecial && isSpecial(it.variant))) return;
      out.push(it);
    });
  }
  return out.sort((a, b) => a.value - b.value || a.id - b.id);
}

function bulkPlan(tier) {
  const need = S.cfg.contractSize[tier], pool = bulkPool(tier);
  const max = Math.min(MAX_BULK_CONTRACTS, Math.floor(pool.length / need));
  const n = Math.max(0, Math.min(FORGE.bulk.n, max));
  const groups = Array.from({ length: n }, (_, k) => pool.slice(k * need, (k + 1) * need));
  return { need, max, n, groups, items: groups.flat() };
}

function bulkPanelHTML(tier) {
  const plan = bulkPlan(tier), value = plan.items.reduce((a, i) => a + i.value, 0);
  const word = n => plural(n, "kontrakt", "kontrakty", "kontraktów");
  return `<div class="bulk-contract">
    <div class="bulk-title">⚡ Wiele kontraktów naraz</div>
    <div class="bulk-row">
      <button class="step-btn" data-bulk="-" ${plan.n > 1 ? "" : "disabled"}>−</button>
      <b class="bulk-n">${plan.n}</b>
      <button class="step-btn" data-bulk="+" ${plan.n < plan.max ? "" : "disabled"}>+</button>
      <button class="btn tiny" data-bulk="max" ${plan.max ? "" : "disabled"}>max (${plan.max})</button>
    </div>
    <label class="chk"><input type="checkbox" data-bulk-opt="dupes" ${FORGE.bulk.dupes ? "checked" : ""}> tylko duplikaty (zostaje po 1 karcie każdej osoby)</label>
    <label class="chk"><input type="checkbox" data-bulk-opt="keepSpecial" ${FORGE.bulk.keepSpecial ? "checked" : ""}> pomiń karty w specjalnych wariantach</label>
    <div class="muted small">${plan.max ? `Zużyjesz <b>${plan.items.length}</b> ${plural(plan.items.length, "kartę", "karty", "kart")} (${fmt(value)}) — najpierw najtańsze. Ulubione ⭐ i karty z gabloty nigdy nie są brane.`
      : "Za mało kart tej rzadkości (przy tych ustawieniach) na choćby 1 kontrakt."}</div>
    <button class="btn primary bulk-go" id="cBulk" ${plan.n ? "" : "disabled"}>📜 Wykonaj ${plan.n} ${word(plan.n)}</button>
  </div>`;
}

async function runBulkContracts() {
  if (FORGE.busy) return;
  const tier = FORGE.tier, plan = bulkPlan(tier);
  if (!plan.n) return;
  const value = plan.items.reduce((a, i) => a + i.value, 0);
  const legendary = rarityIdx(tier) >= rarityIdx("gold") ? "\nUwaga: to karty legendarne!" : "";
  if (!confirm(`Wykonać ${plan.n} ${plural(plan.n, "kontrakt", "kontrakty", "kontraktów")}? Zużyjesz ${plan.items.length} kart o wartości ${fmt(value)}.${legendary}`)) return;
  FORGE.busy = true;
  let res;
  try { res = await api("/api/contracts", { groups: plan.groups.map(g => g.map(i => i.id)) }); }
  catch (e) { FORGE.busy = false; Sound.error(); toast(e.message, true); return renderContract(); }
  if (res.discovered?.length) await refreshConfig();
  removeItems(res.consumed);
  const got = res.results.map(r => r.item);
  S.items = [...got.slice().reverse(), ...S.items];
  applyState(res.state);
  FORGE.slots = [];
  FORGE.busy = false;
  renderContract();
  showBulkResults(got, value);
}

function showBulkResults(got, stake) {
  const gain = got.reduce((a, i) => a + i.value, 0);
  const sorted = got.slice().sort((a, b) => rarityIdx(person(b.person).rarity) - rarityIdx(person(a.person).rarity) ||
    varRank(b.variant) - varRank(a.variant) || b.value - a.value);
  const best = person(sorted[0].person).rarity;
  const dlg = openDialog(`<div class="bulk-res">
      <h3>📜 ${got.length} ${plural(got.length, "kontrakt", "kontrakty", "kontraktów")}</h3>
      <p class="muted">Oddane karty: ${fmt(stake)} → otrzymane: <b>${fmt(gain)}</b></p>
      <div class="bulk-grid">${sorted.map((it, k) => `<div class="bulk-card${isSpecial(it.variant) ? " special" : ""}" style="animation-delay:${Math.min(k, 30) * 70}ms">
        ${cardHTML(it.person, it.variant)}</div>`).join("")}</div>
      <div class="daily-actions">
        <button class="btn sell" data-bulk-sell>💰 Sprzedaj wszystkie (${fmt(gain)})</button>
        <button class="btn primary" data-close>✔ Odbierz</button></div>
    </div>`, "bulk-box");
  Sound.reveal(best);
  if (rarityIdx(best) >= rarityIdx("gold") || got.some(i => isSpecial(i.variant))) confetti(GOLDS.concat(RAINBOW), 160);
  announceFirsts(got);
  dlg.querySelector("[data-bulk-sell]").addEventListener("click", async () => {
    if (got.some(i => rarityIdx(person(i.person).rarity) >= rarityIdx("gold")) && !confirm("Wśród nich są karty legendarne lub lepsze. Sprzedać wszystkie?")) return;
    try { await sellIds(got.map(i => i.id)); } catch (e) { return toast(e.message, true); }
    closeDialogs();
    renderForge();
  });
}

function contractAutoFill() {
  const tier = FORGE.tier, need = S.cfg.contractSize[tier];
  const inSlots = new Set(FORGE.slots);
  const pool = forgeItems().filter(i => person(i.person).rarity === tier && !inSlots.has(i.id));
  // najpierw duplikaty (zostawiamy po 1 karcie każdej osoby), zwykłe przed specjalnymi
  const count = {};
  S.items.forEach(i => { count[i.person] = (count[i.person] || 0) + 1; });
  FORGE.slots.forEach(id => { const it = S.items.find(i => i.id === id); if (it) count[it.person]--; });
  const sorted = pool.sort((a, b) => varRank(a.variant) - varRank(b.variant) || count[b.person] - count[a.person]);
  const picked = [];
  for (const it of sorted) {
    if (FORGE.slots.length + picked.length >= need) break;
    if (count[it.person] > 1) { picked.push(it.id); count[it.person]--; }
  }
  if (FORGE.slots.length + picked.length < need) {
    toast(picked.length ? "Za mało duplikatów — dodano tyle, ile się dało." : "Brak duplikatów tej rzadkości.", !picked.length);
  }
  FORGE.slots.push(...picked);
  Sound.click();
  renderContract();
}

async function runContract() {
  if (FORGE.busy) return;
  const need = S.cfg.contractSize[FORGE.tier];
  const items = FORGE.slots.map(id => S.items.find(i => i.id === id)).filter(Boolean);
  if (items.length !== need) return;
  if (items.some(i => rarityIdx(person(i.person).rarity) >= rarityIdx("gold")) &&
      !confirm("W kontrakcie są karty legendarne. Na pewno?")) return;
  FORGE.busy = true;
  Sound.unlock();
  const fast = S.fast;
  const next = S.cfg.contractNext[FORGE.tier];
  const NR = S.cfg.rarities[next];
  const resP = api("/api/contract", { ids: FORGE.slots }).catch(e => ({ error: e.message }));

  const el = document.createElement("div");
  el.className = "forge-anim";
  el.style.setProperty("--nc", NR.color);
  el.innerHTML = `
    <div class="fa-bg"></div>
    <canvas class="fa-canvas"></canvas>
    <div class="fa-title">📜 KONTRAKT</div>
    <div class="fa-orb"></div>
    <div class="fa-ring">${items.map(i => `<div class="fa-card">${cardHTML(i.person, i.variant)}</div>`).join("")}</div>
    <div class="fa-reel reel" hidden><div class="strip fa-strip"></div><div class="reel-marker"></div></div>
    <div class="fa-result" hidden></div>
    <div class="flash fa-flash"></div>`;
  document.body.appendChild(el);
  document.body.style.overflow = "hidden";
  const P = makeParticles(el.querySelector(".fa-canvas"));
  const cards = [...el.querySelectorAll(".fa-card")];
  const orb = el.querySelector(".fa-orb");
  const colors = next === "ultra" ? RAINBOW : next === "secret" ? SECRET_COLORS : [NR.color, "#ffffff", NR.color];

  // faza 1: karty krążą i zlewają się w kulę energii
  const D1 = fast ? 1000 : 2300;
  Sound.charge(D1 / 1000, rarityIdx(next) >= rarityIdx("ultra"));
  const t0 = performance.now();
  await new Promise(done => {
    const R0 = Math.min(innerWidth, innerHeight) * 0.32;
    const frame = now => {
      const t = Math.min(1, (now - t0) / D1);
      const e = t * t * t;
      const cx = innerWidth / 2, cy = innerHeight / 2;
      cards.forEach((c, k) => {
        const ang = (k / cards.length) * 6.283 + e * 6.283 * 3 - 1.57;
        const r = R0 * (1 - e);
        c.style.transform = `translate(-50%, -50%) translate(${Math.cos(ang) * r}px, ${Math.sin(ang) * r}px) rotate(${e * 720}deg) scale(${1 - e * 0.8})`;
        c.style.opacity = 1 - Math.max(0, (t - 0.85) / 0.15);
        c.style.filter = `brightness(${1 + e * 2}) drop-shadow(0 0 ${10 + e * 30}px ${NR.color})`;
      });
      orb.style.transform = `translate(-50%, -50%) scale(${0.2 + e * 1.3})`;
      orb.style.opacity = 0.3 + e * 0.7;
      if (Math.random() < 0.6) P.implode(cx, cy, 5, colors, R0 * 1.3);
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });

  const res = await resP;
  if (!res.error && res.discovered?.length) await refreshConfig();
  const fl = el.querySelector(".fa-flash");
  fl.style.background = `radial-gradient(circle, #fff, ${NR.color}88 40%, transparent 75%)`;
  fl.classList.add("go");
  P.burst(innerWidth / 2, innerHeight / 2, 160, colors, { speed: 14 });
  Sound.whoosh();
  el.querySelector(".fa-ring").remove();
  orb.classList.add("pop");

  if (res.error) {
    Sound.error(); toast(res.error, true);
    await sleep(500);
    P.stop(); el.remove(); document.body.style.overflow = "";
    FORGE.busy = false; renderContract();
    return;
  }

  // aktualizacja danych
  removeItems(res.consumed);
  S.items = [res.item, ...S.items];
  applyState(res.state);
  FORGE.slots = [];

  // faza 2: bęben z możliwymi wynikami
  const candidates = crateOf(res.crate).people.filter(id => person(id).rarity === next && person(id).forge);
  if (!candidates.includes(res.item.person)) candidates.push(res.item.person);
  const reel = el.querySelector(".fa-reel");
  reel.hidden = false;
  const strip = reel.querySelector(".fa-strip");
  const MW = Math.min(130, innerWidth / 6), GAP = 8, N = 40, WIN = 33;
  reel.style.setProperty("--mw", MW + "px");
  reel.style.setProperty("--gap", GAP + "px");
  reel.style.setProperty("--rh", Math.round(MW * 1.05 + 45) + "px");
  const ids = Array.from({ length: N }, () => candidates[Math.floor(Math.random() * candidates.length)]);
  ids[WIN] = res.item.person;
  strip.innerHTML = ids.map((id, k) => miniHTML(id, k === WIN)).join("");
  await sleep(50);
  const step = MW + GAP, center = reel.clientWidth / 2;
  const to = -(WIN * step + MW / 2 + rand(-0.4, 0.4) * MW) + center;
  const D2 = fast ? 900 : 3200;
  const t1 = performance.now();
  let lastIdx = -1;
  await new Promise(done => {
    const frame = now => {
      const t = Math.min(1, (now - t1) / D2);
      const x = to * (1 - Math.pow(1 - t, 4));
      strip.style.transform = `translate3d(${x}px, -50%, 0)`;
      const idx = Math.floor((center - x) / step);
      if (idx !== lastIdx) { if (lastIdx >= 0) Sound.tick(1 - t); lastIdx = idx; }
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  reel.classList.add("landed");
  reel.style.setProperty("--rc", NR.color);
  await sleep(fast ? 200 : 500);

  // faza 3: odsłonięcie
  if (rarityIdx(next) >= rarityIdx("gold")) await epicReveal(res.item, { fast });
  else {
    Sound.reveal(next);
    P.burst(innerWidth / 2, innerHeight / 2, 120, colors, { speed: 12 });
    if (isSpecial(res.item.variant)) confetti(["#9ff6ff", "#ff9ff3", "#fff"], 80);
  }
  announceFirsts([res.item]);
  reel.hidden = true;
  const box = el.querySelector(".fa-result");
  box.hidden = false;
  const canAgain = forgeItems().filter(i => person(i.person).rarity === FORGE.tier).length >= S.cfg.contractSize[FORGE.tier];
  box.innerHTML = `
    <div class="fa-result-card">${cardHTML(res.item.person, res.item.variant)}</div>
    <div class="fa-result-name">${esc(person(res.item.person).name)}${isSpecial(res.item.variant) ? ` <span class="holo-txt">✨ ${variantName(res.item.variant)}</span>` : ""}</div>
    <div class="fa-result-btns">
      <button class="btn sell" data-act="sell">💰 Sprzedaj ${fmt(res.item.value)}</button>
      ${canAgain ? '<button class="btn primary" data-act="again">🔁 Kolejny kontrakt</button>' : ""}
      <button class="btn" data-act="ok">✔ Odbierz</button>
    </div>`;
  box.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "sell") {
      if (rarityIdx(next) >= rarityIdx("gold") && !confirm(`Na pewno sprzedać ${person(res.item.person).name}?`)) return;
      try { await sellIds([res.item.id]); } catch (err) { toast(err.message, true); return; }
    }
    P.stop(); el.remove(); document.body.style.overflow = "";
    FORGE.busy = false;
    if (act === "again") { contractAutoFill(); }
    renderForge();
  });
}

// ================================================================ ULEPSZACZ

function upgStake() {
  return S.items.filter(i => FORGE.upg.inputs.has(i.id)).reduce((a, i) => a + i.value, 0);
}

function upgChance(stake, goal) {
  if (!stake || !goal || goal <= stake) return 0;
  return Math.min(S.cfg.upgradeMax, stake / goal * S.cfg.upgradeEdge);
}

function allTargets() {
  const out = [];
  // tylko karty ze skrzynek, które są teraz w sklepie (bez tajnych)
  Object.values(S.cfg.people).filter(p => p.rarity !== "secret" && p.forge).forEach(p => {
    // wariantów wyjątkowych nie da się ulepszyć - tylko ze skrzynek; wyłączonych (strona /variants) też nie
    S.cfg.variantOrder.filter(v => !isExclusive(v) && (v === "normal" || variantOn(v)))
      .forEach(v => out.push({ key: `${p.id}|${v}`, person: p.id, variant: v, value: cardValue(p.id, v) }));
  });
  return out.sort((a, b) => a.value - b.value || person(a.person).name.localeCompare(person(b.person).name, "pl"));
}

function renderUpgrader() {
  const u = FORGE.upg;
  const owned = new Set(forgeItems().map(i => i.id));
  [...u.inputs].forEach(id => { if (!owned.has(id)) u.inputs.delete(id); });
  const stake = upgStake();
  const everything = allTargets();
  const targets = everything.filter(t => t.value > stake && (u.variant === "all" || t.variant === u.variant) &&
    cardMatches(t, u.search));
  let target = u.target ? everything.find(t => t.key === u.target) : null;
  if (target && target.value <= stake) { target = null; u.target = null; }
  const chance = target ? upgChance(stake, target.value) : 0;
  // wybrane karty zostają na liście także wtedy, gdy nie pasują do wyszukiwania (żeby dało się je odznaczyć)
  const mine = sortCards(forgeItems().filter(i => u.inputs.has(i.id) || cardMatches(i, u.qMine)), u.sortMine);

  keepScroll($("#forgeBody"), () => $("#forgeBody").innerHTML = `
  <div class="upg-cols">
    <div class="panel upg-side">
      <h3>Twoje karty <small class="muted">(max ${S.cfg.upgradeMaxItems})</small></h3>
      <div class="upg-sum">Wkład: <b>${fmt(stake)}</b> · ${u.inputs.size} ${plural(u.inputs.size, "karta", "karty", "kart")}
        ${u.inputs.size ? '<button class="btn tiny" id="uClear">Wyczyść</button>' : ""}</div>
      <div class="upg-filters"><input type="text" data-fq="mine" placeholder="🔍 Szukaj…" value="${esc(u.qMine)}">${sortSelectHTML(u.sortMine, 'data-fsort="mine"')}</div>
      <div class="pick-grid" data-keep="mine">${mine.length ? mine.slice(0, PICK_LIMIT).map(i => pickHTML(i, { sel: u.inputs.has(i.id) })).join("")
        : `<div class="empty">${u.qMine.trim() ? "Żadna karta nie pasuje do wyszukiwania." : "Nie masz kart."}</div>`}</div>
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
          <div class="upg-mult">${target && stake ? "×" + (target.value / stake).toLocaleString("pl-PL", { maximumFractionDigits: 2 }) : "—"}</div>
        </div>
        <div class="upg-result" id="upgResult" hidden></div>
      </div>
      <div class="upg-pair">
        <div class="upg-stake"><b>${fmt(stake)}</b><small>${u.inputs.size} ${plural(u.inputs.size, "karta", "karty", "kart")}</small></div>
        <div class="upg-arrow">➜</div>
        <div class="upg-target">${target ? pickHTML({ id: 0, person: target.person, variant: target.variant, value: target.value }) : '<div class="upg-q">?</div>'}</div>
      </div>
      <div class="upg-quick">${[1.5, 2, 3, 5, 10, 20].map(m => `<button class="chip" data-mult="${m}"${stake ? "" : " disabled"}>×${String(m).replace(".", ",")}</button>`).join("")}</div>
      <button class="big-btn" id="upgBtn"${target && stake && chance > 0 ? "" : " disabled"}>⬆️ ULEPSZ${chance ? ` (${pct(chance)})` : ""}</button>
    </div>

    <div class="panel upg-side">
      <h3>Cel</h3>
      <div class="upg-filters">
        <input type="text" id="uSearch" placeholder="🔍 Szukaj…" value="${esc(u.search)}">
        <select id="uVariant">${[["all", "Wszystkie"], ...S.cfg.variantOrder.filter(v => !isExclusive(v) && (v === "normal" || variantOn(v))).map(v => [v, variantName(v)])].map(([v, n]) =>
          `<option value="${v}"${u.variant === v ? " selected" : ""}>${n}</option>`).join("")}</select>
        ${sortSelectHTML(u.sortTarget, 'data-fsort="target"', UNIQUE_SORTS)}
      </div>
      <div class="pick-grid" data-keep="target">${targets.length ? sortCards(targets, u.sortTarget).slice(0, PICK_LIMIT).map(t => pickHTML({ id: t.key, person: t.person, variant: t.variant, value: t.value },
        { sel: t.key === u.target, extra: stake ? `<span class="pc">${pct(upgChance(stake, t.value))}</span>` : "" })).join("")
        : '<div class="empty">Brak celów — twój wkład jest już wart więcej niż każda karta!</div>'}</div>
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
  $("#upgPointer").style.transform = `rotate(${FORGE.upg.angle}deg)`;
}

function upgPickMult(m) {
  const stake = upgStake();
  if (!stake) return;
  const all = allTargets().filter(t => t.value >= stake * m && t.value > stake && (FORGE.upg.variant === "all" || t.variant === FORGE.upg.variant));
  if (!all.length) { toast("Brak tak drogiego celu", true); return; }
  const v = all[0].value;
  const same = all.filter(t => t.value === v);
  FORGE.upg.target = same[Math.floor(Math.random() * same.length)].key;
  Sound.click();
  renderUpgrader();
}

async function runUpgrade() {
  const u = FORGE.upg;
  if (FORGE.busy || !u.target || !u.inputs.size) return;
  const target = allTargets().find(t => t.key === u.target);
  const ids = [...u.inputs];
  const stake = upgStake();
  if (ids.some(id => rarityIdx(person(S.items.find(i => i.id === id).person).rarity) >= rarityIdx("gold")) &&
      !confirm(`Stawiasz karty legendarne (${fmt(stake)}). Na pewno?`)) return;
  FORGE.busy = true;
  Sound.unlock();
  $$("#forgeBody button, #forgeBody input, #forgeBody select").forEach(b => b.disabled = true);
  let res;
  try {
    res = await api("/api/upgrade", { ids, target: target.person, variant: target.variant });
    if (res.discovered?.length) await refreshConfig();
  } catch (e) { FORGE.busy = false; Sound.error(); toast(e.message, true); renderUpgrader(); return; }

  const wheel = $("#upgWheel");
  wheel.classList.add("spinning");
  const chance = res.chance;
  drawUpgWheel(chance);
  const finalAngle = upgArcStart(chance) + res.roll * 360;
  const start = u.angle;
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
  u.angle = end;
  wheel.classList.remove("spinning");

  removeItems(res.consumed);
  u.inputs.clear();
  if (res.win) S.items = [res.item, ...S.items];
  applyState(res.state);

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
    announceFirsts([res.item]);
    box.innerHTML = `<div class="upg-res-label win">WYGRANA!</div>${cardHTML(res.item.person, res.item.variant)}<div class="muted small">kliknij kartę, aby ją obejrzeć</div>`;
  } else {
    wheel.classList.add("lost");
    Sound.fail();
    fx().burst(cx, cy, 90, ["#ff5468", "#ff9a9a", "#552"], { speed: 9, g: 0.3 });
    $$("#forgeBody .upg-side:first-child .pick.sel").forEach(el => {
      el.style.setProperty("--dx", rand(-120, 120) + "px");
      el.style.setProperty("--dr", rand(-60, 60) + "deg");
      el.classList.add("shatter");
    });
    box.innerHTML = `<div class="upg-res-label lose">PRZEGRANA</div><div class="upg-lost">💥 ${fmt(stake)}</div>`;
  }
  box.hidden = false;
  // wynik znika sam (albo po kliknięciu) i ulepszacz jest od razu gotowy do kolejnej próby - cel zostaje wybrany.
  // Odblokowujemy też wtedy, gdy gracz w międzyczasie przeszedł do innej zakładki (wcześniej trzeba było odświeżyć stronę).
  const finish = () => {
    if (!FORGE.busy) return;
    FORGE.busy = false;
    if (FORGE.mode === "upgrade" && currentView() === "forge") renderUpgrader();
  };
  setTimeout(finish, res.win ? 2600 : 1600);
  box.addEventListener("click", e => { if (!e.target.closest(".card")) finish(); });
}

// ================================================================ ZDARZENIA

function bindForge() {
  $("#forgeSeg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || FORGE.busy) return;
    FORGE.mode = b.dataset.mode; Sound.click(); renderForge();
  });
  $("#forgeBody").addEventListener("change", e => {
    const opt = e.target.closest("[data-bulk-opt]");
    if (opt) { FORGE.bulk[opt.dataset.bulkOpt] = opt.checked; renderContract(); }
  });
  $("#forgeBody").addEventListener("click", e => {
    const t = e.target;
    if (FORGE.busy) {
      // podgląd wygranej karty w ulepszaczu
      const c = t.closest("#upgResult .card");
      if (c) openViewer(c.dataset.pid, c.dataset.variant);
      return;
    }
    if (FORGE.mode === "contract") {
      const tierBtn = t.closest("[data-tier]");
      if (tierBtn) { FORGE.tier = tierBtn.dataset.tier; FORGE.slots = []; Sound.click(); resetKeep("contract"); return renderContract(); }
      const pick = t.closest(".pick");
      if (pick) {
        if (FORGE.slots.length >= S.cfg.contractSize[FORGE.tier]) { Sound.error(); return toast("Kontrakt jest pełny", true); }
        FORGE.slots.push(+pick.dataset.id); Sound.click(); return renderContract();
      }
      const slot = t.closest(".slot.filled");
      if (slot) { FORGE.slots = FORGE.slots.filter(id => id !== +slot.dataset.id); Sound.click(); return renderContract(); }
      if (t.closest("#cAuto")) return contractAutoFill();
      if (t.closest("#cClear")) { FORGE.slots = []; Sound.click(); return renderContract(); }
      if (t.closest("#cSign")) return runContract();
      if (t.closest("#cBulk")) return runBulkContracts();
      const b = t.closest("[data-bulk]");
      if (b) {
        const plan = bulkPlan(FORGE.tier);
        FORGE.bulk.n = b.dataset.bulk === "max" ? plan.max : Math.max(1, Math.min(plan.max, plan.n + (b.dataset.bulk === "+" ? 1 : -1)));
        Sound.click(); return renderContract();
      }
    } else {
      const u = FORGE.upg;
      const pick = t.closest(".pick");
      if (pick && pick.closest(".upg-side")) {
        const side = pick.closest(".upg-side");
        if (side === side.parentElement.firstElementChild) {
          const id = +pick.dataset.id;
          if (u.inputs.has(id)) u.inputs.delete(id);
          else if (u.inputs.size >= S.cfg.upgradeMaxItems) { Sound.error(); return toast(`Maksymalnie ${S.cfg.upgradeMaxItems} kart`, true); }
          else u.inputs.add(id);
        } else {
          u.target = pick.dataset.id;
        }
        Sound.click();
        return renderUpgrader();
      }
      const mult = t.closest("[data-mult]");
      if (mult) return upgPickMult(+mult.dataset.mult);
      if (t.closest("#uClear")) { u.inputs.clear(); return renderUpgrader(); }
      if (t.closest("#upgBtn")) return runUpgrade();
    }
  });
  $("#forgeBody").addEventListener("input", e => {
    if (e.target.id === "uSearch") {
      FORGE.upg.search = e.target.value;
      const pos = e.target.selectionStart;
      resetKeep("target");
      renderUpgrader();
      const inp = $("#uSearch"); inp.focus(); inp.setSelectionRange(pos, pos);
    }
    const fq = e.target.dataset.fq;
    if (fq) {
      const pos = e.target.selectionStart;
      resetKeep(fq);
      if (fq === "contract") { FORGE.q = e.target.value; renderContract(); }
      else { FORGE.upg.qMine = e.target.value; renderUpgrader(); }
      const inp = $(`[data-fq=${fq}]`); inp.focus(); inp.setSelectionRange(pos, pos);
    }
  });
  $("#forgeBody").addEventListener("change", e => {
    if (e.target.id === "uVariant") { FORGE.upg.variant = e.target.value; resetKeep("target"); renderUpgrader(); }
    const fs = e.target.dataset.fsort;
    if (fs) resetKeep(fs);
    if (fs === "contract") { FORGE.sort = e.target.value; renderContract(); }
    if (fs === "mine") { FORGE.upg.sortMine = e.target.value; renderUpgrader(); }
    if (fs === "target") { FORGE.upg.sortTarget = e.target.value; renderUpgrader(); }
  });
}
