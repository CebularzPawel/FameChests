"use strict";
// Kuźnia: kontrakt (N kart -> 1 wyższej rzadkości). Ulepszacz jest w Kasynie (upgrade.js).

const FORGE = {
  tier: "green",
  slots: [],
  busy: false,
  sort: "valueAsc",       // sortowanie kart do kontraktu
  q: "",                  // wyszukiwanie kart do kontraktu
  bulk: { n: 1, dupes: true, keepSpecial: true },   // wiele kontraktów naraz
};
const MAX_BULK_CONTRACTS = 50;  // tyle przyjmie serwer w jednym zapytaniu
const PICK_LIMIT = 300;
// ulubione karty (⭐) i karty specjalne nie trafiają do kuźni ani do ulepszacza
const forgeItems = () => S.items.filter(i => !i.fav && !isSpecialCard(i.person));
const PICK_TAGS = { bw: "B&W", reverse: "REV", bronze: "BRNZ", silver: "SILV", platinum: "PLAT", steel: "⚙️", sapphire: "💙", blackdiamond: "🖤", holo: "HOLO", pearl: "🦪", gold: "GOLD", vintage: "📷", marble: "🏛️", slime: "🟢", matte: "MAT", racing: "🏁", bismuth: "🌈", digital: "💻", cyber: "🌃", fade: "🎨", wanted: "🤠", artdeco: "DÉCO", cheese: "🧀", aero: "🫧", honey: "🍯", chinese: "🏮", moro: "🪖", beer: "🍺", neon: "💡", electric: "⚡", synthwave: "📼", motor: "🏎️", toxic: "☢️", pixel: "👾", popart: "💥", glass: "⛪", thermal: "🌡️", blueprint: "📐", glitch: "📺", mosaic: "🧱", noir: "🕵️", chocolate: "🍫", candy: "🍭", hollywood: "🎬", cobalt: "🔷", banana: "🍌", uranium: "☢️", mercury: "☿", californium: "⚛️", files: "🗂️", copper: "🟠", reflective: "🦺", flag: "🏳️", halloween: "🎃", lantern: "🏮", devil: "😈", joker: "🃏", jeans: "👖", clear: "🫧", sketch: "✒️", emerald: "💚", amethyst: "💜", ruby: "❤️", mlg: "🎯", royal: "👑", diamond: "💎", galaxy: "🌌", negative: "◐", rzulty: "💛" };

function pickHTML(item, { sel = false, extra = "" } = {}) {
  const p = person(item.person);
  const v = item.variant || "normal";
  const img = p.rarity === "secret" && p.masked ? `/img/${p.id}` : imgUrl(p.id, v, true);
  return `<div class="pick r-${p.rarity} ${vClass(v)}${sel ? " sel" : ""}" data-id="${item.id}" style="--rc:${S.cfg.rarities[p.rarity].color}">
    <img src="${img}" alt="" loading="lazy" draggable="false">
    ${isSpecial(v) ? `<span class="ph ${vtClass(v)}">${isCombo(v) ? PICK_TAGS[variantParts(v)[0]] : ""}${PICK_TAGS[baseVariant(v)] ?? esc((cvOf(baseVariant(v))?.tag || "✨").slice(0, 6))}</span>` : ""}
    <span class="pn">${esc(p.name)}</span>
    <span class="pv">${fmt(item.value)}</span>${extra}
  </div>`;
}

function pct(x) { return (x * 100).toLocaleString("pl-PL", { maximumFractionDigits: x < 0.01 ? 2 : 1 }) + "%"; }

function renderForge() {
  $("#forgeInfo").innerHTML = `📜 <b>Kontrakt:</b> połącz kilka kart tej samej rzadkości w jedną kartę <b>wyższej</b> rzadkości. Karty w specjalnych wariantach zwiększają szansę na wariant.
    <span class="muted">Ulepszacz jest teraz w Kasynie.</span>`;
  renderContract();
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

// ================================================================ ZDARZENIA

function bindForge() {
  $("#forgeBody").addEventListener("change", e => {
    const opt = e.target.closest("[data-bulk-opt]");
    if (opt) { FORGE.bulk[opt.dataset.bulkOpt] = opt.checked; renderContract(); }
  });
  $("#forgeBody").addEventListener("click", e => {
    const t = e.target;
    if (FORGE.busy) return;
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
  });
  $("#forgeBody").addEventListener("input", e => {
    const fq = e.target.dataset.fq;
    if (fq === "contract") {
      const pos = e.target.selectionStart;
      resetKeep(fq);
      FORGE.q = e.target.value; renderContract();
      const inp = $(`[data-fq=${fq}]`); inp.focus(); inp.setSelectionRange(pos, pos);
    }
  });
  $("#forgeBody").addEventListener("change", e => {
    const fs = e.target.dataset.fsort;
    if (fs === "contract") { resetKeep(fs); FORGE.sort = e.target.value; renderContract(); }
  });
}
