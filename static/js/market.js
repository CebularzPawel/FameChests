"use strict";
// Rynek kart: oferty za stałą cenę (kupujący może zaproponować niższą), licytacje, zlecenia "Szukam" i moje transakcje.
// Karty wystawione na rynek i pieniądze z ofert / licytacji / zleceń są zablokowane do końca transakcji (pilnuje serwer).

const MK = {
  tab: "buy",         // buy / wanted / sell / mine
  data: null,
  f: { q: "", rarity: "all", variant: "all", kind: "all", sort: "new", crate: "all" },
  sell: { item: null, kind: "fixed", price: "", step: "", hours: 24, q: "", sort: "value" },
  want: { q: "", person: null, variant: "normal", price: "", onlyMine: false, sortFound: "rarity", sortOrders: "new" },
  timer: null,
};
const MK_PICK_LIMIT = 240;

// ================================================================ POMOCNICZE

function mkTimeLeft(end) {
  const s = Math.max(0, Math.round(end - Date.now() / 1000));
  if (s <= 0) return "kończy się…";
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} godz.`;
  if (h) return `${h} godz. ${m} min`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

// karta z oferty - tajną kartę sprzedającego widać, nawet jeśli samemu się jej jeszcze nie odkryło
function mkCard(x, imgq, fn) {
  return withRevealMap(x.reveal ? { [x.person]: x.reveal } : {}, imgq, fn);
}

function mkPrice(n) { return `<b class="mk-money">${fmt(n)}</b>`; }

function mkMatchesFilter(x) {
  const f = MK.f, p = person(x.person);
  if (f.q && !(p.masked ? searchMatch(searchNorm(`??? ${variantName(x.variant)} ${S.cfg.rarities[p.rarity].name}`), f.q) : cardMatches(x, f.q))) return false;
  if (f.rarity !== "all" && p.rarity !== f.rarity) return false;
  if (f.variant === "special" ? !isSpecial(x.variant) : f.variant !== "all" && x.variant !== f.variant) return false;
  if (f.crate !== "all" && !(p.crates || [p.crate]).includes(f.crate)) return false;
  return true;
}

// moje karty, którymi mogę zapłacić za zlecenie "Szukam" (bez ulubionych)
function mkMyItemFor(pid, variant) { return S.items.find(i => i.person === pid && i.variant === variant && !i.fav); }

function mkAfter(res) {
  if (res?.state) applyState(res.state);
}

async function mkAction(fn, okMsg) {
  try {
    const res = await fn();
    mkAfter(res);
    if (okMsg) toast(okMsg);
    Sound.coin(1);
    return res;
  } catch (e) { Sound.error(); toast(e.message, true); return null; }
  finally { renderMarket(); }
}

// okienko z kwotą (propozycja ceny, licytacja)
function mkAskAmount(title, html, min, value, okLabel) {
  return new Promise(resolve => {
    const dlg = openDialog(`<h3>${title}</h3>${html}
      <form class="mk-ask"><input type="number" name="amount" min="${min}" value="${value}" required>
        <div class="daily-actions"><button class="btn primary" type="submit">${okLabel}</button><button class="btn" type="button" data-close>Anuluj</button></div>
      </form>`, "mk-dialog");
    const inp = dlg.querySelector("input");
    inp.focus(); inp.select();
    dlg.querySelector("form").addEventListener("submit", e => { e.preventDefault(); const v = +inp.value; closeDialogs(); resolve(v); });
    const watch = setInterval(() => { if (!document.body.contains(dlg)) { clearInterval(watch); resolve(null); } }, 300);
  });
}

// ================================================================ RYSOWANIE

async function renderMarket(quiet = false) {
  if (quiet && document.querySelector("#view-market input:focus, #view-market select:focus")) return;
  try { MK.data = await api("/api/market"); }
  catch (e) { if (!quiet) toast(e.message, true); return; }
  if (currentView() !== "market") return;
  $("#marketBadge").hidden = true;
  drawMarket();
  clearInterval(MK.timer);
  MK.timer = setInterval(() => {   // odliczanie licytacji
    if (currentView() !== "market") return clearInterval(MK.timer);
    $$("#marketBody [data-end]").forEach(el => { el.textContent = mkTimeLeft(+el.dataset.end); });
  }, 1000);
}

function drawMarket() {
  const d = MK.data;
  if (!d) return;
  const pendingToMe = d.listings.filter(l => l.mine).reduce((a, l) => a + l.offers.length, 0);
  $("#marketSeg").innerHTML = [["buy", "🛒 Kupuj", d.listings.filter(l => !l.mine).length], ["wanted", "📢 Szukam", d.wanted.length],
    ["sell", "🏷️ Sprzedaj", null], ["mine", "📋 Moje", pendingToMe || null]].map(([t, n, c]) =>
    `<button data-mtab="${t}" class="${MK.tab === t ? "active" : ""}">${n}${c ? ` <small${t === "mine" ? ' class="mk-alert"' : ""}>${c}</small>` : ""}</button>`).join("");
  const body = $("#marketBody");
  body.innerHTML = { buy: mkBuyHTML, wanted: mkWantedHTML, sell: mkSellHTML, mine: mkMineHTML }[MK.tab]();
}

// ---------------------------------------------------------------- kafelek oferty
function mkListingHTML(l, { showSeller = true } = {}) {
  const auction = l.kind === "auction";
  const top = auction ? (l.topBid ? `Najwyższa oferta: ${mkPrice(l.topBid)} <span class="muted">(${esc(l.topBidder || "?")})</span>`
    : `Cena wywoławcza: ${mkPrice(l.price)}`) : `${mkPrice(l.price)}`;
  let actions = "";
  if (l.mine) {
    actions = `<span class="mk-tag mine">Twoja oferta</span>${!auction || !l.topBid ? `<button class="btn tiny" data-lcancel="${l.id}">↩️ Wycofaj</button>` : ""}`;
  } else if (auction) {
    actions = l.myTop ? `<span class="mk-tag lead">🏆 Prowadzisz</span>`
      : `<button class="btn primary" data-bid="${l.id}">🔨 Licytuj</button>`;
  } else {
    actions = `<button class="btn sell" data-buy="${l.id}">🛒 Kup</button>` + (l.myOffer
      ? `<span class="mk-tag">Twoja propozycja: ${fmt(l.myOffer.price)}</span><button class="btn tiny" data-ocancel="${l.myOffer.id}">Wycofaj</button>`
      : `<button class="btn" data-offer="${l.id}">💬 Zaproponuj cenę</button>`);
  }
  const diff = l.value ? Math.round(((auction ? l.topBid || l.price : l.price) / l.value - 1) * 100) : 0;
  return `<div class="mk-item${auction ? " auction" : ""}${l.mine ? " mine" : ""}" data-lid="${l.id}">
    <div class="mk-card">${mkCard(l, `market=${l.id}`, () => cardHTML(l.person, l.variant))}</div>
    <div class="mk-info">
      <div class="mk-kind">${auction ? `🔨 Licytacja · <span class="mk-time" data-end="${l.endsAt}">${mkTimeLeft(l.endsAt)}</span>` : "🏷️ Kup teraz"}</div>
      <div class="mk-price">${top}</div>
      <div class="mk-meta">wartość karty ${fmt(l.value)} <span class="${diff > 0 ? "neg-txt" : "pos-txt"}">${diff > 0 ? "+" : ""}${diff}%</span>
        ${auction ? ` · ${l.bids} ${plural(l.bids, "oferta", "oferty", "ofert")} · przebicie min. ${fmt(l.step)}` : ""}</div>
      ${showSeller && l.seller ? `<div class="mk-seller">${userLink(l.seller)}<span class="fi-time">${timeAgo(l.created)}</span></div>` : ""}
      <div class="mk-actions">${actions}</div>
    </div>
  </div>`;
}

function mkFiltersHTML({ listings = true } = {}) {
  const f = MK.f;
  return `<div class="mk-filters">
    <input type="text" data-mf="q" placeholder="Szukaj karty…" value="${esc(f.q)}">
    ${listings ? `<select data-mf="kind">${[["all", "Wszystkie oferty"], ["fixed", "🏷️ Kup teraz"], ["auction", "🔨 Licytacje"]].map(([v, n]) =>
      `<option value="${v}"${f.kind === v ? " selected" : ""}>${n}</option>`).join("")}</select>` : ""}
    <select data-mf="rarity"><option value="all">Każda rzadkość</option>${S.cfg.rarityOrder.map(r =>
      `<option value="${r}"${f.rarity === r ? " selected" : ""}>${S.cfg.rarities[r].name}</option>`).join("")}</select>
    <select data-mf="variant">${[["all", "Każdy wariant"], ["special", "✨ Tylko specjalne"], ...S.cfg.variantOrder.map(v => [v, variantName(v)])].map(([v, n]) =>
      `<option value="${v}"${f.variant === v ? " selected" : ""}>${n}</option>`).join("")}</select>
    <select data-mf="crate"><option value="all">Każda skrzynka</option>${crateList().map(c =>
      `<option value="${c.id}"${f.crate === c.id ? " selected" : ""}>${esc(c.emoji)} ${esc(c.short)}</option>`).join("")}</select>
    ${listings ? `<select data-mf="sort">${[["new", "Najnowsze"], ["cheap", "Najtańsze"], ["expensive", "Najdroższe"], ["ending", "Kończące się"], ["deal", "Najlepsza okazja"]].map(([v, n]) =>
      `<option value="${v}"${f.sort === v ? " selected" : ""}>${n}</option>`).join("")}</select>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- KUPUJ
function mkBuyHTML() {
  const f = MK.f;
  const cur = l => l.kind === "auction" ? l.topBid || l.price : l.price;
  const by = {
    new: (a, b) => b.id - a.id,
    cheap: (a, b) => cur(a) - cur(b),
    expensive: (a, b) => cur(b) - cur(a),
    ending: (a, b) => (a.endsAt || 9e12) - (b.endsAt || 9e12),
    deal: (a, b) => cur(a) / a.value - cur(b) / b.value,
  }[f.sort];
  const list = MK.data.listings.filter(l => !l.mine && (f.kind === "all" || l.kind === f.kind) && mkMatchesFilter(l)).sort(by);
  return `${mkFiltersHTML()}
    <p class="muted small mk-help">🏷️ <b>Kup teraz</b> — kupujesz od razu albo proponujesz niższą cenę (pieniądze są zablokowane, aż sprzedający zdecyduje).
      🔨 <b>Licytacja</b> — wygrywa najwyższa oferta, gdy skończy się czas; przebity gracz od razu dostaje pieniądze z powrotem.</p>
    <div class="mk-grid">${list.map(l => mkListingHTML(l)).join("") ||
      `<div class="empty">${MK.data.listings.some(l => !l.mine) ? "Brak ofert pasujących do filtrów." : "Na rynku nie ma jeszcze żadnych ofert. Wystaw swoją kartę w zakładce 🏷️ Sprzedaj!"}</div>`}</div>`;
}

// ---------------------------------------------------------------- SZUKAM (zlecenia kupna)
const MK_ORDER_SORTS = [["new", "🕒 Najnowsze"], ["priceDesc", "💰 Najwyższa cena"], ["priceAsc", "💰 Najniższa cena"],
                        ["rarity", "💎 Rzadkość"], ["name", "🔤 Nazwa"]];
function mkSortOrders(list) {
  const mode = MK.want.sortOrders;
  if (mode === "new") return list.slice().sort((a, b) => b.id - a.id);
  if (mode === "priceDesc") return list.slice().sort((a, b) => b.price - a.price || b.id - a.id);
  if (mode === "priceAsc") return list.slice().sort((a, b) => a.price - b.price || b.id - a.id);
  return sortCards(list, mode);
}
function mkWantedHTML() {
  const w = MK.want;
  const sel = w.person && person(w.person);
  const found = w.q.trim() ? sortCards(Object.values(S.cfg.people).filter(p => !p.masked && searchMatch(searchNorm(p.name), w.q))
    .map(p => ({ id: p.id, person: p.id, variant: "normal", value: cardValue(p.id) })), w.sortFound).slice(0, 30) : [];
  const orders = mkSortOrders(MK.data.wanted.filter(o => mkMatchesFilter(o) && (!w.onlyMine || (!o.mine && mkMyItemFor(o.person, o.variant)))));
  const value = sel ? cardValue(sel.id, w.variant) : 0;
  const listed = sel ? MK.data.listings.filter(l => l.person === sel.id && l.variant === w.variant && !l.mine) : [];
  return `<div class="mk-cols">
    <div class="panel mk-new-want">
      <h3>📢 Szukam karty</h3>
      <p class="muted small">Ustal cenę, za którą kupisz kartę. Pieniądze są blokowane, a każdy, kto ma tę kartę, może ci ją od razu sprzedać.</p>
      <div class="mk-row"><input type="text" data-want="q" placeholder="Wpisz nazwę karty…" value="${esc(w.q)}">
        ${sortSelectHTML(w.sortFound, 'data-msort="found"', UNIQUE_SORTS.filter(([k]) => k !== "variant"))}</div>
      ${found.length ? `<div class="pick-grid mk-pick">${found.map(c => pickHTML(c, { sel: c.person === w.person })).join("")}</div>` : ""}
      ${sel ? `<div class="mk-want-form">
        <div class="mk-want-card">${cardHTML(sel.id, w.variant)}</div>
        <div class="mk-form">
          <label>Wariant<select data-want="variant">${possibleVariants(sel).map(v =>
            `<option value="${v}"${w.variant === v ? " selected" : ""}>${variantName(v)} (${fmt(cardValue(sel.id, v))})</option>`).join("")}</select></label>
          <label>Zapłacę<input type="number" data-want="price" min="1" value="${esc(w.price || value)}"></label>
          <div class="muted small">Wartość karty: ${fmt(value)}${listed.length ? ` · na rynku od ${fmt(Math.min(...listed.map(l => l.kind === "auction" ? l.topBid || l.price : l.price)))}` : ""}</div>
          <button class="btn primary" data-want-go>📢 Dodaj zlecenie</button>
        </div>
      </div>` : ""}
    </div>
    <div class="mk-want-list">
      ${mkFiltersHTML({ listings: false })}
      <div class="mk-row"><label class="chk"><input type="checkbox" data-want-only ${w.onlyMine ? "checked" : ""}> tylko te, które mogę od razu sprzedać</label>
        ${sortSelectHTML(w.sortOrders, 'data-msort="orders"', MK_ORDER_SORTS)}</div>
      <div class="mk-wanted">${orders.map(o => {
        const mine = mkMyItemFor(o.person, o.variant);
        return `<div class="mk-want${o.mine ? " mine" : ""}${mine && !o.mine ? " can" : ""}">
          ${mkCard(o, "", () => pickHTML({ id: o.id, person: o.person, variant: o.variant, value: o.value }))}
          <div class="mk-want-info">
            <div><b>${esc(person(o.person).masked ? "Tajna karta" : person(o.person).name)}</b>${isSpecial(o.variant) ? ` <span class="holo-txt">${variantName(o.variant)}</span>` : ""}</div>
            <div>Płaci ${mkPrice(o.price)} <span class="muted small">(wartość ${fmt(o.value)})</span></div>
            <div class="mk-seller">${o.buyer ? userLink(o.buyer) : ""}<span class="fi-time">${timeAgo(o.created)}</span></div>
            <div class="mk-actions">${o.mine ? `<button class="btn tiny" data-wcancel="${o.id}">↩️ Wycofaj</button>`
              : mine ? `<button class="btn sell" data-wfill="${o.id}">💰 Sprzedaj za ${fmt(o.price)}</button>`
              : '<span class="muted small">nie masz tej karty</span>'}</div>
          </div>
        </div>`;
      }).join("") || '<div class="empty">Nikt teraz niczego nie szuka.</div>'}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- SPRZEDAJ
function mkSellHTML() {
  const s = MK.sell;
  const items = S.items.filter(i => !i.fav);
  const it = items.find(i => i.id === s.item);
  if (!it) s.item = null;
  const list = sortCards(items.filter(i => cardMatches(i, s.q)), s.sort);
  let form = '<div class="empty">Wybierz kartę z listy, aby ją wystawić.</div>';
  if (it) {
    const wanted = MK.data.wanted.filter(o => !o.mine && o.person === it.person && o.variant === it.variant).sort((a, b) => b.price - a.price);
    const same = MK.data.listings.filter(l => l.person === it.person && l.variant === it.variant);
    const price = s.price || it.value;
    form = `<div class="mk-sell-form">
      <div class="mk-want-card">${cardHTML(it.person, it.variant)}</div>
      <div class="mk-form">
        <div class="muted small">Wartość karty: <b>${fmt(it.value)}</b>${same.length ? ` · na rynku ${same.length} ${plural(same.length, "taka karta", "takie karty", "takich kart")}, od ${fmt(Math.min(...same.map(l => l.kind === "auction" ? l.topBid || l.price : l.price)))}` : ""}</div>
        ${wanted.length ? `<div class="mk-hint">📢 ${userLink(wanted[0].buyer || { username: "?" })} szuka tej karty i płaci <b>${fmt(wanted[0].price)}</b>
          <button class="btn sell tiny" data-wfill="${wanted[0].id}">💰 Sprzedaj od razu</button></div>` : ""}
        <div class="seg mk-kind-seg"><button data-skind="fixed" class="${s.kind === "fixed" ? "active" : ""}">🏷️ Stała cena</button><button data-skind="auction" class="${s.kind === "auction" ? "active" : ""}">🔨 Licytacja</button></div>
        <label>${s.kind === "auction" ? "Cena wywoławcza (minimalna)" : "Cena"}<input type="number" data-sf="price" min="1" value="${esc(price)}"></label>
        ${s.kind === "auction" ? `
          <label>Minimalne przebicie<input type="number" data-sf="step" min="1" value="${esc(s.step || Math.max(1, Math.round(it.value * 0.05)))}"></label>
          <label>Czas licytacji<select data-sf="hours">${S.cfg.market.auctionHours.map(h =>
            `<option value="${h}"${+s.hours === h ? " selected" : ""}>${h} godz.</option>`).join("")}</select></label>
          <div class="muted small">Licytacji, w której ktoś już licytuje, nie da się wycofać. Oferta w ostatnich ${Math.round(S.cfg.market.snipeSeconds / 60)} min. przedłuża licytację.</div>`
          : '<div class="muted small">Kupujący mogą też zaproponować niższą cenę — zdecydujesz w zakładce 📋 Moje.</div>'}
        ${S.cfg.market.fee ? `<div class="muted small">Prowizja rynku: ${Math.round(S.cfg.market.fee * 100)}%</div>` : ""}
        <button class="big-btn mk-go" data-sell-go>${s.kind === "auction" ? "🔨 Rozpocznij licytację" : "🏷️ Wystaw na rynek"}</button>
      </div>
    </div>`;
  }
  return `<div class="mk-cols">
    <div class="panel mk-sell-pick">
      <h3>Twoje karty <small class="muted">(bez ulubionych ⭐)</small></h3>
      <div class="mk-row"><input type="text" data-sf="q" placeholder="Szukaj…" value="${esc(s.q)}">${sortSelectHTML(s.sort, 'data-msort="sell"')}</div>
      <div class="pick-grid">${list.slice(0, MK_PICK_LIMIT).map(i => pickHTML(i, { sel: i.id === s.item })).join("") || '<div class="empty">Nie masz kart do sprzedania.</div>'}</div>
    </div>
    <div class="panel mk-sell-side">${form}</div>
  </div>`;
}

// ---------------------------------------------------------------- MOJE
const MK_STATUS = {
  sold: "✅ sprzedana", expired: "⌛ bez ofert — wróciła", cancelled: "↩️ wycofana", filled: "✅ zlecenie zrealizowane",
  pending: "⏳ czeka na decyzję", accepted: "✅ przyjęta", declined: "❌ odrzucona", lost: "🔁 przepadła — karta poszła do kogoś innego",
};

function mkMineHTML() {
  const d = MK.data;
  const mine = d.listings.filter(l => l.mine);
  const leading = d.listings.filter(l => l.myTop);
  const wants = d.wanted.filter(o => o.mine);
  const offers = d.myOffers;
  const offersHTML = l => l.offers.length ? `<div class="mk-offers"><b>💬 Propozycje cen:</b>${l.offers.map(o => `<div class="mk-offer">
      ${o.buyer ? userLink(o.buyer) : "?"} proponuje ${mkPrice(o.price)} <span class="muted small">(${Math.round(o.price / l.price * 100)}% ceny)</span>
      <button class="btn sell tiny" data-oaccept="${o.id}">✅ Sprzedaj</button><button class="btn tiny" data-odecline="${o.id}">❌ Odrzuć</button></div>`).join("")}</div>` : "";
  const hist = d.history.map(h => `<div class="mk-hist">
      ${mkCard(h, h.type === "wanted" ? "" : `market=${h.id}`, () => pickHTML({ id: 0, person: h.person, variant: h.variant, value: h.value }))}
      <div><b>${h.role === "seller" ? (h.status === "sold" || h.status === "filled" ? "Sprzedano" : "Twoja oferta") : "Kupiono"}</b>
        ${h.status === "sold" || h.status === "filled" ? ` za ${mkPrice(h.price)}` : ""}
        ${h.other ? ` · ${h.role === "seller" ? "kupił(a)" : "od"} ${userLink(h.other)}` : ""}
        <div class="muted small">${h.type === "auction" ? "🔨 licytacja" : h.type === "wanted" ? "📢 zlecenie Szukam" : "🏷️ stała cena"} · ${MK_STATUS[h.status] || h.status} · ${timeAgo(h.at)}</div></div>
    </div>`).join("");
  return `<div class="mk-mine">
    <div class="panel"><h3>🏷️ Twoje oferty na rynku (${mine.length}/${S.cfg.market.maxListings})</h3>
      ${mine.length ? `<div class="mk-grid">${mine.map(l => `<div class="mk-mine-item">${mkListingHTML(l, { showSeller: false })}${offersHTML(l)}</div>`).join("")}</div>`
        : '<p class="muted">Nic nie wystawiasz. Karty wystawisz w zakładce 🏷️ Sprzedaj.</p>'}</div>
    ${leading.length ? `<div class="panel"><h3>🔨 Licytacje, które prowadzisz</h3><div class="mk-grid">${leading.map(l => mkListingHTML(l)).join("")}</div></div>` : ""}
    <div class="panel"><h3>💬 Twoje propozycje cen</h3>
      ${offers.length ? offers.map(o => `<div class="mk-hist">
        ${mkCard(o, `market=${o.listing}`, () => pickHTML({ id: 0, person: o.person, variant: o.variant, value: o.value }))}
        <div>Proponujesz ${mkPrice(o.price)} <span class="muted small">(cena ${fmt(o.listPrice)})</span>${o.seller ? ` · ${userLink(o.seller)}` : ""}
          <div class="muted small">${MK_STATUS[o.status] || o.status} · ${timeAgo(o.at)}</div></div>
        ${o.status === "pending" ? `<button class="btn tiny" data-ocancel="${o.id}">↩️ Wycofaj</button>` : ""}
      </div>`).join("") : '<p class="muted">Brak propozycji.</p>'}</div>
    <div class="panel"><h3>📢 Twoje zlecenia „Szukam” (${wants.length}/${S.cfg.market.maxWanted})</h3>
      ${wants.length ? wants.map(o => `<div class="mk-hist">
        ${pickHTML({ id: 0, person: o.person, variant: o.variant, value: o.value })}
        <div>Płacisz ${mkPrice(o.price)} <div class="muted small">${timeAgo(o.created)}</div></div>
        <button class="btn tiny" data-wcancel="${o.id}">↩️ Wycofaj</button></div>`).join("") : '<p class="muted">Brak zleceń.</p>'}</div>
    <div class="panel"><h3>📜 Historia</h3>${hist || '<p class="muted">Jeszcze nic nie kupiłeś ani nie sprzedałeś.</p>'}</div>
  </div>`;
}

// ================================================================ AKCJE

function mkFind(id) { return MK.data.listings.find(l => l.id === id); }

async function mkBuy(id) {
  const l = mkFind(id);
  if (!l) return;
  if (S.state.balance < l.price) { Sound.error(); return toast("Za mało pieniędzy!", true); }
  if (!confirm(`Kupić ${person(l.person).masked ? "tajną kartę" : person(l.person).name}${isSpecial(l.variant) ? ` (${variantName(l.variant)})` : ""} za ${fmt(l.price)}?`)) return;
  const res = await mkAction(() => api(`/api/market/${id}/buy`, {}));
  if (!res) return;
  S.items = [res.item, ...S.items].sort((a, b) => b.id - a.id);
  noteCollected([res.item]);
  if (person(res.item.person).masked) await refreshConfig();
  Sound.win();
  toast(`🛒 Kupiono: ${person(res.item.person).name} — karta jest w ekwipunku`);
  renderHeader();
}

async function mkOffer(id) {
  const l = mkFind(id);
  if (!l) return;
  const v = await mkAskAmount("💬 Zaproponuj cenę", `<p class="muted">Cena: <b>${fmt(l.price)}</b> · wartość karty ${fmt(l.value)}.
    Zaproponowana kwota zostanie zablokowana na twoim koncie, dopóki sprzedający jej nie przyjmie albo nie odrzuci (możesz ją też wycofać).</p>`,
    1, Math.max(1, Math.round(l.price * 0.85)), "💬 Wyślij propozycję");
  if (v) await mkAction(() => api(`/api/market/${id}/offer`, { price: v }), "💬 Propozycja wysłana — pieniądze są zablokowane");
}

async function mkBid(id) {
  const l = mkFind(id);
  if (!l) return;
  const min = l.topBid ? l.topBid + Math.max(1, l.step) : l.price;
  const v = await mkAskAmount("🔨 Licytuj", `<p class="muted">${l.topBid ? `Najwyższa oferta: <b>${fmt(l.topBid)}</b>` : `Cena wywoławcza: <b>${fmt(l.price)}</b>`}
    · najmniej możesz dać <b>${fmt(min)}</b>. Kwota zostanie zablokowana — jeśli ktoś cię przebije, od razu wróci na twoje konto.</p>`,
    min, min, "🔨 Licytuj");
  if (v) await mkAction(() => api(`/api/market/${id}/bid`, { amount: v }), "🔨 Prowadzisz w licytacji!");
}

async function mkSellGo() {
  const s = MK.sell;
  const it = S.items.find(i => i.id === s.item);
  if (!it) return;
  const price = +($("[data-sf=price]")?.value || 0), step = +($("[data-sf=step]")?.value || 0), hours = +($("[data-sf=hours]")?.value || 24);
  if (price < it.value * 0.5 && !confirm(`Cena ${fmt(price)} to mniej niż połowa wartości karty (${fmt(it.value)}). Na pewno?`)) return;
  try {
    const res = await api("/api/market/list", { item: it.id, kind: s.kind, price, step, hours });
    removeItems(res.consumed);
    Sound.coin(1);
    toast(s.kind === "auction" ? "🔨 Licytacja rozpoczęta!" : "🏷️ Karta jest na rynku");
    MK.sell = { ...MK.sell, item: null, price: "", step: "" };
    renderHeader();
  } catch (e) { Sound.error(); toast(e.message, true); }
  renderMarket();
}

async function mkCancelListing(id) {
  if (!confirm("Wycofać ofertę? Karta wróci do ekwipunku.")) return;
  const res = await mkAction(() => api(`/api/market/${id}/cancel`, {}), "↩️ Oferta wycofana — karta wróciła do ekwipunku");
  if (res?.item) { S.items = [res.item, ...S.items].sort((a, b) => b.id - a.id); renderHeader(); }
}

async function mkFill(id) {
  const o = MK.data.wanted.find(x => x.id === id);
  const it = o && mkMyItemFor(o.person, o.variant);
  if (!it) return toast("Nie masz tej karty (ulubionych ⭐ nie sprzedajemy)", true);
  if (!confirm(`Sprzedać ${person(o.person).name}${isSpecial(o.variant) ? ` (${variantName(o.variant)})` : ""} graczowi ${o.buyer?.username || "?"} za ${fmt(o.price)}?`)) return;
  const res = await mkAction(() => api(`/api/market/wanted/${id}/fill`, { item: it.id }), `💰 Sprzedano za ${fmt(o.price)}`);
  if (res) { removeItems(res.consumed); renderHeader(); }
}

async function mkWantGo() {
  const w = MK.want;
  const price = +($("[data-want=price]")?.value || 0);
  if (!w.person || !price) return;
  if (price > S.state.balance) { Sound.error(); return toast("Za mało pieniędzy!", true); }
  const res = await mkAction(() => api("/api/market/wanted", { person: w.person, variant: w.variant, price }),
    "📢 Zlecenie dodane — pieniądze są zablokowane, dopóki ktoś nie sprzeda ci karty");
  if (res) MK.want = { ...MK.want, person: null, price: "", q: "" };
}

// ================================================================ ZDARZENIA

function bindMarket() {
  $("#marketSeg").addEventListener("click", e => {
    const b = e.target.closest("[data-mtab]"); if (!b) return;
    MK.tab = b.dataset.mtab; Sound.click(); drawMarket();
  });
  const body = $("#marketBody");
  body.addEventListener("click", e => {
    const t = e.target;
    const get = attr => { const el = t.closest(`[${attr}]`); return el ? +el.getAttribute(attr) : null; };
    if (t.closest(".ulink")) return;   // profil gracza (obsługuje social.js)
    let id;
    if ((id = get("data-buy")) != null) return mkBuy(id);
    if ((id = get("data-offer")) != null) return mkOffer(id);
    if ((id = get("data-bid")) != null) return mkBid(id);
    if ((id = get("data-lcancel")) != null) return mkCancelListing(id);
    if ((id = get("data-ocancel")) != null) return mkAction(() => api(`/api/market/offers/${id}/cancel`, {}), "↩️ Propozycja wycofana — pieniądze wróciły");
    if ((id = get("data-odecline")) != null) return mkAction(() => api(`/api/market/offers/${id}/decline`, {}), "❌ Propozycja odrzucona");
    if ((id = get("data-oaccept")) != null) {
      if (!confirm("Sprzedać kartę za zaproponowaną cenę?")) return;
      return mkAction(() => api(`/api/market/offers/${id}/accept`, {}), "✅ Sprzedane!");
    }
    if ((id = get("data-wfill")) != null) return mkFill(id);
    if ((id = get("data-wcancel")) != null) return mkAction(() => api(`/api/market/wanted/${id}/cancel`, {}), "↩️ Zlecenie wycofane — pieniądze wróciły");
    if (t.closest("[data-want-go]")) return mkWantGo();
    if (t.closest("[data-sell-go]")) return mkSellGo();
    const kind = t.closest("[data-skind]");
    if (kind) { MK.sell.kind = kind.dataset.skind; Sound.click(); return drawMarket(); }
    const pick = t.closest(".pick");
    if (pick && MK.tab === "sell" && pick.closest(".mk-sell-pick")) {
      MK.sell = { ...MK.sell, item: +pick.dataset.id, price: "", step: "" }; Sound.click(); return drawMarket();
    }
    if (pick && MK.tab === "wanted" && pick.closest(".mk-pick")) {
      MK.want = { ...MK.want, person: pick.dataset.id, variant: "normal", price: "" }; Sound.click(); return drawMarket();
    }
    const card = t.closest(".mk-card .card, .mk-want-card .card");
    if (card) openViewer(card.dataset.pid, card.dataset.variant, card.dataset.uid);
  });
  // pola tekstowe: przerysowanie bez utraty kursora
  const keepFocus = (sel, fn) => {
    const el = document.activeElement, pos = el?.selectionStart;
    fn();
    const again = $(sel);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
  };
  body.addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.mf === "q") return keepFocus("[data-mf=q]", () => { MK.f.q = t.value; drawMarket(); });
    if (t.dataset.sf === "q") return keepFocus("[data-sf=q]", () => { MK.sell.q = t.value; drawMarket(); });
    if (t.dataset.want === "q") return keepFocus("[data-want=q]", () => { MK.want.q = t.value; drawMarket(); });
    if (t.dataset.sf === "price" || t.dataset.sf === "step") MK.sell[t.dataset.sf] = t.value;
    if (t.dataset.want === "price") MK.want.price = t.value;
  });
  body.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.mf) { MK.f[t.dataset.mf] = t.value; return drawMarket(); }
    if (t.dataset.sf === "hours") MK.sell.hours = +t.value;
    if (t.dataset.want === "variant") { MK.want.variant = t.value; MK.want.price = ""; return drawMarket(); }
    if (t.matches("[data-want-only]")) { MK.want.onlyMine = t.checked; return drawMarket(); }
    const ms = t.dataset.msort;
    if (ms) {
      if (ms === "sell") MK.sell.sort = t.value;
      if (ms === "found") MK.want.sortFound = t.value;
      if (ms === "orders") MK.want.sortOrders = t.value;
      return drawMarket();
    }
  });
}
