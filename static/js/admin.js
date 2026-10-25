"use strict";
// Panel admina: skrzynki i karty.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("pl-PL") + " gr";

const A = { cat: null, crate: null, search: "", rarity: "all", showSecrets: false };
try { A.showSecrets = localStorage.getItem("adminSecrets") === "1"; } catch (_) {}

async function api(path, { method = "GET", json, form } = {}) {
  const opts = { method };
  if (json !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(json); }
  if (form) opts.body = form;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = "/login"; throw new Error("Zaloguj się"); }
  if (!res.ok) throw new Error(data.error || "Błąd serwera");
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = 0; }, 3200);
  setTimeout(() => t.remove(), 3700);
}

// lista kart skrzynki: zwinięta / rozwinięta (zapamiętane w przeglądarce)
function setCardsCollapsed(on) {
  $("#cardList").hidden = on;
  const b = $("#cardsToggle");
  b.textContent = on ? "▸" : "▾";
  b.setAttribute("aria-expanded", String(!on));
  try { localStorage.setItem("adminCardsCollapsed", on ? "1" : "0"); } catch (_) {}
}

async function load() {
  loadUsers();
  loadLog();
  A.cat = await api("/api/admin/catalog");
  loadLinks();
  loadMessages();
  loadHorses();
  renderEgg();
  if (!A.crate || !A.cat.crates.some(c => c.id === A.crate)) A.crate = A.cat.crates.find(c => !c.hidden)?.id || null;
  render();
}

function avHTML(u) {
  if (u.avatarCard) {
    const rc = A.cat?.rarities?.[u.avatarRarity]?.color || "#ffffff55";
    const vcls = (u.avatarVariant || "normal").split("+").map(v => "avv-" + v).join(" ");   // flag+gold -> obie warstwy
    return `<span class="av av-card ${vcls}" style="--rc:${rc}"><img src="/avatar/${encodeURIComponent(u.username)}?c=${encodeURIComponent(u.avatarCard)}" alt=""></span>`;
  }
  return `<span class="av">${esc(u.avatar)}</span>`;
}

function hiddenSecret(card) { return card.rarity === "secret" && !A.showSecrets; }
function imgSrc(card, alt = false, force = false) {
  return `/img/${card.id}${alt ? "/alt" : ""}?admin=${A.showSecrets || force ? 1 : 0}&v=${card.imgv}`;
}

// ================================================================ RENDER

function render() {
  renderCrates();
  renderCrateForm();
  renderCards();
}

function renderCrates() {
  const counts = {};
  A.cat.cards.forEach(c => { if (!c.hidden) (c.crates || [c.crate]).forEach(k => { counts[k] = (counts[k] || 0) + 1; }); });
  $("#crateList").innerHTML = A.cat.crates.map(c => `
    <button class="a-crate${c.id === A.crate ? " active" : ""}${c.hidden ? " is-hidden" : ""}" data-crate="${c.id}"
            style="--c1:${esc(c.color1)}; --c2:${esc(c.color2)}">
      <span class="a-crate-ico">${esc(c.emoji)}</span>
      <span class="a-crate-txt"><b>${esc(c.name)}</b>
        <small>${c.hidden ? "ukryta" : `${counts[c.id] || 0} kart · ${fmt(c.price)}`}${c.builtin ? " · wbudowana" : " · własna"}${c.modified ? " · zmieniona" : ""}</small>
        <span class="a-badges">${!c.hidden && !c.shop ? '<i class="hid">poza sklepem</i>' : ""}${c.restricted ? `<i class="mod">🔒 dla wybranych (${(c.allowed || []).length})</i>` : ""}</span></span>
    </button>`).join("");
}

function crateFormHTML(c) {
  const isNew = !c.id;
  return `
    <div class="a-form-head">
      <h3>${isNew ? "Nowa skrzynka" : `Edytuj: ${esc(c.name)}`}</h3>
      <div class="a-crate-preview crate" style="--crate-bg: linear-gradient(180deg, ${esc(c.color1)} 0 50%, ${esc(c.color2)} 50%); --crate-lid: linear-gradient(180deg, ${esc(c.color1)}, ${esc(c.color2)})">
        <div class="crate-art"><div class="crate-box"><div class="crate-emblem">${esc(c.emoji)}</div></div><div class="crate-lid"></div><div class="crate-lock"></div></div>
      </div>
    </div>
    <input type="hidden" name="id" value="${esc(c.id || "")}">
    <div class="a-grid">
      <label>Nazwa<input type="text" name="name" value="${esc(c.name)}" required maxlength="60" placeholder="np. Skrzynka YouTuberów"></label>
      <label>Krótka nazwa<input type="text" name="short" value="${esc(c.short)}" maxlength="24" placeholder="np. YouTube"></label>
      <label>Kod (na kartach)<input type="text" name="code" value="${esc(c.code)}" maxlength="4" placeholder="np. YT"></label>
      <label>Emoji<input type="text" name="emoji" value="${esc(c.emoji)}" maxlength="8"></label>
      <label>Kolor górny<input type="color" name="color1" value="${esc(c.color1)}"></label>
      <label>Kolor dolny<input type="color" name="color2" value="${esc(c.color2)}"></label>
      <label>Cena skrzynki (gr)<input type="number" name="price" value="${esc(c.price)}" min="1" max="1000000"></label>
      <label class="wide">Opis<input type="text" name="desc" value="${esc(c.desc)}" maxlength="120" placeholder="krótki opis pod nazwą"></label>
    </div>
    ${c.special ? `<p class="a-special-note">🃏 Skrzynka kart specjalnych — nie ma jej w sklepie i nie da się jej otworzyć ani kupić.
      Karty z niej gracze dostają tylko w kasynie albo z linku od admina. Dodaj tu kartę z rzadkością „Specjalna”.</p>` : ""}
    <fieldset ${c.special ? "hidden" : ""}>
      <legend>🛒 Sklep i dostęp</legend>
      <label class="chk"><input type="checkbox" name="shop" ${c.shop !== false ? "checked" : ""}> Dostępna w sklepie (można ją kupić)</label>
      <label class="chk"><input type="checkbox" name="restricted" ${c.restricted ? "checked" : ""}> 🔒 Tylko dla wybranych graczy</label>
      <div class="a-allowed" ${c.restricted ? "" : "hidden"}>
        <div class="muted small">Gracze, którzy mogą kupować tę skrzynkę (admini mogą zawsze):</div>
        <div class="a-user-checks">${A.cat.users.map(u => `<label class="chk"><input type="checkbox" name="allowed" value="${u.id}" ${(c.allowed || []).includes(u.id) ? "checked" : ""}> ${avHTML(u)} ${esc(u.username)}</label>`).join("") || '<span class="muted small">Brak graczy</span>'}</div>
      </div>
      <p class="muted small">Skrzynki, które gracz ma w ekwipunku, zawsze może otworzyć — nawet gdy skrzynki nie ma w sklepie.</p>
    </fieldset>
    <fieldset ${c.special ? "hidden" : ""}>
      <legend>📌 Warianty w tej skrzynce <small class="muted">(każdy wariant wypada tylko ze skrzynek, do których jest przypięty)</small></legend>
      ${[["Zwykłe", V => !V.exclusive], ["Wyjątkowe — nie z kontraktu ani ulepszacza", V => V.exclusive && !V.always], ["Halloweenowe — każda karta ma jeden z nich", V => V.always]]
        .map(([title, fits]) => { const vs = A.cat.exclusiveVariants.filter(v => fits(A.cat.variants[v])); return vs.length ? `<div class="a-vgroup"><div class="muted small"><b>${title}</b></div>${vs.map(v => {
          const V = A.cat.variants[v], off = A.cat.variantEnabled && A.cat.variantEnabled[v] === false;
          return `<label class="chk"><input type="checkbox" name="variants" value="${v}" ${(c.variants || []).includes(v) ? "checked" : ""}>
          <b>${esc(V.name)}</b>${off ? ' <span class="a-voff">wyłączony</span>' : ""} <span class="muted small">· szansa ${+(V.chance * 100).toFixed(2)}% · wartość ×${V.mult}</span></label>`; }).join("")}</div>` : ""; }).join("")}
      <p class="muted small">Wyłączone warianty (włączasz je na stronie <a href="/variants" target="_blank">Warianty</a>) nie wypadają, nawet przypięte.
        Przy wariancie Flagowym ustaw każdej karcie tej skrzynki kraj (np. PL) w jej edycji.</p>
    </fieldset>
    <fieldset ${c.special ? "hidden" : ""}>
      <legend>🎲 Szanse rzadkości (puste = domyślne)</legend>
      <div class="a-grid a-weights">${A.cat.rarityOrder.filter(r => r !== "special").map(r => `<label style="--rc:${A.cat.rarities[r].color}"><span class="a-wname">${A.cat.rarities[r].name}</span>
        <input type="number" name="w_${r}" min="0" max="1000" step="any" value="${(c.customWeights || {})[r] ?? ""}" placeholder="${+A.cat.rarities[r].weight.toFixed(4)}"></label>`).join("")}</div>
      <p class="muted small">To wagi, nie procenty — liczy się ich stosunek. Rzadkość bez kart w tej skrzynce jest pomijana.</p>
    </fieldset>
    <div class="a-actions">
      <button class="btn primary" type="submit">💾 ${isNew ? "Utwórz skrzynkę" : "Zapisz"}</button>
      ${!isNew && c.hidden ? `<button class="btn" type="button" data-act="restore-crate">↩️ Przywróć skrzynkę</button>` : ""}
      ${!isNew && !c.hidden && c.builtin && c.modified ? `<button class="btn" type="button" data-act="restore-crate">↩️ Przywróć domyślne</button>` : ""}
      ${!isNew && !c.hidden ? `<button class="btn danger" type="button" data-act="delete-crate">${c.builtin ? "🙈 Ukryj skrzynkę" : "🗑️ Usuń skrzynkę"}</button>` : ""}
      ${isNew ? `<button class="btn" type="button" data-act="cancel-crate">Anuluj</button>` : ""}
    </div>`;
}

function renderCrateForm() {
  const c = A.crate === "__new"
    ? { name: "", short: "", code: "", emoji: "📦", color1: "#ffcf3f", color2: "#7a3b00", price: A.cat.defaultPrice, desc: "",
        shop: true, restricted: false, customWeights: {}, allowed: [], variants: [] }
    : A.cat.crates.find(x => x.id === A.crate);
  $("#crateForm").innerHTML = c ? crateFormHTML(c) : "<p class='muted'>Wybierz albo utwórz skrzynkę.</p>";
  $("#newCard").disabled = !c || A.crate === "__new" || c.hidden;
}

function renderCards() {
  $("#rarityFilter").innerHTML = [["all", "Wszystkie rzadkości"], ...A.cat.rarityOrder.map(r => [r, A.cat.rarities[r].name])]
    .map(([v, n]) => `<option value="${v}"${A.rarity === v ? " selected" : ""}>${n}</option>`).join("");
  const crate = A.cat.crates.find(c => c.id === A.crate);
  if (!crate || A.crate === "__new") { $("#cardList").innerHTML = ""; $("#cardsTitle").textContent = "Karty"; return; }
  const q = A.search.toLowerCase();
  const order = A.cat.rarityOrder;
  const cards = A.cat.cards.filter(c => (c.crates || [c.crate]).includes(A.crate) && (A.rarity === "all" || c.rarity === A.rarity) &&
    (!q || (!hiddenSecret(c) && c.name.toLowerCase().includes(q))))
    .sort((a, b) => a.hidden - b.hidden || order.indexOf(b.rarity) - order.indexOf(a.rarity) || a.name.localeCompare(b.name, "pl"));
  $("#cardsTitle").textContent = `Karty — ${crate.name} (${cards.filter(c => !c.hidden).length})`;
  $("#cardList").innerHTML = cards.map(c => {
    const R = A.cat.rarities[c.rarity];
    const secret = hiddenSecret(c);
    return `<button class="a-card${c.hidden ? " is-hidden" : ""}${c.rarity === "secret" ? " is-secret" : ""}" data-card="${c.id}" style="--rc:${R.color}">
      <img src="${imgSrc(c)}" alt="" loading="lazy">
      <span class="a-card-body">
        <b>${secret ? "★ ??? (tajna)" : esc(c.name)}</b>
        <small style="color:${R.color}">${R.name}</small>
        <small>${A.cat.types[c.type]?.icon || ""} ${secret ? "???" : esc(c.attack) + " · " + c.dmg} </small>
        <span class="a-badges">
          ${c.builtin ? '<i>wbudowana</i>' : '<i class="own">własna</i>'}
          ${c.modified ? '<i class="mod">zmieniona</i>' : ""}
          ${c.hidden ? '<i class="hid">ukryta</i>' : ""}
          ${!c.hasImage ? '<i class="warn">brak zdjęcia</i>' : ""}
          ${(c.crates || []).length > 1 ? `<i class="own">też w: ${(c.crates || []).filter(k => k !== A.crate).map(k => esc(A.cat.crates.find(x => x.id === k)?.short || k)).join(", ")}</i>` : ""}
          ${c.owned ? `<i>gracze mają ×${c.owned}</i>` : ""}
        </span>
      </span>
    </button>`;
  }).join("") || '<div class="empty">Brak kart. Dodaj pierwszą!</div>';
}

// ================================================================ FORMULARZ KARTY

// pole "Kraj" jest potrzebne, gdy karta jest w skrzynce z wariantem Flagowym
function countryNeeded(crateIds) {
  return crateIds.some(id => (A.cat.crates.find(x => x.id === id)?.variants || []).includes("flag"));
}

function openCardForm(id) {
  const inSpecial = A.crate === A.cat.specialCrate;
  const c = id ? A.cat.cards.find(x => x.id === id)
    : { id: "", name: "", crate: A.crate, crates: [A.crate], rarity: inSpecial ? "special" : "green", type: "polityka", hp: 60, attack: "",
        dmg: 40, wiki: null, builtin: false, source: "casino", fixedVariant: "joker", style: 1 };
  if (id && hiddenSecret(c) && !confirm("To tajna karta. Pokazać, kto to jest?")) return;
  const isNew = !id;
  const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
  $("#cardForm").innerHTML = `
    <div class="a-card-preview">
      <div class="a-img-box"><img src="${id ? imgSrc(c, false, true) : ""}" alt="" id="prevMain" ${id ? "" : "hidden"}><span>Zdjęcie główne</span></div>
    </div>
    <div class="a-card-fields">
      <h3>${isNew ? "Nowa karta" : `Edytuj: ${esc(c.name)}`}</h3>
      <input type="hidden" name="id" value="${esc(c.id)}">
      <div class="a-grid">
        <label class="wide">Imię i nazwisko / nazwa<input type="text" name="name" value="${esc(c.name)}" required maxlength="60"></label>
        <label class="wide">Podtytuł <small class="muted">(krótki tekst na karcie pod zdjęciem, max 40 znaków — pusty: typ i skrzynka)</small>
          <input type="text" name="subtitle" value="${esc(c.subtitle || "")}" maxlength="40" placeholder="np. Mistrz świata 2026"></label>
        <label class="wide">Opis <small class="muted">(dłuższy tekst obok karty w podglądzie, max 1000 znaków)</small>
          <textarea name="desc" rows="3" maxlength="1000" placeholder="Kim jest ta osoba, ciekawostki…">${esc(c.desc || "")}</textarea></label>
        <div class="wide a-crate-checks" ${c.rarity === "special" ? "hidden" : ""}><span class="muted small">Skrzynki (karta może być w kilku; pierwsza zaznaczona to skrzynka główna — jej kod jest na karcie):</span>
          ${A.cat.crates.filter(x => !x.hidden && !x.special).map(x => `<label class="chk"><input type="checkbox" name="crates" value="${esc(x.id)}" ${(c.crates || [c.crate]).includes(x.id) ? "checked" : ""}> ${esc(x.emoji)} ${esc(x.name)}${(x.variants || []).includes("flag") ? ' <small title="Skrzynka z wariantem Flagowym">🏳️</small>' : ""}</label>`).join("")}</div>
        <label class="wide a-country" ${countryNeeded(c.crates || [c.crate]) || c.country ? "" : "hidden"}>🏳️ Kraj <small class="muted">(kod ISO, np. PL, DE, US, GB-ENG — flaga do wariantu Flagowego)</small>
          <span class="a-country-row"><input type="text" name="country" value="${esc((c.country || "").toUpperCase())}" maxlength="6" placeholder="PL">
          <img class="a-flag" src="${c.country ? `/flag/${esc(c.country)}.svg` : ""}" alt="" ${c.country ? "" : "hidden"}></span></label>
        <label>Rzadkość<select name="rarity">${opt(Object.fromEntries(A.cat.rarityOrder.map(r => [r, A.cat.rarities[r].name])), c.rarity)}</select></label>
        ${specialFieldsHTML(c)}
        <label>Typ<select name="type">${opt(Object.fromEntries(Object.entries(A.cat.types).map(([k, t]) => [k, `${t.icon} ${t.name}`])), c.type)}</select></label>
        <label>HP<input type="number" name="hp" value="${c.hp}" min="0" max="9999"></label>
        <label>Nazwa ataku<input type="text" name="attack" value="${esc(c.attack)}" maxlength="40"></label>
        <label>Wartość<input type="number" name="dmg" value="${c.dmg}" min="0" max="9999"></label>
        <label>Rodzaj<select name="kind1">${kindOpts(c.kind1)}</select></label>
        <label>Druga zdolność <small class="muted">(opcjonalna)</small><input type="text" name="attack2" value="${esc(c.attack2 || "")}" maxlength="40" placeholder="np. dla legendarnych"></label>
        <label>Wartość 2<input type="number" name="dmg2" value="${c.dmg2 || ""}" min="0" max="9999"></label>
        <label>Rodzaj 2<select name="kind2">${kindOpts(c.kind2)}</select></label>
      </div>

      <fieldset>
        <legend>Dodatkowe zdolności <small class="muted">(max ${A.cat.maxExtraAbilities})</small></legend>
        <div id="abilityRows">${(c.abilities || []).map(abilityRowHTML).join("")}</div>
        <button class="btn tiny" type="button" data-act="add-ability">➕ Dodaj zdolność</button>
        <p class="muted small">Wartość zdolności zależy od rodzaju — ofensywna: obrażenia, defensywna: osłona (🛡️), lecząca: leczone HP (💚), ekonomiczna: monety 🪙 w Arenie.</p>
      </fieldset>

      <fieldset class="a-arena">
        <legend>⚔️ Arena <small class="muted">(wersja testowa, tylko dla adminów — animacja, koszt i efekty zdolności)</small></legend>
        <input type="hidden" name="arena_json">
        ${[0, 1, 2, 3].map(i => arenaSlotHTML(i, (c.arena || [])[i])).join("")}
      </fieldset>

      <fieldset>
        <legend>Zdjęcie główne</legend>
        <div class="a-grid">
          <label>Wikipedia<select name="wiki_lang">${opt({ pl: "pl.wikipedia", en: "en.wikipedia", de: "de.wikipedia", fr: "fr.wikipedia" }, c.wiki?.[0] || "pl")}</select></label>
          <label class="wide">Tytuł artykułu<input type="text" name="wiki_title" value="${esc(c.wiki?.[1] || "")}" placeholder="np. Robert Lewandowski"></label>
          <label class="wide">…albo adres obrazka (URL)<input type="text" name="image_url" placeholder="https://…"></label>
          <label class="wide">…albo plik z dysku<input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" data-prev="prevMain"></label>
        </div>
      </fieldset>

      ${(c.cardVariants || []).map(v => `<fieldset class="a-vphoto">
        <legend>📷 Zdjęcie wariantu ${esc(A.cat.variants[v].name)} <small class="muted">(użyte zamiast zwykłego zdjęcia w tym wariancie — gdy brak, ${A.cat.variants[v].photoFallback ? `zdjęcie wariantu ${esc(A.cat.variants[A.cat.variants[v].photoFallback].name)}, a gdy i tego brak - ` : ""}zwykłe zdjęcie)</small></legend>
        <div class="a-vphoto-row">
          <div class="a-img-box"><img src="${(c.variantPhotos || {})[v] != null ? `/img/${esc(c.id)}/${v}?admin=1&v=${c.variantPhotos[v]}` : ""}" alt="" id="prevV_${v}" ${(c.variantPhotos || {})[v] != null ? "" : "hidden"}><span>${esc(A.cat.variants[v].name)}</span></div>
          <div class="a-grid">
            <label class="wide">Adres obrazka (URL)<input type="text" name="image_url_v_${v}" placeholder="https://…"></label>
            <label class="wide">…albo plik z dysku<input type="file" name="image_v_${v}" accept="image/jpeg,image/png,image/webp,image/gif" data-prev="prevV_${v}"></label>
            ${(c.variantPhotos || {})[v] != null ? `<label class="chk"><input type="checkbox" name="remove_v_${v}" value="1"> usuń to zdjęcie</label>` : ""}
          </div>
        </div>
      </fieldset>`).join("")}

      <fieldset class="a-preview">
        <legend>👁️ Podgląd we wszystkich wariantach</legend>
        ${isNew ? '<p class="muted small">Podgląd będzie dostępny po dodaniu karty.</p>'
          : `<p class="muted small">Karta tak jak w grze, w każdym wariancie, który może mieć${c.rarity === "secret" ? " (także tajna)" : ""}. Pokazuje zapisaną wersję — po zapisaniu odśwież podgląd.</p>
        <button class="btn" type="button" data-act="preview-variants">👁️ Pokaż podgląd</button>
        <div class="a-preview-box" hidden></div>`}
      </fieldset>

      <div class="a-actions">
        <button class="btn primary" type="submit">💾 ${isNew ? "Dodaj kartę" : "Zapisz"}</button>
        ${!isNew && !c.hidden ? '<button class="btn" type="button" data-act="refetch">🔄 Pobierz zdjęcie ponownie</button>' : ""}
        ${!isNew && c.builtin && (c.modified || c.hidden) ? `<button class="btn" type="button" data-act="restore-card">↩️ ${c.hidden ? "Przywróć kartę" : "Przywróć domyślne"}</button>` : ""}
        ${!isNew && !c.hidden ? `<button class="btn danger" type="button" data-act="delete-card">${c.builtin ? "🙈 Ukryj kartę" : "🗑️ Usuń kartę"}</button>` : ""}
        <button class="btn" type="button" data-act="close-card">Anuluj</button>
      </div>
      ${c.owned ? `<p class="muted small">Masz ${c.owned} ${c.owned === 1 ? "egzemplarz" : "egzemplarzy"} tej karty. Usunięta karta zniknie z ekwipunku (ukrytą można przywrócić).</p>` : ""}
    </div>`;
  $("#cardModal").hidden = false;
  arenaRefresh();
}

// karta specjalna (rzadkość Specjalna): skąd ją zdobyć, jej jedyny wariant i wygląd (makiety: /mockups)
function specialFieldsHTML(c) {
  const variant = c.fixedVariant || "joker";
  return `<fieldset class="wide a-special" ${c.rarity === "special" ? "" : "hidden"}>
    <legend>🃏 Karta specjalna <small class="muted">(nie wypada ze skrzynek, nie da się jej sprzedać grze, postawić ani zużyć w kuźni)</small></legend>
    <div class="a-grid">
      <label class="wide">Skąd gracze ją dostają<select name="source">${Object.entries(A.cat.specialSources).map(([k, v]) =>
        `<option value="${k}"${k === (c.source || "casino") ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <label>Jedyny wariant karty<select name="fixed_variant">${A.cat.specialVariants.map(v =>
        `<option value="${v}"${v === variant ? " selected" : ""}>${esc(A.cat.variants[v].name)}</option>`).join("")}</select></label>
      <label class="a-style" ${(A.cat.variants[variant]?.styles || []).length > 1 ? "" : "hidden"}>Wygląd<select name="style">${styleOpts(variant, c.style)}</select></label>
      <div class="wide">${c.id ? '<button class="btn" type="button" data-act="preview-special" title="W nowej karcie, tak jak w skrzynce - z wybranym wariantem i wyglądem, nawet niezapisanym">👁️ Podgląd karty</button>'
        : '<span class="muted small">👁️ Podgląd po dodaniu karty</span>'}
        <button class="btn" type="button" data-act="ufo-test" ${c.source === "ufo" ? "" : "hidden"} title="Przy następnym wejściu do ekwipunku w grze zobaczysz kartę ze źródłem UFO">🛸 Test: pokaż mi ją w ekwipunku</button></div>
    </div>
    ${cardTextsHTML(c)}
    <p class="muted small">Wszystkie wyglądy zobaczysz na stronie <a href="/mockups" target="_blank">🎴 makiety</a> (tylko dla adminów). Karta trafi do skrzynki „Karty specjalne”.
      Kartę z linku rozdajesz w sekcji 🔗 Linki do kart specjalnych.</p>
  </fieldset>`;
}
// własne napisy na karcie specjalnej (pole "texts") - niezależne od statystyk; puste = zwykły tekst
function cardTextsHTML(c) {
  const t = c.texts || {}, slots = Object.entries(A.cat.cardTextSlots);
  const group = (title, keys) => `<div class="a-texts-group"><span class="muted small">${title}</span><div class="a-grid">${keys.map(k =>
    `<label>${esc(A.cat.cardTextSlots[k])}<input type="text" name="t_${k}" value="${esc(t[k] || "")}" maxlength="60" placeholder="zwykły"></label>`).join("")}</div></div>`;
  const atk = slots.filter(([k]) => k.startsWith("atk")).map(([k]) => k);
  const rest = slots.filter(([k]) => !k.startsWith("atk")).map(([k]) => k);
  return `<details class="wide a-texts"${Object.keys(t).length ? " open" : ""}>
    <summary>✏️ Teksty na karcie <small class="muted">(każdy napis osobno, niezależnie od statystyk — puste pole = zwykły tekst)</small></summary>
    ${group("Napisy", rest)}${group("Zdolności (po kolei, tak jak na karcie)", atk)}
    <p class="muted small">Np. „Cena” zmienia tylko napis — prawdziwa wartość karty zostaje taka, jak wynika z rzadkości. Napisy ozdobne pojawiają się w niektórych wyglądach.</p>
  </details>`;
}
function styleOpts(variant, sel) {
  return (A.cat.variants[variant]?.styles || ["—"]).map((name, i) =>
    `<option value="${i + 1}"${i + 1 === (+sel || 1) ? " selected" : ""}>${i + 1}. ${esc(name)}</option>`).join("");
}

function kindOpts(sel) {
  return Object.entries(A.cat.abilityKinds).map(([k, v]) =>
    `<option value="${k}"${k === (sel || "off") ? " selected" : ""}>${v.icon} ${esc(v.name)}</option>`).join("");
}

function abilityRowHTML(a = {}) {
  return `<div class="a-grid a-ability">
    <label>Nazwa<input type="text" name="ab_name" value="${esc(a.name || "")}" maxlength="40" required></label>
    <label>Wartość<input type="number" name="ab_value" value="${a.value ?? 30}" min="0" max="9999"></label>
    <label>Rodzaj<select name="ab_kind">${kindOpts(a.kind)}</select></label>
    <button class="btn tiny danger" type="button" data-act="del-ability" title="Usuń zdolność">✕</button>
  </div>`;
}

// ================================================================ ARENA - ustawienia zdolności w walce
// 4 stałe miejsca: 0 = zdolność 1, 1 = zdolność 2, 2-3 = dodatkowe zdolności (puste miejsca są pomijane w walce)
const ARENA_SLOT_NAMES = ["Zdolność 1", "Zdolność 2", "Dodatkowa 1", "Dodatkowa 2"];

function arenaSlotName(i) {
  const form = $("#cardForm");
  const name = i === 0 ? form?.querySelector("[name=attack]")?.value
    : i === 1 ? form?.querySelector("[name=attack2]")?.value
    : form?.querySelectorAll("#abilityRows [name=ab_name]")[i - 2]?.value;
  return name ? `${ARENA_SLOT_NAMES[i]}: „${esc(name)}”` : `${ARENA_SLOT_NAMES[i]} <span class="muted">(brak zdolności)</span>`;
}

function arenaEffectRowHTML(e = {}) {
  const A_ = A.cat.arena;
  return `<div class="a-arena-effect">
    <select name="ae_id">${Object.entries(A_.effects).map(([k, v]) =>
      `<option value="${k}"${k === e.id ? " selected" : ""} title="${esc(v.desc)}">${v.icon} ${esc(v.name)}${v.unique ? " ★ unikalny" : ""}</option>`).join("")}</select>
    <label>Siła<input type="number" name="ae_value" value="${e.value ?? 20}" min="0" max="9999"></label>
    <label>Tury<input type="number" name="ae_turns" value="${e.turns ?? 2}" min="1" max="9"></label>
    <select name="ae_target">${Object.entries(A_.effectTargets).map(([k, v]) => `<option value="${k}"${k === (e.target || "target") ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>
    <button class="btn tiny danger" type="button" data-act="del-arena-effect" title="Usuń efekt">✕</button>
  </div>`;
}

function arenaSlotHTML(i, cfg = {}) {
  const A_ = A.cat.arena;
  cfg = cfg || {};
  return `<div class="a-arena-slot" data-slot="${i}">
    <div class="a-arena-name">${arenaSlotName(i)}</div>
    <div class="a-grid">
      <label>Animacja<select name="ar_visual">${Object.entries(A_.visuals).map(([k, v]) => `<option value="${k}"${k === (cfg.visual || "hit") ? " selected" : ""}>${v.icon} ${esc(v.name)}</option>`).join("")}</select></label>
      <label>Koszt (monety)<select name="ar_cost"><option value="auto">auto (z wartości)</option>${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}"${cfg.cost === n ? " selected" : ""}>${n === 0 ? "za darmo" : "🪙 " + n}</option>`).join("")}</select></label>
      <label>Cel<select name="ar_target"><option value="">auto (⚔️ wróg / 🛡️ ta karta)</option>${Object.entries(A_.targets).map(([k, v]) => `<option value="${k}"${k === cfg.target ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
    </div>
    <div class="a-arena-effects">${(cfg.effects || []).map(arenaEffectRowHTML).join("")}</div>
    <button class="btn tiny" type="button" data-act="add-arena-effect">➕ Efekt</button>
  </div>`;
}

// nazwy zdolności w nagłówkach + pole "Siła" tylko tam, gdzie efekt jej używa (z opisem, co znaczy liczba)
function arenaRefresh() {
  $$("#cardForm .a-arena-slot").forEach(s => { s.querySelector(".a-arena-name").innerHTML = arenaSlotName(+s.dataset.slot); });
  $$("#cardForm .a-arena-effect").forEach(r => {
    const ef = A.cat.arena.effects[r.querySelector("[name=ae_id]").value] || {};
    const v = r.querySelector("[name=ae_value]"), t = r.querySelector("[name=ae_turns]");
    v.disabled = !ef.value; v.title = ef.value || "ten efekt nie używa siły";
    v.closest("label").firstChild.textContent = ef.value ? `Siła (${ef.value})` : "Siła —";
    t.disabled = !ef.turns; t.title = ef.turns ? "liczba tur" : "działa od razu";
  });
}

function arenaCollect() {
  return [...document.querySelectorAll("#cardForm .a-arena-slot")].map(s => ({
    visual: s.querySelector("[name=ar_visual]").value,
    cost: s.querySelector("[name=ar_cost]").value === "auto" ? null : +s.querySelector("[name=ar_cost]").value,
    target: s.querySelector("[name=ar_target]").value || null,
    effects: [...s.querySelectorAll(".a-arena-effect")].map(r => ({
      id: r.querySelector("[name=ae_id]").value, value: +r.querySelector("[name=ae_value]").value,
      turns: +r.querySelector("[name=ae_turns]").value, target: r.querySelector("[name=ae_target]").value })),
  }));
}

function closeCardForm() { $("#cardModal").hidden = true; }

// ================================================================ GRACZE

async function loadUsers() {
  const { users, me, chestKinds, restrictedCrates } = await api("/api/admin/users");
  A.users = users; A.chestKinds = chestKinds; A.restrictedCrates = restrictedCrates;
  const chestTxt = u => Object.entries(u.chests || {}).map(([k, n]) => {
    const ck = chestKinds.find(c => c.kind === k);
    return `${ck ? ck.emoji : "📦"}×${n}`;
  }).join(" ") || '<span class="muted">—</span>';
  $("#userList").innerHTML = `
    <div class="a-user head"><span>Gracz</span><span>Saldo</span><span>Kolekcja</span><span>Karty</span><span>Skrzynki</span><span></span></div>
    ${users.map(u => `
    <div class="a-user${u.banned ? " banned" : ""}" data-uid="${u.id}" data-name="${esc(u.username)}">
      <span>${avHTML(u)} <b>${esc(u.username)}</b> ${u.isAdmin ? "👑" : ""}${u.id === me ? ' <small class="muted">(ty)</small>' : ""}
        ${u.banned ? `<br><small class="ban-tag">⛔ zablokowany${u.banReason ? ": " + esc(u.banReason) : ""}</small>` : ""}
        ${u.rankingHidden ? '<br><small class="muted">🙈 ukryty w rankingu</small>' : ""}
        ${u.moneyGenerated ? '<br><small class="money-tag" title="Dostał pieniądze lub skrzynki od admina">💸 pieniądze od admina — poza rankingiem</small>' : ""}
        ${u.access.length ? `<br><small class="muted">🔑 ${u.access.map(k => esc(A.restrictedCrates.find(c => c.id === k)?.name || k)).join(", ")}</small>` : ""}</span>
      <span>${fmt(u.balance)}</span>
      <span>${fmt(u.value)}</span>
      <span>${u.unique} / ${u.total}</span>
      <span class="a-chests">${chestTxt(u)}</span>
      <span class="a-user-actions">
        <button class="btn tiny" data-uact="cards">🗂 Karty</button>
        <button class="btn tiny" data-uact="chests">📦 Skrzynki</button>
        <button class="btn tiny" data-uact="access">🔑 Dostęp</button>
        <button class="btn tiny" data-uact="money">💸 Pieniądze</button>
        <button class="btn tiny" data-uact="password">🔑 Hasło</button>
        <button class="btn tiny" data-uact="ranking">${u.rankingHidden ? "🏆 Pokaż w rankingu" : "🙈 Ukryj w rankingu"}</button>
        ${u.id !== me ? `<button class="btn tiny" data-uact="admin">${u.isAdmin ? "Odbierz admina" : "👑 Daj admina"}</button>
        <button class="btn tiny ${u.banned ? "" : "danger"}" data-uact="ban">${u.banned ? "✅ Odblokuj" : "⛔ Zablokuj"}</button>
        <button class="btn tiny danger" data-uact="delete">🗑</button>` : ""}
      </span>
    </div>`).join("")}`;
  loadLog();
}

// ================================================================ LINKI DO KART SPECJALNYCH
// Gracz, który otworzy link, dostaje kartę specjalną (każdy gracz raz na link). Adres: <adres gry>/link/<kod>.

// schowek działa tylko przez https albo localhost - w sieci lokalnej (http) pokazujemy link do skopiowania ręcznie
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch (_) { prompt("Skopiuj link:", text); }
}

async function loadLinks() {
  try { A.links = await api("/api/admin/links"); } catch (e) { return toast(e.message, true); }
  const { cards, links } = A.links;
  $("#linkForm").innerHTML = cards.length ? `
    <label>Karta<select name="person">${cards.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(A.cat?.variants?.[c.variant]?.name || c.variant)}</option>`).join("")}</select></label>
    <label>Notatka <small class="muted">(np. dla kogo)</small><input type="text" name="note" maxlength="80" placeholder="np. turniej 20.10"></label>
    <label>Limit graczy <small class="muted">(0 = bez limitu)</small><input type="number" name="maxUses" value="0" min="0" max="100000"></label>
    <button class="btn primary" type="submit">🔗 Utwórz link</button>`
    : `<p class="muted small">Najpierw dodaj kartę specjalną ze źródłem „🔗 Link od admina” (skrzynka „Karty specjalne” → + Nowa karta).</p>`;
  const when = t => new Date(t * 1000).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#linkList").innerHTML = links.map(l => `<div class="a-link${l.active ? "" : " off"}" data-link="${l.id}">
      <div class="a-link-main"><b>${esc(l.name)}</b>${l.note ? ` <span class="muted">· ${esc(l.note)}</span>` : ""}
        <code class="a-link-url">${esc(location.origin + l.path)}</code>
        <small class="muted">utworzył ${esc(l.createdBy || "?")} · ${when(l.created)} · odebrało: <b>${l.uses}</b>${l.maxUses ? ` / ${l.maxUses}` : ""}
          ${l.claimedBy.length ? ` (${l.claimedBy.slice(0, 12).map(esc).join(", ")}${l.claimedBy.length > 12 ? "…" : ""})` : ""}</small></div>
      <span class="a-link-actions">
        <button class="btn tiny" data-lact="copy">📋 Kopiuj</button>
        <button class="btn tiny ${l.active ? "danger" : ""}" data-lact="toggle">${l.active ? "⛔ Wyłącz" : "✅ Włącz"}</button>
      </span>
    </div>`).join("") || '<div class="muted small">Brak linków.</div>';
}

// ================================================================ WIADOMOŚCI DO GRACZY
// Wiadomość pokazuje się raz każdemu graczowi, który wejdzie do gry między "Od" a "Do" (czas z zegara przeglądarki admina).

const msgWhen = t => new Date(t * 1000).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
// wartość pola datetime-local (czas lokalny) dla znacznika czasu w ms
function localInput(ms) { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset(), 0, 0); return d.toISOString().slice(0, 16); }

async function loadMessages() {
  try { A.messages = (await api("/api/admin/messages")).messages; } catch (e) { return toast(e.message, true); }
  const now = Date.now() / 1000;
  $("#msgList").innerHTML = A.messages.map(m => {
    const state = now < m.start ? ["later", "⏳ zaplanowana"] : now < m.end ? ["now", "🟢 wyświetla się teraz"] : ["past", "✔ zakończona"];
    return `<div class="a-link${state[0] === "past" ? " off" : ""}" data-msg="${m.id}">
      <div class="a-link-main"><b>${esc(m.title)}</b>
        <span class="a-msg-body">${esc(m.body)}</span>
        <small class="muted"><span class="a-msg-state ${state[0]}">${state[1]}</span> · ${msgWhen(m.start)} – ${msgWhen(m.end)} ·
          dodał ${esc(m.admin || "?")} · zobaczyło: <b>${m.seen}</b></small></div>
      <span class="a-link-actions"><button class="btn tiny danger" data-mact="delete">🗑 Usuń</button></span>
    </div>`;
  }).join("") || '<div class="muted small">Brak wiadomości.</div>';
}

// ================================================================ WYŚCIGI KONNE: nazwy i mnożniki koni

async function loadHorses() {
  let d;
  try { d = await api("/api/admin/horses"); } catch (e) { return toast(e.message, true); }
  A.horses = d;
  $("#horseRows").innerHTML = d.horses.map((h, i) => {
    const def = d.defaults[i];
    return `<div class="a-horse" data-horse="${h.id}">
      <i class="a-horse-dot" style="background:${esc(h.color)}">${h.id + 1}</i>
      <input type="text" name="name" maxlength="${d.nameMax}" value="${esc(h.name)}" placeholder="${esc(def.name)}" title="Nazwa konia">
      <label>×<input type="number" name="pays" min="0.5" max="1000" step="0.5" value="${h.pays}" title="Mnożnik wygranej"></label>
      <button class="btn tiny" type="button" data-hreset title="Przywróć domyślne">↺ ${esc(def.name)} ×${def.pays}</button>
    </div>`;
  }).join("");
}

function resetMessageForm() {
  const f = $("#msgForm"), start = Date.now();
  f.reset();
  f.elements.start.value = localInput(start);
  f.elements.end.value = localInput(start + 3 * 3600 * 1000);   // domyślnie przez 3 godziny od teraz
}

// ================================================================ EASTER EGG W BĘBNIE

function renderEgg() {
  if (!A.cat) return;
  const e = A.cat.easterEgg, img = $("#eggPreview");
  $("#eggChance").textContent = `${+(A.cat.eggChance * 100).toFixed(3)}%`;
  img.hidden = !e; if (e) img.src = e.url;
  $("#eggRemove").hidden = !e;
}

async function saveEgg(form) {
  try {
    const r = await api("/api/admin/egg", { method: "POST", form });
    A.cat.easterEgg = r.easterEgg;
    $("#eggForm").reset();
    renderEgg();
    toast(r.easterEgg ? "🥚 Obrazek zapisany" : "🥚 Obrazek usunięty");
  } catch (err) { toast(err.message, true); }
}

// ================================================================ DZIENNIK ADMINÓW

const LOG_ACTIONS = {
  money: "💸 Pieniądze", chests: "📦 Skrzynki", cards_delete: "🗑 Usunięte karty", access: "🔑 Dostęp do skrzynek",
  ban: "⛔ Blokada", unban: "✅ Odblokowanie", admin_grant: "👑 Dał admina", admin_revoke: "👑 Odebrał admina",
  password: "🔑 Zmiana hasła", user_delete: "🗑 Usunięte konto", ranking_hide: "🙈 Ukrył w rankingu", ranking_show: "🏆 Pokazał w rankingu",
  crate_save: "📦 Zapis skrzynki", crate_delete: "📦 Usunięcie skrzynki", crate_restore: "📦 Przywrócenie skrzynki",
  card_save: "🎴 Zapis karty", card_delete: "🎴 Usunięcie karty", card_restore: "🎴 Przywrócenie karty",
  link_create: "🔗 Nowy link do karty", link_on: "🔗 Włączył link", link_off: "🔗 Wyłączył link",
  message_add: "📢 Nowa wiadomość do graczy", message_delete: "📢 Usunięcie wiadomości",
  stickers_save: "🎨 Naklejki wariantu", stickers_card: "🎨 Naklejki jednej karty",
  egg_save: "🥚 Easter egg w bębnie", egg_delete: "🥚 Usunięcie easter egga",
  variant_save: "✨ Ustawienia wariantu", variant_crate: "📦 Wariant w skrzynce", variant_event: "⏰ Wydarzenie wariantu", variant_event_stop: "⏰ Koniec wydarzenia wariantu",
};

async function loadLog() {
  try { A.log = (await api("/api/admin/log?limit=500")).log; } catch (e) { return; }
  const sel = $("#logFilter");
  if (!sel.options.length) {
    sel.innerHTML = `<option value="">Wszystkie działania</option><option value="@money">💸 Tylko pieniądze i skrzynki</option>` +
      Object.entries(LOG_ACTIONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  }
  renderLog();
}

function renderLog() {
  const f = $("#logFilter").value, q = $("#logSearch").value.trim().toLowerCase();
  const rows = (A.log || []).filter(r => (!f || (f === "@money" ? ["money", "chests"].includes(r.action) : r.action === f)) &&
    (!q || r.admin.toLowerCase().includes(q) || r.target.toLowerCase().includes(q)));
  const when = t => new Date(t * 1000).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#adminLog").innerHTML = rows.length ? `
    <div class="a-log-row head"><span>Kiedy</span><span>Admin</span><span>Działanie</span><span>Komu</span><span>Szczegóły</span></div>
    ${rows.map(r => `<div class="a-log-row${["money", "chests"].includes(r.action) ? " money" : ""}">
      <span class="muted">${when(r.time)}</span><b>${esc(r.admin)}</b><span>${esc(LOG_ACTIONS[r.action] || r.action)}</span>
      <span>${r.target ? esc(r.target) : '<span class="muted">—</span>'}</span><span>${esc(r.details) || '<span class="muted">—</span>'}</span>
    </div>`).join("")}` : '<div class="muted">Brak wpisów.</div>';
}

async function userAction(row, act) {
  const id = row.dataset.uid, name = row.dataset.name;
  try {
    if (act === "chests") return openChestDialog(id, name);
    if (act === "cards") return openUserCards(id, name);
    if (act === "access") return openAccessDialog(id, name);
    if (act === "ban") {
      const u = A.users.find(x => String(x.id) === String(id));
      if (u.banned) {
        await api(`/api/admin/users/${id}/ban`, { method: "POST", json: { ban: false } });
        toast(`Odblokowano ${name}`);
      } else {
        const reason = prompt(`Zablokować ${name}? Gracz zostanie wylogowany i nie będzie mógł się zalogować.\nPowód (opcjonalnie):`, "");
        if (reason === null) return;
        await api(`/api/admin/users/${id}/ban`, { method: "POST", json: { ban: true, reason } });
        toast(`⛔ Zablokowano ${name}`);
      }
    }
    if (act === "money") {
      const v = prompt(`Ile groszy dodać graczowi ${name}? (ujemna kwota odejmuje)`, "5000");
      if (!v) return;
      await api(`/api/admin/users/${id}/money`, { method: "POST", json: { amount: parseInt(v, 10) } });
      toast(`Zmieniono saldo gracza ${name}`);
    }
    if (act === "password") {
      const v = prompt(`Nowe hasło dla ${name} (min. 8 znaków):`);
      if (!v) return;
      await api(`/api/admin/users/${id}/password`, { method: "POST", json: { password: v } });
      toast(`Zmieniono hasło gracza ${name}`);
    }
    if (act === "ranking") {
      const u = A.users.find(x => String(x.id) === String(id));
      await api(`/api/admin/users/${id}/ranking`, { method: "POST", json: { hidden: !u.rankingHidden } });
      toast(u.rankingHidden ? `${name} znów jest w rankingu` : `🙈 ${name} ukryty w rankingu`);
    }
    if (act === "admin") {
      await api(`/api/admin/users/${id}/admin`, { method: "POST" });
      toast("Zmieniono uprawnienia");
    }
    if (act === "delete") {
      if (!confirm(`Usunąć konto ${name} razem z kartami? Tego nie da się cofnąć.`)) return;
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      toast(`Usunięto konto ${name}`);
    }
    loadUsers();
  } catch (e) { toast(e.message, true); }
}

function openChestDialog(id, name) {
  const u = A.users.find(x => String(x.id) === String(id));
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `
    <form class="modal-box a-chest-form">
      <h3>📦 Skrzynki dla: ${esc(name)}</h3>
      <div class="a-grid">
        <label class="wide">Rodzaj skrzynki<select name="kind">${A.chestKinds.map(k =>
          `<option value="${esc(k.kind)}">${esc(k.emoji)} ${esc(k.name)} (ma: ${(u.chests || {})[k.kind] || 0})</option>`).join("")}</select></label>
        <label>Ilość<input type="number" name="count" value="5" min="-1000" max="1000" required></label>
      </div>
      <p class="muted small">Ujemna ilość zabiera skrzynki. Gracz znajdzie je w zakładce 🎒 Ekwipunek.</p>
      <div class="a-actions"><button class="btn primary" type="submit">📦 Daj skrzynki</button><button class="btn" type="button" data-x>Anuluj</button></div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest("[data-x]")) dlg.remove(); });
  dlg.querySelector("form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api(`/api/admin/users/${id}/chests`, { method: "POST", json: { kind: f.kind, count: parseInt(f.count, 10) } });
      const k = A.chestKinds.find(c => c.kind === f.kind);
      toast(`${parseInt(f.count, 10) > 0 ? "Dano" : "Zabrano"} ${Math.abs(f.count)} × ${k.emoji} ${k.name} — ${name}`);
      dlg.remove();
      loadUsers();
    } catch (err) { toast(err.message, true); }
  });
}

function modalDialog(html, cls = "") {
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `<div class="modal-box ${cls}">${html}</div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest("[data-x]")) dlg.remove(); });
  return dlg;
}

async function openUserCards(id, name) {
  let data;
  try { data = await api(`/api/admin/users/${id}/cards`); } catch (e) { return toast(e.message, true); }
  const total = data.cards.reduce((a, c) => a + c.count, 0);
  const dlg = modalDialog(`
    <h3>🗂 Karty gracza ${esc(name)} <small class="muted">(${total})</small></h3>
    <input type="text" class="a-cards-search" placeholder="Szukaj…">
    <div class="a-ucards">${data.cards.map(c => {
      const R = A.cat.rarities[c.rarity];
      return `<div class="a-ucard" data-person="${esc(c.person)}" data-variant="${esc(c.variant)}" data-name="${esc(c.name.toLowerCase())}" style="--rc:${R.color}">
        <img src="/img/${esc(c.person)}?admin=1" alt="" loading="lazy">
        <span><b>${esc(c.name)}</b><br><small style="color:${R.color}">${R.name}</small> · <small>${esc(data.variants[c.variant] || c.variant)}</small></span>
        <span class="a-ucount">×${c.count}</span>
        <span class="a-uc-actions"><button class="btn tiny" data-del="1">Usuń 1</button>${c.count > 1 ? `<button class="btn tiny danger" data-del="${c.count}">Usuń ×${c.count}</button>` : ""}</span>
      </div>`;
    }).join("") || '<div class="empty">Brak kart.</div>'}</div>
    <div class="a-actions">${total ? '<button class="btn danger" data-delall>🗑 Usuń WSZYSTKIE karty</button>' : ""}<button class="btn" data-x>Zamknij</button></div>`, "a-ucards-box");
  dlg.querySelector(".a-cards-search").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    dlg.querySelectorAll(".a-ucard").forEach(r => { r.hidden = q && !r.dataset.name.includes(q); });
  });
  dlg.addEventListener("click", async e => {
    const del = e.target.closest("[data-del]"), all = e.target.closest("[data-delall]");
    try {
      if (del) {
        const row = del.closest(".a-ucard");
        await api(`/api/admin/users/${id}/cards/delete`, { method: "POST", json: { person: row.dataset.person, variant: row.dataset.variant, count: +del.dataset.del } });
      } else if (all) {
        if (!confirm(`Usunąć WSZYSTKIE karty gracza ${name}? Tego nie da się cofnąć.`)) return;
        await api(`/api/admin/users/${id}/cards/delete`, { method: "POST", json: { all: true } });
      } else return;
      toast("Usunięto karty");
      dlg.remove();
      loadUsers();
      openUserCards(id, name);
    } catch (err) { toast(err.message, true); }
  });
}

function openAccessDialog(id, name) {
  const u = A.users.find(x => String(x.id) === String(id));
  if (!A.restrictedCrates.length) {
    return toast("Żadna skrzynka nie jest „tylko dla wybranych”. Zaznacz to w ustawieniach skrzynki.", true);
  }
  const dlg = modalDialog(`
    <form class="a-access-form">
      <h3>🔑 Dostęp do skrzynek: ${esc(name)}</h3>
      <p class="muted small">Skrzynki „tylko dla wybranych”, które ten gracz może kupować:</p>
      ${A.restrictedCrates.map(c => `<label class="chk"><input type="checkbox" name="crates" value="${esc(c.id)}" ${u.access.includes(c.id) ? "checked" : ""}> ${esc(c.emoji)} ${esc(c.name)}${c.shop ? "" : ' <small class="muted">(teraz poza sklepem)</small>'}</label>`).join("")}
      <div class="a-actions"><button class="btn primary" type="submit">💾 Zapisz</button><button class="btn" type="button" data-x>Anuluj</button></div>
    </form>`);
  dlg.querySelector("form").addEventListener("submit", async e => {
    e.preventDefault();
    const crates = new FormData(e.target).getAll("crates");
    try {
      await api(`/api/admin/users/${id}/access`, { method: "POST", json: { crates } });
      toast(`Zapisano dostęp gracza ${name}`);
      dlg.remove();
      loadUsers();
      load();
    } catch (err) { toast(err.message, true); }
  });
}

// ================================================================ ZDARZENIA

function bind() {
  $("#linkForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const res = await api("/api/admin/links", { method: "POST", json: { person: f.person, note: f.note, maxUses: +f.maxUses || 0 } });
      await copyText(location.origin + res.path, "🔗 Link utworzony i skopiowany");
      loadLinks(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $("#linkList").addEventListener("click", async e => {
    const b = e.target.closest("[data-lact]"); if (!b) return;
    const l = A.links.links.find(x => String(x.id) === b.closest("[data-link]").dataset.link);
    try {
      if (b.dataset.lact === "copy") return copyText(location.origin + l.path, "📋 Skopiowano link");
      await api(`/api/admin/links/${l.id}`, { method: "POST", json: { active: !l.active } });
      toast(l.active ? "⛔ Link wyłączony" : "✅ Link włączony");
      loadLinks(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $("#horseRows").addEventListener("click", e => {
    const b = e.target.closest("[data-hreset]"); if (!b) return;
    const row = b.closest("[data-horse]"), def = A.horses.defaults[+row.dataset.horse];
    row.querySelector("[name=name]").value = def.name;
    row.querySelector("[name=pays]").value = def.pays;
  });
  $("#horseForm").addEventListener("submit", async e => {
    e.preventDefault();
    const horses = [...$$("#horseRows [data-horse]")].map(r => ({ id: +r.dataset.horse, name: r.querySelector("[name=name]").value, pays: r.querySelector("[name=pays]").value }));
    try {
      await api("/api/admin/horses", { method: "POST", json: { horses } });
      toast("🐎 Konie zapisane");
      loadHorses(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $("#msgForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target.elements, start = new Date(f.start.value).getTime() / 1000, end = new Date(f.end.value).getTime() / 1000;
    try {
      await api("/api/admin/messages", { method: "POST", json: { title: f.title.value, body: f.body.value, start, end } });
      toast("📢 Wiadomość zaplanowana");
      resetMessageForm(); loadMessages(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $("#msgList").addEventListener("click", async e => {
    const b = e.target.closest("[data-mact]"); if (!b) return;
    const m = A.messages.find(x => String(x.id) === b.closest("[data-msg]").dataset.msg);
    if (!confirm(`Usunąć wiadomość „${m.title}”?`)) return;
    try {
      await api(`/api/admin/messages/${m.id}`, { method: "DELETE" });
      toast("🗑 Wiadomość usunięta");
      loadMessages(); loadLog();
    } catch (err) { toast(err.message, true); }
  });
  resetMessageForm();
  $("#eggForm").addEventListener("submit", e => { e.preventDefault(); saveEgg(new FormData(e.target)); });
  $("#eggRemove").addEventListener("click", () => {
    if (!confirm("Usunąć obrazek easter egga? Bęben przestanie go pokazywać.")) return;
    const f = new FormData(); f.append("remove", "1"); saveEgg(f);
  });
  $("#logFilter").addEventListener("change", renderLog);
  $("#logSearch").addEventListener("input", renderLog);
  $("#logRefresh").addEventListener("click", loadLog);
  $("#userList").addEventListener("click", e => {
    const b = e.target.closest("[data-uact]"); if (b) userAction(b.closest(".a-user"), b.dataset.uact);
  });
  $("#showSecrets").checked = A.showSecrets;
  $("#showSecrets").addEventListener("change", e => {
    A.showSecrets = e.target.checked;
    try { localStorage.setItem("adminSecrets", A.showSecrets ? "1" : "0"); } catch (_) {}
    renderCards();
  });
  $("#crateList").addEventListener("click", e => {
    const b = e.target.closest("[data-crate]"); if (!b) return;
    A.crate = b.dataset.crate; render();
  });
  $("#newCrate").addEventListener("click", () => { A.crate = "__new"; render(); $("#crateForm [name=name]").focus(); });
  $("#cardsToggle").addEventListener("click", () => setCardsCollapsed(!$("#cardList").hidden));
  try { if (localStorage.getItem("adminCardsCollapsed") === "1") setCardsCollapsed(true); } catch (_) {}
  $("#newCard").addEventListener("click", () => openCardForm(null));
  $("#cardSearch").addEventListener("input", e => { A.search = e.target.value; renderCards(); });
  $("#rarityFilter").addEventListener("change", e => { A.rarity = e.target.value; renderCards(); });
  $("#cardList").addEventListener("click", e => {
    const b = e.target.closest("[data-card]"); if (b) openCardForm(b.dataset.card);
  });

  // podgląd skrzynki na żywo
  $("#crateForm").addEventListener("change", e => {
    if (e.target.name === "restricted") $(".a-allowed").hidden = !e.target.checked;
  });
  $("#crateForm").addEventListener("input", e => {
    if (!["color1", "color2", "emoji"].includes(e.target.name)) return;
    const f = new FormData($("#crateForm"));
    const prev = $(".a-crate-preview");
    prev.style.setProperty("--crate-bg", `linear-gradient(180deg, ${f.get("color1")} 0 50%, ${f.get("color2")} 50%)`);
    prev.style.setProperty("--crate-lid", `linear-gradient(180deg, ${f.get("color1")}, ${f.get("color2")})`);
    $(".crate-emblem", prev).textContent = f.get("emoji");
  });
  $("#crateForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    data.shop = fd.has("shop");
    data.restricted = fd.has("restricted");
    data.allowed = fd.getAll("allowed").map(Number);
    data.variants = fd.getAll("variants");
    data.weights = Object.fromEntries(A.cat.rarityOrder.map(r => [r, fd.get("w_" + r)]).filter(([, v]) => v !== "" && v !== null));
    try {
      const res = await api("/api/admin/crates", { method: "POST", json: data });
      A.crate = res.id;
      toast(data.id ? "Zapisano skrzynkę" : "Utworzono skrzynkę 📦");
      await load();
    } catch (err) { toast(err.message, true); }
  });
  $("#crateForm").addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act; if (!act) return;
    const c = A.cat.crates.find(x => x.id === A.crate);
    try {
      if (act === "cancel-crate") { A.crate = A.cat.crates.find(x => !x.hidden)?.id || null; return render(); }
      if (act === "delete-crate") {
        const msg = c.builtin ? `Ukryć skrzynkę „${c.name}”? (Można ją przywrócić.)`
          : `Usunąć skrzynkę „${c.name}” razem z jej własnymi kartami? Tego nie da się cofnąć.`;
        if (!confirm(msg)) return;
        await api(`/api/admin/crates/${encodeURIComponent(c.id)}`, { method: "DELETE" });
        toast(c.builtin ? "Skrzynka ukryta" : "Skrzynka usunięta");
      }
      if (act === "restore-crate") {
        await api(`/api/admin/crates/${encodeURIComponent(c.id)}/restore`, { method: "POST" });
        toast("Przywrócono skrzynkę");
      }
      await load();
    } catch (err) { toast(err.message, true); }
  });

  // formularz karty
  $("#cardModal").addEventListener("click", e => { if (e.target.id === "cardModal") closeCardForm(); });
  $("#cardForm").addEventListener("input", e => {
    if (e.target.matches("[name=attack], [name=attack2], [name=ab_name]")) arenaRefresh();
    if (e.target.name === "country") {  // podgląd flagi
      const code = e.target.value.trim().toLowerCase(), img = $("#cardForm .a-flag");
      const ok = /^[a-z]{2}(-[a-z0-9]{1,3})?$/.test(code);
      img.hidden = !ok;
      if (ok) img.src = `/flag/${code}.svg`;
    }
  });
  $("#cardForm").addEventListener("change", e => {
    const inp = e.target;
    if (inp.name === "rarity") {   // karta specjalna: własne pola zamiast skrzynek
      const sp = inp.value === "special";
      $("#cardForm .a-special").hidden = !sp;
      $("#cardForm .a-crate-checks").hidden = sp;
    }
    if (inp.name === "source") $("#cardForm [data-act=ufo-test]").hidden = inp.value !== "ufo";
    if (inp.name === "fixed_variant") {   // wariant z jednym wyglądem (Dżinsowa) - bez wyboru wyglądu
      $("#cardForm [name=style]").innerHTML = styleOpts(inp.value, 1);
      $("#cardForm .a-style").hidden = (A.cat.variants[inp.value]?.styles || []).length < 2;
    }
    if (inp.name === "crates") {
      const box = $("#cardForm .a-country");
      box.hidden = !countryNeeded($$("#cardForm [name=crates]:checked").map(x => x.value)) && !$("#cardForm [name=country]").value;
    }
    if (inp.matches("[name=ae_id]")) arenaRefresh();
    if (inp.type === "file" && inp.files[0]) {
      const img = $("#" + inp.dataset.prev);
      img.src = URL.createObjectURL(inp.files[0]); img.hidden = false;
    }
  });
  $("#cardForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fdata = new FormData(e.target);
    if (fdata.get("rarity") !== "special" && !fdata.getAll("crates").length) return toast("Zaznacz co najmniej jedną skrzynkę", true);
    const btn = $("button[type=submit]", e.target);
    $("#cardForm [name=arena_json]").value = JSON.stringify(arenaCollect());
    btn.disabled = true; btn.textContent = "Zapisuję…";
    try {
      const res = await api("/api/admin/cards", { method: "POST", form: new FormData(e.target) });
      (res.warnings || []).forEach(w => toast(w, true));
      toast("Zapisano kartę 🎴");
      closeCardForm();
      await load();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = "💾 Zapisz"; }
  });
  $("#cardForm").addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act; if (!act) return;
    const id = $("#cardForm [name=id]").value;
    const c = A.cat.cards.find(x => x.id === id);
    try {
      if (act === "close-card") return closeCardForm();
      if (act === "preview-special") {   // podgląd karty specjalnej w grze (makiety), z wyborem z formularza
        const f = new FormData($("#cardForm"));
        const q = new URLSearchParams({ card: id, variant: f.get("fixed_variant") || "", style: f.get("style") || "" });
        return window.open(`/mockups?${q}`, "_blank");
      }
      if (act === "ufo-test") {
        await api("/api/admin/ufo/test", { method: "POST" });
        return toast("🛸 Wejdź do gry i otwórz ekwipunek (najpóźniej po 30 s) — karta będzie na samej górze");
      }
      if (act === "preview-variants") {   // podgląd karty we wszystkich wariantach - strona gry osadzona w oknie edycji
        const box = $("#cardForm .a-preview-box");
        box.innerHTML = `<iframe src="/mockups?${new URLSearchParams({ preview: id, embed: 1 })}" title="Podgląd karty"></iframe>`;
        box.hidden = false;
        e.target.textContent = "🔄 Odśwież podgląd";
        return;
      }
      if (act === "add-ability") {
        if (document.querySelectorAll("#abilityRows .a-ability").length >= A.cat.maxExtraAbilities) return toast(`Maksymalnie ${A.cat.maxExtraAbilities} dodatkowe zdolności`, true);
        return $("#abilityRows").insertAdjacentHTML("beforeend", abilityRowHTML());
      }
      if (act === "del-ability") return e.target.closest(".a-ability").remove();
      if (act === "add-arena-effect") {
        const box = e.target.closest(".a-arena-slot").querySelector(".a-arena-effects");
        if (box.children.length >= A.cat.arena.maxEffects) return toast(`Maksymalnie ${A.cat.arena.maxEffects} efekty na zdolność`, true);
        box.insertAdjacentHTML("beforeend", arenaEffectRowHTML());
        return arenaRefresh();
      }
      if (act === "del-arena-effect") return e.target.closest(".a-arena-effect").remove();
      if (act === "refetch") {
        e.target.disabled = true; e.target.textContent = "Pobieram…";
        const r = await api(`/api/admin/cards/${encodeURIComponent(id)}/refetch`, { method: "POST" });
        toast(`Zdjęcie: ${r.main ? "pobrane ✔" : "nie znaleziono ✘"}`, !r.main);
      }
      if (act === "delete-card") {
        const msg = c.builtin ? `Ukryć kartę „${c.name}”? (Można ją przywrócić.)` : `Usunąć kartę „${c.name}”? Tego nie da się cofnąć.`;
        if (!confirm(msg)) return;
        await api(`/api/admin/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(c.builtin ? "Karta ukryta" : "Karta usunięta");
      }
      if (act === "restore-card") {
        await api(`/api/admin/cards/${encodeURIComponent(id)}/restore`, { method: "POST" });
        toast("Przywrócono kartę");
      }
      closeCardForm();
      await load();
    } catch (err) { toast(err.message, true); }
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    closeCardForm();
    $$("body > .modal:not(#cardModal)").forEach(d => d.remove());
  });
}

bind();
load();
