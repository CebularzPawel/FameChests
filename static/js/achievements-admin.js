"use strict";
// Panel admina: osiągnięcia (lista + edytor w panelu "🏆 Osiągnięcia" w admin.html). Zapis: /api/admin/achievements.
// Osiągnięcie ma 1-2 warunki (oba muszą być spełnione) i dowolnie wiele nagród; warunki i nagrody opisuje achievements.py.

const AE = { list: [], meta: null, cur: null };
const aeOpt = (list, value, empty) => (empty != null ? `<option value="">${esc(empty)}</option>` : "") +
  list.map(o => `<option value="${esc(o.id)}"${o.id === value ? " selected" : ""}>${esc(o.name)}</option>`).join("");
const aePeople = () => AE.meta.people.map(p => ({ id: p.id, name: `${p.name} (${AE.meta.rarities.find(r => r.id === p.rarity)?.name || p.rarity})` }));
const aeGames = () => Object.entries(AE.meta.games).map(([id, name]) => ({ id, name }));

async function loadAchievements() {
  let d;
  try { d = await api("/api/admin/achievements"); } catch (e) { return toast(e.message, true); }
  AE.list = d.list; AE.meta = d.meta;
  renderAchList();
}

function aeCritLine(c) {
  const m = AE.meta, person = id => m.people.find(p => p.id === id)?.name || (id ? "?" : "—");
  const n = c.count > 1 ? `${c.count}× ` : "";
  const bits = [m.types[c.type]];
  if (c.type === "cards") bits.push(n, c.person ? person(c.person) : "", c.variant ? `wariant ${m.variants.find(v => v.id === c.variant)?.name || c.variant}` : "",
    c.rarity ? m.rarities.find(r => r.id === c.rarity)?.name : "", c.crate ? m.crates.find(x => x.id === c.crate)?.name : "", c.unique ? "(różne)" : "");
  if (c.type === "open") bits.push(n, c.crate ? m.crates.find(x => x.id === c.crate)?.name : "dowolne");
  if (c.type === "casino_plays") bits.push(n, m.games[c.game] || "dowolna gra");
  if (c.type === "casino_win") bits.push(n, m.games[c.game] || "dowolna gra", c.person ? `kartą ${person(c.person)}` : "", c.variant ? `wariant ${c.variant}` : "");
  if (c.type === "drop_together") bits.push((c.persons || []).map(person).join(" + "));
  if (c.type === "arena") bits.push(c.mode === "finisher" ? `ostatni cios: ${person(c.person)}` : `${n}wygrane walki`);
  return bits.filter(Boolean).join(" ");
}

function renderAchList() {
  $("#achList").innerHTML = AE.list.map(a => `
    <div class="ach-row${a.enabled === false ? " off" : ""}" data-id="${esc(a.id)}">
      <span class="ach-ic">${esc(a.icon || "🏆")}</span>
      <div class="ach-info"><b>${esc(a.name)}</b>${a.hidden ? ' <span class="chip">ukryte</span>' : ""}${a.enabled === false ? ' <span class="chip">wyłączone</span>' : ""}
        <div class="muted small">${a.criteria.map(aeCritLine).join("  +  ")}</div>
        <div class="muted small">🎁 ${a.rewards.map(r => r.type === "money" ? `${r.amount} gr` : r.type === "chest" ? `${r.count}× ${AE.meta.chests.concat(AE.meta.crates).find(x => x.id === r.kind)?.name || r.kind}` :
          `${r.count}× ${AE.meta.people.find(p => p.id === r.person)?.name || "?"}`).join(", ") || "brak nagród"}</div></div>
      <span class="muted small">zdobyło: ${a.earned}</span>
      <button class="btn" data-ae="edit">✏️ Edytuj</button>
      <button class="btn danger" data-ae="del">🗑️</button>
    </div>`).join("") || '<p class="muted">Brak osiągnięć.</p>';
}

const aeNew = () => ({ id: "", name: "", desc: "", icon: "🏆", hidden: false, enabled: true,
  criteria: [{ type: "cards", count: 1 }], rewards: [{ type: "money", amount: 10000 }] });

// pola warunku zależnie od rodzaju
function aeCritFields(c, i) {
  const P = (k, label, html) => `<label>${label}${html}</label>`, at = k => `data-ae-path="criteria.${i}.${k}"`;
  const people = (k, label, empty = "— dowolna —") => P(label, "", `<select ${at(k)}>${aeOpt(aePeople(), c[k], empty)}</select>`);
  const variants = (k, label) => `<label>${label}<select ${at(k)}>${aeOpt(AE.meta.variants, c[k], "— dowolny —")}</select></label>`;
  const games = `<label>Gra<select ${at("game")}>${aeOpt(aeGames(), c.game, "— dowolna —")}</select></label>`;
  const count = `<label>Ile razy / ile sztuk<input type="number" min="1" ${at("count")} value="${c.count || 1}"></label>`;
  switch (c.type) {
    case "cards": return people("person", "Karta") + variants("variant", "Wariant") +
      `<label>Rzadkość<select ${at("rarity")}>${aeOpt(AE.meta.rarities, c.rarity, "— dowolna —")}</select></label>
       <label>Skrzynka<select ${at("crate")}>${aeOpt(AE.meta.crates, c.crate, "— dowolna —")}</select></label>` + count +
      `<label class="chk"><input type="checkbox" ${at("unique")} ${c.unique ? "checked" : ""}> liczą się różne karty z klasera (bez duplikatów)</label>
       <p class="muted small wide">Karta i wariant razem = konkretna karta w konkretnym wariancie. Rzadkość i skrzynka razem = karty tej rzadkości z tej skrzynki.</p>`;
    case "open": return `<label>Skrzynka<select ${at("crate")}>${aeOpt(AE.meta.crates, c.crate, "— dowolna —")}</select></label>` + count;
    case "casino_plays": return games + count;
    case "casino_win": return games + people("person", "Wygrana kartą (postawioną)") + variants("variant", "Wariant postawionej karty") + count;
    case "drop_together": return [0, 1, 2, 3].map(j => `<label>Karta ${j + 1}${j < 2 ? "" : " (opcjonalnie)"}<select data-ae-path="criteria.${i}.persons.${j}">${aeOpt(aePeople(), (c.persons || [])[j], "— brak —")}</select></label>`).join("") +
      '<p class="muted small wide">Wszystkie te karty muszą wypaść przy jednym otwieraniu kilku skrzynek naraz.</p>';
    case "arena": return `<label>Co<select ${at("mode")}><option value="win"${c.mode !== "finisher" ? " selected" : ""}>Wygrane walki</option>
        <option value="finisher"${c.mode === "finisher" ? " selected" : ""}>Wygrana, a ostatni cios zadała karta…</option></select></label>` +
      (c.mode === "finisher" ? people("person", "Karta zadająca ostatni cios", "— dowolna —") : "") + count;
  }
  return "";
}

function aeRewardFields(r, i) {
  const at = k => `data-ae-path="rewards.${i}.${k}"`;
  if (r.type === "money") return `<label>Kwota (gr)<input type="number" min="1" ${at("amount")} value="${r.amount || ""}"></label>`;
  if (r.type === "chest") return `<label>Skrzynka<select ${at("kind")}>${aeOpt(AE.meta.crates.concat(AE.meta.chests), r.kind)}</select></label>
    <label>Ile<input type="number" min="1" ${at("count")} value="${r.count || 1}"></label>`;
  return `<label>Karta<select ${at("person")}>${aeOpt(aePeople(), r.person)}</select></label>
    <label>Wariant<select ${at("variant")}>${aeOpt(AE.meta.variants, r.variant || "normal")}</select></label>
    <label>Ile<input type="number" min="1" ${at("count")} value="${r.count || 1}"></label>`;
}

function renderAchForm() {
  const a = AE.cur, f = $("#achForm");
  f.hidden = !a;
  if (!a) return;
  const typeOpts = Object.entries(AE.meta.types).map(([id, name]) => ({ id, name }));
  const rtOpts = Object.entries(AE.meta.rewardTypes).map(([id, name]) => ({ id, name }));
  f.innerHTML = `
    <h4>${a.id ? "Edycja osiągnięcia" : "Nowe osiągnięcie"}</h4>
    <div class="a-grid">
      <label>Nazwa<input type="text" data-ae-path="name" maxlength="60" value="${esc(a.name)}"></label>
      <label>Ikona (emoji)<input type="text" data-ae-path="icon" maxlength="8" value="${esc(a.icon)}"></label>
      <label class="wide">Opis dla gracza <small class="muted">(pusty: opis zostanie ułożony z warunków)</small>
        <textarea data-ae-path="desc" rows="2" maxlength="300">${esc(a.desc)}</textarea></label>
      <label class="chk"><input type="checkbox" data-ae-path="hidden" ${a.hidden ? "checked" : ""}> 🕵️ Ukryte (gracz widzi „???”, dopóki go nie zdobędzie)</label>
      <label class="chk"><input type="checkbox" data-ae-path="enabled" ${a.enabled !== false ? "checked" : ""}> Włączone</label>
    </div>
    <h4>Warunki <small class="muted">(wszystkie muszą być spełnione; najwyżej ${AE.meta.maxCriteria})</small></h4>
    ${a.criteria.map((c, i) => `<fieldset class="ae-block"><div class="ae-head">
        <select data-ae-path="criteria.${i}.type" data-rerender="1">${aeOpt(typeOpts, c.type)}</select>
        ${a.criteria.length > 1 ? `<button type="button" class="btn danger tiny" data-ae="rm-crit" data-i="${i}">✖</button>` : ""}</div>
      <div class="a-grid">${aeCritFields(c, i)}</div></fieldset>`).join("")}
    ${a.criteria.length < AE.meta.maxCriteria ? '<button type="button" class="btn" data-ae="add-crit">+ Drugi warunek</button>' : ""}
    <h4>Nagrody <small class="muted">(gracz dostaje wszystkie)</small></h4>
    ${a.rewards.map((r, i) => `<fieldset class="ae-block"><div class="ae-head">
        <select data-ae-path="rewards.${i}.type" data-rerender="1">${aeOpt(rtOpts, r.type)}</select>
        <button type="button" class="btn danger tiny" data-ae="rm-rew" data-i="${i}">✖</button></div>
      <div class="a-grid">${aeRewardFields(r, i)}</div></fieldset>`).join("")}
    ${a.rewards.length < AE.meta.maxRewards ? '<button type="button" class="btn" data-ae="add-rew">+ Nagroda</button>' : ""}
    <div class="ae-actions"><button type="submit" class="btn primary">💾 Zapisz</button><button type="button" class="btn" data-ae="cancel">Anuluj</button></div>`;
}

// wartość pola -> model (ścieżka typu criteria.0.person); lista "persons" zbiera niepuste wybory
function aeSet(path, el) {
  const ks = path.split("."), a = AE.cur;
  let o = a;
  ks.slice(0, -1).forEach((k, j) => { o = o[k] ??= (/^\d+$/.test(ks[j + 1]) ? [] : {}); });
  const last = ks[ks.length - 1];
  o[last] = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
  if (path.endsWith(".type")) {   // zmiana rodzaju: czyste pola warunku / nagrody
    const holder = a[ks[0]][+ks[1]], t = holder.type;
    a[ks[0]][+ks[1]] = ks[0] === "criteria" ? { type: t, count: 1, ...(t === "drop_together" ? { persons: [] } : {}) }
      : { type: t, ...(t === "money" ? { amount: 10000 } : { count: 1 }) };
  }
}

function aeBind() {
  const f = $("#achForm");
  f.addEventListener("input", e => {
    const p = e.target.dataset.aePath;
    if (!p) return;
    aeSet(p, e.target);
    if (e.target.dataset.rerender) renderAchForm();
    else if (e.target.matches("select[data-ae-path*='mode']")) renderAchForm();
  });
  f.addEventListener("click", e => {
    const b = e.target.closest("[data-ae]");
    if (!b) return;
    const a = AE.cur, i = +b.dataset.i;
    if (b.dataset.ae === "add-crit") a.criteria.push({ type: "cards", count: 1 });
    else if (b.dataset.ae === "rm-crit") a.criteria.splice(i, 1);
    else if (b.dataset.ae === "add-rew") a.rewards.push({ type: "money", amount: 10000 });
    else if (b.dataset.ae === "rm-rew") a.rewards.splice(i, 1);
    else if (b.dataset.ae === "cancel") AE.cur = null;
    renderAchForm();
  });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const a = AE.cur;
    a.criteria.forEach(c => { if (c.type === "drop_together") c.persons = (c.persons || []).filter(Boolean); });
    try {
      await api("/api/admin/achievements", { method: "POST", json: a });
      toast("Zapisano osiągnięcie");
      AE.cur = null; renderAchForm(); await loadAchievements(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $("#achList").addEventListener("click", async e => {
    const b = e.target.closest("[data-ae]"), row = e.target.closest("[data-id]");
    if (!b || !row) return;
    const a = AE.list.find(x => x.id === row.dataset.id);
    if (b.dataset.ae === "edit") {
      AE.cur = JSON.parse(JSON.stringify(a));
      renderAchForm();
      $("#achForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (b.dataset.ae === "del") {
      if (!confirm(`Usunąć osiągnięcie „${a.name}”? Znika też z list graczy, którzy je zdobyli (nagrody zostają).`)) return;
      try { await api(`/api/admin/achievements/${encodeURIComponent(a.id)}/delete`, { method: "POST", json: {} }); toast("Usunięto"); loadAchievements(); loadLog(); }
      catch (err) { toast(err.message, true); }
    }
  });
  $("#achNew").addEventListener("click", () => { AE.cur = aeNew(); renderAchForm(); $("#achForm").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
}

if ($("#achList")) { aeBind(); loadAchievements(); }
