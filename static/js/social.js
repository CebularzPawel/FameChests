"use strict";
// Konta i funkcje społecznościowe: nagroda dzienna, znajomi, aktywność, ranking, profile, gablota.

const AVATARS = ["😎", "🤠", "🥷", "🧙", "🦸", "🧛", "🤖", "👽", "👻", "🎃", "🐸", "🐼", "🦊", "🐯", "🦁", "🐺",
                 "🐉", "🦄", "🐙", "🦈", "🦅", "🐝", "🍕", "🌶️", "🍀", "🔥", "⚡", "💎", "👑", "🎩", "🎮", "🎲",
                 "🏆", "⚽", "🏀", "🎸", "🚀", "🛸", "🌈", "💀"];
const PROF = { username: null, data: null, crate: null, spread: 0, rankBy: "value", rankScope: "all", rankSearch: "", rankData: null, rankOthers: null };

// ================================================================ WSPÓLNE

function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "przed chwilą";
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} godz. temu`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "wczoraj" : `${d} dni temu`;
}

function openDialog(html, cls = "") {
  closeDialogs();
  const el = document.createElement("div");
  el.className = "sdialog";
  el.innerHTML = `<div class="sdialog-box ${cls}">${html}</div>`;
  el.addEventListener("click", e => { if (e.target === el || e.target.closest("[data-close]")) closeDialogs(); });
  document.body.appendChild(el);
  return el;
}
function closeDialogs() { $$(".sdialog").forEach(d => d.remove()); }
function dialogOpen() { return !!document.querySelector(".sdialog"); }

// Tajna karta znajomego w aktywności: na czas rysowania podmieniamy zamaskowane dane na prawdziwe
let FEED_CACHE = [];
function withReveal(f, fn) {
  if (!f.reveal) return fn();
  const orig = S.cfg.people[f.person];
  S.cfg.people[f.person] = { ...f.reveal, imgq: `feed=${f.id}` };
  try { return fn(); } finally { S.cfg.people[f.person] = orig; }
}

// To samo dla profilu znajomego: { personId: prawdziwe dane } + parametr dla obrazka
function withRevealMap(map, imgq, fn) {
  const ids = Object.keys(map || {});
  if (!ids.length) return fn();
  const orig = {};
  ids.forEach(id => { orig[id] = S.cfg.people[id]; S.cfg.people[id] = { ...map[id], imgq }; });
  try { return fn(); } finally { ids.forEach(id => { S.cfg.people[id] = orig[id]; }); }
}
function profileReveal(fn) {
  const d = PROF.data;
  return withRevealMap(d?.reveal, `owner=${encodeURIComponent(d?.user.username || "")}`, fn);
}

function userLink(u) {
  return `<button class="ulink" data-user="${esc(u.username)}">${avatarHTML(u)}${esc(u.username)}</button>`;
}

// ================================================================ ZNACZKI / ODŚWIEŻANIE

function applyBadges(me) {
  S.dailyClaimable = me.dailyClaimable;
  $("#dailyBtn").classList.toggle("ready", me.dailyClaimable);
  const n = me.incoming + me.unread + (me.trades || 0);
  const b = $("#friendsBadge");
  b.textContent = n;
  b.hidden = !n;
  // rynek: propozycje cen do moich ofert + nowości (sprzedane, kupione, przebite...) od ostatniej wizyty
  const mb = $("#marketBadge");
  mb.textContent = me.market || 0;
  mb.hidden = !me.market || currentView() === "market";
  // kasyno: zaproszenia do lobby jackpota (z wolnym miejscem)
  const cb = $("#casinoBadge");
  cb.textContent = me.jackpotInvites || 0;
  cb.hidden = !me.jackpotInvites;
  if (me.user) S.me = me.user;
}

function startPolling() {
  // co 30 s, a gdy siedzę w lobby jackpota - co 5 s (wynik od razu, gdziekolwiek w grze jestem)
  let last = Date.now(), running = false;
  setInterval(async () => {
    if (document.hidden || running || Date.now() - last < (S.jpLobby ? 4500 : 29500)) return;
    last = Date.now();
    running = true;
    try {
      const me = await api("/api/me");
      const hadNew = me.unread > 0 || me.incoming > 0 || me.trades > 0;
      applyBadges(me);
      noteUfo(me);                                      // wizyta UFO - pokaże się przy następnym wejściu do ekwipunku
      if (hadNew && currentView() === "friends" && !S.opening) renderFriends();
      if (me.market && currentView() === "market" && !S.opening && !dialogOpen()) renderMarket(true);
      S.jpLobby = me.jackpotLobby;
      await syncInventory(me);                          // karty / pieniądze zmienione przez innych graczy
      if (me.horseNews?.length) hrNews(me.horseNews);   // rozliczone zakłady na wyścigi konne
      if (me.jackpot) showJackpotResult(me.jackpot);    // wynik gry w jackpot, którego jeszcze nie widziałem
      else if (me.messages?.length && !S.opening) showAdminMessages(me.messages);   // zaczął się czas wiadomości od adminów
    } catch (_) { /* serwer chwilowo niedostępny */ }
    finally { running = false; }
  }, 5000);
}

// ================================================================ LISTA ZMIAN (raz po aktualizacji)

function openPatchNotes(notes, fresh = false) {
  return openDialog(`<div class="pn">
      <h3>📰 ${fresh ? "Co nowego w ScamBox?" : "Lista zmian"}</h3>
      ${notes.map(n => `<div class="pn-note">
        <div class="pn-head"><b>${esc(n.title)}</b><span class="muted small">${new Date(n.date).toLocaleDateString("pl-PL")}</span></div>
        <ul>${n.items.map(i => `<li>${i}</li>`).join("")}</ul></div>`).join("")}
      <div class="daily-actions"><button class="btn primary" data-close>${fresh ? "Super, gramy! 🎉" : "Zamknij"}</button></div>
    </div>`, "pn-box");
}

// ================================================================ WIADOMOŚCI OD ADMINÓW
// Admin planuje je w panelu (od - do); gracz widzi każdą raz: przy wejściu do gry albo w trakcie gry, gdy zacznie się jej czas.

function showAdminMessages(list, then) {
  list = list.filter(m => !S.msgShown?.has(m.id));
  if (!list.length || dialogOpen() || epicOpen()) return false;
  S.msgShown = S.msgShown || new Set();
  list.forEach(m => S.msgShown.add(m.id));
  const dlg = openDialog(`<div class="pn">
      <h3>📢 ${list.length > 1 ? "Wiadomości" : "Wiadomość"} od ScamBox</h3>
      ${list.map(m => `<div class="pn-note">
        <div class="pn-head"><b>${esc(m.title)}</b><span class="muted small">${new Date(m.at * 1000).toLocaleDateString("pl-PL")}</span></div>
        <p class="am-body">${esc(m.body)}</p></div>`).join("")}
      <div class="daily-actions"><button class="btn primary" data-close>OK 👍</button></div>
    </div>`, "pn-box");
  api("/api/messages/seen", { ids: list.map(m => m.id) }).catch(() => {});
  if (then) {   // po zamknięciu: dalsze okienka po wejściu do gry (lista zmian, codzienna skrzynka)
    const wait = setInterval(() => { if (!document.body.contains(dlg)) { clearInterval(wait); setTimeout(then, 300); } }, 400);
  }
  return true;
}

// po wejściu do gry po aktualizacji: lista zmian (zapamiętana jako obejrzana), potem codzienna skrzynka
function showPatchNotes(notes) {
  if (dialogOpen() || epicOpen()) return;
  const dlg = openPatchNotes(notes, true);
  api("/api/patchnotes/seen", {}).catch(() => {});
  const wait = setInterval(() => {
    if (document.body.contains(dlg)) return;
    clearInterval(wait);
    if (S.dailyClaimable) setTimeout(openDaily, 300);
  }, 400);
}

// ================================================================ CODZIENNA SKRZYNKA

async function openDaily() {
  if (S.opening || dialogOpen() || epicOpen()) return;
  let d;
  try { d = await api("/api/daily"); } catch (e) { return toast(e.message, true); }
  renderDaily(d, openDialog("", "daily-box"));
}

function kRange(m) { return `${(m.min / 1000).toLocaleString("pl-PL")}k–${(m.max / 1000).toLocaleString("pl-PL")}k gr`; }

function moneyChestArt(kind, extra = "") {
  const m = S.cfg.moneyChests[kind];
  return `<div class="crate-art chest-art ${extra}" style="--crate-bg: linear-gradient(180deg, ${m.color1} 0 50%, ${m.color2} 50%); --crate-lid: linear-gradient(180deg, ${m.color1}, ${m.color2})">
    <div class="crate-box"><div class="crate-emblem">${m.emoji}</div></div><div class="crate-lid"></div><div class="crate-lock"></div></div>`;
}

function renderDaily(d, dlg, justClaimed = null) {
  const box = dlg.querySelector(".sdialog-box");
  const D = S.cfg.moneyChests.daily, M = S.cfg.moneyChests.mega;
  const todayKind = d.todayKind;
  const owned = S.chests["money_" + todayKind] || 0;
  box.innerHTML = `
    <div class="daily-head">🎁 <span>Codzienna skrzynka</span></div>
    <p class="muted">Każdego dnia odbierz <b>${D.emoji} ${D.name}</b> z kasą: <b class="gold-txt">${kRange(D)}</b>.
      Odbieraj ją <b class="gold-txt">${S.cfg.dailyStreak} dni z rzędu</b>, a w ${S.cfg.dailyStreak}. dniu dostaniesz
      <b class="gold-txt">${M.emoji} ${M.name}</b>: <b class="gold-txt">${kRange(M)}</b>! Pominięty dzień zaczyna serię od nowa.</p>
    <div class="daily-week">${d.days.map(w => {
      const m = S.cfg.moneyChests[w.kind];
      return `<div class="dday${w.kind === "mega" ? " jackpot" : ""}${w.claimed ? " claimed" : ""}${w.today ? " today" : ""}">
        <div class="dname">${w.kind === "mega" ? "⭐ " : ""}Dzień ${w.day}</div>
        <div class="dicon">${w.claimed ? "✔" : m.emoji}</div>
        <div class="damount">${w.kind === "mega" ? "MEGA<br>" : ""}${kRange(m)}</div>
      </div>`;
    }).join("")}</div>
    ${d.streak > 1 ? `<div class="daily-streak">🔥 Seria: <b>${d.streak} ${plural(d.streak, "dzień", "dni", "dni")}</b> z rzędu</div>` : ""}
    ${justClaimed ? `
      <div class="claimed-panel">
        ${moneyChestArt(justClaimed, "bounce")}
        <div><b>${S.cfg.moneyChests[justClaimed].name}</b> trafiła do ekwipunku!<br><span class="muted small">Możesz ją otworzyć teraz albo później w zakładce 🎒 Ekwipunek.</span></div>
      </div>` : `
      <div class="daily-info">${d.claimable
        ? (todayKind === "mega" ? "💎 <b class='gold-txt'>Dziś MEGA skrzynka!</b>" : `Do MEGA skrzynki: <b>${d.daysToJackpot} ${plural(d.daysToJackpot, "dzień", "dni", "dni")}</b> logowania z rzędu`)
        : `Dzisiejsza skrzynka odebrana ✔ · ${d.daysToJackpot === 0 ? `wróć jutro — zaczniesz nową serię do MEGA` : `MEGA za <b>${d.daysToJackpot} ${plural(d.daysToJackpot, "dzień", "dni", "dni")}</b> — wróć jutro, żeby nie przerwać serii`}`}</div>`}
    <div class="daily-actions">
      ${d.claimable ? `<button class="big-btn${todayKind === "mega" ? " jackpot-btn" : ""}" id="claimBtn">ODBIERZ ${todayKind === "mega" ? "MEGA SKRZYNKĘ 💎" : "SKRZYNKĘ 🎁"}</button>` : ""}
      ${!d.claimable && owned ? `<button class="big-btn${todayKind === "mega" ? " jackpot-btn" : ""}" id="openNowBtn" data-kind="${todayKind}">OTWÓRZ TERAZ${owned > 1 ? ` (${owned})` : ""}</button>` : ""}
      ${!d.claimable && !owned && (S.chests.money_daily || S.chests.money_mega) ? `<button class="btn primary" id="openNowBtn" data-kind="${S.chests.money_mega ? "mega" : "daily"}">Otwórz skrzynkę z ekwipunku</button>` : ""}
      <button class="btn" data-close>${justClaimed ? "Później" : "Zamknij"}</button>
    </div>`;
  box.querySelector("#claimBtn")?.addEventListener("click", e => claimDaily(dlg, e.target));
  box.querySelector("#openNowBtn")?.addEventListener("click", e => { closeDialogs(); openMoneyChest(e.target.dataset.kind); });
}

async function claimDaily(dlg, btn) {
  btn.disabled = true;
  Sound.unlock();
  let res;
  try { res = await api("/api/daily/claim", {}); } catch (e) { toast(e.message, true); btn.disabled = false; return; }
  S.chests = res.chests;
  applyBadges({ dailyClaimable: false, incoming: 0, unread: 0 });
  refreshBadgesSoon();
  const tile = dlg.querySelector(".dday.today");
  tile?.classList.add("flip");
  if (res.kind === "mega") { Sound.gold(); setTimeout(() => confetti(GOLDS, 120), 200); }
  else Sound.win();
  setTimeout(() => { if (document.body.contains(dlg)) renderDaily(res.daily, dlg, res.kind); }, 650);
  if (currentView() === "inventory") renderInventory();
}

// ================================================================ OTWIERANIE SKRZYNKI Z PIENIĘDZMI

const MONEY_TIERS = [[0.15, "#4fc34f"], [0.35, "#4b8bff"], [0.6, "#a35bff"], [0.85, "#ff4040"], [1.01, "#ffc531"]];
function moneyTier(kind, v) {
  const m = S.cfg.moneyChests[kind];
  const f = (v - m.min) / (m.max - m.min);
  return MONEY_TIERS.find(([lim]) => f < lim)[1];
}
function cosmeticMoney(kind) {
  const m = S.cfg.moneyChests[kind];
  return Math.round((m.min + (m.max - m.min) * Math.random() ** m.curve) / 100) * 100;
}
function moneyTileHTML(kind, v, win = false) {
  const short = v >= 10000 ? `${Math.round(v / 1000)}k` : `${(v / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })}k`;
  return `<div class="mini money-tile${win ? " win" : ""}" style="--rc:${moneyTier(kind, v)}">
    <div class="mt-val">💵<b>${short}</b></div><div class="mn">${fmt(v)}</div></div>`;
}

async function openMoneyChest(kind) {
  if (S.opening || epicOpen() || document.querySelector(".money-stage")) return;
  const M = S.cfg.moneyChests[kind];
  Sound.unlock();
  let res;
  try { res = await api("/api/chests/money", { kind }); } catch (e) { Sound.error(); return toast(e.message, true); }
  S.chests = res.chests;
  const fast = S.fast;
  const el = document.createElement("div");
  el.className = `money-stage mk-${kind}`;
  el.style.setProperty("--m1", M.color1);
  el.innerHTML = `
    <div class="ms-bg"></div>
    <canvas class="ms-canvas"></canvas>
    <div class="ms-title">${M.emoji} ${esc(M.name)}</div>
    <div class="ms-chest-wrap">${moneyChestArt(kind, "ms-chest")}</div>
    <div class="fa-reel reel ms-reel" hidden><div class="strip"></div><div class="reel-marker"></div></div>
    <div class="ms-result" hidden></div>
    <div class="flash fa-flash"></div>`;
  document.body.appendChild(el);
  document.body.style.overflow = "hidden";
  const P = makeParticles(el.querySelector(".ms-canvas"));
  const chest = el.querySelector(".ms-chest");
  const cx = () => innerWidth / 2, cy = () => innerHeight / 2;

  // 1. skrzynka trzęsie się i otwiera
  chest.classList.add("shaking");
  Sound.charge(fast ? 0.5 : 1.1, kind === "mega");
  await sleep(fast ? 500 : 1100);
  chest.classList.remove("shaking");
  chest.classList.add("popping");
  Sound.open();
  P.burst(cx(), cy(), kind === "mega" ? 160 : 90, [M.color1, "#ffe58a", "#fff"], { speed: 13 });
  await sleep(fast ? 250 : 450);
  el.querySelector(".ms-chest-wrap").remove();

  // 2. bęben z kwotami
  const reel = el.querySelector(".ms-reel");
  reel.hidden = false;
  const strip = reel.querySelector(".strip");
  const MW = Math.min(130, innerWidth / 6), GAP = 8, N = 46, WIN = 38;
  reel.style.setProperty("--mw", MW + "px");
  reel.style.setProperty("--gap", GAP + "px");
  reel.style.setProperty("--rh", Math.round(MW * 1.05 + 45) + "px");
  const vals = Array.from({ length: N }, () => cosmeticMoney(kind));
  vals[WIN] = res.amount;
  if (Math.random() < 0.35) vals[WIN + (Math.random() < 0.5 ? -1 : 1)] = Math.round((M.max - Math.random() * (M.max - M.min) * 0.1) / 100) * 100;
  strip.innerHTML = vals.map((v, i) => moneyTileHTML(kind, v, i === WIN)).join("");
  await sleep(50);
  const step = MW + GAP, center = reel.clientWidth / 2;
  const to = -(WIN * step + MW / 2 + rand(-0.4, 0.4) * MW) + center;
  const D = fast ? 1000 : 4300;
  const t0 = performance.now();
  let lastIdx = -1;
  await new Promise(done => {
    const frame = now => {
      const t = Math.min(1, (now - t0) / D);
      const x = to * (1 - Math.pow(1 - t, 4.2));
      strip.style.transform = `translate3d(${x}px, -50%, 0)`;
      const idx = Math.floor((center - x) / step);
      if (idx !== lastIdx) { if (lastIdx >= 0) Sound.tick(1 - t); lastIdx = idx; }
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  const color = moneyTier(kind, res.amount);
  reel.classList.add("landed");
  reel.style.setProperty("--rc", color);
  await sleep(fast ? 250 : 600);

  // 3. wynik - licznik kwoty, deszcz monet, im więcej tym większe efekty
  const f = (res.amount - M.min) / (M.max - M.min);
  reel.hidden = true;
  const box = el.querySelector(".ms-result");
  box.hidden = false;
  const more = S.chests["money_" + kind] || 0;
  box.innerHTML = `
    <div class="ms-label">${f >= 0.85 ? "🤑 MEGA WYGRANA!" : f >= 0.6 ? "💰 Świetnie!" : f >= 0.35 ? "Nieźle!" : "Wygrywasz"}</div>
    <div class="ms-amount" style="--rc:${color}">+<span id="msCount">0</span> gr</div>
    <div class="fa-result-btns">
      ${more ? `<button class="btn primary" data-act="again">🔁 Otwórz kolejną (${more})</button>` : ""}
      <button class="btn sell" data-act="ok">✔ Odbierz</button>
    </div>`;
  applyState(res.state);
  Sound.cash();
  coinRain(Math.min(180, 30 + Math.round(f * 150)));
  if (f >= 0.6 || kind === "mega") {
    const fl = el.querySelector(".fa-flash");
    fl.style.background = `radial-gradient(circle, #fff, ${color}88 40%, transparent 75%)`;
    fl.classList.add("go");
    P.burst(cx(), cy(), 200 + Math.round(f * 250), [color, "#ffe58a", "#fff", M.color1], { speed: 18, stars: 0.35 });
    f >= 0.85 ? (Sound.boom(false), Sound.gold()) : Sound.win();
    if (f >= 0.85) { el.classList.add("shake"); setTimeout(() => confetti(GOLDS, 200), 300); }
  }
  const counter = box.querySelector("#msCount"), c0 = performance.now(), CD = fast ? 500 : 1300;
  const count = now => {
    const t = Math.min(1, (now - c0) / CD);
    counter.textContent = Math.round(res.amount * (1 - Math.pow(1 - t, 3))).toLocaleString("pl-PL");
    if (t < 1 && document.body.contains(counter)) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);

  box.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    P.stop(); el.remove(); document.body.style.overflow = "";
    if (act === "again") openMoneyChest(kind);
    else if (currentView() === "inventory") renderInventory();
    else if (currentView() === "crates") renderCrates();
  });
}

async function refreshBadgesSoon() {
  try { applyBadges(await api("/api/me")); } catch (_) {}
}

// ================================================================ ZNAJOMI + AKTYWNOŚĆ

function feedText(f) {
  if (f.kind === "show") {
    if (f.mine) return f.to ? `pokazujesz kartę: <b>${esc(f.to)}</b>` : "pokazujesz kartę znajomym";
    return f.to ? "pokazuje ci kartę" : "chwali się kartą";
  }
  const verb = { drop: "trafia ze skrzynki", contract: "wytwarza w kontrakcie", upgrade: "wygrywa w ulepszaczu",
                 casino: "wygrywa w ruletce", blackjack: "wygrywa w blackjacku", joker: "wygrywa w kasynie kartę specjalną", link: "dostaje kartę specjalną z linku" }[f.kind] || "zdobywa";
  return `${verb}!`;
}

async function renderFriends() {
  let fr, fd, tr;
  try { [fr, fd, tr] = await Promise.all([api("/api/friends"), api("/api/feed"), api("/api/trades")]); } catch (e) { return toast(e.message, true); }
  const person_ = (u, actions) => `
    <div class="friend">
      ${userLink(u)}
      <span class="fstats">${fmt(u.value)} · ${u.unique} kart</span>
      <span class="factions">${actions}</span>
    </div>`;
  $("#friendsBody").innerHTML = `
    <div class="social-cols">
      <div class="social-left">
      <div class="panel friends-panel">
        <h3>👥 Znajomi</h3>
        <form class="add-friend" id="addFriend" autocomplete="off">
          <input type="text" id="friendName" placeholder="Nazwa gracza…" list="userSuggest" maxlength="20">
          <datalist id="userSuggest"></datalist>
          <button class="btn primary" type="submit">➕ Zaproś</button>
        </form>
        ${fr.incoming.length ? `<div class="fsection"><h4>📨 Zaproszenia (${fr.incoming.length})</h4>${fr.incoming.map(u => person_(u,
          `<button class="btn sell tiny" data-accept="${esc(u.username)}">✔ Przyjmij</button><button class="btn tiny" data-decline="${esc(u.username)}">✖</button>`)).join("")}</div>` : ""}
        <div class="fsection"><h4>Twoi znajomi (${fr.friends.length})</h4>
          ${fr.friends.length ? fr.friends.map(u => person_(u,
            `<button class="btn tiny" data-trade="${esc(u.username)}" title="Zaproponuj wymianę">🔄 Wymiana</button><button class="btn tiny" data-user="${esc(u.username)}">📖 Klaser</button><button class="btn tiny" data-remove="${esc(u.username)}" title="Usuń ze znajomych">🗑</button>`)).join("")
            : '<div class="muted small">Nie masz jeszcze znajomych. Zaproś kogoś po nazwie albo z rankingu!</div>'}
        </div>
        ${fr.outgoing.length ? `<div class="fsection"><h4>⏳ Wysłane</h4>${fr.outgoing.map(u => person_(u,
          `<button class="btn tiny" data-remove="${esc(u.username)}">Anuluj</button>`)).join("")}</div>` : ""}
      </div>
      ${tradesPanelHTML(tr)}
      </div>
      <div class="panel feed-panel">
        <h3>📣 Aktywność</h3>
        <p class="muted small">Karty, które pokazują ci znajomi, i ich legendarne dropy. Swoją kartę pokażesz przyciskiem <b>📣</b> w podglądzie karty.</p>
        <div class="feed">${fd.feed.length ? fd.feed.map(f => `
          <div class="feed-item${!f.mine && f.id > fd.seen ? " unread" : ""}${f.kind !== "show" ? " fi-auto" : ""}${(f.reveal || person(f.person)).rarity === "secret" ? " fi-secret" : ""}">
            <div class="fi-head">${f.mine ? `<span class="ulink me">${avatarHTML(S.me)}Ty</span>` : userLink(f.author)}
              <span class="muted">${feedText(f)}</span><span class="fi-time">${timeAgo(f.created)}</span></div>
            <div class="fi-body">
              <div class="fi-card" data-feed="${f.id}">${withReveal(f, () => cardHTML(f.person, f.variant))}</div>
              <div class="fi-side">
                ${f.message ? `<div class="fi-msg">„${esc(f.message)}”</div>` : ""}
                <div class="fi-name">${esc((f.reveal || person(f.person)).name)}</div>
                <div class="fi-meta"><span style="color:${S.cfg.rarities[person(f.person).rarity].color}">${S.cfg.rarities[person(f.person).rarity].name}</span>${isSpecial(f.variant) ? ` · <span class="holo-txt">${variantName(f.variant)}</span>` : ""}</div>
                <div class="fi-val">${fmt(f.value)}</div>
              </div>
            </div>
          </div>`).join("") : '<div class="empty">Na razie cisza. Gdy znajomi coś pokażą albo trafią legendę — zobaczysz to tutaj.</div>'}
        </div>
      </div>
    </div>`;
  FEED_CACHE = fd.feed;
  if (fd.feed.some(f => !f.mine && f.id > fd.seen)) {
    api("/api/feed/seen", {}).then(refreshBadgesSoon).catch(() => {});
  }
}

async function friendAction(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); Sound.click(); } catch (e) { Sound.error(); toast(e.message, true); }
  refreshBadgesSoon();
  if (currentView() === "friends") renderFriends();
  if (currentView() === "profile") renderProfile();
}

// ================================================================ WYMIANY

const TRADE_STATUS = { accepted: "✅ przyjęta", declined: "❌ odrzucona", cancelled: "↩️ wycofana" };

function tradeLineHTML(l) {
  return withRevealMap(l.reveal ? { [l.person]: l.reveal } : {}, `owner=${encodeURIComponent(l.owner || "")}`, () =>
    `<div class="tl-card" data-pid="${l.person}" data-variant="${l.variant}">${pickHTML({ id: 0, person: l.person, variant: l.variant, value: l.value },
      { extra: l.count > 1 ? `<span class="pc">×${l.count}</span>` : "" })}</div>`);
}

function tradeSideHTML(title, lines, money) {
  const value = lines.reduce((a, l) => a + l.value * l.count, 0) + money;
  return `<div class="trade-side">
    <div class="ts-title">${title} <span class="muted">· ${fmt(value)}</span></div>
    <div class="ts-items">${lines.map(tradeLineHTML).join("")}${money ? `<div class="ts-money">💰<b>${fmt(money)}</b></div>` : ""}
      ${!lines.length && !money ? '<span class="muted small">nic</span>' : ""}</div>
  </div>`;
}

function tradeHTML(t, kind) {
  const other = t.mine ? t.to : t.from;
  const give = tradeSideHTML(t.mine ? "Dajesz" : `${esc(other.username)} daje`, t.give, t.moneyGive);
  const want = tradeSideHTML(t.mine ? `Chcesz od ${esc(other.username)}` : "Chce od ciebie", t.want, t.moneyWant);
  const actions = kind === "incoming"
    ? `<button class="btn sell" data-taccept="${t.id}"${t.problem ? " disabled" : ""}>✅ Przyjmij</button><button class="btn" data-tdecline="${t.id}">❌ Odrzuć</button>`
    : kind === "outgoing" ? `<button class="btn" data-tcancel="${t.id}">↩️ Wycofaj</button>`
    : `<span class="t-status">${TRADE_STATUS[t.status] || t.status}</span>`;
  return `<div class="trade${kind === "history" ? " t-old" : ""}">
    <div class="t-head">${userLink(other)}<span class="muted small">${kind === "incoming" ? "proponuje ci wymianę" : kind === "outgoing" ? "— czeka na odpowiedź" : ""}</span>
      <span class="fi-time">${timeAgo(kind === "history" ? t.updated : t.created)}</span></div>
    ${t.message ? `<div class="t-msg">„${esc(t.message)}”</div>` : ""}
    <div class="t-body">${give}<div class="t-arrow">⇄</div>${want}</div>
    ${t.problem ? `<div class="t-problem">⚠️ ${esc(t.problem)}</div>` : ""}
    <div class="t-actions">${actions}</div>
  </div>`;
}

function tradesPanelHTML(tr) {
  return `<div class="panel trades-panel">
    <h3>🔄 Wymiany</h3>
    <p class="muted small">Zaproponujesz wymianę przyciskiem <b>🔄</b> przy znajomym albo na jego profilu.</p>
    ${tr.incoming.length ? `<div class="fsection"><h4>📨 Oferty dla ciebie (${tr.incoming.length})</h4>${tr.incoming.map(t => tradeHTML(t, "incoming")).join("")}</div>` : ""}
    ${tr.outgoing.length ? `<div class="fsection"><h4>⏳ Twoje oferty</h4>${tr.outgoing.map(t => tradeHTML(t, "outgoing")).join("")}</div>` : ""}
    ${!tr.incoming.length && !tr.outgoing.length ? '<div class="muted small">Brak aktywnych ofert.</div>' : ""}
    ${tr.history.length ? `<details class="fsection"><summary>Historia (${tr.history.length})</summary>${tr.history.map(t => tradeHTML(t, "history")).join("")}</details>` : ""}
  </div>`;
}

async function tradeAction(fn, okMsg, after) {
  try {
    const res = await fn();
    if (okMsg) toast(okMsg);
    if (after) await after(res);
  } catch (e) { Sound.error(); toast(e.message, true); }
  refreshBadgesSoon();
  if (currentView() === "friends") renderFriends();
}

async function acceptTrade(id) {
  await tradeAction(() => api(`/api/trades/${id}/accept`, {}), null, async res => {
    S.items = res.items;
    S.showcase = res.showcase || [];
    applyState(res.state);
    await refreshConfig();   // tajne karty z wymiany są teraz odkryte
    Sound.win();
    confetti(["#3ddc84", "#ffcf3f", "#4b8bff", "#fff"], 120);
    toast("🔄 Wymiana zakończona! Karty są w twoim ekwipunku.");
  });
}

// --- budowanie oferty

async function openTradeBuilder(username) {
  let prof;
  try { prof = await api(`/api/users/${encodeURIComponent(username)}`); } catch (e) { return toast(e.message, true); }
  if (prof.relation !== "friend") return toast("Wymieniać się możesz tylko ze znajomymi", true);
  const reveal = prof.reveal || {}, imgq = `owner=${encodeURIComponent(username)}`;
  const T = { give: [], want: {}, qMine: "", qTheirs: "", sortMine: "rarity", sortTheirs: "rarity" };
  const showIds = new Set(S.showcase);

  const mineGroups = {};
  S.items.forEach(i => {
    const k = `${i.person}|${i.variant}`;
    (mineGroups[k] ||= { key: k, person: i.person, variant: i.variant, value: i.value, ids: [] }).ids.push(i.id);
  });
  Object.values(mineGroups).forEach(g => g.ids.sort((a, b) => showIds.has(a) - showIds.has(b)));  // najpierw spoza gabloty
  const theirGroups = {};
  prof.collection.forEach(c => {
    const k = `${c.person}|${c.variant}`;
    theirGroups[k] = { key: k, person: c.person, variant: c.variant, count: c.count, value: cardValue(c.person, c.variant) };
  });
  const sortG = (list, mode) => sortCards(list, mode);
  const TRADE_SORTS = CARD_SORTS.filter(([k]) => k !== "new");

  const dlg = openDialog(`
    <h3>🔄 Wymiana z ${esc(username)}</h3>
    <div class="tb-cols">
      <div class="tb-col">
        <div class="tb-head"><b>Dajesz</b><span class="muted" id="tbGiveVal"></span></div>
        <div class="tb-sel" id="tbGiveSel"></div>
        <div class="tb-row"><input type="text" class="tb-search" data-side="mine" placeholder="Szukaj w swoich kartach…">${sortSelectHTML(T.sortMine, 'data-tbsort="mine"', TRADE_SORTS)}</div>
        <div class="pick-grid tb-grid" id="tbMine"></div>
      </div>
      <div class="tb-col">
        <div class="tb-head"><b>Chcesz od ${esc(username)}</b><span class="muted" id="tbWantVal"></span></div>
        <div class="tb-sel" id="tbWantSel"></div>
        <div class="tb-row"><input type="text" class="tb-search" data-side="theirs" placeholder="Szukaj w kartach znajomego…">${sortSelectHTML(T.sortTheirs, 'data-tbsort="theirs"', TRADE_SORTS)}</div>
        <div class="pick-grid tb-grid" id="tbTheirs"></div>
      </div>
    </div>
    <input type="text" id="tbMsg" maxlength="140" placeholder="Wiadomość (opcjonalnie)…">
    <div class="daily-actions"><button class="btn primary" id="tbSend">🔄 Wyślij ofertę</button><button class="btn" data-close>Anuluj</button></div>`, "trade-box");

  const tileTheirs = g => withRevealMap(reveal, imgq, () => pickHTML({ id: g.key, person: g.person, variant: g.variant, value: g.value },
    { extra: `<span class="pc">×${g.count - (T.want[g.key] || 0)}</span>` }));
  const draw = () => {
    const selMine = {};
    T.give.forEach(id => { const g = Object.values(mineGroups).find(x => x.ids.includes(id)); selMine[g.key] = (selMine[g.key] || 0) + 1; });
    const match = (g, q) => cardMatches(g, q);
    dlg.querySelector("#tbMine").innerHTML = sortG(Object.values(mineGroups), T.sortMine).filter(g => g.ids.length > (selMine[g.key] || 0) && match(g, T.qMine))
      .map(g => pickHTML({ id: g.key, person: g.person, variant: g.variant, value: g.value }, { extra: `<span class="pc">×${g.ids.length - (selMine[g.key] || 0)}</span>` })).join("")
      || '<div class="empty">Brak kart</div>';
    dlg.querySelector("#tbTheirs").innerHTML = withRevealMap(reveal, imgq, () => sortG(Object.values(theirGroups), T.sortTheirs)).filter(g => g.count > (T.want[g.key] || 0) &&
      withRevealMap(reveal, imgq, () => match(g, T.qTheirs))).map(tileTheirs).join("") || '<div class="empty">Brak kart</div>';
    dlg.querySelector("#tbGiveSel").innerHTML = Object.entries(selMine).map(([k, n]) => {
      const g = mineGroups[k];
      return pickHTML({ id: k, person: g.person, variant: g.variant, value: g.value }, { extra: n > 1 ? `<span class="pc">×${n}</span>` : "" });
    }).join("") || '<span class="muted small">Kliknij swoje karty poniżej</span>';
    dlg.querySelector("#tbWantSel").innerHTML = Object.entries(T.want).filter(([, n]) => n > 0).map(([k, n]) => {
      const g = theirGroups[k];
      return withRevealMap(reveal, imgq, () => pickHTML({ id: k, person: g.person, variant: g.variant, value: g.value }, { extra: n > 1 ? `<span class="pc">×${n}</span>` : "" }));
    }).join("") || '<span class="muted small">Kliknij karty znajomego poniżej</span>';
    const giveVal = T.give.reduce((a, id) => a + S.items.find(i => i.id === id).value, 0);
    const wantVal = Object.entries(T.want).reduce((a, [k, n]) => a + theirGroups[k].value * n, 0);
    dlg.querySelector("#tbGiveVal").textContent = fmt(giveVal);
    dlg.querySelector("#tbWantVal").textContent = fmt(wantVal);
  };
  draw();

  dlg.addEventListener("input", e => {
    if (e.target.matches(".tb-search")) { T[e.target.dataset.side === "mine" ? "qMine" : "qTheirs"] = e.target.value; draw(); }
  });
  dlg.addEventListener("change", e => {
    const side = e.target.dataset.tbsort;
    if (side) { T[side === "mine" ? "sortMine" : "sortTheirs"] = e.target.value; draw(); }
  });
  dlg.addEventListener("click", async e => {
    const pick = e.target.closest(".pick");
    if (pick) {
      const k = pick.dataset.id;
      const zone = pick.closest("#tbMine, #tbTheirs, #tbGiveSel, #tbWantSel")?.id;
      if (zone === "tbMine") { const g = mineGroups[k]; const id = g.ids.find(x => !T.give.includes(x)); if (id) T.give.push(id); }
      if (zone === "tbGiveSel") { const g = mineGroups[k]; const idx = T.give.findLastIndex(x => g.ids.includes(x)); if (idx >= 0) T.give.splice(idx, 1); }
      if (zone === "tbTheirs") T.want[k] = (T.want[k] || 0) + 1;
      if (zone === "tbWantSel") T.want[k] = Math.max(0, (T.want[k] || 0) - 1);
      Sound.click();
      return draw();
    }
    if (e.target.closest("#tbSend")) {
      const body = {
        to: username, give: T.give, message: dlg.querySelector("#tbMsg").value,
        want: Object.entries(T.want).filter(([, n]) => n > 0).map(([k, n]) => ({ person: theirGroups[k].person, variant: theirGroups[k].variant, count: n })),
      };
      try {
        await api("/api/trades", body);
        closeDialogs();
        Sound.win();
        toast(`🔄 Wysłano ofertę wymiany do ${username}`);
        if (currentView() === "friends") renderFriends();
      } catch (err) { Sound.error(); toast(err.message, true); }
    }
  });
}

// ================================================================ POKAZYWANIE KART

function myItemFor(pid, variant) {
  return S.items.find(i => i.person === pid && i.variant === variant);
}

async function openShowDialog(pid, variant) {
  const item = myItemFor(pid, variant);
  if (!item) return toast("Nie masz tej karty", true);
  let fr;
  try { fr = await api("/api/friends"); } catch (e) { return toast(e.message, true); }
  if (!fr.friends.length) return toast("Najpierw dodaj znajomych w zakładce 👥 Znajomi", true);
  const dlg = openDialog(`
    <h3>📣 Pokaż kartę znajomym</h3>
    <div class="show-row">
      <div class="show-card">${cardHTML(pid, variant)}</div>
      <form class="show-form" id="showForm">
        <label>Komu?
          <select name="to"><option value="all">👥 Wszystkim znajomym</option>
            ${fr.friends.map(u => `<option value="${esc(u.username)}">${esc(u.avatar)} ${esc(u.username)}</option>`).join("")}</select>
        </label>
        <label>Wiadomość (opcjonalnie)<input type="text" name="message" maxlength="140" placeholder="np. Patrz co trafiłem! 😎"></label>
        <div class="daily-actions"><button class="btn primary" type="submit">📣 Pokaż</button><button class="btn" type="button" data-close>Anuluj</button></div>
      </form>
    </div>`, "show-box");
  dlg.querySelector("#showForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api("/api/show", { item_id: item.id, to: f.to, message: f.message });
      closeDialogs();
      Sound.win();
      toast(f.to === "all" ? "Pokazano kartę znajomym 📣" : `Pokazano kartę: ${f.to} 📣`);
    } catch (err) { toast(err.message, true); }
  });
}

// ================================================================ GABLOTA

function showcaseHas(pid, variant) {
  return S.showcase.some(id => { const it = S.items.find(i => i.id === id); return it && it.person === pid && it.variant === variant; });
}

async function toggleShowcase(pid, variant) {
  let ids = S.showcase.filter(id => S.items.some(i => i.id === id));
  const inside = ids.find(id => { const it = S.items.find(i => i.id === id); return it.person === pid && it.variant === variant; });
  if (inside) ids = ids.filter(id => id !== inside);
  else {
    if (ids.length >= S.cfg.showcaseSize) return toast(`Gablota mieści ${S.cfg.showcaseSize} kart — najpierw coś z niej zdejmij`, true);
    ids.push(myItemFor(pid, variant).id);
  }
  try {
    const res = await api("/api/showcase", { ids });
    S.showcase = res.showcase;
    Sound.click();
    toast(inside ? "Zdjęto z gabloty" : "📌 Dodano do gabloty na twoim profilu");
  } catch (e) { toast(e.message, true); }
}

// ================================================================ RANKING

async function renderRanking() {
  try { PROF.rankData = await api("/api/ranking"); } catch (e) { return toast(e.message, true); }
  const by = PROF.rankBy;
  const r = PROF.rankData;
  $("#rankingBody").innerHTML = `
    <div class="player-stats">
      <span title="Gracze z otwartą grą w ciągu ostatnich 2 minut"><i class="online-dot"></i><b>${r.online.toLocaleString("pl-PL")}</b> online</span>
      <span>👤 <b>${r.accounts.toLocaleString("pl-PL")}</b> ${plural(r.accounts, "konto", "konta", "kont")} w grze</span>
    </div>
    <div class="rank-toolbar">
      <div class="seg" id="rankBy">${[["value", "💰 Wartość kolekcji"], ["cards", "📖 Zebrane karty"], ["opened", "📦 Otwarte skrzynki"]]
        .map(([k, n]) => `<button data-by="${k}" class="${by === k ? "active" : ""}">${n}</button>`).join("")}</div>
      <div class="seg" id="rankScope">${[["all", "🌍 Wszyscy"], ["friends", "👥 Znajomi"]]
        .map(([k, n]) => `<button data-scope="${k}" class="${PROF.rankScope === k ? "active" : ""}">${n}</button>`).join("")}</div>
      <input type="text" id="rankSearch" class="rank-search" placeholder="🔍 Szukaj gracza…" value="${esc(PROF.rankSearch)}" autocomplete="off">
    </div>
    <div class="panel rank-list" id="rankList"></div>`;
  renderRankList();
}

// lista rankingu (osobno, żeby wpisywanie w wyszukiwarkę nie przebudowywało pola i nie pytało serwera)
function renderRankList() {
  const r = PROF.rankData;
  if (!r) return;
  const by = PROF.rankBy;
  const key = { value: "value", cards: "unique", opened: "opened" }[by];
  const ranked = r.players.filter(p => PROF.rankScope === "all" || p.friend || p.me)
    .sort((a, b) => b[key] - a[key] || a.username.localeCompare(b.username, "pl"))
    .map((p, i) => ({ p, i }));  // miejsce liczone przed wyszukiwaniem - znaleziony gracz ma swoje prawdziwe miejsce
  const q = PROF.rankSearch.trim().toLowerCase();
  const list = q ? ranked.filter(({ p }) => p.username.toLowerCase().includes(q)) : ranked;
  const medal = i => ["🥇", "🥈", "🥉"][i] || `#${i + 1}`;
  const val = p => by === "value" ? fmt(p.value)
    : by === "cards" ? `${p.unique} / ${r.totalCards} <span class="muted">(${Math.round(p.unique / Math.max(1, r.totalCards) * 100)}%)</span>`
    : `${p.opened.toLocaleString("pl-PL")} 📦`;
  // gracze spoza tej listy (poza rankiem albo nie-znajomi przy "Znajomi") - z wyszukiwarki na serwerze
  const shown = new Set(ranked.map(({ p }) => p.username));
  const others = q && PROF.rankOthers?.q === q ? PROF.rankOthers.users.filter(u => !shown.has(u.username)) : [];
  $("#rankList").innerHTML = (list.map(({ p, i }) => `
      <div class="rank-row${p.me ? " me" : ""}${i < 3 ? " top" + (i + 1) : ""}">
        <span class="rpos">${medal(i)}</span>
        ${userLink(p)}
        ${p.friend ? '<span class="rfriend" title="Znajomy">👥</span>' : ""}
        ${p.isAdmin ? '<span class="rfriend" title="Admin">👑</span>' : ""}
        <span class="rval">${val(p)}</span>
        ${by === "cards" ? `<div class="rbar"><div style="width:${p.unique / Math.max(1, r.totalCards) * 100}%"></div></div>` : ""}
      </div>`).join("") + (others.length ? `<h4 class="rank-others">Pozostali gracze</h4>` + others.map(u => `
      <div class="rank-row other">
        <span class="rpos">—</span>
        ${userLink(u)}
        <span class="rval muted small">${PROF.rankScope === "friends" ? "nie jest znajomym" : "poza rankingiem"}</span>
      </div>`).join("") : ""))
    || `<div class="empty">${q ? `Nie ma gracza „${esc(PROF.rankSearch.trim())}”.` : "Brak graczy."}</div>`;
}

// wyszukiwanie wszystkich graczy (także spoza rankingu) - z opóźnieniem, żeby nie pytać serwera przy każdej literze
let rankSearchTimer = null;
function searchOtherPlayers() {
  clearTimeout(rankSearchTimer);
  const q = PROF.rankSearch.trim().toLowerCase();
  if (!q) return;
  rankSearchTimer = setTimeout(async () => {
    try {
      const res = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      PROF.rankOthers = { q, users: res.users };
      if (PROF.rankSearch.trim().toLowerCase() === q && $("#rankList")) renderRankList();
    } catch (_) {}
  }, 250);
}

// ================================================================ PROFIL

function openProfile(username, how = "push") {
  if (PROF.username !== username) { PROF.crate = null; PROF.spread = 0; }
  PROF.username = username;
  closeViewer(); closeModal(); closeDialogs();
  switchView("profile", how);
  window.scrollTo(0, 0);
}

async function renderProfile() {
  let d;
  try { d = await api(`/api/users/${encodeURIComponent(PROF.username || S.me.username)}`); } catch (e) { return toast(e.message, true); }
  PROF.data = d;
  const u = d.user, mine = d.relation === "me";
  if (!PROF.crate || !crateOf(PROF.crate)) PROF.crate = S.cfg.crateOrder[0];
  const rel = {
    me: `<button class="btn" data-act="news">📰 Co nowego</button><button class="btn" data-act="avatar">🎭 Zmień ikonę</button><button class="btn" data-act="password">🔑 Zmień hasło</button><button class="btn danger" data-act="logout">🚪 Wyloguj</button>`,
    none: `<button class="btn primary" data-act="invite">➕ Zaproś do znajomych</button>`,
    outgoing: `<button class="btn" disabled>⏳ Zaproszenie wysłane</button><button class="btn tiny" data-act="cancel">Anuluj</button>`,
    incoming: `<button class="btn sell" data-act="accept">✔ Przyjmij zaproszenie</button>`,
    friend: `<span class="friend-tag">👥 Znajomi</span><button class="btn primary" data-act="trade">🔄 Zaproponuj wymianę</button><button class="btn tiny" data-act="cancel">Usuń ze znajomych</button>`,
  }[d.relation];
  const slots = Array.from({ length: S.cfg.showcaseSize }, (_, i) => d.showcase[i]);
  $("#profileBody").innerHTML = `
    <div class="panel profile-head">
      <div class="pf-avatar${mine ? " editable" : ""}" ${mine ? 'data-act="avatar" title="Zmień ikonę"' : ""}>${avatarHTML(u, "pf-av")}</div>
      <div class="pf-info">
        <h2>${esc(u.username)} ${u.isAdmin ? '<span title="Admin">👑</span>' : ""}</h2>
        <div class="muted small">gracz od ${new Date(u.created * 1000).toLocaleDateString("pl-PL")}</div>
        <div class="pf-stats">
          <span><b>${fmt(u.value)}</b>wartość kolekcji</span>
          <span><b>${u.unique}/${Object.keys(S.cfg.people).length}</b>unikalne karty</span>
          <span><b>${u.total}</b>wszystkie karty</span>
          <span><b>${d.stats.opened}</b>otwarte skrzynki</span>
          <span><b>${d.stats.contracts}</b>kontrakty</span>
          <span><b>${d.stats.upgradesWon}/${d.stats.upgradesLost}</b>ulepszenia W/P</span>
        </div>
      </div>
      <div class="pf-actions">${rel}${!mine && S.cfg.arena && u.isAdmin ? '<button class="btn" data-act="duel" title="Arena jest na razie tylko dla adminów">⚔️ Wyzwij na pojedynek</button>' : ""}</div>
    </div>

    <div class="panel">
      <h3>🏆 Gablota</h3>
      ${mine ? '<p class="muted small">Twoje najlepsze karty na pokaz. Dodasz je przyciskiem <b>📌 Do gabloty</b> w podglądzie karty (🔍).</p>' : ""}
      <div class="showcase-grid">${slots.map(it => it
        ? `<div class="sc-slot">${profileReveal(() => cardHTML(it.person, it.variant))}</div>`
        : `<div class="sc-slot empty"><span>${mine ? "📌" : "—"}</span></div>`).join("")}</div>
    </div>

    <div class="panel">
      <div class="binder-toolbar">
        <h3 style="margin:0">📖 Klaser${mine ? "" : ` gracza ${esc(u.username)}`}</h3>
        <div class="seg" id="pfSeg">${crateList().map(c => `<button data-crate="${c.id}" class="${PROF.crate === c.id ? "active" : ""}">${esc(c.emoji)} ${esc(c.short)}</button>`).join("")}</div>
      </div>
      <div class="binder-progress" id="pfProgress"></div>
      <div class="binder-wrap">
        <button class="page-arrow" id="pfPrev">‹</button>
        <div class="binder" id="pfBinder"></div>
        <button class="page-arrow" id="pfNext">›</button>
      </div>
      <div class="page-indicator" id="pfPage"></div>
    </div>

    <div class="panel" id="pfAch"><h3>🏆 Osiągnięcia</h3></div>`;
  renderProfileBinder();
  achProfile(u.username, mine);
}

function renderProfileBinder(flip = 0) {
  const d = PROF.data;
  const owned = collectedOwned(d.collected || []);  // karty, które gracz kiedyś miał (zostają w klaserze)
  for (const c of d.collection) {
    const o = owned[c.person]?.count ? owned[c.person] : (owned[c.person] = { best: c.variant, count: 0 });
    o.count += c.count;
    if (varRank(c.variant) > varRank(o.best)) o.best = c.variant;
  }
  const b = profileReveal(() => binderHTML(crateOf(PROF.crate), owned, PROF.spread, { mine: d.relation === "me" }));
  PROF.spread = b.spread;
  $("#pfProgress").innerHTML = b.progress;
  $("#pfBinder").innerHTML = b.html;
  $("#pfPrev").disabled = PROF.spread === 0;
  $("#pfNext").disabled = PROF.spread >= b.spreads - 1;
  $("#pfPage").textContent = b.label;
  if (flip) {
    Sound.page();
    const el = $("#pfBinder");
    el.classList.remove("flip-next", "flip-prev"); void el.offsetWidth;
    el.classList.add(flip > 0 ? "flip-next" : "flip-prev");
  }
}

let avatarSort = "rarity";
function openAvatarPicker(tab = null) {
  // karty, które mam - każdy wariant osobno (np. Małysz złota, Małysz diamentowa), domyślnie od najrzadszych
  const combos = {};
  S.items.forEach(i => { if (person(i.person)) combos[`${i.person}|${i.variant}`] ||= { person: i.person, variant: i.variant, value: i.value }; });
  const mine = sortCards(Object.values(combos), avatarSort);
  tab = tab || (mine.length ? "cards" : "emoji");
  const dlg = openDialog(`
    <h3>🎭 Ikona gracza</h3>
    <div class="seg av-tabs">
      <button data-tab="cards" class="${tab === "cards" ? "active" : ""}">🃏 Z moich kart (${mine.length})</button>
      <button data-tab="emoji" class="${tab === "emoji" ? "active" : ""}">😎 Emoji</button>
    </div>
    ${tab === "cards" ? `
      <p class="muted small">Ikoną może być każda karta, którą masz — w każdym wariancie, który masz (złota, diamentowa, holo…).</p>
      <div class="tb-row"><input type="text" class="av-search" placeholder="Szukaj…">${sortSelectHTML(avatarSort, "data-avsort", UNIQUE_SORTS)}</div>
      <div class="avatar-cards">${mine.map(c => {
        const p = person(c.person), R = S.cfg.rarities[p.rarity];
        const active = c.person === S.me.avatarCard && c.variant === (S.me.avatarVariant || "normal");
        return `<button class="av-card-opt${active ? " active" : ""}${p.rarity === "secret" ? " av-secret" : ""}" data-card="${c.person}" data-variant="${c.variant}"
            data-search="${esc(cardSearchText(c.person, c.variant))}" style="--rc:${R.color}" title="${esc(p.name)} — ${variantName(c.variant)}">
          <span class="av-card ${vClass(c.variant, "avv-")}${p.rarity === "secret" ? " av-secret" : ""}" style="--rc:${R.color}"><img src="${imgUrl(c.person, null, true)}" alt="" loading="lazy" draggable="false"></span>
          <span>${esc(p.name)}</span>${isSpecial(c.variant) ? `<small class="av-vname ${vtClass(c.variant)}">${variantName(c.variant)}</small>` : ""}</button>`;
      }).join("") || '<div class="empty">Nie masz jeszcze żadnych kart — otwórz skrzynkę! 📦</div>'}</div>` : `
      <div class="avatar-grid">${AVATARS.map(a => `<button class="av-opt${!S.me.avatarCard && a === S.me.avatar ? " active" : ""}" data-av="${a}">${a}</button>`).join("")}</div>`}
    <div class="daily-actions"><button class="btn" data-close>Zamknij</button></div>`, "avatar-box");
  dlg.querySelector("[data-avsort]")?.addEventListener("change", e => { avatarSort = e.target.value; openAvatarPicker("cards"); });
  dlg.querySelector(".av-search")?.addEventListener("input", e => {
    const q = e.target.value;
    dlg.querySelectorAll(".av-card-opt").forEach(b => { b.hidden = !searchMatch(b.dataset.search, q); });
  });
  dlg.addEventListener("click", async e => {
    const t = e.target.closest("[data-tab]");
    if (t) return openAvatarPicker(t.dataset.tab);
    const card = e.target.closest("[data-card]"), emo = e.target.closest("[data-av]");
    if (!card && !emo) return;
    try {
      const res = await api("/api/profile", card ? { avatarCard: card.dataset.card, avatarVariant: card.dataset.variant } : { avatar: emo.dataset.av });
      S.me = res.user;
      renderHeader(); closeDialogs(); Sound.click();
      toast(card ? `Nowa ikona: ${person(card.dataset.card).name}${isSpecial(card.dataset.variant) ? " (" + variantName(card.dataset.variant) + ")" : ""}` : "Nowa ikona ustawiona");
      if (currentView() === "profile") renderProfile();
      if (currentView() === "friends") renderFriends();
    } catch (err) { toast(err.message, true); }
  });
}

function openPasswordDialog() {
  const dlg = openDialog(`
    <h3>🔑 Zmień hasło</h3>
    <form class="show-form" id="pwForm">
      <label>Obecne hasło<input type="password" name="old" required autocomplete="current-password"></label>
      <label>Nowe hasło<input type="password" name="new" required minlength="8" autocomplete="new-password"></label>
      <label>Powtórz nowe hasło<input type="password" name="new2" required minlength="8" autocomplete="new-password"></label>
      <div class="daily-actions"><button class="btn primary" type="submit">Zapisz</button><button class="btn" type="button" data-close>Anuluj</button></div>
    </form>`);
  dlg.querySelector("#pwForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.new !== f.new2) return toast("Nowe hasła nie są takie same", true);
    try { await api("/api/password", { old: f.old, new: f.new }); closeDialogs(); toast("Hasło zmienione 🔑"); }
    catch (err) { toast(err.message, true); }
  });
}

async function logout() {
  try { await api("/api/logout", {}); } catch (_) {}
  location.href = "/login";
}

// ================================================================ ZDARZENIA

function bindSocial() {
  $("#dailyBtn").addEventListener("click", openDaily);
  $("#userChip").addEventListener("click", () => openProfile(S.me.username));

  // klik w nazwę gracza gdziekolwiek -> profil
  document.addEventListener("click", e => {
    const u = e.target.closest("[data-user]");
    if (u && !e.target.closest(".sdialog")) { e.preventDefault(); openProfile(u.dataset.user); }
  });

  // znajomi
  $("#friendsBody").addEventListener("submit", e => {
    if (e.target.id !== "addFriend") return;
    e.preventDefault();
    const name = $("#friendName").value.trim();
    if (!name) return;
    friendAction(async () => {
      const r = await api("/api/friends/request", { username: name });
      if (r.status === "friend") toast(`Jesteście teraz znajomymi z ${name} 🎉`); else toast(`Wysłano zaproszenie do ${name} 📨`);
    });
  });
  let searchTimer = null;
  $("#friendsBody").addEventListener("input", e => {
    if (e.target.id !== "friendName") return;
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (!q) return;
      try {
        const r = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        const dl = $("#userSuggest");
        if (dl) dl.innerHTML = r.users.filter(u => u.username !== S.me.username).map(u => `<option value="${esc(u.username)}">`).join("");
      } catch (_) {}
    }, 250);
  });
  $("#friendsBody").addEventListener("click", e => {
    const t = e.target;
    const trd = t.closest("[data-trade]");
    if (trd) return openTradeBuilder(trd.dataset.trade);
    const ta = t.closest("[data-taccept]"), td = t.closest("[data-tdecline]"), tc = t.closest("[data-tcancel]");
    if (ta) { if (confirm("Przyjąć tę wymianę? Karty zostaną od razu wymienione.")) acceptTrade(ta.dataset.taccept); return; }
    if (td) return tradeAction(() => api(`/api/trades/${td.dataset.tdecline}/decline`, {}), "Odrzucono ofertę");
    if (tc) return tradeAction(() => api(`/api/trades/${tc.dataset.tcancel}/cancel`, {}), "Wycofano ofertę");
    const tlc = t.closest(".tl-card");
    if (tlc) return openViewer(tlc.dataset.pid, tlc.dataset.variant);
    const acc = t.closest("[data-accept]"), dec = t.closest("[data-decline]"), rem = t.closest("[data-remove]");
    if (acc) return friendAction(() => api("/api/friends/respond", { username: acc.dataset.accept, accept: true }), "Nowy znajomy! 🎉");
    if (dec) return friendAction(() => api("/api/friends/respond", { username: dec.dataset.decline, accept: false }));
    if (rem) {
      if (!confirm(`Usunąć ${rem.dataset.remove} ze znajomych / anulować zaproszenie?`)) return;
      return friendAction(() => api("/api/friends/remove", { username: rem.dataset.remove }));
    }
    const c = t.closest(".fi-card .card");
    if (c) {
      const f = FEED_CACHE.find(x => String(x.id) === c.closest(".fi-card").dataset.feed);
      withReveal(f || {}, () => openViewer(c.dataset.pid, c.dataset.variant));
    }
  });

  // ranking
  $("#rankingBody").addEventListener("click", e => {
    const by = e.target.closest("[data-by]"), sc = e.target.closest("[data-scope]");
    if (by) { PROF.rankBy = by.dataset.by; Sound.click(); renderRanking(); }
    if (sc) { PROF.rankScope = sc.dataset.scope; Sound.click(); renderRanking(); }
  });
  $("#rankingBody").addEventListener("input", e => {
    if (e.target.id === "rankSearch") { PROF.rankSearch = e.target.value; renderRankList(); searchOtherPlayers(); }
  });

  // profil
  $("#profileBody").addEventListener("click", e => {
    const t = e.target;
    const act = t.closest("[data-act]")?.dataset.act;
    const name = PROF.data?.user.username;
    if (act === "avatar") return openAvatarPicker();
    if (act === "trade") return openTradeBuilder(name);
    if (act === "duel") return arChallenge(name);
    if (act === "news") return api("/api/patchnotes").then(r => openPatchNotes(r.notes)).catch(err => toast(err.message, true));
    if (act === "password") return openPasswordDialog();
    if (act === "logout") return logout();
    if (act === "invite") return friendAction(() => api("/api/friends/request", { username: name }), "Wysłano zaproszenie 📨");
    if (act === "accept") return friendAction(() => api("/api/friends/respond", { username: name, accept: true }), "Nowy znajomy! 🎉");
    if (act === "cancel") {
      if (!confirm(`Usunąć ${name} ze znajomych / anulować zaproszenie?`)) return;
      return friendAction(() => api("/api/friends/remove", { username: name }));
    }
    const seg = t.closest("#pfSeg [data-crate]");
    if (seg) { PROF.crate = seg.dataset.crate; PROF.spread = 0; Sound.click(); return renderProfileBinder(); }
    if (t.closest("#pfPrev")) { PROF.spread--; return renderProfileBinder(-1); }
    if (t.closest("#pfNext")) { PROF.spread++; return renderProfileBinder(1); }
    const c = t.closest(".pocket.owned .card, .sc-slot .card");
    if (c) profileReveal(() => openViewer(c.dataset.pid, c.dataset.variant));
  });
}
