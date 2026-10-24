"use strict";
// Kreator wariantów (strona /designer, tylko admini): własny wariant od zera, warstwa po warstwie - ramka, tło (kolory,
// wzór, ruch), zdjęcie (filtr, zabarwienie, obwódka, kształt), napisy (czcionka, kolory, poświata, panele), plakietka
// i efekty nad kartą. Podgląd na żywo na kilku kartach (projekt pod tymczasowym kluczem DS_PREVIEW), zapis:
// /api/admin/variant-designs. Nowy wariant jest wyłączony - włącza się go w zakładce Warianty; naklejki - na /stickers.

const DS = { key: "", design: null, pid: "pl_tusk", dirty: false };
const DS_PREVIEW = "cv__preview";
const DS_FX_NAMES = { sheen: "✨ Połysk", sparkles: "💫 Iskierki", rain: "🌧️ Deszcz", snow: "❄️ Śnieg", bubbles: "🫧 Bańki",
  hearts: "💖 Serca", scanlines: "📺 Linie obrazu", vignette: "🌑 Winieta", grain: "🎞️ Ziarno", glow: "🔆 Pulsująca poświata" };
const DS_LABELS = {
  "frame.anim": { none: "Bez ruchu", shimmer: "Mieni się (jak złota)", spin: "Obraca się (jak ULTRA)" },
  "bg.pattern": { none: "Brak", dots: "Kropki", stripes: "Pasy", diagonal: "Ukośne pasy", grid: "Kratka", checker: "Szachownica",
    grain: "Ziarno", waves: "Fale", hearts: "Serca", stars: "Gwiazdki" },
  "bg.anim": { none: "Bez ruchu", drift: "Przesuwa się", pulse: "Pulsuje" },
  "photo.filter": { none: "Bez filtra", grayscale: "Czarno-białe", sepia: "Sepia", invert: "Negatyw", duotone: "Do zabarwienia (szarość)",
    vivid: "Żywe kolory", faded: "Wyblakłe" },
  "photo.tintMode": { none: "Bez zabarwienia", color: "Kolor", multiply: "Przyciemnij (multiply)", screen: "Rozjaśnij (screen)",
    overlay: "Nakładka (overlay)", "soft-light": "Miękkie światło" },
  "photo.shape": { rect: "Prostokąt", rounded: "Zaokrąglone rogi", circle: "Koło" },
};
const dsClone = o => JSON.parse(JSON.stringify(o));
const dsGet = path => path.split(".").reduce((o, k) => o?.[k], DS.design);
function dsSet(path, value) {
  const ks = path.split("."), last = ks.pop();
  ks.reduce((o, k) => (o[k] ??= {}), DS.design)[last] = value;
}

// pola formularza: kolor, suwak, lista, tekst
const dsColor = (path, label, allowNone = false) => {
  const v = dsGet(path);
  return `<label class="ds-f">${label}<span class="ds-color"><input type="color" data-ds="${path}" value="${v || "#ffffff"}"${allowNone && !v ? " disabled" : ""}>
    ${allowNone ? `<label class="chk small"><input type="checkbox" data-ds-on="${path}"${v ? " checked" : ""}> włączona</label>` : ""}</span></label>`;
};
const dsRange = (path, label, min, max, step, fmtv = x => x) =>
  `<label class="ds-f">${label} <b data-ds-out="${path}">${fmtv(dsGet(path))}</b><input type="range" data-ds="${path}" data-num="1" min="${min}" max="${max}" step="${step}" value="${dsGet(path)}"></label>`;
const dsSelect = (path, label, opts) =>
  `<label class="ds-f">${label}<select data-ds="${path}">${opts.map(([v, n]) => `<option value="${esc(v)}"${dsGet(path) === v ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;
const dsEnum = (path, label) => dsSelect(path, label, S.cfg.cvOptions.enums[path].map(v => [v, DS_LABELS[path]?.[v] || v]));
const dsText = (path, label, max, ph = "") =>
  `<label class="ds-f wide">${label}<input type="text" data-ds="${path}" maxlength="${max}" value="${esc(dsGet(path) ?? "")}" placeholder="${esc(ph)}"></label>`;

function dsPreviewCards() {
  S.cfg.customVariants = Object.assign({}, S.cfg.customVariants, { [DS_PREVIEW]: DS.design });
  S.cfg.variants[DS_PREVIEW] = { name: DS.design.name, mult: DS.design.mult, chance: DS.design.chance, off: true, custom: true };
  applyCustomVariants();
  const others = Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p) && p.id !== DS.pid);
  const extra = [others.find(p => p.rarity === "gold"), others.find(p => p.rarity === "secret")].filter(Boolean);
  return [DS.pid, ...extra.map(p => p.id)].map(pid => `<div class="ds-card">${cardHTML(pid, DS_PREVIEW)}</div>`).join("");
}
function dsRefreshPreview() {
  const box = $("#dsPreview");
  if (box) box.innerHTML = dsPreviewCards();
}

function dsOpen(key) {
  DS.key = key;
  DS.design = dsClone(key ? S.cfg.customVariants[key] : S.cfg.cvOptions.default);
  DS.dirty = false;
}

function renderDesigner() {
  if (!S.cfg.cvOptions) return;
  if (!DS.design) dsOpen(Object.keys(S.cfg.customVariants || {}).find(k => k !== DS_PREVIEW) || "");
  if (!person(DS.pid) || person(DS.pid).masked) DS.pid = Object.values(S.cfg.people).find(p => !p.masked && p.rarity !== "secret").id;
  const list = Object.entries(S.cfg.customVariants || {}).filter(([k]) => k !== DS_PREVIEW);
  const cards = Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p)).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  const fonts = S.cfg.cvOptions.fonts.map(f => [f, f]);
  const on = DS.key && variantOn(DS.key);
  $("#designerBody").innerHTML = `
    <div class="mock-head">
      <h2>🖌️ Kreator wariantów</h2>
      <p class="muted">Zaprojektuj własny wariant od zera, warstwa po warstwie — podgląd zmienia się na żywo. Nowy wariant jest
        <b>wyłączony</b>: po zapisaniu włączysz go w <a href="/variants">zakładce Warianty</a> (tam też szansa i wydarzenia).
        Naklejki (własne PNG i grafiki) dodasz w <a href="/stickers">edytorze naklejek</a>.</p>
    </div>
    <div class="ds-wrap">
      <div class="panel ds-list">
        <button class="btn primary" data-dsact="new">➕ Nowy wariant</button>
        ${list.map(([k, d]) => `<button class="ds-item${k === DS.key ? " active" : ""}" data-dsopen="${k}">
          <span class="ds-dot" style="background:linear-gradient(135deg, ${d.frame.c1}, ${d.frame.c2}, ${d.frame.c3})"></span>
          <span><b>${esc(d.name)}</b><small>${variantOn(k) ? "włączony" : "wyłączony"} · ×${d.mult}</small></span></button>`).join("")
          || '<p class="muted small">Nie ma jeszcze wariantów z kreatora.</p>'}
      </div>
      <div class="panel ds-stage">
        <div class="ds-stage-head">
          <label>Karta do podglądu <select class="sort-sel" data-dspid>${cards.map(c => `<option value="${c.id}"${c.id === DS.pid ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
          <span class="muted small">${DS.key ? `${on ? "🟢 włączony w grze" : "⚪ wyłączony"} · klucz <code>${DS.key}</code>` : "nowy wariant — jeszcze nie zapisany"}${DS.dirty ? " · <b>niezapisane zmiany</b>" : ""}</span>
        </div>
        <div class="ds-preview" id="dsPreview">${dsPreviewCards()}</div>
        <div class="ds-actions">
          <button class="big-btn" data-dsact="save">💾 ${DS.key ? "Zapisz zmiany" : "Zapisz nowy wariant"}</button>
          ${DS.key ? `<a class="btn" href="/variants">✨ Włącz / szansa</a><a class="btn" href="/stickers">🎨 Naklejki</a>
            <button class="btn danger" data-dsact="delete">🗑️ Usuń wariant</button>` : ""}
        </div>
      </div>
      <div class="panel ds-form">
        <details open><summary>📝 Ogólne</summary><div class="ds-grid">
          ${dsText("name", "Nazwa", 30)}${dsText("tag", "Plakietka na karcie (np. ✨ NOWY)", 20)}
          ${dsText("desc", "Opis (widać przy wariancie)", 300)}
          ${dsRange("chance", "Szansa przy wypadnięciu karty", 0, 0.05, 0.0005, x => (x * 100).toFixed(2) + "%")}
          ${dsRange("mult", "Mnożnik wartości", 1.1, 50, 0.1, x => "×" + (+x).toFixed(1))}</div></details>
        <details open><summary>🖼️ Ramka</summary><div class="ds-grid">
          ${dsColor("frame.c1", "Kolor 1")}${dsColor("frame.c2", "Kolor 2")}${dsColor("frame.c3", "Kolor 3")}
          ${dsRange("frame.angle", "Kąt", 0, 360, 5, x => x + "°")}${dsEnum("frame.anim", "Ruch")}${dsColor("frame.glow", "Poświata", true)}</div></details>
        <details open><summary>🎨 Tło karty</summary><div class="ds-grid">
          ${dsColor("bg.c1", "Kolor 1")}${dsColor("bg.c2", "Kolor 2")}${dsRange("bg.angle", "Kąt", 0, 360, 5, x => x + "°")}
          ${dsEnum("bg.pattern", "Wzór")}${dsColor("bg.pc", "Kolor wzoru")}${dsRange("bg.po", "Widoczność wzoru", 0, 1, 0.05, x => Math.round(x * 100) + "%")}
          ${dsRange("bg.ps", "Wielkość wzoru", 2, 30, 0.5)}${dsEnum("bg.anim", "Ruch wzoru")}</div></details>
        <details><summary>📷 Zdjęcie</summary><div class="ds-grid">
          ${dsEnum("photo.filter", "Filtr")}${dsRange("photo.hue", "Przesunięcie barw", 0, 360, 5, x => x + "°")}
          ${dsEnum("photo.tintMode", "Zabarwienie")}${dsColor("photo.tint", "Kolor zabarwienia")}
          ${dsRange("photo.tintOp", "Siła zabarwienia", 0, 1, 0.05, x => Math.round(x * 100) + "%")}
          ${dsColor("photo.border", "Obwódka")}${dsRange("photo.bw", "Grubość obwódki", 0, 0.5, 0.01, x => (+x).toFixed(2) + "em")}
          ${dsEnum("photo.shape", "Kształt")}</div></details>
        <details><summary>🔤 Napisy</summary><div class="ds-grid">
          ${dsSelect("text.font", "Czcionka nazwy", fonts)}${dsColor("text.name1", "Nazwa - góra")}${dsColor("text.name2", "Nazwa - dół")}
          ${dsColor("text.glow", "Poświata nazwy", true)}${dsColor("text.color", "Pozostałe napisy")}
          ${dsColor("text.panel", "Tło pól z napisami")}${dsRange("text.panelOp", "Widoczność tła pól", 0, 1, 0.05, x => Math.round(x * 100) + "%")}</div></details>
        <details><summary>🏷️ Plakietka</summary><div class="ds-grid">
          ${dsColor("tagStyle.bg", "Tło")}${dsColor("tagStyle.color", "Napis")}${dsColor("tagStyle.border", "Obwódka")}</div></details>
        <details open><summary>✨ Efekty nad kartą</summary><div class="ds-fx">
          ${S.cfg.cvOptions.fx.map(f => `<label class="chk"><input type="checkbox" data-dsfx="${f}"${DS.design.fx[f] ? " checked" : ""}> ${DS_FX_NAMES[f] || f}</label>`).join("")}
          ${dsColor("fx.color", "Kolor efektów")}</div></details>
      </div>
    </div>`;
}

async function dsSave() {
  try {
    const res = await api("/api/admin/variant-designs", { key: DS.key, design: DS.design });
    await refreshConfig();
    DS.key = res.key; DS.design = dsClone(S.cfg.customVariants[res.key]); DS.dirty = false;
    Sound.click(); toast(`💾 Zapisano wariant „${res.design.name}”${variantOn(res.key) ? "" : " — włącz go w zakładce Warianty"}`);
    renderDesigner();
  } catch (e) { Sound.error(); toast(e.message, true); }
}
async function dsDelete() {
  const d = S.cfg.customVariants[DS.key];
  if (!confirm(`Usunąć wariant „${d.name}”? Karty graczy w tym wariancie staną się zwykłe. Tego nie da się cofnąć.`)) return;
  try {
    await api(`/api/admin/variant-designs/${DS.key}/delete`, {});
    await refreshConfig();
    DS.design = null; DS.key = "";
    toast("🗑️ Wariant usunięty");
    renderDesigner();
  } catch (e) { Sound.error(); toast(e.message, true); }
}

function bindDesigner() {
  const body = $("#designerBody");
  const changed = (refresh = false) => {
    DS.dirty = true;
    if (refresh) renderDesigner(); else dsRefreshPreview();
  };
  body.addEventListener("input", e => {
    const t = e.target, path = t.dataset.ds;
    if (!path) return;
    dsSet(path, t.dataset.num ? +t.value : t.value);
    const out = body.querySelector(`[data-ds-out="${path}"]`);
    if (out) out.textContent = dsFmt(path, +t.value);
    changed();
  });
  body.addEventListener("change", e => {
    const t = e.target;
    if (t.matches("[data-dspid]")) { DS.pid = t.value; return dsRefreshPreview(); }
    if (t.dataset.dsfx) { DS.design.fx[t.dataset.dsfx] = t.checked; return changed(); }
    if (t.dataset.dsOn) {   // poświata włączona / wyłączona
      const inp = body.querySelector(`[data-ds="${t.dataset.dsOn}"]`);
      inp.disabled = !t.checked;
      dsSet(t.dataset.dsOn, t.checked ? inp.value : "");
      return changed();
    }
    if (t.tagName === "SELECT" && t.dataset.ds) changed();
  });
  body.addEventListener("click", e => {
    const open = e.target.closest("[data-dsopen]");
    if (open) {
      if (DS.dirty && !confirm("Masz niezapisane zmiany. Porzucić je?")) return;
      dsOpen(open.dataset.dsopen); return renderDesigner();
    }
    const act = e.target.closest("[data-dsact]")?.dataset.dsact;
    if (act === "new") {
      if (DS.dirty && !confirm("Masz niezapisane zmiany. Porzucić je?")) return;
      dsOpen(""); return renderDesigner();
    }
    if (act === "save") return dsSave();
    if (act === "delete") return dsDelete();
  });
}
// tekst obok suwaka (taki sam jak przy rysowaniu formularza)
function dsFmt(path, x) {
  return { chance: (x * 100).toFixed(2) + "%", mult: "×" + x.toFixed(1), "frame.angle": x + "°", "bg.angle": x + "°", "bg.po": Math.round(x * 100) + "%",
    "photo.hue": x + "°", "photo.tintOp": Math.round(x * 100) + "%", "photo.bw": x.toFixed(2) + "em", "text.panelOp": Math.round(x * 100) + "%" }[path] ?? x;
}
