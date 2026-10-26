"use strict";
// Osiągnięcia (gracz): powiadomienie wysuwane z boku (achPoll - serwer dopisuje nagłówek X-Ach, gdy gracz coś zdobył)
// i panel "🏆 Osiągnięcia" na profilu (achProfile, wołane z renderProfile w social.js). Warunki liczy serwer (achievements.py).

const ACH = { queue: [], showing: 0, polling: false };

async function achPoll() {
  if (ACH.polling) return;
  ACH.polling = true;
  try {
    const d = await api("/api/achievements/pop", {});
    d.list.forEach(a => ACH.queue.push(a));
    achPump();
    if (d.list.length) achResync(0);
  } catch (_) { /* powiadomienie to dodatek - błąd nie przeszkadza w grze */ }
  ACH.polling = false;
}

// nagrody (pieniądze, karty) wpadają po odpowiedzi serwera - odświeżamy ekwipunek, gdy przeglądarka nie jest zajęta
async function achResync(n) {
  if (n > 6) return;
  const before = S.mutations;
  await syncInventory(null, true);
  if (S.inflight > 0 || S.opening) setTimeout(() => achResync(n + 1), 2500);
  else if (before === S.mutations && n < 1) setTimeout(() => achResync(n + 1), 1200);
}

function achPump() {
  while (ACH.queue.length && ACH.showing < 3) achPopup(ACH.queue.shift());
}

function achPopup(a) {
  let host = $("#achToasts");
  if (!host) { host = document.createElement("div"); host.id = "achToasts"; document.body.appendChild(host); }
  const el = document.createElement("div");
  el.className = "ach-popup";
  el.innerHTML = `<div class="ach-pic">${esc(a.icon)}</div><div class="ach-txt">
      <small>🏆 OSIĄGNIĘCIE ZDOBYTE</small><b>${esc(a.name)}</b><span>${esc(a.desc)}</span>
      ${a.rewards.length ? `<em>🎁 ${a.rewards.map(esc).join(" · ")}</em>` : ""}</div>`;
  host.appendChild(el);
  ACH.showing++;
  try { Sound.reveal("gold"); } catch (_) {}
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  const close = () => {
    el.classList.remove("in"); el.classList.add("out");
    setTimeout(() => { el.remove(); ACH.showing--; achPump(); }, 500);
  };
  setTimeout(close, 6000);
  el.addEventListener("click", close);
}

// ---------------------------------------------------------------- profil

function achTile(a) {
  const pr = a.progress || [];
  const bars = !a.earned && pr.length ? pr.map(p => `<div class="ach-bar" title="${p.cur} / ${p.need}"><i style="width:${Math.round(p.cur / p.need * 100)}%"></i><span>${p.cur} / ${p.need}</span></div>`).join("") : "";
  return `<div class="ach-tile${a.earned ? " got" : ""}${a.hidden && !a.earned ? " secret" : ""}">
    <div class="ach-pic">${a.hidden && !a.earned ? "❓" : esc(a.icon)}</div>
    <div class="ach-txt"><b>${esc(a.name)}</b><span>${esc(a.desc)}</span>${bars}
      ${a.rewards?.length ? `<em>🎁 ${a.rewards.map(esc).join(" · ")}</em>` : ""}
      ${a.earned ? `<small>✔ ${new Date(a.at * 1000).toLocaleDateString("pl-PL")}</small>` : ""}</div></div>`;
}

// dwie zakładki: zwykłe i ukryte (ukryte niezdobyte to "???")
async function achProfile(username, mine) {
  const box = $("#pfAch");
  if (!box) return;
  let d;
  try { d = await api(`/api/users/${encodeURIComponent(username)}/achievements`); } catch (_) { return; }
  if (!$("#pfAch")) return;
  ACH.prof = { list: d.list, mine };
  achProfileDraw();
}

function achProfileDraw() {
  const box = $("#pfAch"), P = ACH.prof;
  if (!box || !P) return;
  const tab = ACH.tab || "normal";
  const groups = { normal: P.list.filter(a => !a.hidden), hidden: P.list.filter(a => a.hidden) };
  const count = l => `${l.filter(a => a.earned).length}${P.mine ? " / " + l.length : ""}`;
  const list = groups[tab].slice().sort((a, b) => b.earned - a.earned);
  box.innerHTML = `<div class="ach-head"><h3>🏆 Osiągnięcia</h3>
      <div class="seg ach-tabs">
        <button data-achtab="normal" class="${tab === "normal" ? "active" : ""}">🏆 Zwykłe <small>${count(groups.normal)}</small></button>
        <button data-achtab="hidden" class="${tab === "hidden" ? "active" : ""}">🕵️ Ukryte <small>${count(groups.hidden)}</small></button>
      </div></div>
    ${list.length ? `<div class="ach-grid">${list.map(achTile).join("")}</div>`
      : `<p class="muted">${tab === "hidden" ? (P.mine ? "Brak ukrytych osiągnięć." : "Ten gracz nie odkrył jeszcze żadnego ukrytego osiągnięcia.")
        : (P.mine ? "Brak osiągnięć w grze." : "Ten gracz nie ma jeszcze osiągnięć.")}</p>`}`;
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-achtab]");
  if (!b) return;
  ACH.tab = b.dataset.achtab;
  Sound.click();
  achProfileDraw();
});
