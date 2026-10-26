"use strict";
// HALL OF FAME (podstrona Ekwipunku, /inventory/hall-of-fame): kto pierwszy zdobył każdą kartę i każdy jej wariant,
// kiedy (i skąd: skrzynka / kontrakt / ulepszacz) oraz ile takich kart w ogóle wypadło. Dane: /api/halloffame.

const HOF = { data: null, at: 0, crate: "all", q: "", show: "all", sort: "number" };
const HOF_SOURCES = { drop: "📦 ze skrzynki", contract: "📜 z kontraktu", upgrade: "⬆️ z ulepszacza", joker: "🎰 z kasyna", link: "🔗 z linku", achievement: "🏆 z osiągnięcia" };

// po zdobyciu karty: "jesteś pierwszy w grze!" (serwer oznacza takie karty polem first)
function announceFirsts(items) {
  const firsts = (items || []).filter(i => i && i.first);
  if (!firsts.length) return;
  HOF.at = 0;  // Hall of Fame odświeży się przy następnym wejściu
  const it = firsts[0], p = person(it.person);
  const name = (p.masked ? "Tajna karta" : p.name) + (isSpecial(it.variant) ? ` (${variantName(it.variant)})` : "");
  toast(`🥇 Pierwsza taka karta w grze: ${name}! Trafiasz do Hall of Fame${firsts.length > 1 ? ` (i jeszcze ${firsts.length - 1})` : ""}`);
  Sound.gold();
}

function hofDate(t) { return new Date(t * 1000).toLocaleDateString("pl-PL"); }
function hofUser(id) {
  if (!id) return '<span class="muted">—</span>';   // zdobyli ją tylko gracze ukryci w rankingu
  const u = HOF.data.users[id];
  return u ? userLink(u) : '<span class="muted">usunięty gracz</span>';
}
function hofThumb(pid) {
  const p = person(pid);
  return `<div class="hof-thumb${p.masked ? " masked" : ""}" ${p.masked ? "" : `data-hof-view="${pid}"`} style="--rc:${S.cfg.rarities[p.rarity].color}">
    <img src="${p.masked ? `/img/${pid}` : imgUrl(pid, null, true)}" alt="" loading="lazy"></div>`;
}

async function renderHallOfFame() {
  const box = $("#hofBody");
  if (!HOF.data || Date.now() - HOF.at > 30000) {
    if (!HOF.data) box.innerHTML = '<div class="empty">Wczytuję Hall of Fame…</div>';
    try { HOF.data = await api("/api/halloffame"); HOF.at = Date.now(); }
    catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (currentView() !== "inventory" || S.inv.mode !== "hof") return;
  }
  const rows = HOF.data.rows;
  const known = rows.filter(r => S.cfg.people[r.p]);
  const recent = known.slice().sort((a, b) => b.t - a.t).slice(0, 8);
  const cards = new Set(known.map(r => r.p)).size, total = Object.keys(S.cfg.people).length;
  box.innerHTML = `
    <div class="panel hof-head">
      <h2>🏆 Hall of Fame</h2>
      <p class="muted">Kto pierwszy zdobył każdą kartę — i każdy jej wariant — kiedy to było i ile takich kart wypadło do dziś.
        Zdobyte karty: <b>${cards}/${total}</b> · warianty: <b>${known.length}</b> · wszystkich kart w grze: <b>${known.reduce((a, r) => a + r.n, 0).toLocaleString("pl-PL")}</b></p>
      ${recent.length ? `<h3 class="hof-sub">✨ Najnowsze odkrycia</h3>
      <div class="hof-recent">${recent.map(r => {
        const p = person(r.p);
        return `<div class="hof-recent-item">${hofThumb(r.p)}<div class="hof-ri-text">
          <b>${esc(p.masked ? "???" : p.name)}</b>${isSpecial(r.v) ? ` <span class="hof-vtag ${vtClass(r.v)}">${esc(variantName(r.v))}</span>` : ""}
          <div class="small">🥇 ${hofUser(r.u)}</div><div class="muted small">${timeAgo(r.t)}</div></div></div>`;
      }).join("")}</div>` : ""}
    </div>
    <div class="inv-toolbar hof-toolbar">
      <div class="seg" id="hofCrates">${[["all", "Wszystkie"], ...crateList().map(c => [c.id, `${c.emoji} ${c.short}`])].map(([id, n]) =>
        `<button data-hcrate="${id}" class="${HOF.crate === id ? "active" : ""}">${esc(n)}</button>`).join("")}</div>
      <input type="search" id="hofSearch" placeholder="Szukaj karty…" value="${esc(HOF.q)}">
      <select id="hofShow">${[["all", "Wszystkie karty"], ["got", "Już zdobyte"], ["none", "Jeszcze niezdobyte"]].map(([v, n]) =>
        `<option value="${v}"${HOF.show === v ? " selected" : ""}>${n}</option>`).join("")}</select>
      <select id="hofSort">${[["number", "Kolejność w skrzynce"], ["rarity", "Najrzadsze"], ["most", "Najwięcej zdobytych"], ["least", "Najmniej zdobytych"], ["recent", "Najnowsze odkrycia"]].map(([v, n]) =>
        `<option value="${v}"${HOF.sort === v ? " selected" : ""}>${n}</option>`).join("")}</select>
    </div>
    <div class="hof-grid" id="hofList"></div>`;
  renderHofList();
}

function renderHofList() {
  const list = $("#hofList");
  if (!list || !HOF.data) return;
  const by = {};
  HOF.data.rows.forEach(r => (by[r.p] ||= []).push(r));
  const q = HOF.q.trim().toLowerCase();
  let ids = (HOF.crate === "all" ? crateList().flatMap(c => c.people) : crateOf(HOF.crate).people).filter((id, i, a) => a.indexOf(id) === i);
  ids = ids.filter(id => {
    const p = person(id), got = !!by[id];
    if (HOF.show === "got" && !got) return false;
    if (HOF.show === "none" && got) return false;
    return !q || (!p.masked && p.name.toLowerCase().includes(q));
  });
  const total = id => (by[id] || []).reduce((a, r) => a + r.n, 0);
  const latest = id => Math.max(0, ...(by[id] || []).map(r => r.t));
  const sorts = {
    number: () => 0,
    rarity: (a, b) => rarityIdx(person(b).rarity) - rarityIdx(person(a).rarity),
    most: (a, b) => total(b) - total(a),
    least: (a, b) => total(a) - total(b),
    recent: (a, b) => latest(b) - latest(a),
  };
  ids.sort(sorts[HOF.sort] || sorts.number);
  list.innerHTML = ids.length ? ids.map(id => {
    const p = person(id), R = S.cfg.rarities[p.rarity], crate = crateOf(p.crate);
    const vars = (by[id] || []).sort((a, b) => varRank(a.v) - varRank(b.v));
    return `<div class="hof-card${vars.length ? "" : " none"}" style="--rc:${R.color}">
      ${hofThumb(id)}
      <div class="hof-info">
        <div class="hof-name">${esc(p.masked ? "???" : p.name)} <small class="muted">${esc(crate.code)} ${String(p.number).padStart(3, "0")}</small></div>
        <div class="hof-meta"><span style="color:${R.color}">${R.name}</span>${vars.length ? ` · zdobyto łącznie <b>${total(id).toLocaleString("pl-PL")}×</b>` : ""}</div>
        ${vars.length ? `<div class="hof-vars">${vars.map(r => `
          <div class="hof-var" title="${esc(HOF_SOURCES[r.s] || "")} · ${new Date(r.t * 1000).toLocaleString("pl-PL")}">
            <span class="hof-vname"><span class="vdot ${vtClass(r.v)}"></span>${esc(variantName(r.v))}</span>
            <span class="hof-first">🥇 ${hofUser(r.u)}</span>
            <span class="hof-when muted">${hofDate(r.t)}</span>
            <span class="hof-n">×${r.n.toLocaleString("pl-PL")}</span>
          </div>`).join("")}</div>` : '<div class="muted small hof-nobody">Jeszcze nikt jej nie zdobył — możesz być pierwszy!</div>'}
      </div>
    </div>`;
  }).join("") : '<div class="empty">Brak kart dla tych filtrów.</div>';
}

function bindHallOfFame() {
  $("#invMode").addEventListener("click", e => {
    const b = e.target.closest("[data-mode]");
    if (!b || S.inv.mode === b.dataset.mode) return;
    S.inv.mode = b.dataset.mode;
    Sound.click();
    switchView("inventory");
  });
  const body = $("#hofBody");
  body.addEventListener("click", e => {
    const c = e.target.closest("[data-hcrate]");
    if (c) { HOF.crate = c.dataset.hcrate; Sound.click(); $$("#hofCrates button").forEach(b => b.classList.toggle("active", b === c)); return renderHofList(); }
    const v = e.target.closest("[data-hof-view]");
    if (v) openViewer(v.dataset.hofView, "normal");
  });
  body.addEventListener("input", e => { if (e.target.id === "hofSearch") { HOF.q = e.target.value; renderHofList(); } });
  body.addEventListener("change", e => {
    if (e.target.id === "hofShow") { HOF.show = e.target.value; renderHofList(); }
    if (e.target.id === "hofSort") { HOF.sort = e.target.value; renderHofList(); }
  });
}
