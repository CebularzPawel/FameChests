"use strict";
// Warianty (/variants, tylko admini): podgląd każdego wariantu na przykładowej karcie (Donald Tusk), włączanie / wyłączanie,
// szansa (albo waga przy wariantach "always"), opis i WYDARZENIA - od-do wariant wypada ze wszystkich albo z wybranych skrzynek,
// także wyłączony albo wyjątkowy spoza skrzynki, opcjonalnie z większą szansą. Liczy serwer (catalog.drop_variants),
// tu tylko pokazujemy to samo (crateVariants / variantEvent w app.js). Druga zakładka: propozycje nowych wariantów
// (makiety z variant-mockups.js) do wyboru.

const VR = { tab: "settings", variant: "bronze", pid: "pl_tusk", combo: "", sub: "", zoom: null, bound: false };
const VR_GROUPS = [
  ["Zwykłe warianty", v => !vrV(v).exclusive],
  ["Wyjątkowe (nie z kontraktu, ulepszacza ani kasyna)", v => vrV(v).exclusive && !vrV(v).always && !vrV(v).cards && !vrV(v).special],
  ["Halloweenowe (każda karta w skrzynce ma jeden z nich)", v => vrV(v).always],
  ["Warianty jednej karty", v => !!vrV(v).cards],
  ["Karty specjalne (tylko podgląd)", v => !!vrV(v).special],
];
const VR_DURATIONS = [["1 h", 3600], ["6 h", 6 * 3600], ["24 h", 86400], ["3 dni", 3 * 86400], ["Tydzień", 7 * 86400]];

function vrV(v) { return S.cfg.variants[v]; }
function vrCfg(v) { return S.cfg.variantCfg?.[v] || { enabled: true, events: [] }; }
function vrList() { return S.cfg.variantOrder.filter(v => v !== "normal" && !vrV(v).combo); }
function vrNow() { return Date.now() / 1000; }
function vrPct(x) { return (x * 100).toLocaleString("pl-PL", { maximumFractionDigits: x && x < 0.001 ? 4 : 3 }) + "%"; }
function vrWhen(t) {
  return new Date(t * 1000).toLocaleString("pl-PL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}
// <input type="datetime-local"> liczy w czasie lokalnym
function vrLocal(t) { const d = new Date(t * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function vrUnix(s) { return Math.floor(new Date(s).getTime() / 1000); }
function vrShopCrates() { return crateList().filter(c => !c.special); }
function vrEventState(e, now = vrNow()) { return e.end <= now ? "ended" : e.start <= now ? "live" : "planned"; }

// status wariantu na liście: wydarzenie trwa / włączony / wyłączony (+ zaplanowane wydarzenia, liczba skrzynek)
function vrStatus(v) {
  const V = vrV(v), cfg = vrCfg(v), now = vrNow();
  if (V.special) return { cls: "special", txt: "🃏 karta specjalna" };
  const live = cfg.events.some(e => vrEventState(e, now) === "live"), planned = cfg.events.filter(e => vrEventState(e, now) === "planned").length;
  const crates = vrPinnable(v) ? vrShopCrates().filter(c => (c.variants || []).includes(v)).length : null;
  return {
    cls: live ? "live" : cfg.enabled ? "on" : "off",
    txt: live ? "⏰ wydarzenie trwa" : cfg.enabled ? "✅ włączony" : "⛔ wyłączony",
    extra: [planned ? `📅 ${planned}` : "", crates !== null && cfg.enabled ? `📦 ${crates}` : ""].filter(Boolean).join(" "),
  };
}

// przykładowa karta w wariancie; warianty kart specjalnych - na chwilę zrobiona karta specjalna (jak /mockups)
function vrCardHTML(pid, v) {
  if (!vrV(v)?.special) return cardHTML(pid, v, vrUid(v));
  const base = person(pid), crate = crateList().find(c => c.special) || crateOf(base.crate), id = "__vr_" + v;
  S.cfg.people[id] = Object.assign({}, base, { id, rarity: "special", crate: crate.id, crates: [crate.id], number: 1, style: 1,
    fixedVariant: v, source: "casino", imgAs: base.id });
  try { return cardHTML(id, v); } finally { delete S.cfg.people[id]; }
}

function renderVariants() {
  const list = vrList();
  if (!list.includes(VR.variant)) VR.variant = list[0];
  if (!person(VR.pid) || person(VR.pid).masked) VR.pid = Object.values(S.cfg.people).find(p => !p.masked && !isSpecialCard(p))?.id;
  $("#variantsBody").innerHTML = `
    <div class="mock-head">
      <h2>✨ Warianty</h2>
      <p class="muted">Podgląd każdego wariantu na przykładowej karcie, włączanie i wyłączanie, szanse i <b>wydarzenia</b> — wariant
        na określony czas we wszystkich albo w wybranych skrzynkach. Wyłączony wariant nie wypada ze skrzynek, kontraktu, ulepszacza
        ani kasyna — karty, które gracze już mają, zostają. Każdy wariant wypada tylko ze skrzynek, do których jest
        <b>przypięty</b> (📌 w sekcji „Gdzie wypada teraz” albo w edycji skrzynki w <a href="/admin">panelu admina</a>).</p>
    </div>
    <div class="seg vr-tabs">
      <button type="button" data-tab="settings" class="${VR.tab === "settings" ? "active" : ""}">⚙️ Ustawienia wariantów</button>
      <button type="button" data-tab="proposals" class="${VR.tab === "proposals" ? "active" : ""}">🧪 Propozycje nowych wariantów</button>
    </div>
    <div id="vrBody">${VR.tab === "settings" ? vrSettingsHTML() : vrProposalsHTML()}</div>`;
  vrBind();
}

// ================================================================ USTAWIENIA

function vrSettingsHTML() {
  const v = VR.variant, V = vrV(v);
  const listHTML = VR_GROUPS.map(([title, fits]) => {
    const vs = vrList().filter(fits);
    return vs.length ? `<div class="vr-group"><div class="vr-group-t">${title}</div>${vs.map(x => {
      const st = vrStatus(x);
      return `<button type="button" class="vr-item${x === v ? " active" : ""} st-${st.cls}" data-v="${x}">
        <span class="vdot ${vtClass(x)}"></span><span class="vr-iname">${esc(vrV(x).name)}${vrCfg(x).noHouse ? ' <span title="Ekskluzywny: nie z kuźni ani kasyna">🔒</span>' : ""}<small>×${String(vrV(x).mult).replace(".", ",")}</small></span>
        <span class="vr-ist">${st.txt}${st.extra ? `<small>${st.extra}</small>` : ""}</span></button>`;
    }).join("")}</div>` : "";
  }).join("");
  return `<div class="vr-wrap">
    <aside class="panel vr-list">${listHTML}</aside>
    <div class="vr-main">
      <div class="panel vr-top">
        <div class="vr-preview">
          <div class="vr-tools">
            <label>Karta <select class="sort-sel" data-vr="card">${Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p))
              .sort((a, b) => a.name.localeCompare(b.name, "pl")).map(p =>
              `<option value="${p.id}"${p.id === VR.pid ? " selected" : ""}>${esc(p.name)}${p.rarity === "secret" ? " ★" : ""}</option>`).join("")}</select></label>
            ${V.layer && !V.noCombo ? `<label>Połącz z <select class="sort-sel" data-vr="combo"><option value="">— sam wariant —</option>${
              S.cfg.variantOrder.filter(b => b !== "normal" && !vrV(b).combo && !vrV(b).layer && !vrV(b).special && !vrV(b).cards && S.cfg.variants[`${v}+${b}`])
                .map(b => `<option value="${b}"${b === VR.combo ? " selected" : ""}>${esc(vrV(b).name)}</option>`).join("")}</select></label>` : ""}
            ${V.subs ? `<label>Rodzaj <select class="sort-sel" data-vr="sub"><option value="">— ogólny wygląd —</option>${
              V.subs.map(s => `<option value="${s.id}"${s.id === VR.sub ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>` : ""}
            <button class="btn" type="button" data-vr="viewer">🔍 Jak w grze</button>
          </div>
          <div class="vr-stage" id="vrStage">${vrCardHTML(VR.pid, vrShown())}</div>
          ${v === "flag" && !person(VR.pid).country ? `<p class="stk-note small">Ta karta nie ma ustawionego kraju — flaga się nie pokaże.</p>` : ""}
        </div>
        <div class="vr-side">${vrFormHTML(v)}</div>
      </div>
      ${V.subs ? `<div class="panel">${vrSubsHTML(v)}</div>` : ""}
      ${V.special ? "" : `<div class="panel">${vrWhereHTML(v)}</div><div class="panel">${vrEventsHTML(v)}</div>`}
      <div class="panel"><h3 class="stk-h">🎴 Na innych kartach</h3><div class="vr-others">${vrOthers().map(pid =>
        `<div class="vr-other" data-pid="${pid}">${vrCardHTML(pid, vrShown())}</div>`).join("")}</div></div>
    </div>
  </div>`;
}

// wariant na podglądzie: sam albo połączony z wybranym (np. flag+gold)
function vrShown() { return VR.combo && S.cfg.variants[`${VR.variant}+${VR.combo}`] ? `${VR.variant}+${VR.combo}` : VR.variant; }

// Podwarianty (np. rodzaje piwa Piwnej - VARIANTS.beer.subs): rodzaj wynika z numeru egzemplarza karty (beerSub w app.js),
// więc do podglądu szukamy przykładowego numeru, który daje wybrany rodzaj. null = ogólny wygląd (jak w klaserze).
function vrUid(v) {
  if (!VR.sub || !vrV(VR.variant)?.subs || !variantParts(v).includes(VR.variant)) return null;
  for (let u = 1; u < 100000; u++) if (beerSub(v, u)?.id === VR.sub) return u;
  return null;
}
function vrSubsHTML(v) {
  const subs = vrV(v).subs, total = subs.reduce((a, s) => a + s.weight, 0);
  return `<h3 class="stk-h">🍺 Podwarianty — rodzaje piwa</h3>
    <p class="muted small">Wariant wypada jako jeden („${esc(vrV(v).name)}”, ta sama szansa i wartość), a rodzaj piwa wynika z numeru
      egzemplarza karty — ten sam egzemplarz jest zawsze tym samym piwem. Gracz widzi rodzaj na plakietce, w podpisie pod zdjęciem
      i w podglądzie karty. W klaserze i na rynku (bez konkretnego egzemplarza) karta ma ogólny wygląd. Rodzaje i ich częstość
      zmienia się w kodzie (<code>VARIANTS["beer"]["subs"]</code> w data.py).</p>
    <table class="vr-subs">
      <tr><th>Rodzaj</th><th>Plakietka</th><th>Podpis na karcie</th><th>Szansa</th><th></th></tr>
      ${subs.map(s => `<tr class="${s.id === VR.sub ? "active" : ""}">
        <td><b>${esc(s.name)}</b></td><td>${esc(s.tag)}</td><td class="muted">${esc(s.label)}</td>
        <td>${Math.round(s.weight / total * 1000) / 10}%</td>
        <td><button class="btn" type="button" data-vr-sub="${s.id}">${s.id === VR.sub ? "👁 Na podglądzie" : "Pokaż"}</button></td></tr>`).join("")}
    </table>`;
}

// po jednej karcie z kilku rzadkości (i tajna, jeśli jest znana) - żeby zobaczyć wariant na różnych ramkach
function vrOthers() {
  const people = Object.values(S.cfg.people).filter(p => !p.masked && !isSpecialCard(p) && p.id !== VR.pid);
  const out = [];
  for (const r of [...S.cfg.rarityOrder].reverse()) {
    const p = people.find(x => x.rarity === r && (vrV(VR.variant).cards ? vrV(VR.variant).cards.includes(x.id) : true));
    if (p) out.push(p.id);
  }
  return out.slice(0, 6);
}

function vrFormHTML(v) {
  const V = vrV(v), cfg = vrCfg(v), saved = cfg.saved || {}, def = cfg.defaults || {};
  if (V.special) return `<h3 class="stk-h">${esc(V.name)}</h3><p class="muted">${esc(V.desc || "")}</p>
    <p class="muted small">Wariant kart specjalnych — nie wypada ze skrzynek. Wariant i wygląd karty specjalnej ustawiasz przy samej
      karcie w panelu admina. <a href="/mockups">Makiety kart specjalnych</a></p>`;
  const changed = ["enabled", "chance", "weight", "desc", "mult"].some(k => saved[k] !== null && saved[k] !== undefined) || saved.noHouse;
  return `<form class="vr-form" id="vrForm" autocomplete="off">
    <h3 class="stk-h vr-title"><span class="vdot ${vtClass(v)}"></span>${esc(V.name)}</h3>
    <label class="vr-switch"><input type="checkbox" name="enabled"${cfg.enabled ? " checked" : ""}>
      <span><b>Wariant włączony</b><small class="muted">${cfg.off ? "W kodzie domyślnie wyłączony — włącz, kiedy chcecie." : "W kodzie domyślnie włączony."}</small></span></label>
    ${V.always
      ? `<label>Waga (wśród wariantów halloweenowych)<input type="number" name="weight" min="1" max="10000" step="1" value="${saved.weight ?? ""}" placeholder="${def.weight ?? V.weight}"></label>`
      : `<label>Szansa przy wypadnięciu karty (%)<input type="number" name="chance" min="0" max="20" step="any" value="${
          saved.chance != null ? +(saved.chance * 100).toFixed(5) : ""}" placeholder="${+(def.chance * 100).toFixed(5)}"></label>`}
    <label>Mnożnik wartości karty (×)<input type="number" name="mult" min="0.01" max="1000" step="any" value="${saved.mult ?? ""}" placeholder="${def.mult ?? V.mult}">
      <small class="muted">Wartość karty = wartość rzadkości × ten mnożnik (połączenia z flagą itp. — iloczyn). Zmienia wartość także kart, które gracze już mają.</small></label>
    ${V.exclusive ? "" : `<label class="vr-switch"><input type="checkbox" name="noHouse"${saved.noHouse ? " checked" : ""}>
      <span><b>🔒 Ekskluzywny</b><small class="muted">Wypada tylko ze skrzynek — nie da się go dostać z kuźni (kontrakt), ulepszacza ani wygranych w kasynie.</small></span></label>`}
    <div class="vr-facts">
      <span>Teraz: <b>${V.always ? `waga ${V.weight}` : vrPct(V.chance)}</b>${V.chance ? ` · 1 na ${Math.round(1 / V.chance).toLocaleString("pl-PL")} kart` : ""}</span>
      <span>Wartość: <b>×${String(V.mult).replace(".", ",")}</b>${def.mult != null && def.mult !== V.mult ? ` <small class="muted">(w kodzie ×${String(def.mult).replace(".", ",")})</small>` : ""}</span>
      ${V.exclusive ? `<span>✨ Wyjątkowy — nie z kontraktu ani ulepszacza</span>` : saved.noHouse ? `<span>🔒 Ekskluzywny — nie z kuźni ani kasyna</span>` : ""}
      ${V.layer ? `<span>🧅 Warstwa — łączy się z innymi wariantami${V.extraChance ? ` (${Math.round(V.extraChance * 100)}% kart)` : ""}</span>` : ""}
    </div>
    <label>Opis<textarea name="desc" rows="3" maxlength="300" placeholder="${esc(def.desc || "")}">${esc(saved.desc ?? "")}</textarea></label>
    <div class="vr-actions">
      <button class="btn primary" type="submit">💾 Zapisz</button>
      ${changed ? `<button class="btn" type="button" data-vr="defaults" title="Szansa, mnożnik, opis i włączenie jak w kodzie (data.py)">↩️ Domyślne</button>` : ""}
    </div>
    <p class="muted small">Puste pole = wartość z kodu. Gracze zobaczą zmiany po odświeżeniu gry; losowanie zmienia się od razu.</p>
  </form>`;
}

// wariant przypinany do skrzynek (wszystkie poza wariantami konkretnych kart i kart specjalnych - data.CRATE_VARIANTS)
function vrPinnable(v) { const V = vrV(v); return !V.cards && !V.special && !V.combo; }

// gdzie wariant może wypaść TERAZ: każda skrzynka (bez skrzynki kart specjalnych) z powodem i przełącznikiem "przypięty"
// - każdy wariant wypada tylko ze skrzynek, do których jest przypięty (catalog.drop_variants)
function vrWhereHTML(v) {
  const V = vrV(v), on = vrCfg(v).enabled, pin = vrPinnable(v);
  const rows = vrShopCrates().map(c => {
    const ev = variantEvent(v, c.id), inCrate = (c.variants || []).includes(v);
    const people = c.people.map(person).filter(p => !V.cards || V.cards.includes(p.id));
    const drops = people.length > 0 && crateVariants(c, V.cards ? people[0] : null).includes(v);
    let why = ev ? `⏰ wydarzenie do ${vrWhen(ev.end)}${ev.boost !== 1 ? ` · szansa ×${String(ev.boost).replace(".", ",")}` : ""}`
      : V.cards ? (!on ? "wariant wyłączony" : people.length ? `tylko ${people.map(p => esc(p.name)).join(", ")}` : "nie ma tu tej karty")
      : !inCrate ? "nieprzypięty do tej skrzynki"
      : !on ? "przypięty, ale wariant wyłączony" : "przypięty do tej skrzynki";
    if (v === "flag" && drops) why += ` · ${people.filter(p => p.country).length} kart z krajem`;
    return `<div class="vr-crate${drops ? " yes" : ""}${inCrate ? " pinned" : ""}"><span class="vr-cico" style="${crateStyle(c)}">${esc(c.emoji)}</span>
      <span class="vr-cname"><b>${esc(c.name)}</b>${c.shop ? "" : ' <small class="muted">(poza sklepem)</small>'}<small>${why}</small></span>
      <span class="vr-cpct">${drops ? (V.always ? "✔" : vrPct(vChance(v, c))) : "—"}</span>
      ${pin ? `<label class="vr-pin" title="${inCrate ? "Odepnij wariant od tej skrzynki" : "Przypnij wariant do tej skrzynki"}">
        <input type="checkbox" data-pin="${c.id}"${inCrate ? " checked" : ""}><span>📌</span></label>` : ""}</div>`;
  }).join("");
  const pinned = vrShopCrates().filter(c => (c.variants || []).includes(v)).length;
  return `<div class="vr-where-head"><h3 class="stk-h">📦 Gdzie wypada teraz</h3>${pin ? `<span class="vr-pin-all">
      <span class="muted small">📌 przypięty do <b>${pinned}</b> z ${vrShopCrates().length}</span>
      <button class="btn tiny" type="button" data-pinall="1">📌 Przypnij do wszystkich</button>
      <button class="btn tiny" type="button" data-pinall="0">Odepnij od wszystkich</button></span>` : ""}</div>
    ${pin ? `<p class="muted small">Wariant wypada tylko ze skrzynek, do których jest przypięty (📌) — i tylko gdy jest włączony.
      Nowy wariant nie jest przypięty nigdzie.</p>` : ""}
    <div class="vr-crates">${rows}</div>`;
}

// przypięcie / odpięcie wariantu w skrzynkach (crates - lista id), po kolei; serwer zwraca nowe listy wariantów skrzynek
async function vrPin(crates, on) {
  try {
    for (const cid of crates) {
      const res = await api(`/api/admin/variants/${VR.variant}/crates`, { crate: cid, on });
      Object.entries(res.crates).forEach(([id, vs]) => { if (crateOf(id)) crateOf(id).variants = vs; });
    }
    toast(`📌 ${vrV(VR.variant).name}: ${on ? "przypięty" : "odpięty"}${crates.length > 1 ? ` (${crates.length} skrzynek)` : ""}`);
  } catch (e) { toast(e.message, true); }
  renderVariants();
}

function vrEventsHTML(v) {
  const events = [...vrCfg(v).events].sort((a, b) => b.start - a.start), now = vrNow();
  const crateName = id => crateOf(id) ? `${esc(crateOf(id).emoji)} ${esc(crateOf(id).name)}` : esc(id);
  const label = { live: "⏰ Trwa", planned: "📅 Zaplanowane", ended: "✔ Zakończone" };
  const start = Math.ceil(now / 300) * 300;   // najbliższe pełne 5 minut
  return `<h3 class="stk-h">⏰ Wydarzenia — ${esc(vrV(v).name)} na czas</h3>
    <p class="muted small">W czasie wydarzenia wariant wypada z wybranych skrzynek (albo ze wszystkich) — także gdy jest wyłączony
      albo nieprzypięty do tej skrzynki. Mnożnik zwiększa szansę na czas wydarzenia. Godziny według Twojego zegara.</p>
    <div class="vr-events">${events.length ? events.map(e => {
      const st = vrEventState(e, now);
      return `<div class="vr-ev ev-${st}"><span class="vr-ev-st">${label[st]}</span>
        <span class="vr-ev-when"><b>${vrWhen(e.start)} → ${vrWhen(e.end)}</b>
          <small>${e.crates.length ? e.crates.map(crateName).join(", ") : "🌐 Wszystkie skrzynki"}${e.boost !== 1 ? ` · szansa ×${String(e.boost).replace(".", ",")}` : ""}${
          e.note ? ` · ${esc(e.note)}` : ""}</small></span>
        ${st === "ended" ? "" : `<button class="btn${st === "live" ? " danger" : ""}" type="button" data-stop="${e.id}">${st === "live" ? "⏹ Zakończ teraz" : "🗑️ Usuń"}</button>`}
      </div>`;
    }).join("") : '<p class="muted small">Brak wydarzeń.</p>'}</div>
    <form class="vr-evform" id="vrEvForm" autocomplete="off">
      <h4>➕ Nowe wydarzenie</h4>
      <div class="vr-evgrid">
        <label>Od<input type="datetime-local" name="start" value="${vrLocal(start)}" required></label>
        <label>Do<input type="datetime-local" name="end" value="${vrLocal(start + 86400)}" required></label>
        <label>Mnożnik szansy<input type="number" name="boost" min="1" max="50" step="any" value="1"></label>
        <label>Notatka<input type="text" name="note" maxlength="80" placeholder="np. Weekend z brązem"></label>
      </div>
      <div class="vr-durs"><span class="muted small">Czas trwania od początku:</span>${VR_DURATIONS.map(([n, s]) =>
        `<button class="stk-chip" type="button" data-dur="${s}">${n}</button>`).join("")}</div>
      <div class="vr-evcrates">
        <label class="chk"><input type="radio" name="scope" value="all" checked> 🌐 Wszystkie skrzynki</label>
        <label class="chk"><input type="radio" name="scope" value="some"> Wybrane skrzynki:</label>
        <div class="vr-cchecks">${vrShopCrates().map(c =>
          `<label class="chk"><input type="checkbox" name="crates" value="${c.id}"> ${esc(c.emoji)} ${esc(c.name)}</label>`).join("")}</div>
      </div>
      <button class="btn primary" type="submit">⏰ Zaplanuj wydarzenie</button>
    </form>`;
}

// ================================================================ ZAPIS

function vrApply(res) {
  Object.assign(S.cfg.variants[VR.variant], res.variant);
  S.cfg.variantCfg[VR.variant] = res.cfg;
  // mnożnik wartości: połączenia z warstwami (flag+gold) i kolejność wariantów liczą się od nowa
  Object.entries(res.comboMults || {}).forEach(([k, m]) => { if (S.cfg.variants[k]) S.cfg.variants[k].mult = m; });
  if (res.variantOrder) S.cfg.variantOrder = res.variantOrder;
  renderVariants();
}

async function vrSave(form) {
  const f = new FormData(form), V = vrV(VR.variant);
  const num = k => f.get(k) === null || f.get(k) === "" ? null : +String(f.get(k)).replace(",", ".");
  const body = { enabled: form.enabled.checked, desc: f.get("desc").trim() || null, mult: num("mult"), noHouse: !!form.noHouse?.checked };
  if (V.always) body.weight = num("weight");
  else body.chance = num("chance") === null ? null : num("chance") / 100;
  try {
    vrApply(await api(`/api/admin/variants/${VR.variant}`, body));
    toast(`💾 ${V.name}: zapisano`);
  } catch (e) { toast(e.message, true); }
}

async function vrAddEvent(form) {
  const f = new FormData(form), some = f.get("scope") === "some";
  const crates = some ? f.getAll("crates") : [];
  if (some && !crates.length) return toast("Zaznacz skrzynki albo wybierz „Wszystkie skrzynki”", true);
  const body = { start: vrUnix(f.get("start")), end: vrUnix(f.get("end")), crates,
                 boost: +String(f.get("boost") || 1).replace(",", "."), note: f.get("note") };
  if (!(body.end > body.start)) return toast("Koniec musi być po początku", true);
  try {
    vrApply(await api(`/api/admin/variants/${VR.variant}/events`, body));
    toast(`⏰ Zaplanowano: ${vrV(VR.variant).name}`);
  } catch (e) { toast(e.message, true); }
}

// ================================================================ PROPOZYCJE (makiety z variant-mockups.js)

function vrProposalsHTML() {
  const groups = typeof VARIANT_PROPOSALS === "undefined" ? [] : VARIANT_PROPOSALS;
  return `<p class="muted vr-prop-intro">Makiety nowych wariantów na karcie ${esc(person(VR.pid)?.name || "")} — kliknij kartę, żeby ją powiększyć.
    Wybierz po jednej (albo połączenie kilku), a zrobię z nich prawdziwe warianty — na początku wyłączone, włączycie je tutaj.</p>
    ${groups.map(g => `<section class="panel mock-sec vr-prop" id="prop-${g.key}">
      <h3>${g.icon} ${esc(g.name)} <small class="muted">— ${esc(g.about)}</small></h3>
      <div class="mock-grid">${g.looks.map((l, i) => `<figure class="mock">
        <div class="mock-card" data-prop="${g.key}" data-look="${i}">${vrProposalCard(g, i)}</div>
        <figcaption><b>${g.key.toUpperCase()} ${i + 1}. ${esc(l.name)}</b><span class="muted small">${esc(l.desc)}</span></figcaption></figure>`).join("")}</div>
    </section>`).join("")}`;
}

// karta w makiecie: zwykła karta + klasy wyglądu (vm-<wariant> vm-<wariant>-<nr>) i ozdoby z makiety
function vrProposalCard(g, i, pid = VR.pid) {
  const l = g.looks[i], box = document.createElement("div");
  box.innerHTML = cardHTML(pid, "normal");
  const card = box.firstElementChild;
  card.classList.remove("v-normal");
  card.classList.add("vm", `vm-${g.key}`, `vm-${g.key}-${i + 1}`, ...(l.cls ? l.cls.split(" ") : []));   // cls: wygląd pożyczony z wariantu
  const p = person(pid);
  card.querySelector(".shine")?.insertAdjacentHTML("beforebegin", `${l.deco ? l.deco(p) : ""}<div class="var-tag vm-tag">${l.tag || g.tag}</div>`);
  if (l.bg) card.querySelector(".card-inner").insertAdjacentHTML("afterbegin", l.bg(p));
  if (l.photo) card.querySelector(".card-photo").insertAdjacentHTML("beforeend", l.photo(p));
  if (l.sub) card.querySelector(".card-sub").innerHTML = l.sub(p);
  if (l.top) card.querySelector(".card-head").insertAdjacentHTML("beforebegin", l.top(p));   // np. napis WANTED nad nazwą   // np. pieczątka atelier zamiast "typ · skrzynka"
  return card.outerHTML;
}

function vrOpenZoom(key, i) {
  const g = VARIANT_PROPOSALS.find(x => x.key === key);
  vrCloseZoom();
  const el = document.createElement("div");
  el.className = "vr-zoom";
  el.innerHTML = `<div class="vr-zoom-stage">${vrProposalCard(g, i)}</div>
    <div class="vr-zoom-info"><h2>${g.icon} ${esc(g.name)} — ${i + 1}. ${esc(g.looks[i].name)}</h2><p>${esc(g.looks[i].desc)}</p>
      <div class="vr-zoom-nav"><button class="btn" data-zoom="-1">◀ Poprzednia</button><button class="btn" data-zoom="1">Następna ▶</button>
      <button class="btn" data-zoom="close">✕ Zamknij</button></div></div>`;
  el.onclick = e => {
    const b = e.target.closest("[data-zoom]");
    if (b && b.dataset.zoom !== "close") { Sound.click(); return vrOpenZoom(key, (i + +b.dataset.zoom + g.looks.length) % g.looks.length); }
    if (b || e.target === el) vrCloseZoom();
  };
  document.body.appendChild(el);
  VR.zoom = { key, i };
}
function vrCloseZoom() { $$("body > .vr-zoom").forEach(x => x.remove()); VR.zoom = null; }

// ================================================================ ZDARZENIA

function vrBind() {
  const body = $("#variantsBody");
  body.onclick = async e => {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { Sound.click(); VR.tab = tab.dataset.tab; return renderVariants(); }
    const item = t.closest(".vr-item");
    if (item) { Sound.click(); VR.variant = item.dataset.v; VR.combo = ""; VR.sub = ""; return renderVariants(); }
    if (t.closest('[data-vr="viewer"]')) { Sound.click(); return vrV(VR.variant).special ? null : openViewer(VR.pid, vrShown(), vrUid(vrShown())); }
    const sub = t.closest("[data-vr-sub]");
    if (sub) { Sound.click(); VR.sub = sub.dataset.vrSub; renderVariants(); return $("#vrStage")?.scrollIntoView({ block: "center", behavior: "smooth" }); }
    const other = t.closest(".vr-other");
    if (other) { Sound.click(); VR.pid = other.dataset.pid; return renderVariants(); }
    if (t.closest('[data-vr="defaults"]')) {
      if (!confirm(`Przywrócić ustawienia z kodu dla „${vrV(VR.variant).name}”? (wydarzenia zostają)`)) return;
      try { vrApply(await api(`/api/admin/variants/${VR.variant}`, { enabled: null, chance: null, weight: null, desc: null, mult: null, noHouse: false })); toast("↩️ Przywrócono"); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const dur = t.closest("[data-dur]");
    if (dur) {
      const f = $("#vrEvForm"), s = vrUnix(f.start.value);
      if (s) f.end.value = vrLocal(s + +dur.dataset.dur);
      return;
    }
    const stop = t.closest("[data-stop]");
    if (stop) {
      const live = stop.classList.contains("danger");
      if (!confirm(live ? "Zakończyć to wydarzenie teraz?" : "Usunąć zaplanowane wydarzenie?")) return;
      try { vrApply(await api(`/api/admin/variants/${VR.variant}/events/${stop.dataset.stop}/delete`, {})); toast(live ? "⏹ Zakończono" : "🗑️ Usunięto"); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const prop = t.closest("[data-prop]");
    if (prop) { Sound.click(); vrOpenZoom(prop.dataset.prop, +prop.dataset.look); }
    const all = t.closest("[data-pinall]");
    if (all) {
      const on = all.dataset.pinall === "1";
      const todo = vrShopCrates().filter(c => (c.variants || []).includes(VR.variant) !== on).map(c => c.id);
      if (!todo.length) return toast(on ? "Już przypięty do wszystkich skrzynek" : "Nie jest przypięty do żadnej skrzynki");
      if (!confirm(`${on ? "Przypiąć" : "Odpiąć"} „${vrV(VR.variant).name}” ${on ? "do" : "od"} ${todo.length} skrzynek?`)) return;
      Sound.click(); return vrPin(todo, on);
    }
  };
  body.onchange = e => {
    const t = e.target;
    if (t.matches('[data-vr="card"]')) { VR.pid = t.value; renderVariants(); }
    if (t.matches('[data-vr="combo"]')) { VR.combo = t.value; renderVariants(); }
    if (t.matches('[data-vr="sub"]')) { VR.sub = t.value; renderVariants(); }
    if (t.name === "crates" && t.checked) { const r = $('#vrEvForm input[name="scope"][value="some"]'); if (r) r.checked = true; }
    if (t.matches("[data-pin]")) { Sound.click(); vrPin([t.dataset.pin], t.checked); }
  };
  body.onsubmit = e => {
    e.preventDefault();
    if (e.target.id === "vrForm") vrSave(e.target);
    if (e.target.id === "vrEvForm") vrAddEvent(e.target);
  };
  if (!VR.bound) {
    VR.bound = true;
    document.addEventListener("keydown", e => {
      if (!VR.zoom) return;
      if (e.key === "Escape") vrCloseZoom();
      const g = VARIANT_PROPOSALS.find(x => x.key === VR.zoom.key), n = g.looks.length;
      if (e.key === "ArrowRight") vrOpenZoom(VR.zoom.key, (VR.zoom.i + 1) % n);
      if (e.key === "ArrowLeft") vrOpenZoom(VR.zoom.key, (VR.zoom.i - 1 + n) % n);
    });
  }
}
