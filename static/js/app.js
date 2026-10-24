"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("pl-PL") + " gr";   // waluta gry: grosze

const COUNT_CHIPS = [1, 2, 3, 5, 10, 15, 20];
const INV_PAGE = 120;
const VARIANT_TAGS = { bw: "B&W", reverse: "REVERSE", bronze: "BRONZE", silver: "SILVER", steel: "⚙️ STEEL", sapphire: "💙 SAPPHIRE", blackdiamond: "🖤 BLACK DIAMOND", holo: "HOLO", pearl: "🦪 PEARL", gold: "GOLDEN", vintage: "📷 1887", marble: "🏛️ MARBLE", slime: "🟢 SLIME", matte: "MATTE", racing: "🏁 RETRO", bismuth: "🌈 BISMUTH", digital: "💻 DIGITAL", cyber: "🌃 CYBER", fade: "🎨 FADE", wanted: "🤠 WANTED", artdeco: "ART DÉCO", cheese: "🧀 CHEESE", aero: "🫧 AERO", honey: "🍯 HONEY", chinese: "🏮 CHINA", moro: "🪖 MORO", beer: "🍺 BEER", neon: "💡 NEON", electric: "⚡ VOLT", synthwave: "📼 SYNTH", motor: "🏎️ MOTO", toxic: "☢️ TOXIC", pixel: "👾 PIXEL", popart: "💥 POP!", glass: "⛪ VITRAIL", thermal: "🌡️ THERMAL", blueprint: "📐 BLUEPRINT", glitch: "▓ GL1TCH", mosaic: "🧱 MOSAIC", noir: "🕵️ NOIR", flag: "FLAG", halloween: "🎃 HALLOWEEN", lantern: "🏮 LAMPION", devil: "😈 DEVIL", joker: "🃏 JOKER", jeans: "👖 DŻINS", ufo: "🛸 ⎍⎎⍜⌰⎍⎅", clear: "🫧 CLEAR", sketch: "✒️ SKETCH", emerald: "💚 EMERALD", amethyst: "💜 AMETHYST", ruby: "❤️ RUBY", mlg: "🎯 MLG", royal: "👑 ROYAL", diamond: "💎 DIAMOND", galaxy: "🌌 GALAXY", negative: "◐ NEGATIVE", rzulty: "💛 RZULTY" };
const GEMS = ["emerald", "amethyst", "ruby", "sapphire", "diamond", "blackdiamond"];  // warianty z kamieniami szlachetnymi - wspólny wygląd, inne kolory

const S = {
  cfg: null,
  state: null,
  items: [],              // posortowane malejąco po id
  crate: null,
  count: 1,
  fast: false,
  binderCrate: null,
  spread: 0,
  inv: { crate: "all", rarities: new Set(), variant: "all", sort: "new", limit: INV_PAGE, selected: new Set(), q: "",
         mode: "cards" },        // mode: "cards" = moje karty, "hof" = Hall of Fame (/inventory/hall-of-fame)
  opening: null,
  me: null,               // zalogowany gracz
  showcase: [],           // id kart w mojej gablocie
  chests: {},             // skrzynki w ekwipunku: { rodzaj: ilość }
};

// ================================================================ API / POMOCNICZE

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  // zmiany (POST) liczymy - syncInventory nie nadpisze ekwipunku w trakcie mojej własnej akcji
  if (body !== undefined) { S.inflight = (S.inflight || 0) + 1; S.mutations = (S.mutations || 0) + 1; }
  let res;
  try { res = await fetch(path, opts); }
  finally { if (body !== undefined) S.inflight--; }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.login) { location.href = "/login"; throw new Error("Zaloguj się"); }
  if (!res.ok) throw new Error(data?.error || "Błąd serwera");
  // ucięta odpowiedź (zerwane połączenie) - błąd zamiast pustych danych (start gry spróbuje jeszcze raz)
  if (data === null) throw new Error("Błąd połączenia z serwerem — spróbuj jeszcze raz");
  return data;
}

async function refreshConfig() {
  S.cfg = await api("/api/config");
  if (!S.cfg.crates[S.crate]) S.crate = S.cfg.crateOrder[0];
  if (!S.cfg.crates[S.binderCrate]) S.binderCrate = S.cfg.crateOrder[0];
}

function rarityIdx(r) { return S.cfg.rarityOrder.indexOf(r); }
function varRank(v) { return S.cfg.variantOrder.indexOf(v || "normal"); }
// warianty wyjątkowe (Królewski, Flagowy...) wypadają tylko ze skrzynek, w których admin je włączył
function isExclusive(v) { return !!S.cfg.variants[v]?.exclusive; }
// warianty specjalne, które mogą wypaść z tej skrzynki: zwykłe zawsze, wyjątkowe tylko włączone w skrzynce
// (flagowy - tylko dla kart z ustawionym krajem)
// (warianty z polem "cards", np. Rzulty, należą do konkretnych kart - nie do skrzynki)
// (połączenia "flag+gold" nie wypadają osobno - patrz variantChance)
// (jak catalog.drop_variants: wyłączone warianty nie wypadają, a trwające wydarzenie włącza wariant w swoich skrzynkach)
function crateVariants(crate, p = null) {
  return S.cfg.variantOrder.filter(v => {
    if (!isSpecial(v)) return false;
    const V = S.cfg.variants[v];
    if (V.combo || V.special) return false;
    if (V.cards && !(p && V.cards.includes(p.id))) return false;
    if (v === "flag" && p && !p.country) return false;
    if (variantEvent(v, crate?.id)) return true;
    if (!variantOn(v)) return false;
    return !V.exclusive || !!V.cards || (crate?.variants || []).includes(v);
  });
}
// Ustawienia wariantów ze strony /variants (catalog.variant_cfg_json): włączony / wyłączony i wydarzenia - od-do wariant
// wypada ze wszystkich albo z wybranych skrzynek (e.crates puste = wszystkie), boost = mnożnik szansy
function variantOn(v) { return S.cfg.variantCfg?.[v]?.enabled ?? !S.cfg.variants[v]?.off; }
function variantEvent(v, crateId, now = Date.now() / 1000) {
  return (S.cfg.variantCfg?.[v]?.events || []).find(e => e.start <= now && now < e.end && (!e.crates.length || e.crates.includes(crateId))) || null;
}
// wariant już był w grze (włączony kiedykolwiek albo po wydarzeniu) - tylko takie pokazujemy w klaserze
function variantReleased(v) { return S.cfg.variantCfg?.[v]?.released ?? !S.cfg.variants[v]?.off; }
// szansa na wariant z mnożnikiem trwającego wydarzenia w tej skrzynce
function vChance(v, crate) { return S.cfg.variants[v].chance * (variantEvent(v, crate?.id)?.boost || 1); }
// Warianty, w których ta karta może istnieć (jak catalog.possible_variants): zwykłe zawsze, wyjątkowe tylko z jej skrzynek,
// własne warianty karty (Rzulty - tylko Jan Paweł II) i połączenia flagi z każdym z nich
function possibleVariants(p) {
  if (isSpecialCard(p)) return [p.fixedVariant];   // karta specjalna istnieje tylko w jednym wariancie
  const extra = new Set(), V = S.cfg.variants, crates = p.crates || [p.crate], now = Date.now() / 1000;
  crates.forEach(c => { if (crateOf(c)) (crateOf(c).variants || []).forEach(v => { if ((v !== "flag" || p.country) && variantReleased(v)) extra.add(v); }); });
  S.cfg.variantOrder.forEach(v => {   // własne warianty karty i warianty z wydarzeń (już rozpoczętych) w jej skrzynkach
    if (V[v].cards?.includes(p.id) || (!V[v].special && (v !== "flag" || p.country) && (S.cfg.variantCfg?.[v]?.events || [])
      .some(e => e.start <= now && (!e.crates.length || e.crates.some(c => crates.includes(c)))))) extra.add(v);
  });
  const base = S.cfg.variantOrder.filter(v => !V[v].combo && (v === "normal" || extra.has(v) || (!V[v].exclusive && variantReleased(v))));
  const combos = new Set(base.filter(l => V[l].layer && !V[l].noCombo).flatMap(l => base.filter(b => b !== "normal" && !V[b].layer).map(b => `${l}+${b}`)));
  return S.cfg.variantOrder.filter(v => base.includes(v) || combos.has(v));
}
// Warstwy wariantu: flaga leży na osobnej warstwie, więc karta może być np. "flag+gold" (Flagowa + Złota)
function variantParts(v) { return S.cfg.variants[v || "normal"]?.layers || [v || "normal"]; }
function isCombo(v) { return !!S.cfg.variants[v]?.combo; }
// wariant z warstwy zwykłych wariantów (bez flagi) - od niego zależy zdjęcie i kolor plakietki
function baseVariant(v) { const parts = variantParts(v); return parts[parts.length - 1]; }
// klasy wyglądu: "v-flag v-gold v-combo" (prefix "avv-" dla ikon graczy)
function vClass(v, prefix = "v-") {
  const parts = variantParts(v);
  return parts.map(x => prefix + x).join(" ") + (parts.length > 1 ? ` ${prefix}combo` : "");
}
// klasa koloru (kropki, plakietki, przyciski): połączony wariant = kolor zwykłego wariantu z obwódką flagi
function vtClass(v) { return isCombo(v) ? `vt-${baseVariant(v)} vt-combo vt-l-${variantParts(v)[0]}` : `vt-${v || "normal"}`; }
// ikony warstw (przy połączonych wariantach)
const LAYER_ICONS = { flag: "🏳️", halloween: "🎃", lantern: "🏮", devil: "😈" };
// szansa na wariant przy wypadnięciu karty (avail = warianty możliwe w skrzynce, z crateVariants; crate - do wydarzeń)
function variantChance(avail, v, crate = null) {
  const V = S.cfg.variants, ch = x => vChance(x, crate);
  // warianty "always" (halloweenowe): w tej skrzynce każda karta ma jeden z nich (wg "weight"), zwykły losuje się normalnie
  const always = avail.filter(x => V[x].always);
  if (always.length) {
    const w = x => (V[x].weight || 1) * (variantEvent(x, crate?.id)?.boost || 1);
    const share = x => always.includes(x) ? w(x) / always.reduce((a, y) => a + w(y), 0) : 0;
    const bases = avail.filter(x => !V[x].layer), rest = 1 - bases.reduce((a, x) => a + ch(x), 0);
    // "noCombo" (Lampionowa, Diabelska): karta ma tylko ten wariant, bez zwykłego
    if (!isCombo(v)) return share(v) * (V[v]?.noCombo ? 1 : rest);
    const layer = variantParts(v)[0];
    return bases.includes(baseVariant(v)) && !V[layer].noCombo ? share(layer) * ch(baseVariant(v)) : 0;
  }
  if (!isSpecial(v)) return 1 - avail.reduce((a, x) => a + ch(x), 0);
  if (isCombo(v)) {
    const [layer, base] = variantParts(v);
    const bases = avail.filter(x => !V[x].layer), tot = bases.reduce((a, x) => a + ch(x), 0);
    return avail.includes(layer) && bases.includes(base) && tot ? ch(layer) * V[layer].extraChance * ch(base) / tot : 0;
  }
  if (!avail.includes(v)) return 0;
  return ch(v) * (1 - (V[v].extraChance || 0));
}
// rodzaje zdolności: ofensywna, defensywna, lecząca, ekonomiczna
const KIND_ICONS = { off: "⚔", def: "🛡", heal: "💚", eco: "🪙" };
const KIND_LABELS = { off: "Atak", def: "Obrona", heal: "Leczenie", eco: "Ekonomia" };
function kindIcon(k) { return KIND_ICONS[k] || KIND_ICONS.off; }

// Sortowanie kart w listach do wyboru (kuźnia, kasyno, rynek, wymiany, ikona gracza): elementy { person, variant, value, id? }
const CARD_SORTS = [["value", "💰 Najdroższe"], ["valueAsc", "💰 Najtańsze"], ["rarity", "💎 Rzadkość"],
                    ["variant", "✨ Wariant"], ["name", "🔤 Nazwa"], ["new", "🕒 Najnowsze"], ["dupes", "🔁 Duplikaty"]];
// listy bez sensu dla "Duplikaty" (karty do zdobycia, nie egzemplarze gracza): cele ulepszacza, szukane na rynku, ikona gracza
const UNIQUE_SORTS = CARD_SORTS.filter(([k]) => k !== "new" && k !== "dupes");
// ile egzemplarzy tej karty w tym wariancie ma gracz (osoba + wariant)
function dupKey(x) { return x.person + "|" + (x.variant || "normal"); }
function ownCounts() {
  const m = new Map();
  for (const i of S.items) m.set(dupKey(i), (m.get(dupKey(i)) || 0) + 1);
  return m;
}
function sortCards(list, mode = "value") {
  const name = x => { const p = person(x.person); return !p || p.masked ? "￿" : p.name; };
  const byName = (a, b) => name(a).localeCompare(name(b), "pl");
  const num = x => (typeof x.id === "number" ? x.id : 0);
  let dup = () => 0;
  if (mode === "dupes") {   // moje karty: ile mam ich łącznie (też ⭐), cudze (wymiany): ile jest ich na tej liście
    const own = ownCounts(), mine = new Set(S.items.map(i => i.id)), here = new Map();
    for (const x of list) here.set(dupKey(x), (here.get(dupKey(x)) || 0) + 1);
    dup = x => (mine.has(x.id) ? own : here).get(dupKey(x)) || 0;
  }
  const cmp = {
    // duplikaty na górze (najwięcej egzemplarzy najpierw), takie same karty obok siebie
    dupes: (a, b) => (dup(b) > 1) - (dup(a) > 1) || dup(b) - dup(a) || byName(a, b) || varRank(b.variant) - varRank(a.variant) || b.value - a.value,
    value: (a, b) => b.value - a.value || byName(a, b),
    valueAsc: (a, b) => a.value - b.value || byName(a, b),
    rarity: (a, b) => rarityIdx(person(b.person).rarity) - rarityIdx(person(a.person).rarity) || varRank(b.variant) - varRank(a.variant) || byName(a, b),
    variant: (a, b) => varRank(b.variant) - varRank(a.variant) || b.value - a.value || byName(a, b),
    name: (a, b) => byName(a, b) || varRank(b.variant) - varRank(a.variant),
    new: (a, b) => num(b) - num(a) || b.value - a.value,
  }[mode] || ((a, b) => b.value - a.value);
  return list.slice().sort(cmp);
}
// lista wyboru sortowania; attr - atrybut, po którym widok rozpozna zmianę (np. 'data-cssort="rl"')
function sortSelectHTML(mode, attr, options = CARD_SORTS) {
  return `<select class="sort-sel" ${attr} title="Sortowanie">${options.map(([v, n]) =>
    `<option value="${v}"${v === mode ? " selected" : ""}>${n}</option>`).join("")}</select>`;
}
// Wyszukiwanie kart w listach do wyboru (kuźnia, kasyno, rynek, wymiany, ikona gracza): po nazwie, wariancie i rzadkości,
// bez wielkich liter i polskich znaków ("zlota" znajdzie "Złota"); kilka słów = karta musi pasować do każdego
function searchNorm(s) { return String(s || "").toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function cardSearchText(pid, variant) {
  const p = person(pid);
  return p ? searchNorm(`${p.name} ${variantName(variant)} ${S.cfg.rarities[p.rarity].name}`) : "";
}
function searchMatch(text, q) { return searchNorm(q).split(/\s+/).filter(Boolean).every(w => text.includes(w)); }
function cardMatches(x, q) { return !q || !q.trim() || searchMatch(cardSearchText(x.person, x.variant), q); }
// Kliknięcie karty w kuźni / kasynie przerysowuje cały panel - listy kart z atrybutem data-keep nie wracają wtedy na górę.
// --pick-h: wysokość kafelka (style.css: kafelki poza ekranem mają tę wysokość, zanim się narysują - przewinięcie się zgadza)
function keepScroll(root, render) {
  const kept = {};
  root.querySelectorAll("[data-keep]").forEach(g => { kept[g.dataset.keep] = [g.scrollTop, g.querySelector(".pick")?.offsetHeight]; });
  render();
  root.querySelectorAll("[data-keep]").forEach(g => {
    const [top, h] = kept[g.dataset.keep] || [];
    if (h) g.style.setProperty("--pick-h", h + "px");
    if (top) g.scrollTop = top;
  });
}
// nowa zawartość listy (inna rzadkość, wyszukiwanie, sortowanie) - lista zaczyna się od góry
function resetKeep(key) { $$(`[data-keep="${key}"]`).forEach(g => { g.scrollTop = 0; }); }
function flagUrl(country) { return `/flag/${encodeURIComponent(country)}.svg`; }
function person(id) { return S.cfg.people[id]; }
// karta specjalna (rzadkość Specjalna): tylko z kasyna albo z linku, jeden wariant; nie da się jej sprzedać grze,
// postawić ani zużyć w kuźni (można ją wymienić albo sprzedać na rynku). p - karta albo jej id.
function isSpecialCard(p) { p = typeof p === "string" ? person(p) : p; return p?.rarity === "special"; }
function crateOf(id) { return S.cfg.crates[id]; }
function crateList() { return S.cfg.crateOrder.map(id => S.cfg.crates[id]); }
function isSpecial(v) { return !!v && v !== "normal"; }
function variantName(v) { return S.cfg.variants[v || "normal"].name; }
function cardValue(pid, v = "normal") {
  const p = person(pid);  // valueMult: karty tylko z droższych skrzynek są warte więcej (liczy serwer)
  return Math.round(S.cfg.rarities[p.rarity].value * (p.valueMult || 1) * S.cfg.variants[v || "normal"].mult);
}
// zdjęcie karty; wariant z własnym zdjęciem (np. Rzulty Jana Pawła II) -> /img/<id>/<wariant>
// (połączony wariant, np. halloween+gold: zdjęcie tej warstwy, która ma własne zdjęcie)
// small - mały kafelek (bęben, kuźnia, kasyno...): serwer wysyła lekką miniaturę zamiast pełnego zdjęcia
function imgUrl(pid, variant = null, small = false) {
  // część wariantu z własnym zdjęciem, a gdy brak - zdjęcie z "photoFallback" (Lampionowa -> Halloweenowa)
  const p = person(pid), has = x => x && p.variantPhotos?.[x] != null, parts = variant ? variantParts(variant) : [];
  const part = parts.find(has) || parts.map(x => S.cfg?.variants[x]?.photoFallback).find(has);
  const vv = part ? p.variantPhotos[part] : null;
  return `/img/${p.imgAs || pid}${vv != null ? "/" + part : ""}?v=${vv ?? (p.imgv || 0)}${small ? "&s=1" : ""}${p.imgq ? "&" + p.imgq : ""}`;
}
// ikona gracza: zdjęcie wybranej karty albo emoji
function avatarHTML(u, cls = "av") {
  if (u && u.avatarCard) {
    const rc = S.cfg?.rarities[u.avatarRarity]?.color || "#ffffff55";
    return `<span class="${cls} av-card ${S.cfg ? vClass(u.avatarVariant, "avv-") : "avv-" + (u.avatarVariant || "normal")}${u.avatarRarity === "secret" ? " av-secret" : ""}" style="--rc:${rc}"><img src="/avatar/${encodeURIComponent(u.username)}?c=${encodeURIComponent(u.avatarCard)}" alt="" draggable="false"></span>`;
  }
  return `<span class="${cls}">${esc(u?.avatar || "😎")}</span>`;
}

function crateStyle(c) {
  return `--crate-bg: linear-gradient(180deg, ${c.color1} 0 50%, ${c.color2} 50%); --crate-lid: linear-gradient(180deg, ${c.color1}, ${c.color2}); --c1: ${c.color2}`;
}

// ================================================================ KARTA

// efekty wariantu na karcie - połączony wariant (np. flag+gold) dostaje efekty obu warstw i dwie plakietki
function variantLayers(v, p = null) {
  const parts = variantParts(v).filter(isSpecial);
  let html = "";
  for (const x of parts) {
    if (x === "royal") html += '<div class="gold-sheen"></div><div class="royal-border"></div><div class="royal-crown"></div>';
    if (x === "mlg") html += mlgDeco(p);
    if (x === "flag") html += '<div class="flag-tint"></div><div class="flag-wave"></div>';
    if (x === "halloween") html += halloweenDeco();
    if (x === "lantern") html += lanternDeco();
    if (x === "devil") html += devilDeco();
    if (x === "toxic") html += toxicDeco();
    if (x === "blueprint" && p) html += `<div class="bpr-title">PROJ. ${esc(p.name.toUpperCase())}<br>SKALA 1:1 · ARK. ${p.number || 1}/${crateOf(p.crate)?.people.length || 96}</div>`;
    if (VX_DECO[x]) html += VX_DECO[x](p);
    if (x === "holo") html += '<div class="holo-layer"></div>';
    if (x === "gold" || x === "silver" || x === "bronze") html += '<div class="gold-sheen"></div>';
    if (x === "clear") html += '<div class="clear-sheen"></div>';
    // nad kartą: migoczące gwiazdy i co jakiś czas spadająca gwiazda (każda karta w innym momencie i miejscu)
    if (x === "galaxy") html += `<div class="galaxy-stars"></div><div class="galaxy-shoot" style="--sd:-${rand(0, 11).toFixed(1)}s;--st:${Math.round(rand(4, 50))}%;--sl:${Math.round(rand(-30, 10))}%"><i></i></div>`;
    if (x === "negative") html += '<div class="neg-grain"></div>';
    if (x === "joker") html += jokerDeco();
    if (x === "jeans") html += jeansDeco();
    if (x === "ufo") html += ufoDeco(p);
    if (GEMS.includes(x)) html += '<div class="diamond-layer"></div><div class="diamond-glints"><i></i><i></i><i></i><i></i><i></i></div>';
    if (S.cfg.variants[x]?.stickers !== "under") html += stickersHTML(x, stickerList(x, p));   // "under" - pod zdjęciem (underStickersHTML)
  }
  parts.forEach((x, i) => {
    const cls = `var-tag vt-${x}${i ? " vt-second" : ""}`;
    html += x === "flag" && p?.country
      ? `<div class="${cls}"><img src="${flagUrl(p.country)}" alt="">${esc(p.country.toUpperCase())}</div>`
      : `<div class="${cls}">${VARIANT_TAGS[x]}</div>`;
  });
  return html;
}

// Galaktyczna: ruchome tło kosmosu w środku karty (pod napisami i zdjęciem) - trzy mgławice i dwie warstwy gwiazd
// Losowe gwiazdy (SVG, za każdym razem inne): pojedyncze w różnych miejscach, gromady wokół kilku punktów i kilka
// jaśniejszych "iskier" z promieniami; część gwiazd migocze (klasy tw1-tw3), w = szerokość, h = wysokość pola
function galaxyStars(w, h, solo, clumps, sparkles, size = 1) {
  const tint = () => ["#ffffff", "#ffffff", "#ffe3f6", "#dcecff"][Math.floor(Math.random() * 4)];
  const tw = () => (Math.random() < 0.4 ? ` class="tw${1 + Math.floor(Math.random() * 3)}"` : "");
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  let out = "";
  const star = (x, y, r, o) => { out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * size).toFixed(2)}" fill="${tint()}" opacity="${o.toFixed(2)}"${tw()}/>`; };
  for (let i = 0; i < solo; i++) star(rand(0, w), rand(0, h), rand(0.25, 0.75) ** 1.6 + 0.12, rand(0.35, 1));
  for (let c = 0; c < clumps; c++) {
    const cx = rand(0, w), cy = rand(0, h), spread = rand(3, 9), n = 7 + Math.floor(rand(0, 12));
    for (let i = 0; i < n; i++) star(cx + gauss() * spread, cy + gauss() * spread * rand(0.5, 1.2), rand(0.12, 0.4), rand(0.4, 0.95));
  }
  for (let i = 0; i < sparkles; i++) {
    const x = rand(5, w - 5), y = rand(5, h - 5), l = rand(1.8, 3.4) * size, t = 0.22 * size;
    out += `<g class="tw${1 + (i % 3)} gx-spark" opacity="0.95"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.55 * size).toFixed(2)}" fill="#fff"/>` +
      `<path d="M${x} ${y - l}L${x + t} ${y}L${x} ${y + l}L${x - t} ${y}Z M${x - l} ${y}L${x} ${y - t}L${x + l} ${y}L${x} ${y + t}Z" fill="#fff"/></g>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${out}</svg>`;
}

// Galaktyczna: ruchome tło kosmosu w środku karty (pod napisami i zdjęciem) - mgławice w różu, magencie i fiolecie
// z niebieską poświatą + dwie warstwy losowych gwiazd (dalsza wolniej, bliższa szybciej)
function galaxyBG(variant) {
  if (!variantParts(variant).includes("galaxy")) return "";
  return `<div class="galaxy-bg"><i class="gx-neb n1"></i><i class="gx-neb n2"></i><i class="gx-neb n3"></i><i class="gx-neb n4"></i>` +
    `<i class="gx-stars s1">${galaxyStars(100, 140, 55, 3, 0, 0.9)}</i><i class="gx-stars s2">${galaxyStars(100, 140, 14, 1, 3, 1.2)}</i></div>`;
}
// ...i ta sama galaktyka na zdjęciu: kosmiczne zabarwienie, mgławica i gwiazdy na postaci (jak skórka Galaxy)
function galaxyPhoto(variant) {
  if (!variantParts(variant).includes("galaxy")) return "";
  return `<i class="gx-photo"><i class="gx-neb n1"></i><i class="gx-neb n3"></i><i class="gx-stars s1">${galaxyStars(100, 100, 28, 2, 2, 1)}</i></i>`;
}

// Halloweenowa (symbole SVG #hw-* z templates/index.html): nietoperze przelatujące nad kartą...
const hwUse = (id, cls, style = "") => `<svg class="${cls}" style="${style}" aria-hidden="true"><use href="#${id}"/></svg>`;
function halloweenDeco() {
  const bat = (k, d) => `<i class="hw-bat b${k}" style="animation-delay:-${d.toFixed(1)}s">${hwUse("hw-bat", "hw-bat-svg")}</i>`;
  return `<div class="hw-deco">${bat(1, rand(0, 9))}${bat(2, rand(0, 12))}${bat(3, rand(0, 15))}</div>`;
}
// ...a na zdjęciu: księżyc w rogu, migoczące dynie-lampiony na dole i czaszka
function halloweenPhoto(variant) {
  if (!variantParts(variant).includes("halloween")) return "";
  return `<i class="hw-photo"><i class="hw-moon"></i><span class="hw-pumpkins">${hwUse("hw-pumpkin", "hw-p1")}${hwUse("hw-pumpkin", "hw-p2")}${
    hwUse("hw-pumpkin", "hw-p3")}</span>${hwUse("hw-skull", "hw-skull")}</i>`;
}
// Lampionowa: karta w blasku świecy - iskry unoszące się z dołu i dwie migoczące dynie w dolnych rogach
const embersHTML = (n, cls) => Array.from({ length: n }, () =>
  `<i class="${cls}" style="left:${rand(5, 90).toFixed(0)}%;animation-delay:-${rand(0, 5).toFixed(1)}s;animation-duration:${rand(3.5, 6.5).toFixed(1)}s"></i>`).join("");
function lanternDeco() {
  return `<div class="hw-deco lt-deco">${embersHTML(9, "lt-ember")}${hwUse("hw-pumpkin", "lt-cp l")}${hwUse("hw-pumpkin", "lt-cp r")}</div>`;
}
// Diabelska: płomienie od dołu karty (pod napisami) i rogi wystające nad kartę
function devilBG(variant) {
  if (!variantParts(variant).includes("devil")) return "";
  return `<div class="dv-bg">${[6, 20, 34, 48, 62, 76].map((x, k) =>
    `<i class="dv-flame" style="left:${x}%;animation-delay:-${(k * .37).toFixed(2)}s;animation-duration:${rand(.8, 1.4).toFixed(2)}s"></i>`).join("")}</div>`;
}
function devilDeco() { return `<div class="dv-out">${hwUse("dv-horn", "dv-horn l")}${hwUse("dv-horn", "dv-horn r")}</div>`; }

// Perłowa, Vintage, Marmurowa, Toksyczna, Pop-art: tło w środku karty (pod napisami - .vx-bg) i nakładki na zdjęcie
// (.vx-photo, na tajnej karcie w .sc-art). Perłowa: masa perłowa przesuwająca się po karcie i perłowy połysk zdjęcia;
// Vintage: ziarno, rysy i winieta starej fotografii; Marmurowa: zdjęcie jak biały posąg; Toksyczna: jarzący się szlam
// i bąbelki; Pop-art: zdjęcie cztery razy w kratce 2 x 2, każde w innym jaskrawym kolorze (jak sitodruk Warhola).
function variantBG(variant) {
  const parts = variantParts(variant);
  let html = "";
  if (parts.includes("pearl")) html += '<i class="pl-nacre"></i>';
  if (parts.includes("glass")) html += `${glassShards()}<i class="gl-cool"></i>`;
  if (parts.includes("thermal")) html += '<i class="ht-blob h1"></i><i class="ht-blob h2"></i><i class="ht-blob h3"></i>';
  if (parts.includes("toxic")) html += `<i class="tx-glow"></i>${Array.from({ length: 7 }, () =>
    `<i class="tx-bub" style="left:${rand(10, 85).toFixed(0)}%;--s:${rand(.5, 1.5).toFixed(2)};animation-delay:-${rand(0, 9).toFixed(1)}s;animation-duration:${rand(5, 10).toFixed(1)}s"></i>`).join("")}`;
  for (const x of parts) if (VX_BG[x]) html += VX_BG[x]();
  return html ? `<div class="vx-bg">${html}</div>` : "";
}
function variantPhoto(variant, p) {
  const parts = variantParts(variant);
  let html = "";
  if (parts.includes("popart")) html += ["#ff4fa0", "#ffe13b", "#2fd0ff", "#7cff4a"].map((c, k) =>
    `<i class="vx-photo pa-quad q${k + 1}" style="--c:${c}"><img src="${imgUrl(p.id, variant)}" alt="" loading="lazy" draggable="false"></i>`).join("");
  if (parts.includes("pearl")) html += '<i class="vx-photo pl-sheen"></i>';
  if (parts.includes("glass")) html += '<i class="vx-photo gl-shine"></i>';
  if (parts.includes("blueprint")) html += '<i class="vx-photo bp-dims"><b class="w">63 mm</b><b class="h">88 mm</b></i>';
  if (parts.includes("glitch")) html += '<span class="gt-err">⚠ file_corrupted.jpg</span>';
  if (parts.includes("vintage")) html += '<i class="vx-photo vp-grain"></i><i class="vx-photo vp-scratch"></i><i class="vx-photo vp-vignette"></i>';
  if (parts.includes("marble")) html += '<i class="vx-photo mr-statue"></i>';
  if (parts.includes("toxic")) html += '<i class="vx-photo tx-photo"></i>';
  for (const x of parts) if (VX_PHOTO[x]) html += typeof VX_PHOTO[x] === "function" ? VX_PHOTO[x]() : VX_PHOTO[x];
  return html;
}
// Toksyczna: kałuża jarzącego się szlamu na dole karty
function toxicDeco() {
  return '<div class="tx-puddle"><svg viewBox="0 0 66 6" preserveAspectRatio="none" aria-hidden="true"><path d="M0 1.6 Q10 -.2 20 1.2 T40 .8 T58 .4 T66 1.2 V6 H0Z"/></svg></div>';
}
// Vintage: zamiast "typ · skrzynka" pieczątka atelier fotograficznego (podtytuł z panelu admina ma pierwszeństwo)
const VINTAGE_STAMP = "Atelier ScamBox · Warszawa · 1887";
// Pikselowa (16-bitowa gra RPG): zdjęcie przerysowane w canvasie - zmniejszone do 58 pikseli szerokości (wykadrowane jak
// w ramce zdjęcia), 6 poziomów na kanał z lekkim ditheringiem - i pokazane powiększone (image-rendering: pixelated).
// Wynik w pamięci (PX_CACHE), żeby ta sama karta w ekwipunku nie liczyła się kilka razy.
const PX_CACHE = new Map();
const PX_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// zdjęcie przerysowane w canvasie po wczytaniu: Pikselowa (pxPhoto) albo Witrażowa (glassPhoto)
// (Neonowa, Termowizyjna: fxPhoto)
const photoFx = variant => {
  const parts = variantParts(variant);
  return parts.includes("pixel") ? ' onload="pxPhoto(this)"' : parts.includes("glass") ? ' onload="glassPhoto(this)"'
    : (fx => fx ? ` onload="fxPhoto(this,'${fx}')"` : "")([...Object.keys(FX_KINDS), "glitch"].find(k => parts.includes(k)));
};
// Neonowa: krawędzie zdjęcia (Sobel na rozmytej szarości) - najmocniejsze 13% jako rurki w różu / błękicie / żółci (wg koloru
// zdjęcia w tym miejscu), reszta przezroczysta; Termowizyjna: "ciepło" = odcień skóry + trochę jasności, paleta jak w kamerze
// (fiolet - czerwień - żółć - biel), liczone w 70 px i powiększane z wygładzeniem. Wynik w pamięci (FX_CACHE).
const FX_CACHE = new Map();
const HEAT_RAMP = [[0, [5, 2, 26]], [.18, [42, 10, 106]], [.36, [138, 26, 138]], [.52, [216, 48, 58]], [.68, [240, 122, 26]], [.84, [255, 210, 63]], [1, [255, 251, 232]]];
function fxCrop(img, ratio, W) {
  const H = Math.round(W / ratio), c = document.createElement("canvas"), nw = img.naturalWidth, nh = img.naturalHeight;
  c.width = W; c.height = H;
  let sx = 0, sy = 0, sw = nw, sh = nh;
  if (nw / nh > ratio) { sw = nh * ratio; sx = (nw - sw) / 2; } else { sh = nw / ratio; sy = (nh - sh) * .18; }
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  return [c, ctx, W, H];
}
// Przerysowania zdjęcia po wczytaniu: (img, proporcje, szerokość ekranowa) -> canvas. Blueprint: kontur białą kreską; Dolarowa:
// rycina (poziome faliste linie, grubsze w cieniach) zielonym tuszem, na ekranową rozdzielczość (bez mory); Glitch: patrz glitchPhoto
const FX_KINDS = {
  neon: img => neonCanvas(img, ...fxArgs(img)), thermal: img => heatCanvas(img, ...fxArgs(img)),
  blueprint: img => linesCanvas(img, fxArgs(img)[0], "#e8f4ff"),
  mosaic: img => mosaicCanvas(img, fxArgs(img)[0]),
};
const fxArgs = img => [img.closest(".sc-art") ? 63 / 88 : 1 / .96, Math.max(120, Math.round((img.parentElement?.offsetWidth || 150) * (window.devicePixelRatio || 1)))];
function fxPhoto(img, kind) {
  if (img.dataset.fx) return;
  img.dataset.fx = "1";
  const [ratio] = fxArgs(img), key = `${kind}|${img.src}|${ratio}`;
  if (kind === "glitch") return glitchPhoto(img, ratio, key);
  if (FX_CACHE.has(key)) { img.src = FX_CACHE.get(key); return; }
  try {
    const url = FX_KINDS[kind](img).toDataURL();
    FX_CACHE.set(key, url);
    img.src = url;
  } catch (e) { /* nie udało się przerysować - zostaje zwykłe zdjęcie */ }
}
// kontur: krawędzie zdjęcia (Sobel na rozmytej szarości) - najmocniejsza część "keep" w kolorze color, reszta przezroczysta
function linesCanvas(img, ratio, color, keep = .13, W = 220) {
  const [c, ctx, , H] = fxCrop(img, ratio, W), d = ctx.getImageData(0, 0, W, H), s = d.data, col = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const g = new Float32Array(W * H), b = new Float32Array(W * H), m = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = .3 * s[i * 4] + .59 * s[i * 4 + 1] + .11 * s[i * 4 + 2];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let t = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) t += g[(y + j) * W + x + i];
    b[y * W + x] = t / 9;
  }
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const k = y * W + x;
    const gx = b[k - W + 1] + 2 * b[k + 1] + b[k + W + 1] - b[k - W - 1] - 2 * b[k - 1] - b[k + W - 1];
    const gy = b[k + W - 1] + 2 * b[k + W] + b[k + W + 1] - b[k - W - 1] - 2 * b[k - W] - b[k - W + 1];
    m[k] = Math.hypot(gx, gy);
  }
  const t = Float32Array.from(m).sort()[Math.floor(m.length * (1 - keep))];
  for (let k = 0; k < W * H; k++) {
    const i = k * 4;
    if (m[k] <= t) { s[i + 3] = 0; continue; }
    s[i] = col[0]; s[i + 1] = col[1]; s[i + 2] = col[2]; s[i + 3] = Math.min(255, 110 + (m[k] - t) * 3);
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
// Mozaikowa: zdjęcie zmniejszone do 34 kolumn, każde pole przemalowane na najbliższy kolor klocka i narysowane jako klocek z nopkiem
const BRICK_PAL = ["#c91a09", "#0055bf", "#f2cd37", "#237841", "#ffffff", "#05131d", "#fe8a18", "#a0a5a9", "#6c6e68", "#582a12", "#d09168", "#e4cd9e", "#e4adc8", "#9bd7d6", "#bbe90b"]
  .map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
function mosaicCanvas(img, ratio) {
  const cols = 34, cell = 10, [, sctx, , rows] = fxCrop(img, ratio, cols), d = sctx.getImageData(0, 0, cols, rows).data;
  const c = document.createElement("canvas"); c.width = cols * cell; c.height = rows * cell;
  const g = c.getContext("2d"), shade = (col, f) => `rgb(${col.map(v => Math.round(Math.min(255, v * f))).join(",")})`;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = (y * cols + x) * 4, r = (d[i] - 128) * 1.12 + 128, gg = (d[i + 1] - 128) * 1.12 + 128, b = (d[i + 2] - 128) * 1.12 + 128;
    let best = 0, bd = 1e9;
    BRICK_PAL.forEach((p, k) => { const dd = 2 * (r - p[0]) ** 2 + 4 * (gg - p[1]) ** 2 + 3 * (b - p[2]) ** 2; if (dd < bd) { bd = dd; best = k; } });
    const col = BRICK_PAL[best], px = x * cell, py = y * cell, cx = px + cell / 2, cy = py + cell / 2;
    g.fillStyle = shade(col, .7); g.fillRect(px, py, cell, cell);
    g.fillStyle = shade(col, 1); g.beginPath(); g.arc(cx, cy, cell * .38, 0, 7); g.fill();
    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1.2; g.beginPath(); g.arc(cx, cy, cell * .3, 3.4, 4.8); g.stroke();
    g.strokeStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.arc(cx, cy, cell * .3, .3, 1.7); g.stroke();
  }
  return c;
}
// Glitch "zepsuty plik": bloki 8 x 8 przesunięte w bok, z odwróconymi albo przesuniętymi kolorami, i kilka pasów z powtórzonym
// wierszem. Zdjęcie jest RUCHOME: liczymy 4 różne wersje uszkodzeń; pierwsza leży na stałe, a trzy pozostałe (.gt-fr) co chwilę
// błyskają nad nią w różnych momentach - więc elementy uszkodzenia ciągle się zmieniają (sama animacja opacity - tania)
function corruptCanvas(img, ratio) {
  const [c, ctx, W, H] = fxCrop(img, ratio, 192), d = ctx.getImageData(0, 0, W, H), s = d.data, o = new Uint8ClampedArray(s);
  for (let by = 0; by < H; by += 8) {
    const bad = Math.random() < .3, shift = bad ? Math.floor(rand(-40, 40)) : 0, mode = Math.floor(rand(0, 3));
    for (let bx = 0; bx < W; bx += 8) {
      if (!bad && Math.random() > .05) continue;
      for (let y = by; y < Math.min(H, by + 8); y++) for (let x = bx; x < Math.min(W, bx + 8); x++) {
        const sx = Math.min(W - 1, Math.max(0, x + shift)), i = (y * W + x) * 4, j = (y * W + sx) * 4;
        if (mode === 0) { s[i] = o[j + 2]; s[i + 1] = o[j]; s[i + 2] = o[j + 1]; }
        else if (mode === 1) { s[i] = o[j]; s[i + 1] = o[j + 1] * .3; s[i + 2] = o[j + 2] * 1.6; }
        else { s[i] = 255 - o[j]; s[i + 1] = 255 - o[j + 1]; s[i + 2] = 255 - o[j + 2]; }
      }
    }
  }
  for (let n = 0; n < 4; n++) {
    const y0 = Math.floor(rand(0, H - 12)), hh = Math.floor(rand(3, 12));
    for (let y = y0; y < y0 + hh; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) s[(y * W + x) * 4 + k] = o[(y0 * W + x) * 4 + k];
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
function glitchPhoto(img, ratio, key) {
  try {
    let frames = FX_CACHE.get(key);
    if (!frames) { frames = Array.from({ length: 4 }, () => corruptCanvas(img, ratio).toDataURL("image/jpeg", .85)); FX_CACHE.set(key, frames); }
    img.src = frames[0];
    for (let k = 1; k < 4; k++) img.insertAdjacentHTML("afterend", `<img class="gt-fr" src="${frames[k]}" alt="" draggable="false" style="animation-delay:-${(k * 1.07).toFixed(2)}s">`);
  } catch (e) { /* nie udało się przerysować - zostaje zwykłe zdjęcie */ }
}
function neonCanvas(img, ratio) {
  const [c, ctx, W, H] = fxCrop(img, ratio, 210), d = ctx.getImageData(0, 0, W, H), s = d.data;
  const g = new Float32Array(W * H), b = new Float32Array(W * H), m = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = .3 * s[i * 4] + .59 * s[i * 4 + 1] + .11 * s[i * 4 + 2];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let t = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) t += g[(y + j) * W + x + i];
    b[y * W + x] = t / 9;
  }
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const k = y * W + x;
    const gx = b[k - W + 1] + 2 * b[k + 1] + b[k + W + 1] - b[k - W - 1] - 2 * b[k - 1] - b[k + W - 1];
    const gy = b[k + W - 1] + 2 * b[k + W] + b[k + W + 1] - b[k - W - 1] - 2 * b[k - W] - b[k - W + 1];
    m[k] = Math.hypot(gx, gy);
  }
  const t = Float32Array.from(m).sort()[Math.floor(m.length * .87)];
  for (let k = 0; k < W * H; k++) {
    const i = k * 4;
    if (m[k] <= t) { s[i + 3] = 0; continue; }
    const r = s[i], gg = s[i + 1], bb = s[i + 2];
    const col = r > bb + 30 ? (gg > r * .8 ? [255, 230, 60] : [255, 60, 220]) : [60, 230, 255];
    s[i] = col[0]; s[i + 1] = col[1]; s[i + 2] = col[2]; s[i + 3] = Math.min(255, 130 + (m[k] - t) * 3);
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
function heatCanvas(img, ratio) {
  const [c, ctx, W, H] = fxCrop(img, ratio, 70), d = ctx.getImageData(0, 0, W, H), s = d.data;
  const ramp = t => {
    t = Math.max(0, Math.min(1, t));
    let k = 1;
    while (k < HEAT_RAMP.length - 1 && HEAT_RAMP[k][0] < t) k++;
    const [p0, a] = HEAT_RAMP[k - 1], [p1, b] = HEAT_RAMP[k], f = (t - p0) / (p1 - p0);
    return a.map((v, i) => v + (b[i] - v) * f);
  };
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i], g = s[i + 1], b = s[i + 2], lum = (.3 * r + .59 * g + .11 * b) / 255;
    const skin = Math.max(0, Math.min(1, (r - b - 25) / 90)) * (r >= g ? 1 : .5), out = ramp(.12 + .18 * lum + .72 * skin * (.55 + .45 * lum));
    s[i] = out[0]; s[i + 1] = out[1]; s[i + 2] = out[2];
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
function pxPhoto(img) {
  if (img.dataset.px) return;
  img.dataset.px = "1";
  const ratio = img.closest(".sc-art") ? 63 / 88 : 1 / .96, key = `${img.src}|${ratio}`;
  if (PX_CACHE.has(key)) { img.src = PX_CACHE.get(key); return; }
  try {
    const w = 58, h = Math.round(w / ratio), c = document.createElement("canvas"), nw = img.naturalWidth, nh = img.naturalHeight;
    c.width = w; c.height = h;
    let sx = 0, sy = 0, sw = nw, sh = nh;
    if (nw / nh > ratio) { sw = nh * ratio; sx = (nw - sw) / 2; } else { sh = nw / ratio; sy = (nh - sh) * .18; }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h), px = d.data, q = v => Math.round(Math.max(0, Math.min(255, v)) / 51) * 51;
    for (let i = 0; i < px.length; i += 4) {
      const t = (PX_BAYER[(Math.floor(i / 4 / w) % 4) * 4 + (i / 4) % 4] / 16 - .5) * 12;
      px[i] = q(px[i] + t); px[i + 1] = q(px[i + 1] + t); px[i + 2] = q(px[i + 2] + t);
    }
    ctx.putImageData(d, 0, 0);
    const url = c.toDataURL();
    PX_CACHE.set(key, url);
    img.src = url;
  } catch (e) { /* nie udało się przerysować - zostaje zwykłe zdjęcie */ }
}
// Witrażowa (lampa Tiffany "ważka"): zdjęcie podzielone na ok. 500 kawałków szkła - komórki Woronoja z lekko przesuniętej
// siatki punktów, każdy kawałek w uśrednionym, nasyconym kolorze zdjęcia, jaśniejszy w środku, rozdzielone ołowiem.
// Wynik w pamięci (GL_CACHE); tło z trójkątów szkła w chłodnych barwach - jedno SVG dla wszystkich kart (glassShards).
const GL_CACHE = new Map();
function glassPhoto(img) {
  if (img.dataset.gl) return;
  img.dataset.gl = "1";
  const ratio = img.closest(".sc-art") ? 63 / 88 : 1 / .96, key = `${img.src}|${ratio}`;
  if (GL_CACHE.has(key)) { img.src = GL_CACHE.get(key); return; }
  try {
    const W = 320, H = Math.round(W / ratio), c = document.createElement("canvas"), nw = img.naturalWidth, nh = img.naturalHeight;
    c.width = W; c.height = H;
    let sx = 0, sy = 0, sw = nw, sh = nh;
    if (nw / nh > ratio) { sw = nh * ratio; sx = (nw - sw) / 2; } else { sh = nw / ratio; sy = (nh - sh) * .18; }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H), s = d.data, cols = 22, rows = Math.max(2, Math.round(cols / ratio));
    const cw = W / cols, ch = H / rows, seeds = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++)
      seeds.push([(i + .5 + rand(-.4, .4)) * cw, (j + .5 + rand(-.4, .4)) * ch, rand(-.06, .06)]);
    const cell = new Int32Array(W * H), dist = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const gj = Math.min(rows - 1, Math.floor(y / ch));
      for (let x = 0; x < W; x++) {
        const gi = Math.min(cols - 1, Math.floor(x / cw));
        let best = 0, bd = 1e12;
        for (let j = Math.max(0, gj - 1); j <= Math.min(rows - 1, gj + 1); j++)
          for (let i = Math.max(0, gi - 1); i <= Math.min(cols - 1, gi + 1); i++) {
            const k = j * cols + i, dx = x - seeds[k][0], dy = y - seeds[k][1], dd = dx * dx + dy * dy;
            if (dd < bd) { bd = dd; best = k; }
          }
        cell[y * W + x] = best;
        dist[y * W + x] = Math.min(1, Math.sqrt(bd) / cw);
      }
    }
    const sum = new Float64Array(seeds.length * 4);
    for (let i = 0; i < W * H; i++) { const k = cell[i] * 4; sum[k] += s[i * 4]; sum[k + 1] += s[i * 4 + 1]; sum[k + 2] += s[i * 4 + 2]; sum[k + 3]++; }
    const col = seeds.map((_, k) => {
      const n = sum[k * 4 + 3] || 1, r = sum[k * 4] / n, g = sum[k * 4 + 1] / n, b = sum[k * 4 + 2] / n, gray = (r + g + b) / 3;
      return [gray + (r - gray) * 1.55 + 8, gray + (g - gray) * 1.55 + 8, gray + (b - gray) * 1.55 + 8];
    });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, k = cell[i];
      const lead = (x + 1 < W && cell[i + 1] !== k) || (y + 1 < H && cell[i + W] !== k) || (x > 0 && cell[i - 1] !== k) || (y > 0 && cell[i - W] !== k);
      if (lead) { s[i * 4] = 34; s[i * 4 + 1] = 28; s[i * 4 + 2] = 22; continue; }
      const f = (1.18 - dist[i] * .36 + seeds[k][2] + Math.sin((x + y * .6) * .9 + k) * .025) * (1 + rand(-.04, .04));
      s[i * 4] = col[k][0] * f; s[i * 4 + 1] = col[k][1] * f; s[i * 4 + 2] = col[k][2] * f;
    }
    ctx.putImageData(d, 0, 0);
    const url = c.toDataURL("image/jpeg", .9);
    GL_CACHE.set(key, url);
    img.src = url;
  } catch (e) { /* nie udało się przerysować - zostaje zwykłe zdjęcie */ }
}
let GLASS_SHARDS = null;
function glassShards() {
  if (GLASS_SHARDS) return GLASS_SHARDS;
  const pal = ["#2f7fc0", "#3fa0a0", "#4f8a5a", "#6a5aa8", "#2a5a8a", "#8ac0c0", "#e8a33a"], cols = 14, rows = 20, P = [];
  for (let j = 0; j <= rows; j++) {
    P.push([]);
    for (let i = 0; i <= cols; i++) {
      const ex = i === 0 || i === cols, ey = j === 0 || j === rows;
      P[j].push([i / cols * 63 + (ex ? 0 : rand(-1.4, 1.4)), j / rows * 88 + (ey ? 0 : rand(-1.4, 1.4))]);
    }
  }
  let out = "";
  const pt = a => `${a[0].toFixed(1)} ${a[1].toFixed(1)}`;
  const tri = (a, b, c) => { out += `<path d="M${pt(a)}L${pt(b)}L${pt(c)}Z" fill="${pal[Math.floor(rand(0, pal.length))]}" opacity="${rand(.78, 1).toFixed(2)}"/>`; };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = P[j][i], b = P[j][i + 1], c = P[j + 1][i + 1], d = P[j + 1][i];
    if (Math.random() < .5) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
  }
  GLASS_SHARDS = `<svg viewBox="0 0 63 88" preserveAspectRatio="none" aria-hidden="true"><g stroke="#2a1d12" stroke-width=".7" stroke-linejoin="round">${out}</g></svg>`;
  return GLASS_SHARDS;
}
// pasek postaci nad nazwą (Pikselowa): poziom i pasek HP zależne od punktów życia karty
function pxStatus(p, variant) {
  if (!variantParts(variant).includes("pixel")) return "";
  return `<div class="px-status"><span>LV ${Math.min(99, Math.max(1, Math.round(p.hp / 3)))}</span><span class="px-bar"><i style="width:${Math.min(100, Math.max(12, p.hp / 2.5)).toFixed(0)}%"></i></span></div>`;
}

// ---------------------------------------------------------------- warianty z makiet (strona /variants, domyślnie wyłączone)
// Szlamowa, Matowa czerń, Wyścigowa retro, Bizmutowa, Cyfrowa, Cyberpunk, Gradient, Wanted, Art déco, Serowa.
// VX_BG - tło w środku karty (pod napisami, w .vx-bg), VX_PHOTO - nakładki na zdjęcie (.vx-photo), VX_DECO - nad całą kartą
// (variantLayers), variantTop - pasek nad nazwą, variantSub - tekst zamiast "typ · skrzynka". Wygląd: sekcja w cards2.css.
const vxN = (a, b, d = 0) => rand(a, b).toFixed(d);
const vxSvg = (body, vb = "0 0 63 88", cls = "") => `<svg class="${cls}" viewBox="${vb}" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;
// kapiący płyn z górnej krawędzi (losowe sople) - w jednostkach karty 63 x 88
function vxDrips(color, hi, long = [7, 18]) {
  let d = "M0 0 H63 V3 ", x = 63;
  while (x > 0) {
    const w = +vxN(3, 7, 1), len = Math.random() < 0.45 ? +vxN(...long, 1) : +vxN(3.5, 6, 1), nx = Math.max(0, x - w);
    const mid = (x + nx) / 2, r = Math.min(w / 2, 2.2);
    d += `L${x.toFixed(1)} 3 C${(x - w * .15).toFixed(1)} 3.5 ${(mid + r).toFixed(1)} ${(len - r * 2).toFixed(1)} ${(mid + r).toFixed(1)} ${(len - r).toFixed(1)} ` +
      `A${r} ${r} 0 0 1 ${(mid - r).toFixed(1)} ${(len - r).toFixed(1)} C${(mid - r).toFixed(1)} ${(len - r * 2).toFixed(1)} ${(nx + w * .15).toFixed(1)} 3.5 ${nx.toFixed(1)} 3 `;
    x = nx - +vxN(1, 4, 1);
  }
  d += "L0 3 Z";
  return `<path d="${d}" fill="${color}"/><path d="${d}" fill="none" stroke="${hi}" stroke-width=".35" opacity=".7" transform="translate(-.4 -.5)"/>`;
}
// powierzchnia płynu na wysokości y (fala), zamknięta do dołu karty
const vxWave = (y, amp = 1.6) => `M-1 ${y} Q7 ${y - amp} 15 ${y} T31 ${y} T47 ${y} T63 ${y} L64 ${y} V90 H-1 Z`;
const vxFloat = (n, cls, x = [4, 92]) => Array.from({ length: n }, () =>
  `<i class="${cls}" style="left:${vxN(...x)}%;--s:${vxN(0.5, 1.6, 2)};animation-delay:-${vxN(0, 9, 1)}s;animation-duration:${vxN(5, 11, 1)}s"></i>`).join("");
// Cyfrowa: kolumny znaków lecące z góry na dół (jak w Matrixie)
const DG_CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789Z:.=*+-<>";
const dgRain = n => Array.from({ length: n }, (_, k) => {
  const txt = Array.from({ length: 10 + Math.floor(rand(0, 14)) }, () => esc(DG_CHARS[Math.floor(rand(0, DG_CHARS.length))])).join("<br>");
  return `<i class="dg-col" style="left:${(k / n * 100 + rand(-1, 1)).toFixed(1)}%;animation-duration:${vxN(4, 9, 1)}s;animation-delay:-${vxN(0, 9, 1)}s;font-size:${vxN(2.6, 3.8, 1)}cqw">${txt}</i>`;
}).join("");
// Cyberpunk: nocne miasto z losowymi neonowymi oknami
function cpSkyline(base = 88, colors = ["#ff2bd6", "#00e5ff", "#fcee0a"]) {
  let out = "", x = -1;
  while (x < 64) {
    const w = rand(4, 9), h = rand(12, 38);
    out += `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#0b0618"/>`;
    for (let yy = base - h + 1.5; yy < base - 1; yy += 2.4)
      for (let xx = x + 1; xx < x + w - 1; xx += 1.8)
        if (Math.random() < 0.28) out += `<rect x="${xx.toFixed(1)}" y="${yy.toFixed(1)}" width=".9" height="1.1" fill="${colors[Math.floor(rand(0, colors.length))]}" opacity="${vxN(.5, 1, 2)}"/>`;
    if (Math.random() < 0.3) out += `<rect x="${(x + w / 2 - .15).toFixed(1)}" y="${(base - h - 5).toFixed(1)}" width=".3" height="5" fill="#0b0618"/><circle cx="${(x + w / 2).toFixed(1)}" cy="${(base - h - 5).toFixed(1)}" r=".5" fill="#ff003c"/>`;
    x += w + rand(-.5, 1);
  }
  return out;
}
// Serowa: dziury różnej wielkości na całym tle
const chHoles = (n, big = [6, 16]) => Array.from({ length: n }, () =>
  `<i class="ch-hole" style="left:${vxN(-4, 92)}%;top:${vxN(-3, 95)}%;width:${vxN(...big, 1)}%"></i>`).join("");
// Frutiger Aero, Grecka, Afrykańska, Miodowa, Uliczna, Chińska (druga partia makiet) - kształty SVG w jednostkach karty 63 x 88.
// Gradienty SVG potrzebują unikalnych id (ta sama karta bywa na stronie kilka razy) - vxId.
let vxUid = 0;
const vxId = name => `${name}${++vxUid}`;
const vxPick = arr => arr[Math.floor(Math.random() * arr.length)];
function vxRainbow(cx, cy, r, w = 2.2, op = .75) {
  return ["#ff3b3b", "#ff9a1f", "#ffe13b", "#4fd12a", "#2fa8ff", "#5a4dff", "#b04dff"].map((c, k) => {
    const rr = r - k * w;
    return `<path d="M${cx - rr} ${cy} A${rr} ${rr} 0 0 1 ${cx + rr} ${cy}" fill="none" stroke="${c}" stroke-width="${w + .1}" opacity="${op}"/>`;
  }).join("");
}
// rybka płynąca w prawo (viewBox 0 0 40 24); stripes - białe paski jak u błazenka
const vxFish = (c1, c2, stripes = false) => `<svg viewBox="0 0 40 24" aria-hidden="true"><path d="M10 12 L1 3 L4 12 L1 21 Z" fill="${c2}"/><path d="M17 5 Q23 -2 30 5 Z" fill="${c2}"/>
  <ellipse cx="22" cy="12" rx="14" ry="8.5" fill="${c1}"/>${stripes ? `<ellipse cx="18" cy="12" rx="1.7" ry="8" fill="#fff"/><ellipse cx="27" cy="12" rx="1.5" ry="7.3" fill="#fff"/>` : ""}
  <ellipse cx="22" cy="8" rx="10" ry="3" fill="#fff" opacity=".35"/><circle cx="31" cy="10" r="1.8" fill="#fff"/><circle cx="31.5" cy="10" r=".9" fill="#111"/></svg>`;
const AERO_FISH = [["#ff7a1f", "#ffb03f", true], ["#ffd23f", "#2fa8ff"], ["#3fe0c0", "#2f6bff"]];
// błyszczące zielone wzgórze z trawą i stokrotkami (Frutiger Aero) - od wysokości y do dołu karty
function aeMeadow(g, y = 62) {
  let blades = "", daisies = "";
  for (let x = -2; x < 66; x += rand(1.1, 2.2)) {
    const yy = y - 2.6 * Math.cos((x - 31.5) / 20) + 1, h = rand(2.5, 5.5), lean = rand(-1.4, 1.4);
    blades += `<path d="M${(x - .6).toFixed(1)} ${(yy + 1).toFixed(1)} Q${(x + lean * .5).toFixed(1)} ${(yy - h * .6).toFixed(1)} ${(x + lean).toFixed(1)} ${(yy - h).toFixed(1)} Q${(x + .2).toFixed(1)} ${(yy - h * .5).toFixed(1)} ${(x + .6).toFixed(1)} ${(yy + 1).toFixed(1)} Z" fill="${vxPick(["#5fd61c", "#7ef03a", "#3fae0e"])}"/>`;
  }
  for (let k = 0; k < 7; k++) {
    const x = rand(3, 60), yy = y + rand(4, 18), r = rand(.9, 1.5);
    daisies += `<g transform="translate(${x.toFixed(1)} ${yy.toFixed(1)})">${[0, 60, 120, 180, 240, 300].map(a => `<ellipse rx="${(r * .45).toFixed(2)}" ry="${r.toFixed(2)}" transform="rotate(${a}) translate(0 ${(-r * .7).toFixed(2)})" fill="#fff"/>`).join("")}<circle r="${(r * .45).toFixed(2)}" fill="#ffd23f"/></g>`;
  }
  return `<defs><radialGradient id="${g}" cx=".4" cy="0" r="1.1"><stop offset="0" stop-color="#c8ff6a"/><stop offset=".45" stop-color="#4fbf14"/><stop offset="1" stop-color="#1f7a06"/></radialGradient></defs>
    <path d="M-3 ${y + 3} C14 ${y - 4} 48 ${y - 4} 66 ${y + 3} V92 H-3 Z" fill="url(#${g})"/>
    <path d="M-3 ${y + 3} C14 ${y - 4} 48 ${y - 4} 66 ${y + 3}" fill="none" stroke="#e8ffb0" stroke-width=".5" opacity=".8"/>${blades}${daisies}`;
}
const vxBubbles = (n, cls) => Array.from({ length: n }, () =>
  `<i class="${cls}" style="left:${vxN(4, 92)}%;--s:${vxN(0.5, 1.6, 2)};animation-delay:-${vxN(0, 9, 1)}s;animation-duration:${vxN(5, 11, 1)}s"></i>`).join("");
// pszczoła lecąca w prawo (viewBox 0 0 24 16), skrzydła machają (.bee-wing)
const VX_BEE = `<svg viewBox="0 0 24 16" aria-hidden="true"><ellipse class="bee-wing" cx="10" cy="4" rx="4.2" ry="3.2" fill="#ffffffcc" stroke="#9ab" stroke-width=".3"/>
  <ellipse class="bee-wing b" cx="13" cy="4.4" rx="3.6" ry="2.8" fill="#ffffffaa" stroke="#9ab" stroke-width=".3"/>
  <path d="M3 10 L1 10.6 L3 11.2 Z" fill="#222"/><ellipse cx="11" cy="10.5" rx="8" ry="4.6" fill="#ffc21f"/>
  <path d="M8 6.2 C7 9 7 12 8 14.8 M11.4 6 C10.4 9 10.4 12 11.4 15 M14.8 6.4 C13.8 9 13.8 12 14.8 14.6" stroke="#222" stroke-width="1.6" fill="none"/>
  <circle cx="19.5" cy="9.6" r="2.6" fill="#222"/><circle cx="20.4" cy="9" r=".7" fill="#fff"/><path d="M20 7.2 Q21 4.6 22.6 4.4 M19 7.2 Q19.4 4.6 20.6 3.8" stroke="#222" stroke-width=".4" fill="none"/></svg>`;
const hnBees = n => Array.from({ length: n }, () =>
  `<i class="hn-bee" style="--by:${vxN(8, 70)}%;animation-delay:-${vxN(0, 10, 1)}s;animation-duration:${vxN(8, 13, 1)}s">${VX_BEE}</i>`).join("");
// chiński lampion na sznurku (x, długość sznurka) i złote chmurki xiangyun
function cnLantern(x, len, s = 1) {
  const y = len + 5 * s;
  return `<path d="M${x} -1 V${len}" stroke="#e2b13c" stroke-width=".3"/><rect x="${x - 2 * s}" y="${len}" width="${4 * s}" height="${1.1 * s}" fill="#e2b13c"/>
    <ellipse cx="${x}" cy="${y + .6 * s}" rx="${4.6 * s}" ry="${5 * s}" fill="#d81e1e"/><ellipse cx="${x}" cy="${y + .6 * s}" rx="${2.4 * s}" ry="${5 * s}" fill="none" stroke="#a30d0d" stroke-width=".35"/>
    <ellipse cx="${x - 1.6 * s}" cy="${y - 1 * s}" rx="${1.2 * s}" ry="${2.4 * s}" fill="#ff8a6a" opacity=".5"/>
    <rect x="${x - 2 * s}" y="${y + 5.2 * s}" width="${4 * s}" height="${1.1 * s}" fill="#e2b13c"/><path d="M${x - 1 * s} ${y + 6.3 * s} V${y + 10 * s} M${x} ${y + 6.3 * s} V${y + 10.8 * s} M${x + 1 * s} ${y + 6.3 * s} V${y + 10 * s}" stroke="#e2b13c" stroke-width=".35"/>`;
}
const cnCloud = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 4 C0 1 3 0 4.4 1.6 C5 -.4 9 -.6 9.6 1.8 C11.6 1 13.6 2.6 12.8 4.6 Z M3 3.4 a1.2 1.2 0 1 1 2 .2 M8 2.8 a1.1 1.1 0 1 1 1.8 .4" fill="none" stroke="#e2b13c" stroke-width=".55" stroke-linecap="round"/>`;
// Piwna, Moro, Elektryczna, Neonowa, Synthwave, Emo, Motoryzacyjna (trzecia partia makiet).
// Piwna: piana z koronką na dole i drobnymi bańkami (SVG, wysokość y w jednostkach karty), bąbelki i krople rosy
function brFoam(y, c1 = "#fffdf6", c2 = "#efe0b8", ring = "#d9c79a") {
  const g = vxId("brFoam");
  let d = `M-3 -3 H66 V${y}`;
  for (let x = 66; x > -3;) { const w = rand(1.6, 3.4); d += ` Q${(x - w / 2).toFixed(1)} ${(y + rand(.9, 2.4)).toFixed(1)} ${(x - w).toFixed(1)} ${(y + rand(-.4, .5)).toFixed(1)}`; x -= w; }
  let s = `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset=".7" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <path d="${d} Z" fill="url(#${g})"/>`;
  for (let k = 0; k < 80; k++) {
    const x = rand(-1, 64), yy = rand(-1, y + 1.5), r = rand(.2, .9) * (yy > y - 2.5 ? 1.5 : 1);
    s += `<circle cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="${r.toFixed(2)}" fill="none" stroke="${ring}" stroke-width=".14" opacity=".75"/>`;
    if (r > .5) s += `<circle cx="${(x - r * .35).toFixed(1)}" cy="${(yy - r * .35).toFixed(1)}" r="${(r * .22).toFixed(2)}" fill="#fff"/>`;
  }
  for (let k = 0; k < 9; k++) {
    const x = rand(2, 61), r = rand(.8, 1.6);
    s += `<circle cx="${x.toFixed(1)}" cy="${(y + rand(.2, 1.4)).toFixed(1)}" r="${r.toFixed(2)}" fill="#fff6d455" stroke="#fff" stroke-width=".18"/>`;
  }
  return s;
}
// bąbelki jak w prawdziwym szkle: łańcuszki z kilku punktów na dnie (ten sam x, równe odstępy w czasie) i pojedyncze;
// każdy to osobna kulka z jasnym brzegiem i odblaskiem, która rośnie, przyspiesza i lekko się chwieje w drodze do piany
function brBubbles(chains = 6, per = 5, loose = 8) {
  const bub = (x, sz, dur, delay, sw) => `<i class="br-bub" style="left:${x}%;width:${sz}cqw;--sw:${sw}cqw;animation-duration:${dur}s;animation-delay:-${delay}s"></i>`;
  let out = "";
  for (let c = 0; c < chains; c++) {
    const x = vxN(6, 92, 1), sz = rand(.7, 1.25), dur = rand(3.4, 5.4), sw = vxN(-.9, .9, 2);
    for (let k = 0; k < per; k++) out += bub(x, (sz * rand(.85, 1.1)).toFixed(2), dur.toFixed(2), (dur * k / per).toFixed(2), sw);
  }
  for (let k = 0; k < loose; k++) out += bub(vxN(4, 94, 1), vxN(.5, 1.5, 2), vxN(4.5, 7.5, 2), vxN(0, 7, 2), vxN(-1.6, 1.6, 2));
  return out;
}
// krople rosy na zimnym szkle; część co jakiś czas spływa w dół, zostawiając czysty ślad
const brDew = (n, runs = 0) => Array.from({ length: n }, () =>
  `<i class="br-drop" style="left:${vxN(0, 98)}%;top:${vxN(0, 96)}%;width:${vxN(.7, 2.2, 1)}%"></i>`).join("") +
  Array.from({ length: runs }, () =>
    `<i class="br-run" style="left:${vxN(3, 95)}%;top:${vxN(4, 40)}%;animation-delay:-${vxN(0, 9, 1)}s;animation-duration:${vxN(7, 12, 1)}s"></i>`).join("");
// Moro: nieśmiertelniki z nazwą i numerem karty
const moTags = p => `<i class="mo-tags"><b><span>${esc(p?.name || "SZEREGOWY")}</span><span>NR ${String(p?.number || 7).padStart(4, "0")}-2137</span><span>GR. KRWI 0 RH+</span></b><b></b></i>`;
// Elektryczna: piorun - poszarpana linia od (x1, y1) do (x2, y2) z odgałęzieniami (jednostki karty)
function elBolt(x1, y1, x2, y2, branches = 2, jag = 3) {
  const steps = 10, pts = [[x1, y1]];
  for (let k = 1; k < steps; k++) { const t = k / steps; pts.push([x1 + (x2 - x1) * t + rand(-jag, jag), y1 + (y2 - y1) * t + rand(-jag * .3, jag * .3)]); }
  pts.push([x2, y2]);
  let d = "M" + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L");
  for (let b = 0; b < branches; b++) {
    const [bx, by] = pts[2 + Math.floor(rand(0, steps - 4))], dir = Math.random() < .5 ? -1 : 1;
    let x = bx, y = by; d += ` M${x.toFixed(1)} ${y.toFixed(1)}`;
    for (let k = 0; k < 4; k++) { x += dir * rand(1.5, 4); y += rand(1.5, 4); d += ` L${x.toFixed(1)} ${y.toFixed(1)}`; }
  }
  return d;
}
const elBoltSvg = (d, cls) => `<path class="el-bolt ${cls}" d="${d}"/><path class="el-core ${cls}" d="${d}"/>`;
// Motoryzacyjna: obrotomierz dookoła okrągłego zdjęcia (zdjęcie = promień 11.5 z 20 jednostek tarczy) - podziałka 0-9
// z czerwonym polem, cyfry i krótka wskazówka tylko na pierścieniu; na dole tarczy przerwa (bez obwódki) na podpis karty
function mtGauge() {
  let ticks = "";
  for (let k = 0; k <= 45; k++) {
    const a = (-225 + k * 6) * Math.PI / 180, big = k % 5 === 0, r1 = big ? 15.5 : 17, red = k >= 35;
    ticks += `<path d="M${(20 + Math.cos(a) * r1).toFixed(2)} ${(20 + Math.sin(a) * r1).toFixed(2)} L${(20 + Math.cos(a) * 18.5).toFixed(2)} ${(20 + Math.sin(a) * 18.5).toFixed(2)}" stroke="${red ? "#ff2b2b" : "#f2f2f2"}" stroke-width="${big ? .8 : .35}"/>`;
    if (big) ticks += `<text x="${(20 + Math.cos(a) * 13.6).toFixed(2)}" y="${(20 + Math.sin(a) * 13.6 + .9).toFixed(2)}" font-size="2.6" text-anchor="middle" fill="${red ? "#ff2b2b" : "#f2f2f2"}">${k / 5}</text>`;
  }
  const arc = a => `${(20 + Math.cos(a * Math.PI / 180) * 18.5).toFixed(2)} ${(20 + Math.sin(a * Math.PI / 180) * 18.5).toFixed(2)}`;
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M${arc(-15)} A18.5 18.5 0 0 1 ${arc(45)}" stroke="#ff2b2b55" stroke-width="2.5" fill="none"/>
    ${ticks}<g class="mt-needle"><path d="M20 8.3 L20 1.6" stroke="#ff4a1f" stroke-width="1.1" stroke-linecap="round"/></g></svg>`;
}
// Noir: pionowe rysy na taśmie filmowej, co chwilę w innym miejscu
const nrScratches = n => Array.from({ length: n }, () =>
  `<i class="nr-scratch" style="left:${vxN(6, 94)}%;animation-delay:-${vxN(0, 3, 2)}s;animation-duration:${vxN(1.4, 3.2, 2)}s"></i>`).join("");
const VX_BG = {
  steel: () => '<i class="stl-shine"></i>',
  noir: () => '<i class="nr-rain soft"></i>',
  beer: () => `<i class="br-body"></i>${brBubbles()}`,
  electric: () => '<i class="el-clouds"></i><i class="el-rain"></i>',
  // Synthwave: na dole tła zachodzi słońce w paski (spod paneli z napisami)
  synthwave: () => '<i class="sw-sun"></i><i class="sw-glow"></i>',
  aero: () => `${vxSvg(vxRainbow(10, 40, 26, 1.8, .45), "0 0 63 88", "ae-rainbow")}<i class="ae-cloud c1"></i><i class="ae-cloud c2"></i>${vxSvg(aeMeadow(vxId("aeHill")))}`,
  honey: () => '<i class="hn-shine"></i>',
  chinese: () => vxSvg(cnCloud(6, 40, 1) + cnCloud(42, 60, .9) + cnCloud(10, 78, .8)),
  racing: () => '<i class="rc-band"></i><i class="rc-grain"></i>',
  bismuth: () => '<i class="bi-iso"></i><i class="bi-iso-tint"></i>',
  digital: () => `<span class="dg-rain">${dgRain(14)}</span>`,
  cyber: () => `${vxSvg(cpSkyline(), "0 0 63 88", "cp-city")}<i class="cp-rain"></i>`,
  fade: () => '<i class="fd-sheen"></i>',
  artdeco: () => '<i class="ad-fans"></i>',
  // ser z dziurami (makieta 1.) + trochę niebiesko-zielonej pleśni przy brzegach (makieta 3.)
  cheese: () => `${chHoles(15)}<i class="ch-mold"></i>`,
};
const VX_PHOTO = {
  steel: '<i class="vx-photo stl-cold"></i>',
  // ...i kilka łańcuszków bąbelków na zdjęciu (krótsza droga do góry)
  beer: () => `<i class="vx-photo br-amber"></i><i class="vx-photo br-bubs">${brBubbles(3, 4, 4)}</i><i class="vx-photo br-glass"></i>`,
  electric: '<i class="vx-photo el-strike"></i>',
  aero: '<i class="vx-photo ae-glass"></i>',
  honey: '<i class="vx-photo hn-amber"></i>',
  slime: '<i class="vx-photo sl-tint"></i>',
  bismuth: '<i class="vx-photo bi-oxide"></i>',
  digital: '<i class="vx-photo dg-crt"></i>',
  cyber: '<i class="vx-photo cp-duo"></i>',
  fade: '<i class="vx-photo fd-tint"></i>',
};
const VX_DECO = {
  // Neonowa: rurka neonu dookoła karty z uchwytami
  neon: () => '<div class="vx-deco"><i class="nn-tube"></i><i class="nn-clip a"></i><i class="nn-clip b"></i><i class="nn-clip c"></i><i class="nn-clip d"></i></div>',
  // Stalowa: śruby w rogach karty
  steel: () => `<div class="vx-deco">${["tl", "tr", "bl", "br"].map(c => `<i class="stl-screw ${c}"></i>`).join("")}</div>`,
  // Piwna: piana u góry (nazwa nad nią), oszronione szkło z kroplami rosy - część spływa
  beer: () => `<div class="vx-deco vx-clip">${vxSvg(brFoam(11), "0 0 63 88", "br-foam")}</div><div class="vx-deco vx-clip"><i class="br-frost"></i>${brDew(46, 6)}</div>`,
  moro: p => `<div class="vx-deco"><i class="mo-stitch"></i>${moTags(p)}</div>`,
  // Elektryczna: dwa pioruny w losowych miejscach uderzają w swoim rytmie, przy uderzeniu karta się rozjaśnia
  electric: () => `<div class="vx-deco vx-clip"><i class="el-flash"></i>${vxSvg(elBoltSvg(elBolt(rand(8, 20), -2, rand(14, 30), 60, 3), "s1") +
    elBoltSvg(elBolt(rand(44, 56), -2, rand(36, 52), 50, 2), "s2"))}</div>`,
  synthwave: () => '<div class="vx-deco vx-clip"><i class="sw-track"></i><i class="sw-lines"></i></div>',
  // Noir: klatka starego filmu - perforacja, rysy, kurz, winieta, ziarno i lekkie migotanie
  noir: () => `<div class="vx-deco vx-clip nr-flick"><i class="nr-perf l"></i><i class="nr-perf r"></i>${nrScratches(3)}<i class="nr-dust"></i><i class="nr-vignette"></i><i class="nr-grain"></i></div>`,
  motor: () => `<div class="vx-deco"><i class="mt-gauge">${mtGauge()}</i><i class="mt-shift"></i></div>`,
  // Frutiger Aero: szklany połysk na górnej połowie karty, rybki pływające po niebie i bańki
  aero: () => `<div class="vx-deco"><i class="ae-gloss"></i></div><div class="vx-deco vx-clip">${AERO_FISH.map(([a, b, s], k) =>
    `<i class="ae-fish f${k + 1}" style="animation-delay:-${vxN(0, 12, 1)}s">${vxFish(a, b, s)}</i>`).join("")}${vxBubbles(6, "ae-bubble")}</div>`,
  // Miodowa: miód kapiący z góry i przelatujące pszczoły
  honey: () => `<div class="vx-deco hn-drip">${vxSvg(vxDrips("#f2a20f", "#ffe08a", [8, 16]))}</div><div class="vx-deco vx-clip">${hnBees(2)}</div>`,
  // Chińska: czerwone lampiony ze złotymi frędzlami kołyszą się u góry karty
  chinese: () => `<div class="vx-deco cn-lanterns">${vxSvg(cnLantern(6, 3, .95) + cnLantern(57, 8, 1.1) + cnLantern(48, 1, .7))}</div>`,
  // dolna część karty pływa w szlamie (fala + bąbelki), z góry kapie glut
  slime: () => `<div class="vx-deco sl-flood">${vxSvg(`<path d="${vxWave(60)}" fill="#8cf04a44"/><path d="${vxWave(61.5, 1.2)}" fill="#3fbf1a40"/>`, "0 0 63 88", "sl-wave")}
    ${vxFloat(9, "sl-bub", [6, 90])}</div><div class="vx-deco sl-drip">${vxSvg(vxDrips("#7dff3a", "#d4ffb0", [5, 9]))}</div>`,
  matte: () => '<div class="vx-deco"><i class="mt-stitch"></i></div>',
  racing: p => `<div class="vx-deco"><div class="rc-roundel"><b>${p?.number || 7}</b></div></div>`,
  wanted: () => `<div class="vx-deco"><i class="ww-hole" style="left:${vxN(66, 80)}%;top:${vxN(16, 24)}%"></i><i class="ww-hole" style="left:${vxN(10, 20)}%;top:${vxN(52, 60)}%"></i>` +
    `<i class="ww-hole small" style="left:${vxN(74, 84)}%;top:${vxN(62, 70)}%"></i></div>`,
  artdeco: () => '<div class="vx-deco"><i class="ad-lines"></i></div>',
  // roztopiony ser kapiący z górnej krawędzi (makieta 2.) - krótszy, żeby nie zasłaniał nazwy
  cheese: () => `<div class="vx-deco ch-melt">${vxSvg(vxDrips("#ffc23a", "#fff1a8", [5, 9]))}</div>`,
};
// pasek nad nazwą: okno terminala (Cyfrowa), napis WANTED
function variantTop(variant) {
  const parts = variantParts(variant);
  if (parts.includes("digital")) return '<div class="dg-bar"><i></i><i></i><i></i><span>root@scambox: ~/hack</span></div>';
  if (parts.includes("wanted")) return '<div class="ww-title">WANTED</div>';
  if (parts.includes("synthwave")) return '<div class="sw-osd"><span>▶ PLAY</span><span>SP 0:21:37</span></div>';
  return "";
}
// tekst zamiast "typ · skrzynka" (podtytuł z panelu admina ma pierwszeństwo); null = zwykły
function variantSub(variant, pid) {
  const parts = variantParts(variant);
  if (parts.includes("vintage")) return VINTAGE_STAMP;
  if (parts.includes("noir")) return "— Ta sprawa śmierdziała od początku.";
  // Glitch: kod błędu
  if (parts.includes("glitch")) { const p = person(pid); return `${S.cfg.types[p.type].name} · ${esc(crateOf(p.crate).short)} <b>▓ERR 0x2137</b>`; }
  if (parts.includes("digital")) return "$ ./access --target <b>ACCESS GRANTED</b>";
  if (parts.includes("moro")) return "ODDZIAŁ 2137 · LAS";
  // Wanted: nagroda (wartość karty) zaraz pod DEAD OR ALIVE
  if (parts.includes("wanted")) return `DEAD OR ALIVE<span class="ww-reward">REWARD ${fmt(cardValue(pid, variant))}</span>`;
  return null;
}

// Karty specjalne - wariant Jokerowa "Talia Kasynowa" (joker-talia.css): karta do gry na zielonym suknie - na szerokich
// marginesach indeksy JOKER z czapką błazna (symbol SVG #jk-hat w templates/index.html) i stosy żetonów; nic nie zasłania zdjęcia.
function jokerDeco() {
  const letters = "JOKER".split("").map(l => `<b>${l}</b>`).join("");
  const idx = c => `<span class="jt-idx ${c}">${hwUse("jk-hat", "jt-hat")}${letters}</span>`;
  const chips = (side, colors) => `<span class="jt-chips ${side}">${colors.map(c => `<i class="jt-chip ${c}"></i>`).join("")}</span>`;
  return `<div class="jt-deco"><i class="jt-stitch"></i>${idx("tl")}${idx("br")}${chips("l", ["red", "black", "blue"])}${chips("r", ["purple", "red", "black"])}</div>`;
}
// Karty specjalne - wariant Dżinsowa: dżins, pomarańczowe przeszycia, miedziane nity
function jeansDeco() {
  const rivets = ["tl", "tr", "bl", "br"].map(c => `<i class="dz-rivet ${c}"></i>`).join("");
  return `<div class="dz-deco"><i class="dz-stitch"></i>${rivets}</div>`;
}

// Karta z UFO - wariant ⎍⎎⍜⌰⎍⎅ (static/css/ufo.css, wygląd "Pustka"): obracający się znak, napisy w alfabecie obcych.
// Napisy (deco1 u góry - domyślnie losowe znaki, deco2 na dole) można zmienić w panelu admina (teksty na karcie).
const UFO_GLYPHS = [..."⏃⏚☊⎅⟒⎎☌⊑⟟⟊☍⌰⋔⋏⍜⌿⍾⍀⌇⏁⎍⎐⍙⌖⊬⋉"];
const ufoGlyphs = n => Array.from({ length: n }, () => UFO_GLYPHS[Math.floor(Math.random() * UFO_GLYPHS.length)]).join("");
const UFO_SIGIL = `<i class="uf-sigil"><svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2">
  <polygon points="50,4 92,27 92,73 50,96 8,73 8,27"/><polygon points="50,18 80,35 80,65 50,82 20,65 20,35"/>
  <circle cx="50" cy="50" r="12"/><path d="M50 4V38M50 62v34M8 27l30 17M62 56l30 17M92 27L62 44M38 56L8 73"/></g></svg></i>`;
function ufoDeco(p) {
  const T = p ? cardTexts(p) : (k, h) => h;
  return `<div class="uf-deco">${UFO_SIGIL}<span class="uf-ring">${T("deco1", ufoGlyphs(14))}</span>` +
    `<span class="uf-band bot">${T("deco2", "⌇⌿⍜⏁⍀⏃⍀⟒⌇ ⍙ ⌿⎍⌇⏁☍⟒")}</span></div>`;
}

// MLG "Quickscope": jaskrawy gradient przesuwający się po skosie w środku karty (mlgBG), na zdjęciu celownik, który co jakiś
// czas namierza twarz i strzela (błysk + hitmarkery, potem kilka sekund zwykłego zdjęcia - mlgPhoto), nad kartą killfeed
// z nazwą karty, obracające się 360°, napisy i oko Illuminati (mlgDeco). Grafiki z biblioteki naklejek (static/img/mlg).
const MLG_WORDS = ["NO SCOPE", "QUICKSCOPE", "REKT", "WOW", "GG EZ", "+1000", "SKILL", "MLG", "#1"];
const MLG_TAGS = ["xX_Sn1p3r_Xx", "N0Sc0pe420", "FaZe_Tata", "MLG_Pro2137", "QuickScoper"];
const mlgPos = (a, b) => rand(a, b).toFixed(0) + "%";
const mlgImg = (k, cls, style = "") => `<img class="${cls}" src="${S.cfg.stickerLibrary[k].url}" alt="" draggable="false" style="${style}">`;
function mlgHits(n, x = [14, 86], y = [14, 84]) {
  return Array.from({ length: n }, (_, k) => mlgImg("hitmarker", "mlg-hit",
    `left:${mlgPos(...x)};top:${mlgPos(...y)};animation-delay:-${(k * 3.6 / n + rand(0, 0.5)).toFixed(2)}s`)).join("");
}
function mlgBG(variant) {
  if (!variantParts(variant).includes("mlg")) return "";
  return '<div class="mlg-bg"><i class="mlg-grad"></i></div>';
}
function mlgPhoto(variant) {
  if (!variantParts(variant).includes("mlg")) return "";
  return `<i class="mlg-photo"><i class="mlg-scope">${mlgImg("scope", "")}</i><i class="mlg-shot"></i>${mlgHits(5, [40, 60], [30, 55])}</i>`;
}
function mlgDeco(p) {
  const tag = () => MLG_TAGS[Math.floor(rand(0, MLG_TAGS.length))];
  const row = (k, victim) => `<span class="mlg-kill" style="animation-delay:${k * 0.8}s"><b>${tag()}</b>${mlgImg("scope", "")}<i>${esc(victim)}</i></span>`;
  const word = MLG_WORDS[Math.floor(rand(0, MLG_WORDS.length))];
  return `<div class="mlg-deco"><span class="mlg-feed">${row(0, p?.name || "noob")}${row(1, "Rywal")}</span>${mlgHits(3)}` +
    `<b class="mlg-word spin360">360°</b><b class="mlg-word" style="left:${mlgPos(30, 70)};top:${mlgPos(20, 40)};--wr:${
      rand(-16, 16).toFixed(0)}deg;animation-delay:-${rand(0, 5).toFixed(1)}s">${word}</b></div>${mlgImg("illuminati", "mlg-eye")}`;
}
// Naklejki od admina (strona /stickers) na wariantach z "stickers" (MLG): środek i szerokość w % karty, obrót, odbicie
// i ruch (klasy vsa-*); kolejność listy = od spodu. Obrazek w środku <i>, żeby ruch nie kasował obrotu.
// Karta z własnymi naklejkami (edytor, tryb "Tylko ta karta") ma gotową listę w cardStickers - reszta ma standardowe.
function stickerList(v, p) { return (p && S.cfg.cardStickers?.[v]?.[p.imgAs || p.id]) || S.cfg.variantStickers?.[v]; }
function stickersHTML(v, list = S.cfg.variantStickers?.[v], cls = "") {
  return list?.length ? `<div class="v-stickers${cls}">${list.map(stickerHTML).join("")}</div>` : "";
}
// Warianty z "stickers": "under" (np. Grecka, Afrykańska): naklejki leżą na tle karty - pod zdjęciem i napisami
// (w .card-inner zaraz po tle wariantu; na tajnej karcie nad zdjęciem, które zajmuje całą kartę)
function underStickersHTML(variant, p) {
  return variantParts(variant).filter(x => S.cfg.variants[x]?.stickers === "under")
    .map(x => stickersHTML(x, stickerList(x, p), " under")).join("");
}
function stickerHTML(s) {
  return `<i class="v-sticker${s.anim && s.anim !== "none" ? " vsa-" + s.anim : ""}" data-sid="${s.id}" style="${stickerStyle(s)}">` +
    `<img src="${esc(s.url)}" alt="" draggable="false"></i>`;
}
function stickerStyle(s) { return `--x:${s.x}%;--y:${s.y}%;--w:${s.w}%;--r:${s.rot}deg;--f:${s.flip ? -1 : 1}`; }

// wszystkie zdolności karty po kolei: [{ name, kind: "off" | "def" | "heal" | "eco", value }]
function abilitiesOf(p) {
  const list = [{ name: p.attack, kind: p.kind1 || "off", value: p.dmg }];
  if (p.attack2) list.push({ name: p.attack2, kind: p.kind2 || "off", value: p.dmg2 });
  return list.concat(p.abilities || []);
}

// wariant flagowy (także połączony, np. flag+gold): flaga kraju karty jako tło ramki (zmienna CSS --flag)
function flagStyle(p, variant) { return variantParts(variant).includes("flag") && p.country ? ` style="--flag:url('${flagUrl(p.country)}')"` : ""; }

// własne napisy na karcie z panelu admina (pole "texts", karty specjalne): T(miejsce, zwykły tekst w HTML)
function cardTexts(p) { return (k, html) => p.texts?.[k] != null ? esc(p.texts[k]) : html; }

function cardHTML(pid, variant = "normal") {
  const p = person(pid);
  if (p.masked) return mysteryCardHTML(p);
  if (p.rarity === "secret") return secretCardHTML(p, variant);
  const r = S.cfg.rarities[p.rarity];
  const type = S.cfg.types[p.type];
  const crate = crateOf(p.crate);
  const total = String(crate.people.length).padStart(3, "0");
  const cost = type.icon.repeat(Math.min(3, 1 + Math.floor(rarityIdx(p.rarity) / 2)));
  const abils = abilitiesOf(p);
  const T = cardTexts(p), name = p.texts?.name ?? p.name;
  // napis rzadkości: wariant może mieć własny (UFO - alfabet obcych zamiast "Specjalna")
  const rarityName = variantParts(variant).map(x => S.cfg.variants[x]?.rarityName).find(Boolean) || r.name;
  return `
  <div class="card r-${p.rarity} ${vClass(variant)}${p.style ? " vs-" + p.style : ""}${abils.length > 1 ? " two-atk" : ""}${abils.length > 2 ? ` atk-${abils.length}` : ""}" data-pid="${p.id}" data-variant="${variant}"${flagStyle(p, variant)}>
    <div class="card-inner">
      ${baseVariant(variant) === "reverse" ? '<div class="rev-foil"></div>' : ""}
      ${galaxyBG(variant)}${devilBG(variant)}${mlgBG(variant)}${variantBG(variant)}${underStickersHTML(variant, p)}
      ${variantTop(variant)}${pxStatus(p, variant)}
      <div class="card-head">
        <span class="card-name">${variantParts(variant).includes("digital") ? `<span class="dg-type" style="--n:${[...name].length}">${esc(name)}</span>` : esc(name)}</span>
        <span class="card-hp"><small>${T("hpLabel", "HP")}</small>${T("hp", p.hp)}</span>
        <span class="card-type">${T("type", type.icon)}</span>
      </div>
      <div class="card-photo"><img src="${imgUrl(p.id, variant)}" alt="${esc(name)}" loading="lazy" draggable="false"${photoFx(variant)}>${galaxyPhoto(variant)}${halloweenPhoto(variant)}${mlgPhoto(variant)}${variantPhoto(variant, p)}</div>
      <div class="card-sub${p.subtitle || p.texts?.sub ? " has-subtitle" : ""}">${T("sub", p.subtitle ? esc(p.subtitle)
        : variantSub(variant, pid) ?? `${type.name} · ${esc(crate.short)}`)}</div>
      ${abils.map((a, i) => `<div class="card-attack${i ? " atk2" : ""}${a.kind !== "off" ? " " + a.kind : ""}">
        <span class="atk-cost">${T(`atk${i + 1}Cost`, a.kind === "off" ? cost + (i ? type.icon : "") : S.cfg.abilityKinds[a.kind]?.icon || "")}</span>
        <span class="atk-name">${T(`atk${i + 1}Name`, esc(a.name))}</span>
        <span class="atk-dmg">${T(`atk${i + 1}Value`, a.value)}</span>
      </div>`).join("")}
      <div class="card-stats">
        <span>${T("weakLabel", "słabość")}<b>${T("weak", S.cfg.types[type.weak].icon + "×2")}</b></span>
        <span>${T("resistLabel", "odporność")}<b>${T("resist", S.cfg.types[type.resist].icon + "-20")}</b></span>
        <span>${T("retreatLabel", "wycofanie")}<b>${T("retreat", "⚪".repeat(1 + rarityIdx(p.rarity) % 3))}</b></span>
      </div>
      <div class="card-foot">
        <span class="card-rarity"><span class="gem"></span>${T("rarity", rarityName)}</span>
        <span>${T("number", `${esc(crate.code)} ${String(p.number).padStart(3, "0")}/${total}`)}</span>
        <span class="card-value">${T("value", fmt(cardValue(pid, variant)))}</span>
      </div>
    </div>
    ${variantLayers(variant, p)}
    <div class="shine"></div>
  </div>`;
}

// TAJNA karta - zupełnie inny układ: pełnoekranowe zdjęcie, aureola, złota animowana ramka
function secretCardHTML(p, variant) {
  const type = S.cfg.types[p.type];
  const crate = crateOf(p.crate);
  return `
  <div class="card r-secret ${vClass(variant)}" data-pid="${p.id}" data-variant="${variant}"${flagStyle(p, variant)}>
    <div class="sc">
      <div class="sc-art"><img src="${imgUrl(p.id, variant)}" alt="${esc(p.name)}" loading="lazy" draggable="false"${photoFx(variant)}>${variantPhoto(variant, p)}</div>
      ${galaxyBG(variant)}${devilBG(variant)}${halloweenPhoto(variant)}${mlgBG(variant)}${mlgPhoto(variant)}${variantBG(variant)}${underStickersHTML(variant, p)}
      <div class="sc-halo"></div>
      <div class="sc-stars"></div>
      ${baseVariant(variant) === "reverse" ? '<div class="rev-foil"></div>' : ""}
      <div class="sc-top">
        <span class="sc-seal">★</span>
        <span class="sc-name">${esc(p.name)}</span>
        <span class="sc-hp"><small>HP</small>${p.hp}</span>
      </div>
      <div class="sc-panel">
        ${p.subtitle ? `<div class="sc-sub">${esc(p.subtitle)}</div>` : ""}
        ${abilitiesOf(p).map((a, i) => `<div class="sc-attack${a.kind !== "off" ? " " + a.kind : ""}"><span>${a.kind === "off" ? type.icon.repeat(i ? 2 : 1) : S.cfg.abilityKinds[a.kind]?.icon || ""}</span><span class="sc-atk">${esc(a.name)}</span><b>${a.value}</b></div>`).join("")}
        <div class="sc-foot"><span>★ TAJNA ★</span><span>${esc(crate.code)} ★${String(p.number).padStart(3, "0")}</span><span class="sc-val">${fmt(cardValue(p.id, variant))}</span></div>
      </div>
      <div class="sc-frame"></div>
      <div class="sc-border"></div>
    </div>
    ${variantLayers(variant, p)}
    <div class="shine"></div>
  </div>`;
}

// tajna karta, której jeszcze nie zdobyłeś
function mysteryCardHTML(p) {
  const n = rarityShare(p.crate, "secret");
  return `
  <div class="card r-secret mystery" data-pid="${p.id}" data-variant="normal">
    <div class="sc">
      <div class="sc-stars"></div>
      <div class="my-star">★</div>
      <div class="my-q">???</div>
      <div class="my-label">TAJNA KARTA</div>
      <div class="my-sub">Zdobądź ją, aby odkryć, kto to jest.<br>Szansa: 1 na ${n ? Math.round(1 / n).toLocaleString("pl-PL") : "?"}</div>
      <div class="sc-border"></div>
    </div>
  </div>`;
}

// szansa na konkretną kartę danej rzadkości w danej skrzynce
function rarityShare(crateId, rarity) {
  const crate = crateOf(crateId);
  if (!crate) return 0;
  const present = new Set(crate.people.map(id => person(id).rarity));
  const total = S.cfg.rarityOrder.filter(r => present.has(r)).reduce((a, r) => a + crate.weights[r], 0);
  const inR = crate.people.filter(id => person(id).rarity === rarity).length;
  return present.has(rarity) && total ? crate.weights[rarity] / total / inR : 0;
}

// efekt przechylania kart za kursorem
let tiltCard = null;
function resetTilt(card) {
  if (!card) return;
  card.classList.remove("tilting");
  card.style.removeProperty("--rx"); card.style.removeProperty("--ry");
}
// Prostokąt karty BEZ przechylenia (środek z getBoundingClientRect + rozmiar z układu strony) -
// pozycja kursora liczona względem przechylonej karty "pływała" i karta się trzęsła.
function flatRect(el) {
  const b = el.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  return { left: b.left + (b.width - w) / 2, top: b.top + (b.height - h) / 2, width: w, height: h };
}
function inRect(e, b) {
  return e.clientX >= b.left && e.clientX <= b.left + b.width && e.clientY >= b.top && e.clientY <= b.top + b.height;
}
// ruch myszy liczymy najwyżej raz na klatkę (myszki potrafią zgłaszać ruch 500-1000 razy na sekundę)
let tiltEvent = null;
document.addEventListener("pointermove", e => {
  if (!tiltEvent) requestAnimationFrame(() => { const ev = tiltEvent; tiltEvent = null; if (ev) tiltMove(ev); });
  tiltEvent = e;
}, { passive: true });
function tiltMove(e) {
  // podgląd karty i kieszonka w albumie: obszar, który się nie przechyla - przechylona karta "chowa się"
  // za swój pojemnik i przeglądarka przestaje widzieć nad nią kursor (karta skakała tam i z powrotem)
  const zone = e.target.closest?.(".viewer-stage, .pocket");
  let card = zone ? zone.querySelector(".card") : e.target.closest?.(".card");
  if (!card && tiltCard?.isConnected && inRect(e, flatRect(tiltCard))) card = tiltCard;  // kursor przy krawędzi
  if (card !== tiltCard) { resetTilt(tiltCard); tiltCard = card; }
  if (!card) return;
  const b = zone ? zone.getBoundingClientRect() : flatRect(card);
  const px = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
  const py = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
  const fancy = card.matches(".r-secret, .v-holo, .v-reverse, .v-gold, .v-silver, .v-bronze, .v-pearl, .v-vintage, .v-marble, .v-toxic, .v-pixel, .v-popart, .v-glass, .v-neon, .v-thermal, .v-blueprint, .v-glitch, .v-diamond, .v-emerald, .v-ruby, .v-amethyst, .v-sapphire, .v-blackdiamond, .v-steel, .v-bw, .v-clear, .v-negative, .v-sketch, .v-galaxy, .v-mlg");
  const strength = card.closest(".viewer") ? 1.5 : fancy || card.closest(".modal") ? 1 : 0.6;
  card.classList.add("tilting");
  card.style.setProperty("--rx", ((0.5 - py) * 16 * strength).toFixed(2) + "deg");
  card.style.setProperty("--ry", ((px - 0.5) * 20 * strength).toFixed(2) + "deg");
  card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
  card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
}
// kursor wyjechał poza okno - karta wraca do pozycji prostej
document.documentElement.addEventListener("pointerleave", () => { tiltEvent = null; resetTilt(tiltCard); tiltCard = null; });

// Pełnoekranowa nakładka (otwieranie skrzynek, wielkie odsłonięcie, kuźnia, podgląd karty, skrzynka z pieniędzmi...)
// zasłania całą stronę - wtedy body.covered chowa stronę pod spodem (style.css: WYDAJNOŚĆ), żeby przeglądarka nie liczyła
// animacji setek niewidocznych kart. Wszystkie te nakładki są dodawane bezpośrednio do <body>.
const COVERS = ["body > #stage:not([hidden])", "body > .epic", "body > .sreveal", "body > .forge-anim", "body > .money-stage",
                "body > .jp-anim", "body > .viewer", "body > .vr-zoom"].join(", ");
function updateCovered() { document.body.classList.toggle("covered", !!document.querySelector(COVERS)); }
function watchCovers() {
  const mo = new MutationObserver(updateCovered);
  mo.observe(document.body, { childList: true });
  mo.observe($("#stage"), { attributes: true, attributeFilter: ["hidden"] });
}

// ================================================================ NAGŁÓWEK / WSPÓLNE

let shownBalance = null;
function renderHeader() {
  const el = $("#balance");
  const target = S.state.balance;
  if (shownBalance === null) shownBalance = target;
  const from = shownBalance, t0 = performance.now();
  shownBalance = target;
  if (from !== target) {
    el.classList.add("bump");
    setTimeout(() => el.classList.remove("bump"), 200);
  }
  const step = now => {
    const t = Math.min(1, (now - t0) / 450);
    el.textContent = fmt(from + (target - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const broke = target < Math.min(...crateList().map(c => c.price));
  el.classList.toggle("neg", broke);
  $("#adminLink").hidden = !S.me?.isAdmin;
  // Arena (wersja testowa) - zakładka tylko dla adminów
  $(".tab[data-view=arena]").hidden = !S.cfg?.arena;
  $(".tabs").classList.toggle("no-arena", !S.cfg?.arena);
  if (S.me) {
    $("#userAvatar").outerHTML = avatarHTML(S.me, "").replace('<span class="', '<span id="userAvatar" class="');
    $("#userName").textContent = S.me.username;
  }
  $("#invCount").textContent = S.items.length;
  $("#soundBtn").textContent = Sound.enabled ? "🔊" : "🔇";
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = 0; }, 2600);
  setTimeout(() => t.remove(), 3100);
}

function applyState(state) {
  S.state = state;
  renderHeader();
}

// Ekwipunek zmieniony bez udziału tej karty przeglądarki (wygrana w jackpocie, wygrana licytacja, sprzedaż na rynku,
// przyjęta wymiana): /api/me podaje "odcisk" ekwipunku (liczba kart, suma id) i saldo - gdy się różnią, pobieramy świeży stan.
// force = bez porównywania. Pomijamy w trakcie własnych akcji i animacji (one same aktualizują ekwipunek).
async function syncInventory(me = null, force = false) {
  if (!S.items || !S.state) return;
  if (!force) {
    if (!me?.inv) return;
    const sum = S.items.reduce((a, i) => a + i.id, 0);
    if (S.items.length === me.inv[0] && sum === me.inv[1] && S.state.balance === me.balance) return;
  }
  const busy = () => S.inflight > 0 || S.opening || FORGE.busy || CS.spinning;
  if (busy()) return;
  const m = S.mutations;
  let st;
  try { st = await api("/api/state"); } catch (_) { return; }
  if (m !== S.mutations || busy()) return;
  S.items = st.items;
  S.showcase = st.showcase || [];
  S.chests = st.chests || S.chests;
  noteCollected(S.items);
  if (S.items.some(i => !person(i.person) || person(i.person).masked)) await refreshConfig();   // nowe (tajne) karty
  applyState(st.state);
  if (["inventory", "binder"].includes(currentView()) && !dialogOpen() && !viewerOpen()) rerenderCurrent();
}

// klaser pamięta każdą kartę, którą gracz kiedykolwiek miał ("osoba|wariant")
function noteCollected(items) { items.forEach(i => S.collected.add(`${i.person}|${i.variant}`)); }

function removeItems(ids) {
  const set = new Set(ids);
  noteCollected(S.items.filter(i => set.has(i.id)));
  S.items = S.items.filter(i => !set.has(i.id));
  ids.forEach(id => S.inv.selected.delete(id));
}

async function setFavorite(ids, fav) {
  await api("/api/favorite", { ids, fav });
  const set = new Set(ids);
  S.items.forEach(i => { if (set.has(i.id)) i.fav = fav; });
  S.opening?.drops.forEach(d => { if (set.has(d.id)) d.fav = fav; });
  Sound.click();
}

function favBtnHTML(id, fav, cls = "") {
  return `<button class="fav-btn${fav ? " on" : ""} ${cls}" data-fav="${id}" title="${fav ? "Ulubiona — nie da się jej sprzedać ani zużyć. Kliknij, aby odznaczyć" : "Dodaj do ulubionych (ochrona przed sprzedażą)"}">${fav ? "★" : "☆"}</button>`;
}

async function sellIds(ids) {
  if (!ids.length) return 0;
  // ulubionych i kart specjalnych nie sprzedajemy (serwer też je pomija)
  const keep = new Set(S.items.filter(i => i.fav || isSpecialCard(i.person)).map(i => i.id));
  ids = ids.filter(id => !keep.has(id));
  if (!ids.length) { toast("⭐ Ulubionych i 🃏 specjalnych kart nie da się sprzedać"); return 0; }
  const res = await api("/api/sell", { ids });
  removeItems(res.sold);
  applyState(res.state);
  Sound.coin(Math.ceil(res.sold.length / 4));
  toast(`Sprzedano ${res.sold.length} ${plural(res.sold.length, "kartę", "karty", "kart")} za ${fmt(res.total)}`);
  return res.total;
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

// ================================================================ APLIKACJA NA TELEFON (PWA)
// Android / Chrome / Edge: przeglądarka sama proponuje instalację (beforeinstallprompt) - pokazujemy przycisk 📲.
// iPhone (Safari) nie ma takiego okna - przycisk otwiera instrukcję "Udostępnij -> Do ekranu początkowego".
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function setupInstall() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const btn = $("#installBtn");
  if (isStandalone()) return;  // już działa jako aplikacja
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; btn.hidden = false; });
  window.addEventListener("appinstalled", () => { installPrompt = null; btn.hidden = true; toast("📲 Gotowe! Gra jest na ekranie głównym."); });
  if (isIOS()) btn.hidden = false;
  btn.addEventListener("click", async () => {
    Sound.click();
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") { installPrompt = null; btn.hidden = true; }
      return;
    }
    openDialog(`<h3>📲 Gra jako aplikacja</h3>
      ${isIOS() ? `<ol class="install-steps">
          <li>Otwórz grę w <b>Safari</b>.</li>
          <li>Stuknij <b>Udostępnij</b> <span class="kbd">⎋⬆</span> na dole ekranu.</li>
          <li>Wybierz <b>„Do ekranu początkowego”</b> i stuknij <b>Dodaj</b>.</li>
        </ol>` : `<ol class="install-steps">
          <li>Otwórz menu przeglądarki <span class="kbd">⋮</span>.</li>
          <li>Wybierz <b>„Zainstaluj aplikację”</b> albo <b>„Dodaj do ekranu głównego”</b>.</li>
        </ol>`}
      <p class="muted">Gra pojawi się z ikoną na ekranie telefonu i otworzy się na pełnym ekranie, bez paska przeglądarki.</p>
      <div class="daily-actions"><button class="btn" data-close>Zamknij</button></div>`);
  });
}

// ================================================================ ADRESY STRON
// każda zakładka ma swój adres (/inventory...), profil gracza: /player/<nazwa>; "/" = skrzynki
const VIEW_PATHS = { crates: "/crates", binder: "/binder", inventory: "/inventory", forge: "/forge", market: "/market", casino: "/casino",
                     friends: "/friends", ranking: "/ranking", arena: "/arena", mockups: "/mockups",
                     stickers: "/stickers", variants: "/variants" };

function viewPath(view) {
  if (view === "inventory" && S.inv.mode === "hof") return "/inventory/hall-of-fame";
  return view === "profile" ? "/player/" + encodeURIComponent(PROF.username || S.me.username) : VIEW_PATHS[view] || "/";
}

function routeFromPath(path = location.pathname) {
  const m = path.match(/^\/player\/([^/]+)\/?$/);
  if (m) return { view: "profile", user: decodeURIComponent(m[1]) };
  const link = path.match(/^\/link\/([^/]+)\/?$/);   // link od admina do karty specjalnej
  if (link) return { view: "inventory", link: decodeURIComponent(link[1]) };
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/inventory/hall-of-fame") return { view: "inventory", hof: true };
  return { view: Object.keys(VIEW_PATHS).find(v => VIEW_PATHS[v] === clean) || "crates" };
}

function showRoute(how = "none") {
  const r = routeFromPath();
  if (r.link) return claimLink(r.link);
  if (r.view === "inventory") S.inv.mode = r.hof ? "hof" : "cards";
  if (r.view === "profile") openProfile(r.user, how);
  else switchView(r.view, how);
}

// how: "push" - nowy wpis w historii (kliknięcie), "replace" - podmiana (start), "none" - bez zmian (wstecz/dalej)
function switchView(view, how = "push") {
  if (view === "arena" && !S.cfg.arena) view = "crates";  // Arena: na razie tylko dla adminów
  if ((view === "mockups" || view === "stickers" || view === "variants") && !S.me?.isAdmin) view = "crates";
  const path = viewPath(view);
  const entering = view !== $(".view.active")?.id.replace("view-", "");
  if (view === "inventory" && entering) ufoArrive();
  else if (view !== "inventory" && S.ufo?.shown) ufoLeave();   // wyszedł z ekwipunku - karta znika bez animacji
  if (how !== "none" && location.pathname !== path) history[how === "replace" ? "replaceState" : "pushState"](null, "", path);
  const tab = $(`.tab[data-view="${view}"]`);
  const label = view === "profile" ? (PROF.username || S.me.username) : tab && `${tab.querySelector(".ti").textContent} ${tab.querySelector(".tl").textContent}`;
  document.title = label ? `${label} — ScamBox` : "ScamBox";
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  if (view === "binder") renderBinder();
  if (view === "inventory") renderInventory();
  if (view === "crates") renderCrates();
  if (view === "forge") renderForge();
  if (view === "market") renderMarket();
  if (view === "casino") renderCasino();
  else stopJackpotPolling();
  if (view === "friends") renderFriends();
  if (view === "ranking") renderRanking();
  if (view === "profile") renderProfile();
  if (view === "arena") renderArena();
  if (view === "mockups") renderMockups();
  if (view === "stickers") renderStickers();
  if (view === "variants") renderVariants();
  else document.body.classList.remove("hs-open");  // walka w Arenie zajmuje cały ekran tylko w jej zakładce
  updateSellbar();
}

function currentView() { return $(".view.active").id.replace("view-", ""); }

function rerenderCurrent() { switchView(currentView(), "none"); }

// ================================================================ SKRZYNKI

function shopCrates() {
  // skrzynki "dla wybranych" widzą tylko gracze z dostępem (posiadane z ekwipunku zawsze da się otworzyć);
  // skrzynki kart specjalnych nie ma w sklepie (karty specjalne są z kasyna i z linków)
  return crateList().filter(c => !c.special && ((c.shop && (!c.restricted || c.canBuy)) || (S.chests[c.id] || 0) > 0 || S.me?.isAdmin));
}

// ---------------------------------------------------------------- karuzela skrzynek ("rotacja sklepu")
// Środkowa skrzynka = wybrana. Karuzela stoi - skrzynkę zmienia tylko gracz (strzałki, kafelek, przesunięcie, lista).
function carOffset(i, sel, n) {   // przesunięcie kafelka względem wybranego, "w kółko": -n/2 ... n/2
  const half = Math.floor(n / 2);
  return ((i - sel + n + half) % n) - half;
}
function placeCarousel(track, sel) {
  const tiles = [...track.children], n = tiles.length, side = innerWidth <= 700 ? 1 : 2;
  tiles.forEach((t, i) => {
    const off = carOffset(i, sel, n), abs = Math.abs(off);
    t.style.setProperty("--off", off);
    t.style.setProperty("--abs", abs);
    t.classList.toggle("far", abs > side);
    t.classList.toggle("selected", off === 0);
  });
}
function shopRotate(dir) {
  const list = shopCrates();
  if (list.length < 2) return;
  Sound.click();
  const i = list.findIndex(c => c.id === S.crate);
  S.crate = list[(i + dir + list.length) % list.length].id;
  renderCrates();
}

function crateArtHTML(c, cls = "") {
  return `<div class="crate-art ${cls}" style="${crateStyle(c)}">
    <div class="crate-box"><div class="crate-emblem">${esc(c.emoji)}</div></div><div class="crate-lid"></div><div class="crate-lock"></div></div>`;
}

function crateRarities(c) {
  const present = new Set(c.people.map(id => person(id).rarity));
  return S.cfg.rarityOrder.filter(r => present.has(r) && c.weights[r] > 0);
}

function oddsBarHTML(c) {
  const rs = crateRarities(c);
  const tot = rs.reduce((a, r) => a + c.weights[r], 0) || 1;
  // pasek w skali "pierwiastkowej", żeby rzadkie kolory były w ogóle widoczne
  return `<div class="odds-bar">${rs.map(r => `<i style="flex:${Math.sqrt(c.weights[r] / tot)}; --rc:${S.cfg.rarities[r].color}"
    title="${S.cfg.rarities[r].name}: ${(c.weights[r] / tot * 100).toLocaleString("pl-PL", { maximumFractionDigits: 3 })}%"></i>`).join("")}</div>`;
}

function renderCrates() {
  const visible = shopCrates();
  if (!visible.some(c => c.id === S.crate)) S.crate = (visible.find(c => c.canBuy) || visible[0])?.id;
  const track = $("#cratePicker");
  track.innerHTML = visible.map(c => {
    const owned = S.chests[c.id] || 0;
    const locked = !c.canBuy;
    return `<div class="shop-tile${S.crate === c.id ? " selected" : ""}${locked ? " locked" : ""}" data-crate="${c.id}" style="${crateStyle(c)}">
      <div class="st-badges">
        ${owned ? `<span class="stb owned">📦 ×${owned}</span>` : ""}
        ${!c.shop ? '<span class="stb off">Poza sklepem</span>' : ""}
        ${c.restricted ? `<span class="stb vip">${locked ? "🔒" : "⭐"} Dla wybranych</span>` : ""}
      </div>
      ${crateArtHTML(c)}
      <div class="st-name">${esc(c.name)}</div>
      <div class="st-meta">${c.people.length} kart${c.desc ? " · " + esc(c.desc) : ""}</div>
      ${oddsBarHTML(c)}
      <div class="st-price">${fmt(c.price)}</div>
    </div>`;
  }).join("") || '<div class="empty">Sklep jest pusty — na razie nie ma żadnych skrzynek.</div>';
  // karuzela: kafelki startują z pozycji względem poprzednio wybranej skrzynki i przesuwają się (transition) na nowe miejsca
  const sel = visible.findIndex(c => c.id === S.crate), prev = visible.findIndex(c => c.id === S.shopPrev);
  if (sel >= 0) {
    placeCarousel(track, prev >= 0 ? prev : sel);
    if (prev >= 0 && prev !== sel) { void track.offsetWidth; placeCarousel(track, sel); }
  }
  S.shopPrev = S.crate;
  $("#shopCarousel").classList.toggle("single", visible.length < 2);
  $("#shopDots").innerHTML = visible.length > 1 ? visible.map(c =>
    `<button class="car-dot${c.id === S.crate ? " active" : ""}" data-crate="${c.id}" title="${esc(c.name)}" style="--c1:${c.color1}"></button>`).join("") : "";
  // lista wszystkich skrzynek pod karuzelą (rozwijana) - kliknięcie przenosi karuzelę do tej skrzynki
  $("#shopAll").hidden = visible.length < 2;
  $("#shopAllToggle").innerHTML = `📋 Wszystkie skrzynki (${visible.length}) ${S.shopAllOpen ? "▴" : "▾"}`;
  $("#shopAllList").hidden = !S.shopAllOpen;
  $("#shopAllList").innerHTML = visible.map(c => {
    const owned = S.chests[c.id] || 0;
    return `<button class="sal-item${c.id === S.crate ? " active" : ""}${!c.canBuy ? " locked" : ""}" data-crate="${c.id}" style="--c1:${c.color1}; --c2:${c.color2}" type="button">
      <span class="sal-emoji">${esc(c.emoji)}</span>
      <span class="sal-main"><b>${esc(c.name)}</b><small class="muted">${c.people.length} kart${owned ? ` · 📦 ×${owned}` : ""}${!c.canBuy ? " · 🔒" : ""}</small></span>
      <span class="sal-price">${fmt(c.price)}</span>
    </button>`;
  }).join("");

  const crate = crateOf(S.crate);
  $("#buyPanel").hidden = !crate;
  if (crate) {
    $("#bpArt").innerHTML = crateArtHTML(crate, "bp-crate");
    $("#buyPanel").style.cssText = crateStyle(crate);
    $("#bpTitle").textContent = crate.name;
    $("#bpDesc").textContent = crate.desc || "";
    $("#bpPrice").textContent = `${fmt(crate.price)} za sztukę · ${crate.people.length} kart`;
  }

  $("#countChips").innerHTML = COUNT_CHIPS.map(n =>
    `<button class="chip${S.count === n ? " active" : ""}" data-n="${n}">${n}</button>`).join("");
  $("#countRange").value = S.count;
  $("#countVal").textContent = S.count;
  $("#fastToggle").checked = S.fast;
  updateOpenBtn();

  const st = S.state;
  const profit = st.earned - st.spent;
  $("#stats").innerHTML = `
    <span>Otwarte skrzynki: <b>${st.opened}</b></span>
    <span>Wydano: <b>${fmt(st.spent)}</b></span>
    <span>Ze sprzedaży: <b>${fmt(st.earned)}</b></span>
    <span>Wartość ekwipunku: <b>${fmt(S.items.reduce((a, i) => a + i.value, 0))}</b></span>
    <span>Bilans sprzedaży: <b style="color:${profit >= 0 ? "var(--good)" : "var(--bad)"}">${profit >= 0 ? "+" : ""}${fmt(profit)}</b></span>
    <span>Z codziennych skrzynek: <b>${fmt(st.daily_total || 0)}</b></span>
    <span>Kontrakty: <b>${st.contracts || 0}</b></span>
    <span>Ulepszenia: <b style="color:var(--good)">${st.upgrades_won || 0}</b> / <b style="color:var(--bad)">${st.upgrades_lost || 0}</b></span>`;

  if (!crate) { $("#contentsGrid").innerHTML = ""; $("#odds").innerHTML = ""; return; }
  $("#contentsTitle").textContent = `Zawartość: ${crate.name}`;
  const rs = crateRarities(crate);
  const totalW = rs.reduce((a, r) => a + crate.weights[r], 0);
  const pctTxt = x => (x * 100).toLocaleString("pl-PL", { maximumFractionDigits: x < 0.001 ? 3 : 2 }) + "%";
  // warianty "always" (halloweenowe): każda karta ma jeden z nich - pokazujemy udział każdego
  const always = crateVariants(crate).filter(v => S.cfg.variants[v].always);
  const aw = v => (S.cfg.variants[v].weight || 1) * (variantEvent(v, crate.id)?.boost || 1);
  const alwaysW = always.reduce((a, v) => a + aw(v), 0);
  const comboTxt = v => S.cfg.variants[v].noCombo ? "nie łączy się z innymi wariantami" : "łączy się z innymi wariantami";
  const alwaysTxt = v => always.length > 1
    ? `${pctTxt(aw(v) / alwaysW)} kart (każda karta ma jeden z ${always.length} wariantów halloweenowych, ${comboTxt(v)})`
    : `100% — każda karta (${comboTxt(v)})`;
  $("#odds").innerHTML = rs.map(r => {
    const R = S.cfg.rarities[r];
    const n = crate.people.filter(id => person(id).rarity === r).length;
    return `<span class="odd odd-${r}" style="--rc:${R.color}"><b>${R.name}</b> ${pctTxt(crate.weights[r] / totalW)} · ${n} ${plural(n, "karta", "karty", "kart")} · ${fmt(R.value)}</span>`;
  }).join("") + `<div class="odds-variants">${crateVariants(crate).map(v => {
    const V = S.cfg.variants[v];
    const flags = v === "flag" ? crate.people.filter(id => person(id).country).length : null;
    const ev = variantEvent(v, crate.id);   // wydarzenie: wariant na czas (strona /variants)
    const evTxt = ev ? ` · ⏰ do ${new Date(ev.end * 1000).toLocaleString("pl-PL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}${
      ev.boost !== 1 ? ` (szansa ×${String(ev.boost).replace(".", ",")})` : ""}` : "";
    return `<span class="odd odd-v vt-${v}${ev ? " odd-event" : ""}"><b>${ev ? "⏰ " : isExclusive(v) ? "✨ " : ""}${V.name}</b> ${V.always ? alwaysTxt(v) : pctTxt(vChance(v, crate))}${evTxt} · wartość ×${String(V.mult).replace(".", ",")}${
      flags !== null ? ` · ${flags} ${plural(flags, "karta", "karty", "kart")} z flagą` : ""}${
      V.extraChance ? ` · ${Math.round(V.extraChance * 100)}% z dodatkowym wariantem (wartości się mnożą)` : ""}${isExclusive(v) && !ev ? " · tylko w tej skrzynce" : ""}</span>`;
  }).join("")}</div>`;
  $("#contentsGrid").innerHTML = crate.people.map(id => cardHTML(id)).join("");
}

function updateOpenBtn() {
  const crate = crateOf(S.crate);
  const btn = $("#openBtn"), buy = $("#buyBtn");
  if (!crate) { btn.disabled = buy.disabled = true; btn.textContent = "BRAK SKRZYNEK"; return; }
  const ownedAll = S.chests[crate.id] || 0;
  const owned = Math.min(ownedAll, S.count);
  const toBuy = S.count - owned;
  const cost = toBuy * crate.price;
  const blocked = toBuy > 0 && !crate.canBuy;
  btn.innerHTML = blocked
    ? `🔒 OTWÓRZ ${S.count}`
    : owned
      ? `OTWÓRZ ${S.count} <small class="ob-sub">📦 ${owned} z ekwipunku${cost ? ` + ${fmt(cost)}` : ""}</small>`
      : `OTWÓRZ ${S.count} × ${fmt(crate.price)} = ${fmt(cost)}`;
  btn.disabled = !!S.opening || !crate.people.length || blocked;
  buy.textContent = `🛒 Kup ${S.count} do ekwipunku · ${fmt(S.count * crate.price)}`;
  buy.disabled = !crate.canBuy;
  buy.hidden = !crate.canBuy;
  const after = S.state.balance - cost;
  const lock = $("#bpLock");
  lock.hidden = crate.canBuy;
  lock.innerHTML = crate.canBuy ? "" : `🔒 ${crate.shop ? "Tę skrzynkę mogą kupować tylko wybrani gracze." : "Tej skrzynki nie ma teraz w sklepie."}
    ${ownedAll ? `Masz <b>${ownedAll}</b> w ekwipunku — możesz je otworzyć (maks. ${ownedAll}).` : ""}`;
  $("#bpSummary").innerHTML = `
    <span>W ekwipunku: <b>${ownedAll}</b></span>
    <span>Z ekwipunku: <b>${owned}</b></span>
    <span>Do zapłaty: <b class="${after < 0 ? "neg-txt" : ""}">${fmt(cost)}</b></span>
    <span>Saldo po: <b class="${after < 0 ? "neg-txt" : ""}">${fmt(after)}</b></span>`;
}

function setCount(n) {
  S.count = Math.max(1, Math.min(S.cfg.maxOpen, n));
  $("#countRange").value = S.count;
  $("#countVal").textContent = S.count;
  $$("#countChips .chip").forEach(c => c.classList.toggle("active", +c.dataset.n === S.count));
  updateOpenBtn();
}

async function buyChests() {
  const crate = crateOf(S.crate);
  if (!crate || S.opening) return;
  try {
    const res = await api("/api/chests/buy", { crate: crate.id, count: S.count });
    S.chests = res.chests;
    applyState(res.state);
    Sound.coin(2);
    toast(`🛒 Kupiono ${S.count} × ${crate.name} — czekają w ekwipunku`);
    renderCrates();
  } catch (e) {
    Sound.error();
    if (S.state.balance < S.count * crate.price && S.dailyClaimable) { toast(e.message + " Odbierz codzienną skrzynkę!", true); openDaily(); }
    else toast(e.message, true);
  }
}


// ================================================================ OTWIERANIE

function weightedPerson(crateId) {
  // losowanie kosmetyczne do wypełnienia bębna (takie same szanse jak na serwerze)
  const crate = crateOf(crateId), ids = crate.people;
  const byR = {};
  ids.forEach(id => (byR[person(id).rarity] ||= []).push(id));
  const rs = Object.keys(byR);
  const total = rs.reduce((a, r) => a + crate.weights[r], 0);
  let x = Math.random() * total;
  for (const r of rs) {
    x -= crate.weights[r];
    if (x <= 0) return byR[r][Math.floor(Math.random() * byR[r].length)];
  }
  return ids[0];
}

// Easter egg (obrazek od admina, S.cfg.easterEgg): bardzo rzadko jeden z kafelków bębna zamienia się w ten obrazek.
// Ma przejechać przez bęben dopiero pod koniec, gdy ten już powoli hamuje, i zniknąć za lewą krawędzią tuż przed
// zatrzymaniem (po zatrzymaniu nigdy go nie widać). Dlatego wybieramy kafelek i trochę przesuwamy miejsce zatrzymania
// na wygranej karcie (off - w tych samych granicach co zwykle), żeby prawa krawędź obrazka po zatrzymaniu była
// EGG_EDGE px za lewą krawędzią bębna. Prawa krawędź kafelka k po zatrzymaniu: (k - win) * step + mw / 2 + center - off.
const EGG_EDGE = 6;
function eggSpot(step, mw, center, win, off) {
  for (let k = win - 1; k > 0; k--) {
    const o = (k - win) * step + mw / 2 + center + EGG_EDGE;
    if (Math.abs(o) <= 0.42 * mw) return [o, k];
    if (o < -0.42 * mw) break;
  }
  // nie da się dopasować (wąski bęben) - najbliższy kafelek, który po zatrzymaniu jest już cały poza bębnem
  const to = -(win * step + mw / 2 + off) + center;
  return [off, Math.floor((-to - mw - EGG_EDGE) / step)];
}
function spinEgg(strip, k) {
  const tile = strip.children[k];
  if (k < 1 || !tile) return;
  tile.outerHTML = `<div class="mini mini-egg"><img src="${esc(S.cfg.easterEgg.url)}" alt="" draggable="false"></div>`;
}

function miniHTML(pid, win = false) {
  const p = person(pid);
  if (p.rarity === "secret") {
    // jak nóż w CS - w bębnie tajna karta to zawsze złota gwiazda
    return `<div class="mini r-secret mini-secret${win ? " win" : ""}" style="--rc:${S.cfg.rarities.secret.color}">
      <div class="ms-star">★</div><div class="mn">??? TAJNA</div></div>`;
  }
  return `<div class="mini r-${p.rarity}${win ? " win" : ""}" style="--rc:${S.cfg.rarities[p.rarity].color}">
    <img src="${imgUrl(p.id, null, true)}" alt="" draggable="false"><div class="mn">${esc(p.name)}</div></div>`;
}

// ================================================================ AUTOOTWIERANIE
// S.autoRun = { rounds, spent } - otwieramy raz za razem tę samą liczbę skrzynek, dopóki starcza pieniędzy

function stopAuto(msg) {
  if (!S.autoRun) return;
  const r = S.autoRun;
  S.autoRun = null;
  $("#autoToggle").checked = false;
  updateAutoBtn();
  if (msg) toast(`${msg} (rund: ${r.rounds}, wydano ${fmt(r.spent)})`);
}

function updateAutoBtn() {
  const b = $("#autoStopBtn");
  b.hidden = !S.autoRun;
  if (S.autoRun) b.textContent = `⏹ Zatrzymaj auto (runda ${S.autoRun.rounds})`;
}

function autoNext(o) {
  if (!S.autoRun) return;
  const crate = crateOf(o.crate);
  const owned = Math.min(S.chests[o.crate] || 0, o.count);
  const cost = (o.count - owned) * (crate?.price || 0);
  if (!crate || S.state.balance < cost) return stopAuto("🔁 Auto zatrzymane — skończyły się pieniądze");
  if (owned < o.count && !crate.canBuy) return stopAuto("🔁 Auto zatrzymane — tej skrzynki nie można już kupić");
  setTimeout(() => { if (S.autoRun && S.opening === o && !epicOpen()) openAgain(); }, o.fast ? 800 : 1500);
}

async function openCrates() {
  if (S.opening) return;
  const crate = crateOf(S.crate);
  if (!crate) return;
  const cost = (S.count - Math.min(S.chests[crate.id] || 0, S.count)) * crate.price;
  if (S.state.balance < cost) {
    Sound.error();
    const msg = `Brakuje ci ${fmt(cost - S.state.balance)}, żeby otworzyć ${S.count} ${plural(S.count, "skrzynkę", "skrzynki", "skrzynek")}.`;
    // bez darmowych pieniędzy po bankructwie - tylko nagroda dzienna (i sprzedaż kart)
    if (S.dailyClaimable) { toast(msg + " Odbierz nagrodę dzienną!", true); openDaily(); }
    else toast(msg + " Sprzedaj kilka kart albo wróć jutro po nagrodę dzienną 🎁", true);
    return;
  }
  Sound.unlock();
  if (!S.autoRun && $("#autoToggle").checked) S.autoRun = { rounds: 0, spent: 0 };
  if (S.autoRun) { S.autoRun.rounds++; S.autoRun.spent += cost; }
  S.opening = { crate: S.crate, count: S.count, fast: S.fast };
  updateOpenBtn();

  const ownedBefore = new Set(S.items.map(i => i.person));
  let res;
  try {
    const crateEl = $("#buyPanel");
    crateEl?.classList.add("opening");
    Sound.open();
    [res] = await Promise.all([api("/api/open", { crate: S.crate, count: S.count }), sleep(S.fast ? 120 : 450)]);
    crateEl?.classList.remove("opening");
    if (res.discovered.length) await refreshConfig();
  } catch (e) {
    S.opening = null; updateOpenBtn();
    Sound.error(); toast(e.message, true);
    stopAuto();
    return;
  }
  S.items = [...res.drops.slice().reverse(), ...S.items];
  S.chests = res.chests || S.chests;
  applyState(res.state);
  S.opening.drops = res.drops;
  S.opening.ownedBefore = ownedBefore;
  runStage();
}

function runStage() {
  const o = S.opening;
  const n = o.drops.length;
  const stage = $("#stage");
  stage.hidden = false;
  document.body.style.overflow = "hidden";
  $("#stageTitle").textContent = `${crateOf(o.crate).name} × ${n}${o.fast ? "  ⚡" : ""}${S.autoRun ? `  🔁 ${S.autoRun.rounds}` : ""}`;
  updateAutoBtn();
  const reels = $("#reels"), results = $("#results");
  reels.hidden = false; results.hidden = true; results.innerHTML = "";
  $("#skipBtn").hidden = false;
  ["#sellAllBtn", "#againBtn", "#closeBtn"].forEach(s => $(s).hidden = true);
  $("#stageSum").textContent = "";

  const fitW = window.innerWidth - 40;
  const cols = Math.min(n <= 2 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5, Math.max(1, Math.floor(fitW / 230)));
  const rows = Math.ceil(n / cols);
  const gap = 12;
  reels.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  reels.style.maxWidth = n <= 2 ? "1100px" : "";
  reels.style.width = "100%";
  reels.style.margin = "0 auto";

  const W = Math.min(reels.clientWidth || window.innerWidth - 40, n <= 2 ? 1100 : 9999);
  const H = reels.clientHeight || window.innerHeight - 160;
  const cellW = (W - gap * (cols - 1)) / cols;
  const rowH = Math.min((H - gap * (rows - 1)) / rows, 280);
  const mw = Math.max(54, Math.min(150, cellW / 5, (rowH - 20) / 1.4));
  const mgap = Math.max(4, Math.round(mw * 0.06));
  const rh = Math.round(mw * 1.05 + (mw >= 70 ? 22 : 18) + 5 + 18);

  const STRIP = 54, WIN = 46;
  const rare = crateOf(o.crate).people.filter(id => rarityIdx(person(id).rarity) >= rarityIdx("gold"));
  reels.innerHTML = "";
  const now = performance.now();
  o.reels = o.drops.map((drop, i) => {
    const ids = Array.from({ length: STRIP }, () => weightedPerson(o.crate));
    ids[WIN] = drop.person;
    // czasem "prawie" - rzadka karta tuż obok wygranej
    if (rare.length && Math.random() < 0.28) ids[WIN + (Math.random() < 0.5 ? -1 : 1)] = rare[Math.floor(Math.random() * rare.length)];
    const el = document.createElement("div");
    el.className = "reel";
    el.style.setProperty("--rh", rh + "px");
    el.style.setProperty("--mw", mw + "px");
    el.style.setProperty("--gap", mgap + "px");
    el.innerHTML = `<div class="strip">${ids.map((id, k) => miniHTML(id, k === WIN)).join("")}</div><div class="reel-marker"></div>`;
    reels.appendChild(el);
    const strip = el.firstElementChild;
    const step = mw + mgap;
    const center = cellW / 2;
    let off = rand(-0.42, 0.42) * mw, egg = 0;
    if (S.cfg.easterEgg && Math.random() < S.cfg.easterEgg.chance) [off, egg] = eggSpot(step, mw, center, WIN, off);
    const from = rand(0, step * 0.8);
    const to = -(WIN * step + mw / 2 + off) + center;
    strip.style.transform = `translate3d(${from}px, -50%, 0)`;
    if (egg) spinEgg(strip, egg);
    const dur = o.fast ? 700 : rand(5200, 6200);
    const delay = o.fast ? i * 18 : i * 70;
    return { el, strip, drop, from, to, step, center, dur, start: now + delay, lastIdx: -1, done: false };
  });

  o.spinning = true;
  const easeSlow = t => 1 - Math.pow(1 - t, 4.2);
  const easeFast = t => 1 - Math.pow(1 - t, 3);
  const ease = o.fast ? easeFast : easeSlow;
  let lastLand = 0;
  const frame = ts => {
    if (S.opening !== o) return;
    let all = true;
    for (const r of o.reels) {
      if (r.done) continue;
      const t = Math.max(0, Math.min(1, (ts - r.start) / r.dur));
      const x = r.from + (r.to - r.from) * ease(t);
      r.strip.style.transform = `translate3d(${x.toFixed(1)}px, -50%, 0)`;
      const idx = Math.floor((r.center - x) / r.step);
      if (idx !== r.lastIdx) { if (r.lastIdx >= 0) Sound.tick(1 - t); r.lastIdx = idx; }
      if (t >= 1) {
        r.done = true;
        const rar = person(r.drop.person).rarity;
        r.el.classList.add("landed", "r-" + rar);
        if (rarityIdx(rar) >= rarityIdx("gold")) r.el.classList.add("jackpot");
        r.el.style.setProperty("--rc", S.cfg.rarities[rar].color);
        if (ts - lastLand > 60) { Sound.land(rar === "secret" ? "ultra" : rar); lastLand = ts; }
      } else all = false;
    }
    if (all) {
      o.spinning = false;
      $("#skipBtn").hidden = true;
      afterSpin(o);
    } else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function afterSpin(o) {
  await sleep(o.fast ? 250 : 700);
  if (S.opening !== o) return;
  // tajna karta przerywa autootwieranie - żeby jej nie przegapić
  if (S.autoRun && o.drops.some(d => person(d.person).rarity === "secret")) stopAuto("★ TAJNA KARTA! Auto zatrzymane");
  // legendarne, ultra i tajne dostają własne, wielkie odsłonięcie
  const epics = o.drops.filter(d => rarityIdx(person(d.person).rarity) >= rarityIdx("gold"))
    .sort((a, b) => rarityIdx(person(b.person).rarity) - rarityIdx(person(a.person).rarity) || varRank(b.variant) - varRank(a.variant));
  for (const d of epics) {
    await epicReveal(d, { fast: o.fast, auto: !!S.autoRun });
    if (S.opening !== o) return;
  }
  showResults(epics.length > 0);
}

function skipSpin() {
  const o = S.opening;
  if (!o || !o.spinning) return;
  const now = performance.now();
  o.reels.forEach(r => { r.start = Math.min(r.start, now - r.dur); });
}

function showResults(afterEpic = false) {
  const o = S.opening;
  o.spinning = false;
  o.showingResults = true;
  const n = o.drops.length;
  announceFirsts(o.drops);
  $("#reels").hidden = true;
  const results = $("#results");
  results.hidden = false;
  const avail = results.clientWidth || window.innerWidth - 40;
  const cols = Math.min(n <= 5 ? n : n <= 10 ? 5 : n <= 12 ? 6 : 7, Math.max(1, Math.floor(avail / 150)));
  const rcw = Math.min(n === 1 ? 320 : n <= 3 ? 260 : 220, (avail - 18 * (cols - 1) - 12) / cols);
  results.style.setProperty("--cols", cols);
  results.style.setProperty("--rcw", rcw + "px");

  const seenNew = new Set();
  results.innerHTML = o.drops.map((d, i) => {
    const p = person(d.person);
    const isNew = !o.ownedBefore.has(d.person) && !seenNew.has(d.person);
    if (isNew) seenNew.add(d.person);
    const big = rarityIdx(p.rarity) >= rarityIdx("gold");
    return `<div class="result r-${p.rarity}${big ? " big" : ""}" data-id="${d.id}"
              style="--rc:${S.cfg.rarities[p.rarity].color}; animation-delay:${i * (o.fast ? 25 : 70)}ms">
      ${isNew ? '<span class="new-badge">NOWA!</span>' : ""}
      ${cardHTML(d.person, d.variant)}
      <div class="rbtns">${favBtnHTML(d.id, d.fav)}<button class="btn sell rsell" data-id="${d.id}" title="Sprzedaj" ${d.fav ? "disabled" : ""}>💰 ${fmt(d.value)}</button></div>
    </div>`;
  }).join("");

  // najlepszy drop -> efekty
  let best = o.drops[0];
  for (const d of o.drops) {
    const a = rarityIdx(person(d.person).rarity), b = rarityIdx(person(best.person).rarity);
    if (a > b || (a === b && varRank(d.variant) > varRank(best.variant))) best = d;
  }
  const bestR = person(best.person).rarity;
  if (afterEpic) {
    // wielkie odsłonięcie już było - tylko lekki akcent
    flash(`radial-gradient(circle, ${S.cfg.rarities[bestR].color}55, transparent 70%)`);
    Sound.reveal("purple");
  } else {
    Sound.reveal(bestR);
    if (bestR === "red") flash("radial-gradient(circle, #ff404066, transparent 70%)");
  }
  const specials = o.drops.filter(d => isSpecial(d.variant));
  if (specials.length && !afterEpic) {
    const top = specials.reduce((a, d) => varRank(d.variant) > varRank(a.variant) ? d : a);
    const topBase = baseVariant(top.variant);
    const colors = {
      diamond: ["#e8fbff", "#9ff6ff", "#c9b8ff", "#ffffff"], emerald: ["#00c853", "#6dffb0", "#c6ffe0", "#ffffff"],
      ruby: ["#ff1744", "#ff8a9c", "#ffd0d8", "#ffffff"], amethyst: ["#9b3dff", "#c99bff", "#ecdcff", "#ffffff"],
      sapphire: ["#1c46d8", "#5a86ff", "#a8c0ff", "#ffffff"], blackdiamond: ["#0a0a0e", "#6a6a7c", "#c8c8d8", "#ffffff"], steel: ["#d2d9df", "#8c969f", "#3e464d"], clear: ["#ffffff", "#e0f7ff", "#bfefff"],
      negative: ["#000000", "#ffffff", "#7a7a7a", "#00e5ff"], gold: ["#ffc531", "#fff3b0", "#fff"], holo: ["#9ff6ff", "#ff9ff3", "#fff"],
      silver: ["#e6ebf2", "#b8c2d0", "#ffffff"], bronze: ["#cd7f32", "#f0b27a", "#ffe0c0"], pearl: ["#ffffff", "#ffd1e4", "#d3fff1", "#d3e2ff"],
      pixel: ["#3a5bd0", "#ffffff", "#7dff5a", "#ffe13b"], glass: ["#2f7fc0", "#3fa0a0", "#6a5aa8", "#e8a33a", "#ffffff"],
      neon: ["#ff3df0", "#3de0ff", "#ffe63c", "#ffffff"], thermal: ["#2a0a6a", "#d8303a", "#f07a1a", "#ffd23f", "#fffbe8"],
      blueprint: ["#1f3a7a", "#e8f4ff", "#4a8ad8"], glitch: ["#ff2b5a", "#00e5ff", "#ffffff", "#7a2bff"], mosaic: ["#c91a09", "#f2cd37", "#0055bf", "#237841"],
      popart: ["#ffe100", "#e8202f", "#ff4fa0", "#2fd0ff", "#7cff4a"], noir: ["#e8e8e8", "#2a2a2a", "#ffffff"],
      slime: ["#7dff3a", "#c6ff6c", "#3fbf1a"], matte: ["#2a2a2a", "#5c5c5c", "#111"], racing: ["#c8202f", "#f2e6cf", "#161210"],
      bismuth: ["#ff4fb5", "#ffd23f", "#3fe0ff", "#7a5cff"], digital: ["#3dff6e", "#0f6a26", "#eaffea"], cyber: ["#ff2bd6", "#00e5ff", "#fcee0a"],
      fade: ["#f9e45b", "#f7a23b", "#f05ba5", "#a86bf0", "#5aa8f5"], wanted: ["#f2e2b8", "#b8955a", "#2a1608"], artdeco: ["#d4af37", "#fff3c4", "#0a0908"],
      cheese: ["#ffd34a", "#ffe680", "#b88512"], aero: ["#4cc2ff", "#ffffff", "#7ef03a", "#ffd23f"],
      honey: ["#ffd75e", "#f2a20f", "#b86a08"],
      chinese: ["#d81e1e", "#e2b13c", "#fff2b0"], moro: ["#4a4f2e", "#6a5a3a", "#1c1f14", "#a89a6a"], beer: ["#f7bf3a", "#fffdf6", "#cf7a0c"],
      electric: ["#9fdcff", "#ffffff", "#4fb8ff"],
      synthwave: ["#ff2bd6", "#00e5ff", "#ffe14a", "#6a1fb8"], motor: ["#e8202f", "#f2f2f2", "#1b1b1b"],
      vintage: ["#efe4cb", "#b8913d", "#6b4c22"], marble: ["#ffffff", "#d9d4c8", "#d4af37"], toxic: ["#5dff1f", "#b6ff3a", "#ffd400", "#0c1407"], reverse: ["#c9d6ff", "#ffffff", "#9ff6ff"], bw: ["#ffffff", "#111111", "#888888"],
      rzulty: ["#ffe600", "#fff6a0", "#ffffff"], flag: ["#ffffff", "#dc143c", "#ffcf3f"], halloween: ["#ff7a00", "#1a0a12", "#8a2be2", "#ffd84a"],
      lantern: ["#ffb347", "#ff7a00", "#fff1c1", "#3a1a06"], devil: ["#ff1a1a", "#b3001b", "#ffcf5a", "#120002"],
      sketch: ["#1b1712", "#f4ecd8", "#6b5d4a"], galaxy: ["#7b4dff", "#1fb6ff", "#ff4fd8", "#ffffff"],
      mlg: ["#9cff00", "#ffe100", "#ff7a00", "#ff2bd6", "#00e5ff"],
    }[topBase] || GOLDS;
    if (topBase === "mlg") setTimeout(() => Sound.airhorn(), 250);
    const rare = varRank(top.variant) >= varRank("gold");
    setTimeout(() => confetti(colors, topBase === "negative" ? 360 : varRank(top.variant) > varRank("gold") ? 260 : rare ? 140 : 60), 300);
    if (rare) toast(`✨ ${variantName(top.variant).toUpperCase()}: ${person(top.person).name}!`);
  }

  updateStageBar();
  autoNext(o);
}

function updateStageBar() {
  const o = S.opening;
  const unsold = o.drops.filter(d => !d.sold);
  const sellable = unsold.filter(d => !d.fav);  // ulubione (⭐) zostają
  $("#stageSum").textContent = unsold.length ? `Wartość: ${fmt(unsold.reduce((a, d) => a + d.value, 0))}` : "Wszystko sprzedane";
  const sellAll = $("#sellAllBtn");
  sellAll.hidden = !sellable.length;
  sellAll.textContent = `💰 Sprzedaj ${sellable.length < unsold.length ? "resztę" : "wszystko"} (${fmt(sellable.reduce((a, d) => a + d.value, 0))})`;
  const again = $("#againBtn");
  const price = crateOf(o.crate).price;
  again.hidden = false;
  again.textContent = `🔁 Otwórz ponownie (${o.count} × ${fmt(price)})`;
  $("#closeBtn").hidden = false;
  $("#closeBtn").textContent = unsold.length ? "✔ Zatrzymaj i zamknij" : "✔ Zamknij";
}

async function sellResult(ids) {
  const o = S.opening;
  const rare = o.drops.filter(d => ids.includes(d.id) && rarityIdx(person(d.person).rarity) >= rarityIdx("gold"));
  if (rare.length && !confirm(`Na pewno sprzedać ${rare.length > 1 ? "legendarne karty" : person(rare[0].person).name}?`)) return;
  try {
    await sellIds(ids);
  } catch (e) { Sound.error(); toast(e.message, true); return; }
  ids.forEach(id => {
    const d = o.drops.find(d => d.id === id); if (d) d.sold = true;
    $(`.result[data-id="${id}"]`)?.classList.add("sold");
  });
  updateStageBar();
}

function closeStage() {
  stopAuto();
  $("#stage").hidden = true;
  document.body.style.overflow = "";
  $("#reels").innerHTML = ""; $("#results").innerHTML = "";
  S.opening = null;
  rerenderCurrent();
}

async function openAgain() {
  const o = S.opening;
  S.crate = o.crate; S.count = o.count; S.fast = $("#fastToggle").checked;
  S.opening = null;
  $("#stage").hidden = true;
  document.body.style.overflow = "";
  await openCrates();
  if (!S.opening) rerenderCurrent();
}

function flash(bg) {
  const f = $("#flash");
  f.style.background = bg;
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
}

// ================================================================ KONFETTI

const confettiState = { parts: [], running: false };
function confetti(colors, count) {
  const cv = $("#confetti");
  cv.width = innerWidth; cv.height = innerHeight;
  for (let i = 0; i < count; i++) {
    const fromLeft = i % 2 === 0;
    confettiState.parts.push({
      x: fromLeft ? -10 : cv.width + 10, y: cv.height * rand(0.4, 0.8),
      vx: (fromLeft ? 1 : -1) * rand(4, 14), vy: rand(-18, -8),
      w: rand(6, 12), h: rand(8, 16), rot: rand(0, 6.28), vr: rand(-0.3, 0.3),
      c: colors[i % colors.length], life: 0,
    });
  }
  if (!confettiState.running) { confettiState.running = true; requestAnimationFrame(confettiFrame); }
}
function drawCoin(ctx, p) {
  p.vy -= 0.2; // monety spadają wolniej niż konfetti
  const sx = Math.abs(Math.cos(p.life / 7)) * 0.85 + 0.15, r = p.w / 2;
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(sx, 1);
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r);
  g.addColorStop(0, "#fff6c2"); g.addColorStop(0.5, "#ffc531"); g.addColorStop(1, "#b37a00");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.fill();
  ctx.strokeStyle = "#8a5d00"; ctx.lineWidth = 2; ctx.stroke();
  if (sx > 0.5) { ctx.fillStyle = "#8a5d00"; ctx.font = `bold ${r * 0.8}px Rubik, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("gr", 0, 1); }
  ctx.restore();
}
function confettiFrame() {
  const cv = $("#confetti"), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  confettiState.parts = confettiState.parts.filter(p => p.y < cv.height + 40 && p.life < 400);
  for (const p of confettiState.parts) {
    p.life++; p.vy += 0.35; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    if (p.shape === "coin") { drawCoin(ctx, p); continue; }
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life / 6)));
    ctx.restore();
  }
  if (confettiState.parts.length) requestAnimationFrame(confettiFrame);
  else { confettiState.running = false; ctx.clearRect(0, 0, cv.width, cv.height); }
}

// ================================================================ KLASER

function ownedMap() {
  const m = {};
  for (const it of S.items) {
    const e = (m[it.person] ||= { ids: [], byVar: {}, best: "normal" });
    e.ids.push(it.id);
    (e.byVar[it.variant] ||= []).push(it.id);
    if (varRank(it.variant) > varRank(e.best)) e.best = it.variant;
  }
  for (const e of Object.values(m)) if (!e.byVar[e.best]) e.best = Object.keys(e.byVar)[0];
  return m;
}

// karty, które gracz kiedyś miał, a teraz nie ma: { personId: { best: najlepszy wariant, count: 0 } }
function collectedOwned(pairs) {
  const out = {};
  for (const [pid, v] of pairs) {
    if (!S.cfg.people[pid]) continue;
    const o = (out[pid] ||= { best: v, count: 0 });
    if (varRank(v) > varRank(o.best)) o.best = v;
  }
  return out;
}

// owned: { personId: { best: wariant, count: liczba } } - count 0 = karta była, ale już jej nie ma (sprzedana / oddana)
function binderHTML(crate, owned, spread, { mine = true } = {}) {
  const ids = crate.people.filter(id => person(id)?.source !== "ufo" || owned[id]);   // karta z UFO - niespodzianka, nie w klaserze
  const pages = [];
  for (let i = 0; i < ids.length; i += 9) pages.push(ids.slice(i, i + 9));
  if (!pages.length) pages.push([]);
  const spreads = Math.ceil(pages.length / 2);
  spread = Math.max(0, Math.min(spread, spreads - 1));
  const pageHTML = (page, side) => {
    const slots = (page || []).concat(Array(9 - (page || []).length).fill(null));
    return `<div class="bpage ${side}">${slots.map(id => {
      if (!id) return `<div class="pocket"></div>`;
      const p = person(id), o = owned[id];
      if (!o) {
        if (p.rarity === "secret") return `<div class="pocket secret-pocket"><div class="card-back secret-back"><div><div class="q">★</div><div class="n">TAJNA</div></div></div></div>`;
        return `<div class="pocket"><div class="card-back"><div><div class="q">?</div><div class="n">#${String(crate.people.indexOf(id) + 1).padStart(3, "0")}</div></div></div></div>`;
      }
      return `<div class="pocket owned${o.count ? "" : " gone"}${p.rarity === "secret" ? " secret-pocket" : ""}" data-pid="${id}" data-variant="${o.best}"${o.count ? "" : ' title="Ta karta jest w kolekcji, ale nie masz już żadnego egzemplarza"'}>${cardHTML(id, o.best)}${o.count > 1 ? `<span class="count">×${o.count}</span>` : o.count ? "" : '<span class="count">×0</span>'}</div>`;
    }).join("")}</div>`;
  };
  const html = pageHTML(pages[spread * 2], "left") + pageHTML(pages[spread * 2 + 1], "right") +
    `<div class="binder-rings">${"<span></span>".repeat(4)}</div>`;
  const have = ids.filter(id => owned[id]).length;
  const special = ids.filter(id => owned[id] && isSpecial(owned[id].best)).length;
  const progress = `
    <span>${mine ? "Zebrano" : "Zebrane"} <b style="color:var(--text)">${have}/${ids.length}</b></span>
    <div class="pbar"><div style="width:${ids.length ? have / ids.length * 100 : 0}%"></div></div>
    ${S.cfg.rarityOrder.map(r => {
      const all = ids.filter(id => person(id).rarity === r);
      if (!all.length) return "";
      return `<span class="rar-count rc-${r}" style="--rc:${S.cfg.rarities[r].color}"><i></i>${all.filter(id => owned[id]).length}/${all.length}</span>`;
    }).join("")}
    <span>✨ warianty ${special}/${ids.length}</span>`;
  const a = spread * 2 + 1, b = Math.min(a + 1, pages.length);
  return { html, progress, spread, spreads, label: `Strony ${a}–${b} z ${pages.length}` };
}

function renderBinder() {
  $("#binderSeg").innerHTML = crateList().map(c =>
    `<button data-crate="${c.id}" class="${S.binderCrate === c.id ? "active" : ""}">${esc(c.emoji)} ${esc(c.short)}</button>`).join("");
  const crate = crateOf(S.binderCrate);
  if (!crate) { $("#binder").innerHTML = ""; return; }
  noteCollected(S.items);
  const owned = collectedOwned([...S.collected].map(k => k.split("|")));
  for (const [pid, o] of Object.entries(ownedMap())) owned[pid] = { best: o.best, count: o.ids.length };
  const b = binderHTML(crate, owned, S.spread);
  S.spread = b.spread;
  $("#binderProgress").innerHTML = b.progress;
  $("#binder").innerHTML = b.html;
  $("#pagePrev").disabled = S.spread === 0;
  $("#pageNext").disabled = S.spread >= b.spreads - 1;
  $("#pageIndicator").textContent = b.label;
}

function flipBinder(dir) {
  const before = S.spread;
  S.spread += dir;
  renderBinder();
  if (S.spread === before) return;
  Sound.page();
  const b = $("#binder");
  b.classList.remove("flip-next", "flip-prev"); void b.offsetWidth;
  b.classList.add(dir > 0 ? "flip-next" : "flip-prev");
}

// ================================================================ MODAL KARTY

function openModal(pid) {
  const o = ownedMap()[pid];
  if (!o) { closeModal(); return; }
  const p = person(pid);
  const R = S.cfg.rarities[p.rarity];
  const special = isSpecialCard(p);
  const rows = S.cfg.variantOrder.slice().reverse().filter(v => o.byVar[v]).map(v => {
    const favs = new Set(S.items.filter(i => i.fav).map(i => i.id));
    // ulubionych nie sprzedajemy, karty specjalnej w ogóle (można ją wymienić albo wystawić na rynku)
    const all = o.byVar[v], list = special ? [] : all.filter(id => !favs.has(id)), val = cardValue(pid, v);
    const nFav = all.length - list.length;
    return `<div class="copy-row">
      <span class="lbl"><span class="vdot ${vtClass(v)}"></span>${variantName(v)} ×${all.length}${nFav ? ` <span class="fav-note">★${nFav}</span>` : ""} <small>· ${fmt(val)}/szt.</small></span>
      <span>${list.length ? `<button class="btn" data-sell="${list[0]}">Sprzedaj 1</button>` : ""}
      ${list.length > 1 ? `<button class="btn sell" data-sell="${list.join(",")}">${nFav ? "Pozostałe" : "Wszystkie"} (${fmt(val * list.length)})</button>` : ""}</span>
    </div>`;
  }).join("");
  const dupes = dupesOf(o);
  $("#modalBox").innerHTML = `
    ${cardHTML(pid, o.best)}
    <div class="modal-side">
      <h3>${esc(p.name)}</h3>
      <div class="muted">${S.cfg.types[p.type].icon} ${S.cfg.types[p.type].name} · ${esc(crateOf(p.crate).name)} · <b style="color:${R.color}">${R.name}</b></div>
      <div>Posiadasz: <b>${o.ids.length}</b></div>
      ${special ? `<div class="special-note">🃏 Karta specjalna — nie da się jej sprzedać grze, postawić w kasynie ani zużyć w kuźni. Możesz ją wymienić albo wystawić na 🏪 Rynku.</div>` : ""}
      ${rows}
      <div class="modal-actions">
        ${dupes.length ? `<button class="btn sell" data-sell="${dupes.join(",")}">Sprzedaj duplikaty (zostaw najlepszą)</button>` : ""}
        <button class="btn" id="modalClose">Zamknij</button>
      </div>
    </div>`;
  $("#modal").hidden = false;
  $("#modal").dataset.pid = pid;
}

function dupesOf(o) {
  // zostawiamy jedną kartę - w najlepszym wariancie (najlepiej ulubioną) - i wszystkie ulubione; karty specjalne zostają
  if (isSpecialCard(S.items.find(i => i.id === o.ids[0])?.person)) return [];
  const favs = new Set(S.items.filter(i => i.fav).map(i => i.id));
  const keep = o.byVar[o.best].find(id => favs.has(id)) ?? o.byVar[o.best][0];
  return o.ids.filter(id => id !== keep && !favs.has(id));
}

function closeModal() { $("#modal").hidden = true; }

// ================================================================ EKWIPUNEK

function filteredItems() {
  const f = S.inv;
  const list = S.items.filter(i => {
    const p = person(i.person);
    return (f.crate === "all" || (p.crates || [p.crate]).includes(f.crate)) &&
           (!f.rarities.size || f.rarities.has(p.rarity)) && cardMatches(i, f.q) &&
           (f.variant === "all" || (f.variant === "fav" ? i.fav : f.variant === "special" ? isSpecial(i.variant) : i.variant === f.variant));
  });
  const byName = (a, b) => person(a.person).name.localeCompare(person(b.person).name, "pl");
  const by = {
    new: (a, b) => b.id - a.id,
    value: (a, b) => b.value - a.value || b.id - a.id,
    rarity: (a, b) => rarityIdx(person(b.person).rarity) - rarityIdx(person(a.person).rarity) || varRank(b.variant) - varRank(a.variant) || byName(a, b),
    name: (a, b) => byName(a, b) || varRank(b.variant) - varRank(a.variant),
  }[f.sort];
  if (f.sort === "dupes") return sortCards(list, "dupes");
  return list.sort(by);
}

function chestTileHTML(kind, n) {
  const money = kind.startsWith("money_") ? S.cfg.moneyChests[kind.slice(6)] : null;
  const c = money || crateOf(kind);
  if (!c) return "";
  const art = `<div class="crate-art chest-art" style="--crate-bg: linear-gradient(180deg, ${c.color1} 0 50%, ${c.color2} 50%); --crate-lid: linear-gradient(180deg, ${c.color1}, ${c.color2})">
      <div class="crate-box"><div class="crate-emblem">${esc(c.emoji)}</div></div><div class="crate-lid"></div><div class="crate-lock"></div></div>`;
  const k = n => n.toLocaleString("pl-PL");
  return `<div class="chest-tile${money ? " money" : ""}${kind === "money_mega" ? " mega" : ""}">
    ${art}
    <span class="chest-count">×${n}</span>
    <div class="chest-name">${esc(c.name)}</div>
    <div class="chest-sub">${money ? `${k(money.min)}–${k(money.max)} gr` : `${c.people.length} kart`}</div>
    <div class="chest-btns">${money
      ? `<button class="btn primary" data-open-money="${kind.slice(6)}">Otwórz</button>`
      : `<button class="btn primary" data-open-crate="${kind}" data-n="1">Otwórz</button>${n > 1 ? `<button class="btn" data-open-crate="${kind}" data-n="${Math.min(n, S.cfg.maxOpen)}">×${Math.min(n, S.cfg.maxOpen)}</button>` : ""}`}</div>
  </div>`;
}

function renderChestShelf() {
  const kinds = Object.entries(S.chests).filter(([, n]) => n > 0)
    .sort(([a], [b]) => (b.startsWith("money_") - a.startsWith("money_")) || a.localeCompare(b));
  const shelf = $("#chestShelf");
  shelf.hidden = !kinds.length;
  shelf.innerHTML = kinds.length ? `<h3>📦 Twoje skrzynki</h3><div class="chest-grid">${kinds.map(([k, n]) => chestTileHTML(k, n)).join("")}</div>` : "";
}

function renderInventory() {
  const hof = S.inv.mode === "hof";
  $$("#invMode [data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === S.inv.mode));
  $("#invCards").hidden = hof;
  $("#hofBody").hidden = !hof;
  if (hof) return renderHallOfFame();
  renderChestShelf();
  const f = S.inv;
  const inCrate = id => S.items.filter(i => { const p = person(i.person); return (p.crates || [p.crate]).includes(id); }).length;
  $("#invCrateSeg").innerHTML = [["all", "Wszystkie", S.items.length], ...crateList().map(c => [c.id, `${c.emoji} ${c.short}`, inCrate(c.id)])]
    .map(([id, n, count]) => `<button data-crate="${id}" class="${f.crate === id ? "active" : ""}">${esc(n)} <small>${count}</small></button>`).join("");
  $("#invRarity").innerHTML = S.cfg.rarityOrder.map(r =>
    `<button class="rf rf-${r}${f.rarities.has(r) ? " active" : ""}" data-r="${r}" style="--rc:${S.cfg.rarities[r].color}"><i></i>${S.cfg.rarities[r].name}</button>`).join("");
  $("#invVariant").innerHTML = [["all", "Wszystkie warianty"], ["fav", "⭐ Tylko ulubione"], ["special", "✨ Tylko specjalne"],
    ...S.cfg.variantOrder.map(v => [v, variantName(v)])].map(([v, n]) =>
    `<option value="${v}"${f.variant === v ? " selected" : ""}>${n}</option>`).join("");
  $("#invSort").value = f.sort;

  const list = filteredItems();
  const total = list.reduce((a, i) => a + i.value, 0);
  $("#invSummary").innerHTML = `Kart: <b>${list.length}</b> · Wartość: <b>${fmt(total)}</b>` +
    (list.length !== S.items.length ? ` <span class="muted">(wszystkich: ${S.items.length})</span>` : "");
  const grid = $("#invGrid");
  if (!list.length) {
    grid.innerHTML = ufoItemHTML() + `<div class="empty" style="grid-column:1/-1">${S.items.length ? "Brak kart pasujących do filtrów." : "Ekwipunek jest pusty. Otwórz jakąś skrzynkę! 📦"}</div>`;
  } else {
    grid.innerHTML = ufoItemHTML() + list.slice(0, f.limit).map(i =>
      `<div class="inv-item${f.selected.has(i.id) ? " sel" : ""}${i.fav ? " fav" : ""}" data-id="${i.id}"><span class="tick">✓</span><button class="zoom-btn" title="Powiększ">🔍</button>${favBtnHTML(i.id, i.fav)}${cardHTML(i.person, i.variant)}</div>`).join("");
  }
  $("#invMore").parentElement.hidden = list.length <= f.limit;
  $("#invMore").textContent = `Pokaż więcej (${list.length - f.limit})`;
  updateSellbar();
}

// ================================================================ WIZYTA UFO (easter egg)
// Bardzo rzadko (UFO_VISIT w data.py, losuje serwer w /api/me) w ekwipunku pojawia się karta ze źródłem "ufo" - na samej
// górze, bez żadnych powiadomień. Gracz jej nie dostaje: kliknięta - przylatuje po nią UFO i ją wciąga; po wyjściu
// z ekwipunku znika bez animacji. S.ufo = { pid, shown } - shown: już pokazana (serwer zapomina o wizycie od razu).
function noteUfo(me) { if (me?.ufo && !S.ufo && person(me.ufo)) S.ufo = { pid: me.ufo, shown: false }; }
function ufoArrive() {
  if (!S.ufo || S.ufo.shown) return;
  S.ufo.shown = true;
  api("/api/ufo/seen", {}).catch(() => {});
}
function ufoLeave() { if (!S.ufo?.abducting) S.ufo = null; }
function ufoItemHTML() {
  if (!S.ufo?.shown || S.ufo.abducting || S.inv.mode === "hof") return "";
  const p = person(S.ufo.pid);
  return p ? `<div class="inv-item ufo-item">${cardHTML(p.id, p.fixedVariant || "ufo")}</div>` : "";
}

const UFO_SHIP = `<svg viewBox="0 0 170 90" aria-hidden="true">
  <defs><radialGradient id="ufDome" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#f2fdff"/><stop offset=".55" stop-color="#9fe6f5" stop-opacity=".85"/><stop offset="1" stop-color="#3a7f90" stop-opacity=".9"/></radialGradient>
  <linearGradient id="ufHull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3e6ea"/><stop offset=".45" stop-color="#9aa0a7"/><stop offset="1" stop-color="#4b5057"/></linearGradient></defs>
  <ellipse cx="85" cy="70" rx="34" ry="9" fill="#b9f3ff" opacity=".55"/>
  <path d="M52 44 Q55 12 85 10 Q115 12 118 44 Z" fill="url(#ufDome)" stroke="#5b6a70" stroke-width="1.5"/>
  <ellipse cx="85" cy="52" rx="82" ry="20" fill="url(#ufHull)" stroke="#33373c" stroke-width="2"/>
  <ellipse cx="85" cy="46" rx="60" ry="8" fill="none" stroke="#ffffff70" stroke-width="2"/>
  ${[22, 46, 72, 98, 124, 148].map(x => `<circle class="ul" cx="${x}" cy="${(55 - Math.abs(85 - x) / 12).toFixed(1)}" r="4.5" fill="#fff6a8"/>`).join("")}
</svg>`;

// Kliknięta karta z wizyty UFO: UFO przylatuje, wciąga kartę promieniem i odlatuje (dźwięki: Sound.ufo*)
async function ufoAbduct(item) {
  if (!S.ufo || S.ufo.abducting) return;
  S.ufo.abducting = true;
  const card = item.querySelector(".card");
  const r = card.getBoundingClientRect();
  const scene = document.createElement("div");
  scene.className = "ufo-scene";
  const cx = r.left + r.width / 2;
  const hoverY = Math.max(70, r.top - 70);               // UFO nad kartą (gdy karta przy górze ekranu - przy samej górze)
  const fromLeft = cx > innerWidth / 2;                    // przylatuje z dalszej strony ekranu
  scene.innerHTML = `<div class="ufo-beam"></div><div class="ufo-card">${card.outerHTML}</div><div class="ufo-ship">${UFO_SHIP}</div>`;
  document.body.appendChild(scene);
  const [beam, ghost, ship] = scene.children;
  Object.assign(ghost.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px" });
  Object.assign(beam.style, { left: cx + "px", top: hoverY + "px", height: Math.max(40, r.bottom - hoverY) + "px" });
  item.classList.add("gone");
  const at = (x, y, extra = "") => `translate(${x}px, ${y}px) ${extra}`;
  const startX = fromLeft ? -160 : innerWidth + 160;
  try {
    // 1. przylot - z daleka, z lekkim bujaniem
    Sound.ufoArrive();
    await ship.animate([
      { transform: at(startX, -120, "rotate(-14deg) scale(.6)") },
      { transform: at((startX + cx) / 2, hoverY - 60, "rotate(8deg) scale(.85)"), offset: .6 },
      { transform: at(cx, hoverY + 8, "rotate(-4deg)"), offset: .85 },
      { transform: at(cx, hoverY, "rotate(0deg)") },
    ], { duration: 1500, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" }).finished;
    const bob = ship.animate([{ transform: at(cx, hoverY) }, { transform: at(cx, hoverY - 5, "rotate(1.5deg)") }, { transform: at(cx, hoverY) }],
      { duration: 900, iterations: Infinity, easing: "ease-in-out" });
    // 2. promień
    Sound.ufoBeam();
    await beam.animate([{ opacity: 0, transform: "scaleY(0)" }, { opacity: 1, transform: "scaleY(1)" }],
      { duration: 350, easing: "ease-out", fill: "forwards" }).finished;
    // 3. karta drży, unosi się, kręci i maleje w środku UFO
    const dy = hoverY + 10 - (r.top + r.height / 2);
    await ghost.animate([
      { transform: "none", filter: "brightness(1)" },
      { transform: "translateX(-3px) rotate(-1deg)", offset: .06 }, { transform: "translateX(3px) rotate(1deg)", offset: .12 },
      { transform: "translateX(-2px)", offset: .18 }, { transform: "translateY(-6px)", filter: "brightness(1.4)", offset: .26 },
      { transform: `translateY(${dy * .55}px) rotate(200deg) scale(.55)`, filter: "brightness(1.8)", offset: .7 },
      { transform: `translateY(${dy}px) rotate(420deg) scale(.04)`, filter: "brightness(3)", opacity: .6 },
    ], { duration: 1900, easing: "cubic-bezier(.5,0,.7,1)", fill: "forwards" }).finished;
    ghost.remove();
    // 4. promień gaśnie, UFO odlatuje
    await beam.animate([{ opacity: 1, transform: "scaleY(1)" }, { opacity: 0, transform: "scaleY(0)" }],
      { duration: 300, easing: "ease-in", fill: "forwards" }).finished;
    bob.cancel();
    Sound.ufoLeave();
    const endX = fromLeft ? innerWidth + 200 : -200;
    await ship.animate([
      { transform: at(cx, hoverY) },
      { transform: at(cx + (fromLeft ? -20 : 20), hoverY + 10, "rotate(-6deg)"), offset: .2 },
      { transform: at(endX, -200, `rotate(${fromLeft ? 18 : -18}deg) scale(.3)`) },
    ], { duration: 1000, easing: "cubic-bezier(.6,0,.9,.4)", fill: "forwards" }).finished;
  } finally {
    scene.remove();
    item.remove();
    S.ufo = null;
  }
}

function updateSellbar() {
  const sel = S.items.filter(i => S.inv.selected.has(i.id) && !i.fav && !isSpecialCard(i.person));
  $("#selInfo").textContent = `Zaznaczono ${sel.length}` + (sel.length ? ` (${fmt(sel.reduce((a, i) => a + i.value, 0))})` : "");
  $("#sellSel").disabled = !sel.length;
  $("#selNone").disabled = !sel.length;
  $("#sellbar").hidden = currentView() !== "inventory" || S.inv.mode === "hof" || !S.items.length;
}

async function sellSelected() {
  const sel = S.items.filter(i => S.inv.selected.has(i.id) && !i.fav && !isSpecialCard(i.person));
  if (!sel.length) { toast("⭐ Zaznaczone karty są ulubione albo specjalne — nie da się ich sprzedać"); return; }
  const value = sel.reduce((a, i) => a + i.value, 0);
  const rare = sel.filter(i => rarityIdx(person(i.person).rarity) >= rarityIdx("gold"));
  if ((rare.length || value >= 1000) &&
      !confirm(`Sprzedać ${sel.length} ${plural(sel.length, "kartę", "karty", "kart")} za ${fmt(value)}?` +
               (rare.length ? `\nW tym ${rare.length} legendarnych lub lepszych!` : ""))) return;
  try { await sellIds(sel.map(i => i.id)); } catch (e) { Sound.error(); toast(e.message, true); }
  renderInventory();
}

async function sellAllDupes() {
  const owned = ownedMap();
  const ids = Object.values(owned).flatMap(dupesOf);
  if (!ids.length) { toast("Nie masz duplikatów."); return; }
  const value = S.items.filter(i => ids.includes(i.id)).reduce((a, i) => a + i.value, 0);
  if (!confirm(`Sprzedać ${ids.length} ${plural(ids.length, "duplikat", "duplikaty", "duplikatów")} za ${fmt(value)}?\n(Z każdej osoby zostanie 1 karta — w najlepszym wariancie.)`)) return;
  try { await sellIds(ids); } catch (e) { Sound.error(); toast(e.message, true); }
  renderInventory();
}

// ================================================================ KARTY SPECJALNE: LINKI I MAKIETY

// Link od admina do karty specjalnej (/link/<token>): odbieramy kartę (każdy gracz raz na link) i pokazujemy ją
async function claimLink(token) {
  history.replaceState(null, "", "/inventory");
  S.inv.mode = "cards";
  switchView("inventory", "none");
  let res;
  try { res = await api(`/api/links/${encodeURIComponent(token)}/claim`, {}); }
  catch (e) { Sound.error(); toast(e.message, true); return; }
  S.items = [res.item, ...S.items];
  noteCollected([res.item]);
  applyState(res.state);
  if (currentView() === "inventory") renderInventory();
  await epicReveal(res.item);
  announceFirsts([res.item]);
  toast(`🎁 ${person(res.item.person).name} — karta specjalna jest już w twoim ekwipunku!`);
}

// Makiety (/mockups, tylko admini): każdy wygląd każdego wariantu kart specjalnych na przykładowej karcie
// (Donald Tusk - pl_tusk) i wszystkie karty specjalne z gry.
// Admin wybiera wariant i wygląd karty specjalnej w panelu (edycja karty); przycisk "Podgląd" w panelu otwiera
// /mockups?card=<id>&variant=<wariant>&style=<wygląd> - podgląd karty jak w skrzynce, także z niezapisanym wyglądem.
function renderMockups() {
  const pq = new URLSearchParams(location.search).get("preview");
  if (pq) return renderCardPreview(pq);
  const base = person("pl_tusk") || Object.values(S.cfg.people).find(p => !p.masked && p.rarity !== "secret");
  const crate = crateList().find(c => c.special) || crateOf(base.crate);
  const real = Object.values(S.cfg.people).filter(p => isSpecialCard(p) && !p.id.startsWith("__"))
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  const realHTML = `<section class="panel mock-sec mock-real"><h3>🎴 Karty specjalne w grze <small class="muted">— ${real.length
    ? "kliknij kartę, żeby zobaczyć ją tak jak w skrzynce" : "brak, dodaj je w panelu admina (rzadkość „Specjalna”)"}</small></h3>
    <div class="mock-grid">${real.map(p => `<figure class="mock"><div class="mock-card" data-real="${esc(p.id)}">${cardHTML(p.id, p.fixedVariant)}</div>
      <figcaption><b>${esc(p.name)}</b><span class="muted small">${esc(variantName(p.fixedVariant))}${
        (S.cfg.variants[p.fixedVariant]?.styles || []).length > 1 ? ` · wygląd ${p.style || 1}. ${esc(S.cfg.variants[p.fixedVariant].styles[(p.style || 1) - 1] || "")}` : ""
      } · ${esc(S.cfg.specialSources[p.source] || "")}</span></figcaption></figure>`).join("")}</div></section>`;
  const sections = S.cfg.specialVariants.map(v => {
    const V = S.cfg.variants[v];
    const cards = (V.styles || ["—"]).map((name, i) => {
      const id = `__mock_${v}_${i + 1}`;   // przykładowa karta tylko na czas budowania HTML
      S.cfg.people[id] = Object.assign({}, base, {
        id, rarity: "special", crate: crate.id, crates: [crate.id], number: i + 1, style: i + 1, fixedVariant: v,
        source: v === "jeans" ? "link" : v === "ufo" ? "ufo" : "casino", imgAs: base.id,
        attack2: base.attack2 || "Specjalny atak", dmg2: base.dmg2 || Math.round(base.dmg * 1.4) });
      const html = `<figure class="mock"><div class="mock-card">${cardHTML(id, v)}</div>
        <figcaption><b>${i + 1}. ${esc(name)}</b><span class="muted small">wygląd ${i + 1} · ${esc(V.name)}</span></figcaption></figure>`;
      delete S.cfg.people[id];
      return html;
    }).join("");
    return `<section class="panel mock-sec"><h3>${{ joker: "🃏", jeans: "👖", ufo: "🛸" }[v] || "🎴"} ${esc(V.name)} <small class="muted">— ${esc(V.desc || "")}</small></h3>
      <div class="mock-grid">${cards}</div></section>`;
  }).join("");
  $("#mockupsBody").innerHTML = `<div class="mock-head">
      <h2>🎴 Makiety kart specjalnych</h2>
      <p class="muted">Rzadkość <b style="color:${S.cfg.rarities.special.color}">${esc(S.cfg.rarities.special.name)}</b> — między Legendarną a ULTRA.
        Na przykładzie: ${esc(base.name)}. Wariant i wygląd każdej karty specjalnej wybierasz w <a href="/admin">panelu admina</a>
        (rzadkość „Specjalna” w edycji karty).</p></div>${realHTML}${sections}`;
  $("#mockupsBody").onclick = e => {
    const card = e.target.closest("[data-real]");
    if (card) { Sound.click(); openViewer(card.dataset.real, person(card.dataset.real).fixedVariant); }
  };
  // podgląd z panelu admina: /mockups?card=<id>&variant=...&style=... (wariant i wygląd mogą być jeszcze niezapisane)
  const q = new URLSearchParams(location.search), pid = q.get("card");
  if (pid && person(pid)) {
    history.replaceState(null, "", location.pathname);
    const p = person(pid), saved = { fixedVariant: p.fixedVariant, style: p.style };
    if (S.cfg.variants[q.get("variant")]?.special) p.fixedVariant = q.get("variant");
    if (+q.get("style") > 0) p.style = +q.get("style");
    try { openViewer(pid, p.fixedVariant); } finally { Object.assign(p, saved); }
  }
}

// Podgląd jednej karty we wszystkich jej możliwych wariantach (possibleVariants) - /mockups?preview=<id>&embed=1, osadzony
// w oknie edycji karty w panelu admina. Dane karty bierzemy z /api/admin/catalog, więc działa też dla tajnej karty (bez
// maski, zdjęcie z ?admin=1) i dla karty ukrytej. Kliknięcie karty = duży podgląd.
async function renderCardPreview(pid) {
  const box = $("#mockupsBody");
  box.innerHTML = '<div class="empty">Ładowanie…</div>';
  let card;
  try { card = (await api("/api/admin/catalog")).cards.find(c => c.id === pid); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (!card) { box.innerHTML = '<div class="empty">Nie ma takiej karty.</div>'; return; }
  const p = S.cfg.people[pid] = Object.assign({}, S.cfg.people[pid] || {}, card, { masked: false, imgq: card.rarity === "secret" ? "admin=1" : "" });
  const vs = possibleVariants(p);
  const fig = v => `<figure class="mock"><div class="mock-card" data-pv="${esc(v)}">${cardHTML(pid, v)}</div>
    <figcaption><b>${esc(variantName(v))}</b><span class="muted small">×${(S.cfg.variants[v]?.mult || 1).toLocaleString("pl-PL")} · ${fmt(cardValue(pid, v))}${
      v !== "normal" && !isCombo(v) && !variantOn(v) ? " · wyłączony" : ""}</span></figcaption></figure>`;
  const single = vs.filter(v => !isCombo(v)), combos = vs.filter(isCombo);
  box.innerHTML = `<div class="mock-head"><p class="muted small">${esc(p.name)} — ${single.length} ${plural(single.length, "wariant", "warianty", "wariantów")}${
      combos.length ? ` + ${combos.length} ${plural(combos.length, "połączenie", "połączenia", "połączeń")}` : ""}. Kliknij kartę, żeby ją powiększyć.
      Podgląd pokazuje zapisaną kartę.</p></div>
    <div class="mock-grid pv-grid">${single.map(fig).join("")}</div>
    ${combos.length ? `<details class="pv-combos"><summary>Połączenia wariantów (${combos.length})</summary><div class="mock-grid pv-grid">${combos.map(fig).join("")}</div></details>` : ""}`;
  box.onclick = e => {
    const c = e.target.closest("[data-pv]");
    if (c) { Sound.click(); openViewer(pid, c.dataset.pv); }
  };
}

// ================================================================ ZDARZENIA

function bind() {
  $$(".tab").forEach(t => t.addEventListener("click", e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;  // otwieranie w nowej karcie przeglądarki
    e.preventDefault(); Sound.click();
    if (t.dataset.view === "inventory") S.inv.mode = "cards";  // zakładka = moje karty (Hall of Fame ma własny przycisk)
    switchView(t.dataset.view);
  }));
  window.addEventListener("popstate", () => showRoute("none"));

  $("#cntMinus").addEventListener("click", () => { Sound.click(); setCount(S.count - 1); });
  $("#cntPlus").addEventListener("click", () => { Sound.click(); setCount(S.count + 1); });
  const car = $("#shopCarousel");
  let swipeX = null, swiped = false;
  car.addEventListener("click", e => {
    if (swiped) { swiped = false; return; }   // to był ruch w bok, nie kliknięcie w kafelek
    const arrow = e.target.closest("[data-car]");
    if (arrow) return shopRotate(+arrow.dataset.car);
    const c = e.target.closest(".shop-tile, .car-dot"); if (!c) return;
    if (S.crate !== c.dataset.crate) { S.crate = c.dataset.crate; Sound.click(); renderCrates(); }
    else if (c.matches(".shop-tile")) $("#buyPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  // przesunięcie palcem / myszą w bok = następna / poprzednia skrzynka
  car.addEventListener("pointerdown", e => { swipeX = e.clientX; swiped = false; });
  car.addEventListener("pointerup", e => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX; swipeX = null;
    if (Math.abs(dx) > 45) { swiped = true; shopRotate(dx < 0 ? 1 : -1); }
  });
  car.addEventListener("pointerleave", () => { swipeX = null; });
  $("#shopAllToggle").addEventListener("click", () => { S.shopAllOpen = !S.shopAllOpen; Sound.click(); renderCrates(); });
  $("#shopAllList").addEventListener("click", e => {
    const c = e.target.closest("[data-crate]"); if (!c) return;
    Sound.click();
    S.crate = c.dataset.crate; S.shopAllOpen = false;   // wybrana z listy - lista się zwija, karuzela jedzie do tej skrzynki
    renderCrates();
    $("#shopCarousel").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#countChips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    Sound.click(); setCount(+c.dataset.n);
  });
  $("#countRange").addEventListener("input", e => setCount(+e.target.value));
  $("#fastToggle").addEventListener("change", e => { S.fast = e.target.checked; Sound.click(); try { localStorage.setItem("fast", S.fast ? "1" : "0"); } catch (_) {} });
  $("#openBtn").addEventListener("click", openCrates);
  $("#buyBtn").addEventListener("click", buyChests);
  $("#chestShelf").addEventListener("click", e => {
    const c = e.target.closest("[data-open-crate]"), m = e.target.closest("[data-open-money]");
    if (c) { S.crate = c.dataset.openCrate; S.count = +c.dataset.n; openCrates(); }
    if (m) openMoneyChest(m.dataset.openMoney);
  });

  $("#skipBtn").addEventListener("click", skipSpin);
  $("#autoStopBtn").addEventListener("click", () => { Sound.click(); stopAuto("⏹ Auto zatrzymane"); });
  $("#closeBtn").addEventListener("click", closeStage);
  $("#againBtn").addEventListener("click", openAgain);
  $("#sellAllBtn").addEventListener("click", () => sellResult(S.opening.drops.filter(d => !d.sold && !d.fav).map(d => d.id)));
  $("#results").addEventListener("click", async e => {
    const f = e.target.closest("[data-fav]");
    if (f) {
      const id = +f.dataset.fav, d = S.opening.drops.find(d => d.id === id);
      try { await setFavorite([id], !d.fav); } catch (err) { Sound.error(); toast(err.message, true); return; }
      f.outerHTML = favBtnHTML(id, d.fav);
      $(`.result[data-id="${id}"] .rsell`).disabled = d.fav;
      updateStageBar();
      return;
    }
    const b = e.target.closest(".rsell"); if (b) sellResult([+b.dataset.id]);
  });

  // klaser
  $("#binderSeg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    S.binderCrate = b.dataset.crate; S.spread = 0; Sound.click(); renderBinder();
  });
  $("#pagePrev").addEventListener("click", () => flipBinder(-1));
  $("#pageNext").addEventListener("click", () => flipBinder(1));
  $("#binder").addEventListener("click", e => {
    const p = e.target.closest(".pocket.owned"); if (!p) return;
    Sound.click();
    if (p.classList.contains("gone")) openViewer(p.dataset.pid, p.dataset.variant);  // nie ma już egzemplarza - tylko podgląd
    else openModal(p.dataset.pid);
  });

  // modal
  $("#modal").addEventListener("click", async e => {
    if (e.target.id === "modal" || e.target.id === "modalClose") return closeModal();
    const b = e.target.closest("[data-sell]"); if (!b) return;
    const ids = b.dataset.sell.split(",").map(Number);
    const pid = $("#modal").dataset.pid;
    const r = person(pid).rarity;
    if (rarityIdx(r) >= rarityIdx("gold") && !confirm(`Na pewno sprzedać ${person(pid).name} (${S.cfg.rarities[r].name})?`)) return;
    try { await sellIds(ids); } catch (err) { Sound.error(); toast(err.message, true); return; }
    openModal(pid);
    rerenderCurrent();
  });

  // ekwipunek
  $("#invCrateSeg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    S.inv.crate = b.dataset.crate; S.inv.limit = INV_PAGE; renderInventory();
  });
  $("#invRarity").addEventListener("click", e => {
    const b = e.target.closest(".rf"); if (!b) return;
    const r = b.dataset.r;
    S.inv.rarities.has(r) ? S.inv.rarities.delete(r) : S.inv.rarities.add(r);
    S.inv.limit = INV_PAGE; renderInventory();
  });
  $("#invVariant").addEventListener("change", e => { S.inv.variant = e.target.value; S.inv.limit = INV_PAGE; renderInventory(); });
  // wyszukiwanie po nazwie (też po wariancie i rzadkości, bez polskich znaków - cardMatches)
  $("#invSearch").addEventListener("input", e => { S.inv.q = e.target.value; S.inv.limit = INV_PAGE; renderInventory(); });
  $("#invSort").addEventListener("change", e => { S.inv.sort = e.target.value; renderInventory(); });
  $("#invMore").addEventListener("click", () => { S.inv.limit += INV_PAGE; renderInventory(); });
  $("#invGrid").addEventListener("click", async e => {
    const ufo = e.target.closest(".ufo-item");
    if (ufo) return ufoAbduct(ufo);
    const it = e.target.closest(".inv-item"); if (!it) return;
    if (e.target.closest(".zoom-btn")) return;
    if (e.target.closest("[data-fav]")) {
      const item = S.items.find(i => i.id === +it.dataset.id);
      try { await setFavorite([item.id], !item.fav); } catch (err) { Sound.error(); toast(err.message, true); return; }
      it.classList.toggle("fav", item.fav);
      it.querySelector("[data-fav]").outerHTML = favBtnHTML(item.id, item.fav);
      updateSellbar();
      return;
    }
    const id = +it.dataset.id;
    S.inv.selected.has(id) ? S.inv.selected.delete(id) : S.inv.selected.add(id);
    it.classList.toggle("sel");
    Sound.click(); updateSellbar();
  });
  $("#selAll").addEventListener("click", () => { filteredItems().forEach(i => S.inv.selected.add(i.id)); renderInventory(); });
  $("#selNone").addEventListener("click", () => { S.inv.selected.clear(); renderInventory(); });
  $("#sellSel").addEventListener("click", sellSelected);
  $("#sellDupes").addEventListener("click", sellAllDupes);

  $("#invGrid").addEventListener("contextmenu", e => {
    if (e.target.closest(".ufo-item")) return e.preventDefault();
    const c = e.target.closest(".inv-item .card"); if (!c) return;
    e.preventDefault(); openViewer(c.dataset.pid, c.dataset.variant);
  });

  // powiększanie kart
  document.addEventListener("click", e => {
    const z = e.target.closest(".zoom-btn");
    const c = z ? z.parentElement.querySelector(".card")
                : e.target.closest("#contentsGrid .card, #results .card, #modalBox .card, .fa-result .card");
    if (c) { e.stopPropagation(); openViewer(c.dataset.pid, c.dataset.variant); }
  }, true);

  bindForge();
  bindMarket();
  bindCasino();
  bindUpgrader();
  bindSocial();
  bindArena();
  bindHallOfFame();

  // nagłówek
  $("#soundBtn").addEventListener("click", () => { Sound.toggle(); renderHeader(); });

  // klawiatura: Spacja/Enter = otwórz / pomiń, Esc = zamknij
  document.addEventListener("keydown", e => {
    if (e.target.matches("input[type=text], input[type=number], select, textarea")) return;
    if (epicOpen() || document.querySelector(".money-stage, .forge-anim")) return;
    if (dialogOpen()) { if (e.key === "Escape") closeDialogs(); return; }
    if (viewerOpen()) { if (e.key === "Escape" || e.key === " ") { e.preventDefault(); closeViewer(); } return; }
    if (e.key === "Escape") {
      if (!$("#modal").hidden) return closeModal();
      if (S.opening?.spinning) return skipSpin();
      if (S.opening?.showingResults) return closeStage();
    }
    if (e.key === " " || e.key === "Enter") {
      if (!$("#modal").hidden) return;
      if (S.opening?.spinning) { e.preventDefault(); return skipSpin(); }
      if (S.opening?.showingResults) { e.preventDefault(); openAgain(); return; }
      if (!S.opening && currentView() === "crates" && !e.target.closest("button, input")) { e.preventDefault(); openCrates(); }
    }
    if (currentView() === "binder" && $("#modal").hidden && !S.opening) {
      if (e.key === "ArrowLeft") flipBinder(-1);
      if (e.key === "ArrowRight") flipBinder(1);
    }
    if (currentView() === "crates" && $("#modal").hidden && !S.opening && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault(); shopRotate(e.key === "ArrowLeft" ? -1 : 1);
    }
  });
  document.addEventListener("pointerdown", () => Sound.unlock(), { once: true });
}

// ================================================================ START

(async function init() {
  // serwer mógł się właśnie restartować - kilka prób zanim się poddamy
  let me, cfg, st;
  for (let attempt = 0; ; attempt++) {
    try { [me, cfg, st] = await Promise.all([api("/api/me"), api("/api/config"), api("/api/state")]); break; }
    catch (e) {
      if (attempt >= 5) { toast("Nie można połączyć się z serwerem — odśwież stronę", true); throw e; }
      await sleep(1000);
    }
  }
  S.me = me.user;
  S.cfg = cfg;
  S.state = st.state;
  S.items = st.items;
  S.showcase = st.showcase || [];
  S.chests = st.chests || {};
  S.collected = new Set((st.collected || []).map(([p, v]) => `${p}|${v}`));
  S.crate = S.binderCrate = cfg.crateOrder[0];
  try { S.fast = localStorage.getItem("fast") === "1"; } catch (_) {}
  // ?embed=1 - strona osadzona w panelu admina (podgląd karty): bez paska, okienek na start i odpytywania serwera
  const embed = new URLSearchParams(location.search).has("embed");
  if (embed) document.body.classList.add("embed");
  // podgrzej cache miniatur, żeby bębny od razu miały obrazki
  else {
    Object.keys(cfg.people).forEach(id => { const im = new Image(); im.src = imgUrl(id, null, true); });
    if (cfg.easterEgg) new Image().src = cfg.easterEgg.url;
  }
  bind();
  watchCovers();
  renderHeader();
  noteUfo(me);
  showRoute("replace");  // widok z adresu strony (/inventory, /player/nazwa...)
  setupInstall();
  updateSellbar();
  applyBadges(me);
  S.jpLobby = me.jackpotLobby;
  if (embed) return;
  startPolling();
  const startDialogs = () => {
    if (me.patchNotes?.length) setTimeout(() => showPatchNotes(me.patchNotes), 500);  // nowa aktualizacja: co się zmieniło
    else if (me.jackpot) setTimeout(() => showJackpotResult(me.jackpot), 600);  // gra w jackpot skończyła się, gdy mnie nie było
    else if (me.dailyClaimable) setTimeout(openDaily, 600);
  };
  // najpierw wiadomości od adminów (zaplanowane w panelu), potem reszta
  if (me.messages?.length) setTimeout(() => { if (!showAdminMessages(me.messages, startDialogs)) startDialogs(); }, 500);
  else startDialogs();
})();
