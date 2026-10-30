"use strict";
// Edytor naklejek wariantów (/stickers, tylko admini). Na wariant z "stickers" (np. MLG) admin nakleja wbudowane grafiki
// (S.cfg.stickerLibrary, static/img/mlg) albo własne pliki PNG. Pozycja i szerokość są w % karty, więc pasują do kart
// każdej wielkości (stickersHTML / stickerStyle w app.js). Dwa tryby:
//   - "base": standardowe naklejki - te same na każdej karcie w tym wariancie,
//   - "card": tylko wybrana karta - standardowe naklejki można na niej przesunąć / zmienić / ukryć (zmiana = "edits", nadal
//     idzie za standardem, dopóki jej nie ruszysz) i dodać naklejki tylko tej karty ("extra", leżą nad standardowymi).
// Przeciąganie myszą / palcem, kółko myszy nad naklejką = rozmiar, Shift + kółko = obrót, strzałki = przesunięcie, Delete = usuń.
// Zmiany widać od razu na podglądzie, gracze zobaczą je dopiero po zapisaniu.

const STK = {
  variant: null, loaded: null, pid: null, mode: "base",
  def: [],        // standardowe naklejki (edytowane)
  cards: {},      // zapisane naklejki pojedynczych kart: { karta: { edits, extra } }
  card: null,     // naklejki wybranej karty w trybie "card" (edytowane): { edits: { id: położenie | {hidden} }, extra: [...] }
  sel: null, dirty: false, others: null, bound: false,
};
// domyślna szerokość nowej naklejki (% szerokości karty)
const STK_WIDTH = { glasses: 62, wow: 50, noscope: 60, illuminati: 30, airhorn: 40, soda: 18, upload: 40 };
const STK_PLACE = ["x", "y", "w", "rot", "flip", "anim"];
const STK_KIND = { base: "standard", edited: "zmieniona na tej karcie", hidden: "ukryta na tej karcie", extra: "tylko ta karta" };

function stkVariants() { return Object.keys(S.cfg.variantStickers || {}); }
function stkCopy(list) { return (list || []).map(s => ({ ...s })); }
function stkCopyCard(own) {
  return { edits: Object.fromEntries(Object.entries(own?.edits || {}).map(([k, e]) => [k, { ...e }])), extra: stkCopy(own?.extra) };
}
function stkNewId() { return [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, "0")).join(""); }
function stkName(s) { return s.src === "upload" ? "Własny plik" : S.cfg.stickerLibrary[s.src]?.name || s.src; }
function stkPlacement(s) { return Object.fromEntries(STK_PLACE.map(k => [k, s[k]])); }
function stkCardMode() { return STK.mode === "card"; }

// naklejki w kolejności od spodu, z rodzajem: base / edited / hidden (tylko w trybie karty) / extra
function stkItems() {
  if (!stkCardMode()) return STK.def.map(s => ({ s, kind: "base" }));
  return STK.def.map(s => {
    const e = STK.card.edits[s.id];
    return e?.hidden ? { s, kind: "hidden" } : e ? { s: { ...s, ...e }, kind: "edited" } : { s, kind: "base" };
  }).concat(STK.card.extra.map(s => ({ s, kind: "extra" })));
}
function stkVisible() { return stkItems().filter(i => i.kind !== "hidden").map(i => i.s); }
function stkFind(id) { return stkItems().find(i => i.s.id === id) || null; }
function stkSel() { const it = stkFind(STK.sel); return it && it.kind !== "hidden" ? it.s : null; }

// zmiana naklejki: w trybie karty zmiana standardowej naklejki trafia do "edits" tej karty
function stkMutate(id, fn) {
  const it = stkFind(id);
  if (!it || it.kind === "hidden") return;
  let target;
  if (!stkCardMode()) target = STK.def.find(s => s.id === id);
  else if (it.kind === "extra") target = STK.card.extra.find(s => s.id === id);
  else target = STK.card.edits[id] = STK.card.edits[id] || stkPlacement(it.s);
  fn(target);
  stkUpdateEl(id);
}

function stkLoadCard() { STK.card = stkCopyCard(STK.cards[STK.pid]); }

async function stkLoad(v) {
  const res = await api(`/api/admin/stickers/${v}`);
  STK.variant = STK.loaded = v;
  STK.def = stkCopy(res.stickers);
  STK.cards = res.cards || {};
  STK.sel = null;
  STK.dirty = false;
  stkLoadCard();
}

function stkConfirmLeave() { return !STK.dirty || confirm("Masz niezapisane naklejki. Porzucić zmiany?"); }

async function renderStickers() {
  const vs = stkVariants();
  if (!vs.length) {
    $("#stickersBody").innerHTML = `<div class="mock-head"><h2>🎨 Naklejki wariantów</h2>
      <p class="muted">Żaden wariant nie ma naklejek (pole "stickers" w server/data/game.json).</p></div>`;
    return;
  }
  const cards = Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p)).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  if (!person(STK.pid) || person(STK.pid).masked) STK.pid = (person("pl_tusk") && !person("pl_tusk").masked ? "pl_tusk" : cards[0]?.id);
  if (!vs.includes(STK.variant)) STK.variant = vs[0];
  if (STK.loaded !== STK.variant) {
    $("#stickersBody").innerHTML = `<div class="mock-head"><h2>🎨 Naklejki wariantów</h2><p class="muted">Wczytywanie…</p></div>`;
    try { await stkLoad(STK.variant); } catch (e) { toast(e.message, true); return; }
  }
  const lib = S.cfg.stickerLibrary, cardMode = stkCardMode(), p = person(STK.pid), under = stkUnder();
  const custom = Object.keys(STK.cards).filter(id => person(id)).sort((a, b) => person(a).name.localeCompare(person(b).name, "pl"));
  $("#stickersBody").innerHTML = `
    <div class="mock-head">
      <h2>🎨 Naklejki wariantów</h2>
      <p class="muted"><b>Standard</b> to naklejki na każdej karcie w wybranym wariancie. W trybie <b>Tylko ta karta</b> możesz na jednej karcie
        przesunąć, zmienić albo ukryć standardowe naklejki i dodać własne — nieruszone standardowe naklejki nadal idą za standardem.
        Wariant włączasz w skrzynce w <a href="/admin">panelu admina</a>. Gracze zobaczą zmiany dopiero po zapisaniu.</p>
    </div>
    <div class="stk-wrap">
      <div class="panel stk-main">
        <div class="stk-tools">
          <label>Wariant <select class="sort-sel" data-stk="variant">${vs.map(v =>
            `<option value="${v}"${v === STK.variant ? " selected" : ""}>${esc(variantName(v))}</option>`).join("")}</select></label>
          <label>Karta <select class="sort-sel" data-stk="card">${cards.map(c =>
            `<option value="${c.id}"${c.id === STK.pid ? " selected" : ""}>${STK.cards[c.id] ? "✎ " : ""}${esc(c.name)}${c.rarity === "secret" ? " ★" : ""}</option>`).join("")}</select></label>
          <button class="btn" type="button" data-stk="viewer" title="Podgląd jak w grze (z niezapisanymi naklejkami)">🔍 Jak w grze</button>
          ${under ? `<label class="chk" title="Zdjęcie i napisy na chwilę półprzezroczyste - widać naklejki, które są pod nimi">
            <input type="checkbox" data-stk="peek"${STK.peek ? " checked" : ""}> 👁 Prześwietl zdjęcie i napisy</label>` : ""}
        </div>
        <div class="seg stk-mode">
          <button type="button" class="${cardMode ? "" : "active"}" data-mode="base">🌐 Standard — wszystkie karty</button>
          <button type="button" class="${cardMode ? "active" : ""}" data-mode="card">🎴 Tylko ta karta: ${esc(p.name)}</button>
        </div>
        ${custom.length ? `<div class="stk-custom muted small">Karty z własnymi naklejkami: ${custom.map(id =>
          `<button type="button" class="stk-chip${cardMode && id === STK.pid ? " active" : ""}" data-goto="${id}">✎ ${esc(person(id).name)}</button>`).join("")}</div>` : ""}
        ${!cardMode && STK.cards[STK.pid] ? `<p class="stk-note small">Ta karta ma własne naklejki — tu widzisz i zmieniasz sam standard.</p>` : ""}
        ${under ? `<p class="stk-note small">Naklejki tego wariantu leżą na tle karty - pod zdjęciem i napisami.</p>` : ""}
        <div class="stk-stage${cardMode ? " card-mode" : ""}${under ? " under-mode" : ""}${under && STK.peek ? " peek" : ""}" id="stkStage"><div class="stk-cardbox">${cardHTML(STK.pid, STK.variant)}</div></div>
        <p class="muted small stk-help">Przeciągnij naklejkę myszą · kółko myszy nad naklejką = rozmiar · Shift + kółko = obrót ·
          strzałki = przesuń (Shift - szybciej) · Delete = usuń${cardMode ? " (standardową - ukryj na tej karcie)" : ""}</p>
        ${cardMode ? "" : `<h3 class="stk-h">Na innych kartach</h3><div class="stk-others" id="stkOthers"></div>`}
      </div>
      <div class="stk-side">
        <div class="panel">
          <h3 class="stk-h">➕ Dodaj naklejkę${cardMode ? " tylko na tę kartę" : ""}</h3>
          <div class="stk-lib">${Object.entries(lib).map(([k, x]) =>
            `<button type="button" class="stk-libitem" data-add="${k}" title="${esc(x.name)}"><img src="${esc(x.url)}" alt=""><span>${esc(x.name)}</span></button>`).join("")}</div>
          <label class="btn stk-upload">📁 Wgraj własny plik (PNG z przezroczystym tłem)
            <input type="file" accept="image/png,image/webp,image/gif,image/jpeg" data-stk="upload" hidden></label>
        </div>
        <div class="panel">
          <h3 class="stk-h">Naklejki ${cardMode ? "tej karty" : "standardowe"} <span class="muted" id="stkCount"></span></h3>
          <div class="stk-list" id="stkList"></div>
          <div class="stk-props" id="stkProps"></div>
        </div>
        <div class="panel stk-save">
          <button class="btn primary" type="button" data-stk="save">💾 ${cardMode ? "Zapisz naklejki tej karty" : "Zapisz standard"}</button>
          <button class="btn" type="button" data-stk="reset">↺ Cofnij zmiany</button>
          ${cardMode ? `<button class="btn" type="button" data-stk="clear" title="Usuwa wszystkie zmiany tej karty - zostaje sam standard">🌐 Przywróć sam standard</button>` : ""}
          <span class="stk-dirty" id="stkDirty"></span>
        </div>
      </div>
    </div>`;
  stkDrawAll();
  stkBind();
}

// przerysowanie samych naklejek (bez całej karty - losowe ozdoby MLG zostają na miejscu)
// naklejki "under" (pod zdjęciem) - w tle karty zaraz po tle wariantu, jak underStickersHTML w app.js
function stkUnder() { return S.cfg.variants[STK.variant]?.stickers === "under"; }
function stkDrawStickers() {
  const card = $("#stkStage .card");
  if (!card) return;
  card.querySelectorAll(".v-stickers").forEach(el => el.remove());
  const html = `<div class="v-stickers${stkUnder() ? " under" : ""}">${stkVisible().map(stickerHTML).join("")}</div>`;
  if (!stkUnder()) card.insertAdjacentHTML("beforeend", html);
  else {
    const inner = card.querySelector(".card-inner, .sc"), bg = [...inner.children].filter(el => el.matches(".vx-bg, .mlg-bg, .galaxy-bg, .dv-bg, .sc-art")).pop();
    if (bg) bg.insertAdjacentHTML("afterend", html); else inner.insertAdjacentHTML("afterbegin", html);
  }
  card.querySelectorAll(".v-sticker").forEach(el => el.classList.toggle("sel", el.dataset.sid === STK.sel));
}

function stkDrawList() {
  const items = stkItems(), cardMode = stkCardMode();
  const extras = items.filter(i => i.kind === "extra");
  $("#stkCount").textContent = `(${items.filter(i => i.kind !== "hidden").length})`;
  // na liście: na górze to, co leży najwyżej
  $("#stkList").innerHTML = items.length ? items.slice().reverse().map(({ s, kind }) => {
    const movable = !cardMode || kind === "extra", group = cardMode ? extras.map(i => i.s) : STK.def, i = group.indexOf(group.find(x => x.id === s.id));
    const buttons = kind === "hidden" ? `<button type="button" class="btn" data-show title="Pokaż na tej karcie">👁</button>`
      : (movable ? `<button type="button" class="btn" data-move="1" title="Wyżej (przed innymi)"${i === group.length - 1 ? " disabled" : ""}>▲</button>
           <button type="button" class="btn" data-move="-1" title="Niżej (pod innymi)"${i === 0 ? " disabled" : ""}>▼</button>` : "") +
        (kind === "edited" ? `<button type="button" class="btn" data-reset title="Jak w standardzie">↺</button>` : "") +
        `<button type="button" class="btn" data-del title="${cardMode && kind !== "extra" ? "Ukryj na tej karcie" : "Usuń"}">${cardMode && kind !== "extra" ? "🙈" : "🗑"}</button>`;
    return `<div class="stk-row k-${kind}${s.id === STK.sel ? " sel" : ""}" data-sid="${s.id}">
      <img src="${esc(s.url)}" alt="">
      <span class="stk-rname">${esc(stkName(s))}${s.anim !== "none" ? ` <small class="muted">· ${esc(S.cfg.stickerAnims[s.anim])}</small>` : ""}
        ${cardMode ? `<small class="stk-kind">${STK_KIND[kind]}</small>` : ""}</span>${buttons}
    </div>`;
  }).join("") : `<p class="muted small">Brak naklejek — dodaj grafikę albo wgraj plik.</p>`;
  const it = stkFind(STK.sel), s = stkSel();
  $("#stkProps").innerHTML = s ? `
    <div class="stk-props-head">✏️ ${esc(stkName(s))}${cardMode ? ` <small class="stk-kind">${STK_KIND[it.kind]}</small>` : ""}</div>
    <label>Szerokość <input type="range" min="2" max="160" step="0.5" data-prop="w" value="${s.w}"><output>${s.w}%</output></label>
    <label>Obrót <input type="range" min="-180" max="180" step="1" data-prop="rot" value="${s.rot}"><output>${s.rot}°</output></label>
    <label>Poziomo <input type="range" min="-25" max="125" step="0.5" data-prop="x" value="${s.x}"><output>${s.x}%</output></label>
    <label>Pionowo <input type="range" min="-25" max="125" step="0.5" data-prop="y" value="${s.y}"><output>${s.y}%</output></label>
    <label class="chk"><input type="checkbox" data-prop="flip"${s.flip ? " checked" : ""}> Odbij w poziomie</label>
    <label>Ruch <select class="sort-sel" data-prop="anim">${Object.entries(S.cfg.stickerAnims).map(([k, n]) =>
      `<option value="${k}"${k === s.anim ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`
    : `<p class="muted small">${it?.kind === "hidden" ? "Ta naklejka jest ukryta na tej karcie — 👁 na liście ją pokaże."
      : "Kliknij naklejkę na karcie albo na liście, żeby ją ustawić."}</p>`;
  $("#stkDirty").textContent = STK.dirty ? "● niezapisane zmiany" : "";
}

// kilka innych kart ze standardowymi naklejkami - widać, jak pasują do różnych zdjęć
let stkOthersTimer = null;
function stkDrawOthers(now = false) {
  clearTimeout(stkOthersTimer);
  if (!now) { stkOthersTimer = setTimeout(() => stkDrawOthers(true), 250); return; }
  const box = $("#stkOthers");
  if (!box) return;
  const pool = Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p) && p.id !== STK.pid);
  if (!STK.others || STK.others.some(id => !person(id))) STK.others = pool.sort(() => Math.random() - 0.5).slice(0, 4).map(p => p.id);
  stkWithPreview(() => { box.innerHTML = STK.others.map(id => `<div class="stk-other">${cardHTML(id, STK.variant)}</div>`).join(""); });
}

// na czas budowania karty: niezapisane naklejki zamiast zapisanych (standard albo lista wybranej karty)
function stkWithPreview(fn) {
  const v = STK.variant, cs = S.cfg.cardStickers[v] = S.cfg.cardStickers[v] || {};
  const saved = [S.cfg.variantStickers[v], cs[STK.pid]];
  if (stkCardMode()) cs[STK.pid] = stkVisible();
  else { S.cfg.variantStickers[v] = STK.def; delete cs[STK.pid]; }
  try { fn(); } finally {
    S.cfg.variantStickers[v] = saved[0];
    if (saved[1]) cs[STK.pid] = saved[1]; else delete cs[STK.pid];
  }
}

function stkDrawAll() { stkDrawStickers(); stkDrawList(); stkDrawOthers(true); }

function stkChanged(redrawList = true) {
  STK.dirty = true;
  if (redrawList) stkDrawList(); else $("#stkDirty").textContent = "● niezapisane zmiany";
  if (!stkCardMode()) stkDrawOthers();
}

// zmiana pozycji / rozmiaru / obrotu jednej naklejki - bez przerysowywania (płynne przeciąganie)
function stkUpdateEl(id) {
  const s = stkFind(id)?.s;
  if (!s) return;
  const el = $(`#stkStage .v-sticker[data-sid="${id}"]`);
  if (el) el.setAttribute("style", stickerStyle(s));
  if (id !== STK.sel) return;
  $$("#stkProps [data-prop]").forEach(inp => {
    const k = inp.dataset.prop;
    if (["w", "rot", "x", "y"].includes(k)) {
      inp.value = s[k];
      inp.nextElementSibling.textContent = s[k] + (k === "rot" ? "°" : "%");
    }
  });
}

const stkRound = v => Math.round(v * 2) / 2;
const stkClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function stkSelect(id) {
  STK.sel = id;
  $$("#stkStage .v-sticker").forEach(el => el.classList.toggle("sel", el.dataset.sid === id));
  stkDrawList();
}

function stkAdd(sticker) {
  (stkCardMode() ? STK.card.extra : STK.def).push(sticker);
  STK.sel = sticker.id;
  stkDrawStickers();
  stkChanged();
}

// usunięcie: w trybie karty standardowa naklejka zostaje tylko ukryta na tej karcie
function stkRemove(id) {
  const it = stkFind(id);
  if (!it) return;
  if (!stkCardMode()) STK.def = STK.def.filter(s => s.id !== id);
  else if (it.kind === "extra") STK.card.extra = STK.card.extra.filter(s => s.id !== id);
  else STK.card.edits[id] = { hidden: true };
  if (STK.sel === id) STK.sel = null;
  stkDrawStickers();
  stkChanged();
}

async function stkUpload(file) {
  const fd = new FormData();
  fd.append("image", file);
  try {
    const res = await fetch(`/api/admin/stickers/${STK.variant}/upload`, { method: "POST", body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || "Błąd serwera");
    stkAdd({ ...data.sticker, x: 50, y: 45, w: STK_WIDTH.upload });
    toast("📁 Plik wgrany — ustaw go i zapisz naklejki");
  } catch (e) { toast(e.message, true); }
}

async function stkSave() {
  const v = STK.variant, strip = list => list.map(({ url, ...s }) => s);
  try {
    if (stkCardMode()) {
      const res = await api(`/api/admin/stickers/${v}/card/${STK.pid}`, { edits: STK.card.edits, extra: strip(STK.card.extra) });
      const cs = S.cfg.cardStickers[v] = S.cfg.cardStickers[v] || {};
      if (res.card) { STK.cards[STK.pid] = res.card; cs[STK.pid] = res.stickers; }
      else { delete STK.cards[STK.pid]; delete cs[STK.pid]; }
      stkLoadCard();
      toast(res.card ? `💾 Zapisano naklejki karty ${person(STK.pid).name}` : `🌐 ${person(STK.pid).name} ma znów sam standard`);
    } else {
      const res = await api(`/api/admin/stickers/${v}`, { stickers: strip(STK.def) });
      S.cfg.variantStickers[v] = res.stickers;
      S.cfg.cardStickers[v] = res.cardStickers || {};
      STK.def = stkCopy(res.stickers);
      toast(`💾 Zapisano standardowe naklejki wariantu ${variantName(v)}`);
    }
    if (!stkFind(STK.sel)) STK.sel = null;
    STK.dirty = false;
    Sound.click();
    renderStickers();   // odświeża też listę kart z własnymi naklejkami
  } catch (e) { toast(e.message, true); }
}

function stkBind() {
  const body = $("#stickersBody"), stage = $("#stkStage");
  body.onchange = e => {
    const t = e.target;
    if (t.dataset.stk === "variant") {
      if (!stkConfirmLeave()) { t.value = STK.variant; return; }
      STK.variant = t.value;
      return renderStickers();
    }
    if (t.dataset.stk === "card") {
      if (stkCardMode() && !stkConfirmLeave()) { t.value = STK.pid; return; }
      STK.pid = t.value;
      if (stkCardMode()) { stkLoadCard(); STK.sel = null; STK.dirty = false; }
      return renderStickers();
    }
    if (t.dataset.stk === "upload") { if (t.files[0]) stkUpload(t.files[0]); t.value = ""; return; }
    if (t.dataset.stk === "peek") { STK.peek = t.checked; $("#stkStage").classList.toggle("peek", t.checked); return; }
    if (t.dataset.prop === "flip") { stkMutate(STK.sel, x => { x.flip = t.checked; }); stkChanged(); }
    if (t.dataset.prop === "anim") { stkMutate(STK.sel, x => { x.anim = t.value; }); stkDrawStickers(); stkChanged(); }
  };
  body.oninput = e => {
    const k = e.target.dataset.prop;
    if (!stkSel() || !["w", "rot", "x", "y"].includes(k)) return;
    stkMutate(STK.sel, x => { x[k] = +e.target.value; });
    stkChanged(false);
  };
  body.onclick = e => {
    const add = e.target.closest("[data-add]");
    if (add) {
      Sound.click();
      return stkAdd({ id: stkNewId(), src: add.dataset.add, x: 50, y: 45, w: STK_WIDTH[add.dataset.add] || 28, rot: 0, flip: false,
                      anim: "none", v: 0, url: S.cfg.stickerLibrary[add.dataset.add].url });
    }
    const mode = e.target.closest("[data-mode]")?.dataset.mode;
    if (mode && mode !== STK.mode) {
      if (!stkConfirmLeave()) return;
      STK.mode = mode;
      STK.def = stkCopy(S.cfg.variantStickers[STK.variant]);   // porzucone zmiany standardu
      stkLoadCard();
      STK.sel = null;
      STK.dirty = false;
      return renderStickers();
    }
    const go = e.target.closest("[data-goto]");
    if (go) {
      if (!stkConfirmLeave()) return;
      STK.mode = "card";
      STK.pid = go.dataset.goto;
      STK.def = stkCopy(S.cfg.variantStickers[STK.variant]);
      stkLoadCard();
      STK.sel = null;
      STK.dirty = false;
      return renderStickers();
    }
    const act = e.target.closest("[data-stk]")?.dataset.stk;
    if (act === "save") return stkSave();
    if (act === "reset") {
      if (STK.dirty && !confirm("Cofnąć wszystkie niezapisane zmiany?")) return;
      STK.def = stkCopy(S.cfg.variantStickers[STK.variant]);
      stkLoadCard();
      STK.sel = null;
      STK.dirty = false;
      return stkDrawAll();
    }
    if (act === "clear") {
      STK.card = { edits: {}, extra: [] };
      STK.sel = null;
      stkDrawStickers();
      return stkChanged();
    }
    if (act === "viewer") return stkWithPreview(() => openViewer(STK.pid, STK.variant));
    const row = e.target.closest(".stk-row");
    if (row) {
      const id = row.dataset.sid;
      if (e.target.closest("[data-del]")) return stkRemove(id);
      if (e.target.closest("[data-show]") || e.target.closest("[data-reset]")) {
        delete STK.card.edits[id];
        stkDrawStickers();
        return stkChanged();
      }
      const mv = e.target.closest("[data-move]");
      if (mv) {
        const list = stkCardMode() ? STK.card.extra : STK.def, i = list.findIndex(s => s.id === id), j = i + +mv.dataset.move;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        stkDrawStickers();
        return stkChanged();
      }
      return stkSelect(id);
    }
  };

  // przeciąganie naklejki po karcie
  let drag = null;
  stage.addEventListener("pointermove", e => {
    e.stopPropagation();   // karta w edytorze się nie przechyla (tiltMove w app.js nasłuchuje na document)
    if (!drag || e.pointerId !== drag.pointer) return;
    const x = stkRound(stkClamp(drag.x + (e.clientX - drag.cx) / drag.rect.width * 100, -25, 125));
    const y = stkRound(stkClamp(drag.y + (e.clientY - drag.cy) / drag.rect.height * 100, -25, 125));
    if (x !== drag.lastX || y !== drag.lastY) {
      drag.lastX = x; drag.lastY = y; drag.moved = true;
      stkMutate(drag.id, t => { t.x = x; t.y = y; });
    }
  });
  stage.addEventListener("pointerdown", e => {
    const el = e.target.closest(".v-sticker");
    if (!el) { if (STK.sel) stkSelect(null); return; }
    e.preventDefault();
    const s = stkFind(el.dataset.sid)?.s;
    if (!s) return;
    if (STK.sel !== s.id) stkSelect(s.id);
    drag = { id: s.id, pointer: e.pointerId, cx: e.clientX, cy: e.clientY, x: s.x, y: s.y, rect: flatRect($("#stkStage .card")) };
    stage.setPointerCapture(e.pointerId);
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = null;
    if (moved) stkChanged();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  // kółko myszy nad zaznaczoną naklejką: rozmiar, z Shiftem - obrót (gdzie indziej - zwykłe przewijanie strony)
  stage.addEventListener("wheel", e => {
    const s = stkSel();
    if (!s || !e.target.closest(".v-sticker.sel")) return;
    e.preventDefault();
    const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
    stkMutate(s.id, t => {
      if (e.shiftKey) t.rot = ((s.rot + dir * 5 + 540) % 360) - 180;
      else t.w = stkRound(stkClamp(s.w * (dir > 0 ? 1.06 : 1 / 1.06), 2, 160));
    });
    stkChanged(false);
  }, { passive: false });

  if (STK.bound) return;   // poniższe nasłuchują na całej stronie - raz
  STK.bound = true;
  document.addEventListener("keydown", e => {
    if (currentView() !== "stickers" || e.target.matches("input, select, textarea") || viewerOpen()) return;
    const s = stkSel();
    if (!s) return;
    const step = e.shiftKey ? 2 : 0.5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      stkMutate(s.id, t => { t.x = stkRound(stkClamp(s.x + d[0], -25, 125)); t.y = stkRound(stkClamp(s.y + d[1], -25, 125)); });
      return stkChanged(false);
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      stkRemove(s.id);
    }
  });
  window.addEventListener("beforeunload", e => {
    if (STK.dirty && currentView() === "stickers") { e.preventDefault(); e.returnValue = ""; }
  });
}
