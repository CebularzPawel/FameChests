"use strict";
// Efekty: cząsteczki, wielkie odsłonięcie (legendarne/ultra), podgląd karty, deszcz monet.
// Korzysta z globalnych funkcji z app.js (S, $, person, cardHTML, fmt, esc...).

const RAINBOW = ["#ff3b3b", "#ff9f1a", "#ffe53b", "#3bff6b", "#3bd5ff", "#6b5bff", "#ff3bd8"];
const GOLDS = ["#ffc531", "#ffe58a", "#fff6cf", "#ffb300", "#ffffff"];
const SECRET_COLORS = ["#fff6d0", "#f3e3b0", "#ffd54a", "#ffffff", "#ffe9a8"];
const SPECIAL_COLORS = ["#19e6ff", "#ff2bd6", "#ffd54a", "#7dff6b", "#ffffff"];   // karty specjalne (Joker...)

// ================================================================ CZĄSTECZKI

function makeParticles(canvas) {
  const ctx = canvas.getContext("2d");
  const ps = [];
  let running = false, stopped = false;
  const fit = () => {
    if (canvas.width !== innerWidth || canvas.height !== innerHeight) { canvas.width = innerWidth; canvas.height = innerHeight; }
  };
  function star(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, rr = i % 2 ? r * 0.28 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
  }
  function frame() {
    if (stopped) return;
    fit();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "lighter";
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life++;
      if (p.kind === "in") {
        p.x += (p.tx - p.x) * p.k; p.y += (p.ty - p.y) * p.k;
      } else {
        p.vx *= p.drag; p.vy *= p.drag; p.vy += p.g; p.x += p.vx; p.y += p.vy;
      }
      const a = 1 - p.life / p.max;
      if (a <= 0) { ps.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, a * 1.5);
      ctx.fillStyle = p.color;
      if (p.kind === "star") {
        star(p.x, p.y, p.size * (0.6 + 0.4 * Math.sin(p.life / 4)));
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 2.2, 0, 6.283); ctx.globalAlpha *= 0.25; ctx.fill();
        ctx.globalAlpha = Math.min(1, a * 1.5);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (ps.length) requestAnimationFrame(frame);
    else { running = false; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }
  return {
    add(p) {
      if (stopped) return;
      ps.push(Object.assign({ life: 0, max: 60, size: 3, color: "#fff", vx: 0, vy: 0, g: 0, drag: 1, kind: "spark" }, p));
      if (!running) { running = true; requestAnimationFrame(frame); }
    },
    burst(x, y, n, colors, { speed = 12, g = 0.12, life = [60, 120], size = [1.5, 4], stars = 0.15 } = {}) {
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * 6.283, sp = speed * (0.25 + Math.random() * 0.9);
        this.add({
          x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, g, drag: 0.965,
          max: rand(life[0], life[1]), size: rand(size[0], size[1]),
          color: colors[i % colors.length], kind: Math.random() < stars ? "star" : "spark",
        });
      }
    },
    implode(x, y, n, colors, radius) {
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * 6.283, r = radius * rand(0.7, 1.2);
        this.add({ kind: "in", x: x + Math.cos(ang) * r, y: y + Math.sin(ang) * r, tx: x, ty: y,
                   k: rand(0.03, 0.07), max: rand(35, 60), size: rand(1.5, 3.5), color: colors[i % colors.length] });
      }
    },
    stop() { stopped = true; ps.length = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); },
  };
}

let FX = null; // globalny system cząsteczek (nad całą stroną)
function fx() { return FX ||= makeParticles($("#fxCanvas")); }

// ================================================================ REWERS KARTY

function cardBackHTML() {
  return `<div class="cback"><div class="cback-inner">
    <div class="cback-swirl"></div>
    <div class="cback-logo">🎴</div>
    <div class="cback-title">SCAM<br>BOX</div>
  </div></div>`;
}

// ================================================================ WIELKIE ODSŁONIĘCIE

function epicReveal(drop, { fast = false, auto = false } = {}) {
  if (person(drop.person).rarity === "secret") return secretReveal(drop, { fast });
  return new Promise(resolve => {
    const p = person(drop.person);
    const ultra = p.rarity === "ultra", special = p.rarity === "special";
    const title = ultra ? "ULTRA LEGENDARNA!" : special ? (baseVariant(drop.variant) === "joker" ? "🃏 JOKER!" : "SPECJALNA!") : "LEGENDARNA!";
    const colors = ultra ? RAINBOW : special ? SPECIAL_COLORS : GOLDS;
    const chargeMs = ultra ? (fast ? 1300 : 2700) : (fast ? 800 : 1700);

    const el = document.createElement("div");
    el.className = `epic ${ultra ? "ultra" : special ? "special" : "gold"}`;
    el.style.setProperty("--charge", chargeMs + "ms");
    el.innerHTML = `
      <div class="epic-bg"></div>
      <div class="epic-vortex"></div>
      <div class="epic-rays"></div>
      <canvas class="epic-canvas"></canvas>
      <div class="epic-rings"><i></i><i></i><i></i>${ultra ? "<i></i><i></i>" : ""}</div>
      <div class="epic-lightning"></div>
      <div class="epic-content">
        <div class="epic-title" data-text="${title}">${title}</div>
        <div class="epic-center">
          <div class="epic-glow"></div>
          <div class="epic-flipper">
            <div class="epic-face epic-back">${cardBackHTML()}</div>
            <div class="epic-face epic-front">${cardHTML(drop.person, drop.variant, drop.id)}</div>
          </div>
        </div>
        <div class="epic-name">${esc(p.name)}${isSpecial(drop.variant) ? ` <span class="epic-holo">✨ ${variantName(drop.variant)}</span>` : ""}<b>${fmt(drop.value)}</b></div>
        <div class="epic-hint">Kliknij lub naciśnij spację, aby kontynuować</div>
      </div>
      <div class="epic-flash"></div>`;
    document.body.appendChild(el);

    const P = makeParticles(el.querySelector(".epic-canvas"));
    const center = () => {
      const b = el.querySelector(".epic-center").getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    let phase = "charge", ambient = null, chargeLoop = null, lightning = null;

    // faza 1: ładowanie
    requestAnimationFrame(() => el.classList.add("charging"));
    Sound.charge(chargeMs / 1000, ultra);
    chargeLoop = setInterval(() => {
      const [x, y] = center();
      P.implode(x, y, ultra ? 14 : 8, colors, Math.max(innerWidth, innerHeight) * 0.5);
    }, 50);
    if (ultra) {
      lightning = setInterval(() => {
        const l = el.querySelector(".epic-lightning");
        l.style.setProperty("--lx", rand(10, 90) + "%");
        l.classList.remove("go"); void l.offsetWidth; l.classList.add("go");
      }, fast ? 260 : 420);
    }
    const burstTimer = setTimeout(burst, chargeMs);

    // faza 2: wybuch
    function burst() {
      if (phase !== "charge") return;
      phase = "burst";
      clearTimeout(burstTimer); clearInterval(chargeLoop); clearInterval(lightning);
      el.classList.remove("charging");
      el.classList.add("burst");
      Sound.boom(ultra);
      ultra ? Sound.ultra(true) : Sound.gold();
      const [x, y] = center();
      P.burst(x, y, ultra ? 420 : 240, colors, { speed: ultra ? 22 : 16, stars: 0.25 });
      if (ultra) {
        setTimeout(() => P.burst(x, y, 260, RAINBOW, { speed: 28, g: 0.05, life: [80, 160], stars: 0.4 }), 350);
        setTimeout(() => confetti(RAINBOW, 260), 500);
      } else {
        setTimeout(() => confetti(colors, special ? 200 : 140), 450);
      }
      // delikatne iskry unoszące się wokół karty
      ambient = setInterval(() => {
        const [cx, cy] = center();
        for (let i = 0; i < (ultra ? 4 : 2); i++) {
          P.add({ x: cx + rand(-220, 220), y: cy + rand(-60, 260), vx: rand(-0.4, 0.4), vy: rand(-2.5, -0.8),
                  max: rand(50, 100), size: rand(1, 2.8), color: colors[Math.floor(Math.random() * colors.length)],
                  kind: Math.random() < 0.3 ? "star" : "spark" });
        }
      }, 60);
      setTimeout(() => { if (phase === "burst") { phase = "ready"; el.classList.add("ready"); } }, fast ? 500 : 1100);
    }

    function close() {
      phase = "closing";
      clearInterval(ambient);
      window.removeEventListener("keydown", onKey, true);
      el.classList.add("closing");
      setTimeout(() => { P.stop(); el.remove(); resolve(); }, 350);
    }

    function advance() {
      if (phase === "charge") burst();
      else if (phase === "ready") close();
      else if (phase === "burst") { phase = "ready"; el.classList.add("ready"); }
    }
    function onKey(e) {
      if ([" ", "Enter", "Escape"].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); advance(); }
    }
    window.addEventListener("keydown", onKey, true);
    el.addEventListener("click", advance);
    // autootwieranie: odsłonięcie samo przechodzi dalej po chwili
    if (auto) {
      const tick = () => { if (phase !== "closing") { advance(); setTimeout(tick, fast ? 900 : 1500); } };
      setTimeout(tick, chargeMs + (fast ? 1200 : 2400));
    }
  });
}

function epicOpen() { return !!document.querySelector(".epic, .sreveal"); }

// ================================================================ PODGLĄD KARTY

// Piwna: rodzaj piwa tego egzemplarza (i jak często wypada), a w podglądzie bez egzemplarza - lista wszystkich rodzajów
function beerRow(variant, uid) {
  const subs = S.cfg.variants.beer?.subs;
  if (!subs?.length || !variantParts(variant).includes("beer")) return "";
  const sub = beerSub(variant, uid), total = subs.reduce((a, s) => a + s.weight, 0);
  return sub
    ? `<tr><td>Rodzaj piwa</td><td><b>${esc(sub.name)}</b> <span class="muted">(${Math.round(sub.weight / total * 100)}% Piwnych kart)</span></td></tr>`
    : `<tr><td>Rodzaje piwa</td><td>${subs.map(s => esc(s.name)).join(", ")}</td></tr>`;
}
// uid - numer egzemplarza (jeśli podgląd jest dla konkretnej karty gracza): od niego zależy podwariant Piwnej
function openViewer(pid, variant = "normal", uid = null) {
  closeViewer();
  const p = person(pid);
  variant = variant || "normal";
  uid = uid || null;
  const el = document.createElement("div");
  el.className = "viewer";
  const stage = `
    <div class="viewer-stage">
      <div class="viewer-flipper">
        <div class="vf vf-front">${cardHTML(pid, variant, uid)}</div>
        <div class="vf vf-back">${cardBackHTML()}</div>
      </div>
    </div>`;
  // skrzynki, z których można zdobyć tę kartę (widać tylko w podglądzie, nie na samej karcie)
  // karta specjalna: nie ze skrzynek, tylko z kasyna albo z linku od admina
  const cratesRow = isSpecialCard(p)
    ? `<tr><td>Skąd</td><td>${esc(S.cfg.specialSources[p.source] || "")}</td></tr>`
    : `<tr><td>Ze skrzynek</td><td>${(p.crates || [p.crate]).map(crateOf).filter(Boolean)
    .map(c => `${esc(c.emoji)} ${esc(c.name)}`).join("<br>")}</td></tr>`;
  if (p.masked) {
    const share = rarityShare(p.crate, "secret");
    el.innerHTML = `${stage}
      <div class="viewer-info" style="--rc:${S.cfg.rarities.secret.color}">
        <div class="vi-rarity">★ TAJNA</div>
        <h2>???</h2>
        <div class="muted">${esc(crateOf(p.crate).name)}</div>
        <p>Najrzadsza karta w tej skrzynce. Nie wiadomo, kto na niej jest — dopóki jej nie zdobędziesz.</p>
        <table class="vi-table">
          <tr><td>Szansa z 1 skrzynki</td><td>${share ? "1 na " + Math.round(1 / share).toLocaleString("pl-PL") : "—"}</td></tr>
          <tr><td>Wartość</td><td>${fmt(cardValue(p.id))}+</td></tr>
          ${cratesRow}
        </table>
        <div class="vi-actions"><button class="btn" data-act="flip">🔄 Obróć</button><button class="btn" data-act="close">✕ Zamknij</button></div>
      </div>`;
  } else {
    const R = S.cfg.rarities[p.rarity];
    const type = S.cfg.types[p.type];
    const crate = crateOf(p.crate);
    // szansa z 1 skrzynki: najlepsza ze skrzynek karty (wyjątkowe warianty tylko tam, gdzie są włączone)
    const chance = Math.max(0, ...(p.crates || [p.crate]).filter(crateOf).map(c => rarityShare(c, p.rarity) * variantChance(crateVariants(crateOf(c), p), variant, crateOf(c))));
    // warianty, w których karta może istnieć (np. Rzulty tylko JP2), osobno połączenia z flagą; plus te, które już masz
    const mine = S.items.filter(i => i.person === pid);
    const shown = new Set([...possibleVariants(p), variant, ...mine.map(i => i.variant)]);
    const chip = v => `<button class="vchip ${vtClass(v)}${v === variant ? " active" : ""}" data-var="${v}">${isCombo(v) ? "+ " + variantName(baseVariant(v)) : variantName(v)}</button>`;
    const combos = S.cfg.variantOrder.filter(v => shown.has(v) && isCombo(v));
    const layers = [...new Set(combos.map(v => variantParts(v)[0]))];   // osobny wiersz dla każdej warstwy (flaga, Halloween)
    const owned = S.cfg.variantOrder.filter(v => mine.some(i => i.variant === v))
      .map(v => `${variantName(v)} ×${mine.filter(i => i.variant === v).length}`).join(", ");
    el.innerHTML = `${stage}
      <div class="viewer-info" style="--rc:${R.color}">
        <div class="vi-rarity">${R.name}${isSpecial(variant) ? ` · <span class="holo-txt">${variantName(variant)}</span>` : ""}</div>
        <h2>${esc(p.name)}</h2>
        <div class="muted">${type.icon} ${type.name} · ${esc(crate.name)} · nr ${String(p.number).padStart(3, "0")}/${String(crate.people.length).padStart(3, "0")}</div>
        ${p.subtitle ? `<div class="vi-subtitle">${esc(p.subtitle)}</div>` : ""}
        ${p.desc ? `<p class="vi-desc">${esc(p.desc)}</p>` : ""}
        <table class="vi-table">
          <tr><td>HP</td><td>${p.hp}</td></tr>
          ${abilitiesOf(p).map((a, i, all) => `<tr><td>${a.kind !== "off" ? kindIcon(a.kind) + " " : ""}${KIND_LABELS[a.kind] || "Atak"}${all.length > 1 ? " " + (i + 1) : ""}</td><td>${esc(a.name)} <b>${a.value}</b></td></tr>`).join("")}
          <tr><td>Słabość / odporność</td><td>${S.cfg.types[type.weak].icon} ×2 · ${S.cfg.types[type.resist].icon} −20</td></tr>
          <tr><td>Wartość</td><td><b>${fmt(cardValue(pid, variant))}</b> <span class="muted">(×${String(S.cfg.variants[variant].mult).replace(".", ",")})</span></td></tr>
          ${beerRow(variant, uid)}
          ${isSpecialCard(p) ? `<tr><td>Karta specjalna</td><td>tylko w wariancie ${esc(variantName(p.fixedVariant))} · nie da się jej sprzedać grze, postawić ani zużyć</td></tr>`
            : `<tr><td>Szansa z 1 skrzynki</td><td>${chance ? "1 na " + Math.round(1 / chance).toLocaleString("pl-PL") : "—"}</td></tr>`}
          ${cratesRow}
          <tr><td>Posiadasz</td><td>${owned || '<span class="muted">brak</span>'}</td></tr>
        </table>
        <div class="vi-variants">${S.cfg.variantOrder.filter(v => shown.has(v) && !isCombo(v)).map(chip).join("")}</div>
        ${layers.map(l => `<div class="vi-variants vi-combos"><span class="vi-combo-lbl">${LAYER_ICONS[l] || "✨"} ${variantName(l)} +</span>${
          combos.filter(v => variantParts(v)[0] === l).map(chip).join("")}</div>`).join("")}
        <div class="vi-actions">
          <button class="btn" data-act="flip">🔄 Obróć</button>
          <button class="btn" data-act="close">✕ Zamknij</button>
        </div>
        ${myItemFor(pid, variant) ? `<div class="vi-actions vi-social">
          <button class="btn primary" data-act="share">📣 Pokaż znajomym</button>
          <button class="btn" data-act="pin">${showcaseHas(pid, variant) ? "📌 Zdejmij z gabloty" : "📌 Do gabloty"}</button>
        </div>` : ""}
        <div class="muted small">Porusz kursorem nad kartą, aby ją przechylić. Kliknij kartę, aby ją obrócić.</div>
      </div>`;
  }
  document.body.appendChild(el);
  Sound.whoosh();

  el.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const v = e.target.closest("[data-var]")?.dataset.var;
    if (act === "close" || e.target === el) return closeViewer();
    if (v) return openViewer(pid, v, v === variant ? uid : null);
    if (act === "share") return openShowDialog(pid, variant);
    if (act === "pin") return toggleShowcase(pid, variant).then(() => openViewer(pid, variant, uid));
    if (act === "flip" || e.target.closest(".viewer-flipper")) {
      el.querySelector(".viewer-flipper").classList.toggle("flipped");
      Sound.page();
    }
  });
}

function closeViewer() { document.querySelector(".viewer")?.remove(); }
function viewerOpen() { return !!document.querySelector(".viewer"); }

// ================================================================ DESZCZ MONET

function coinRain(n) {
  const cv = $("#confetti");
  cv.width = innerWidth; cv.height = innerHeight;
  for (let i = 0; i < n; i++) {
    confettiState.parts.push({
      shape: "coin", x: rand(0, cv.width), y: rand(-cv.height * 0.6, -20),
      vx: rand(-1, 1), vy: rand(2, 7), w: rand(16, 26), h: 0, rot: 0, vr: 0,
      c: "#ffc531", life: rand(0, 30),
    });
  }
  if (!confettiState.running) { confettiState.running = true; requestAnimationFrame(confettiFrame); }
}

// ================================================================ ODSŁONIĘCIE TAJNEJ KARTY

function starPoints(cx, cy, R, r, n) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + i * Math.PI / n, rr = i % 2 ? r : R;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return pts.join(" ");
}

function secretReveal(drop, { fast = false } = {}) {
  return new Promise(resolve => {
    const p = person(drop.person);
    const T = fast ? { sigil: 900, crack: 800, ready: 1500 } : { sigil: 2000, crack: 1700, ready: 3400 };
    const title = "★ TAJNA KARTA ★";
    const el = document.createElement("div");
    el.className = "sreveal";
    el.style.setProperty("--k", fast ? 0.45 : 1);
    el.style.setProperty("--sig", T.sigil + "ms");
    el.innerHTML = `
      <div class="sr-stars s1"></div><div class="sr-stars s2"></div>
      <div class="sr-beam"></div>
      <canvas class="sr-canvas"></canvas>
      <div class="sr-sigil">
        <svg viewBox="0 0 200 200">
          <circle class="sr-line" cx="100" cy="100" r="94"/>
          <circle class="sr-line thin" cx="100" cy="100" r="84"/>
          <polygon class="sr-line" points="${starPoints(100, 100, 80, 32, 5)}"/>
          <polygon class="sr-line thin" points="${starPoints(100, 100, 80, 32, 5)}" transform="rotate(36 100 100)"/>
          ${Array.from({ length: 24 }, (_, i) => `<line class="sr-line thin" x1="100" y1="2" x2="100" y2="${i % 2 ? 8 : 14}" transform="rotate(${i * 15} 100 100)"/>`).join("")}
          <circle class="sr-core" cx="100" cy="100" r="10"/>
        </svg>
      </div>
      <div class="sr-cracks">${Array.from({ length: 16 }, (_, i) =>
        `<i style="--a:${(i * 22.5 + rand(-8, 8)).toFixed(1)}deg; --l:${rand(35, 70).toFixed(0)}vmax; --d:${rand(0, 0.6).toFixed(2)}s"></i>`).join("")}</div>
      <div class="sr-content">
        <div class="sr-title">${[...title].map((ch, i) => `<span style="--i:${i}">${ch === " " ? "&nbsp;" : ch}</span>`).join("")}</div>
        <div class="sr-card"><div class="sr-halo"></div>${cardHTML(drop.person, drop.variant, drop.id)}</div>
        <div class="sr-name">${esc(p.name)}</div>
        <div class="sr-sub">${isSpecial(drop.variant) ? `<span class="holo-txt">✨ ${variantName(drop.variant)}</span> · ` : ""}<b>${fmt(drop.value)}</b></div>
        <div class="sr-hint">Kliknij lub naciśnij spację, aby kontynuować</div>
      </div>
      <div class="sr-flash"></div>`;
    document.body.appendChild(el);
    const P = makeParticles(el.querySelector(".sr-canvas"));
    let phase = "sigil", timers = [], loop = null;
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const cx = () => innerWidth / 2, cy = () => innerHeight / 2;

    // faza 1: ciemność, rysuje się złota pieczęć, bije serce
    requestAnimationFrame(() => el.classList.add("p-sigil"));
    Sound.drone(T.sigil + T.crack);
    later(crack, T.sigil);

    // faza 2: pieczęć wiruje, z jej środka wystrzeliwują pęknięcia światła
    function crack() {
      if (phase !== "sigil") return;
      phase = "crack";
      el.classList.add("p-crack");
      Sound.charge(T.crack / 1000, true);
      loop = setInterval(() => P.implode(cx(), cy(), 10, SECRET_COLORS, Math.max(innerWidth, innerHeight) * 0.55), 40);
      later(reveal, T.crack);
    }

    // faza 3: biały błysk, promień z nieba, karta zstępuje, litery tytułu spadają jedna po drugiej
    function reveal() {
      if (phase === "reveal" || phase === "ready" || phase === "closing") return;
      timers.forEach(clearTimeout); timers = [];
      clearInterval(loop);
      phase = "reveal";
      el.classList.remove("p-sigil", "p-crack");
      el.classList.add("p-reveal");
      Sound.boom(true);
      Sound.choir();
      P.burst(cx(), cy(), 420, SECRET_COLORS, { speed: 24, g: 0.06, life: [90, 170], stars: 0.45 });
      later(() => P.burst(cx(), cy() * 0.8, 200, SECRET_COLORS, { speed: 14, g: -0.02, life: [120, 200], stars: 0.6 }), 600 * (fast ? 0.45 : 1));
      later(() => confetti(SECRET_COLORS, 220), 900 * (fast ? 0.45 : 1));
      loop = setInterval(() => {
        // złoty pył opadający z promienia
        P.add({ x: cx() + rand(-160, 160), y: rand(-20, innerHeight * 0.3), vx: rand(-0.3, 0.3), vy: rand(0.6, 1.8),
                max: rand(90, 160), size: rand(1, 2.6), color: SECRET_COLORS[Math.floor(Math.random() * SECRET_COLORS.length)],
                kind: Math.random() < 0.35 ? "star" : "spark" });
      }, 45);
      later(() => { if (phase === "reveal") { phase = "ready"; el.classList.add("ready"); } }, T.ready);
    }

    function close() {
      phase = "closing";
      timers.forEach(clearTimeout); clearInterval(loop);
      window.removeEventListener("keydown", onKey, true);
      el.classList.add("closing");
      setTimeout(() => { P.stop(); el.remove(); resolve(); }, 450);
    }
    function advance() {
      if (phase === "sigil" || phase === "crack") reveal();
      else if (phase === "reveal") { phase = "ready"; el.classList.add("ready"); }
      else if (phase === "ready") close();
    }
    function onKey(e) {
      if ([" ", "Enter", "Escape"].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); advance(); }
    }
    window.addEventListener("keydown", onKey, true);
    el.addEventListener("click", advance);
  });
}
