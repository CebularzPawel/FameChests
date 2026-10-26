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

async function achProfile(username, mine) {
  const box = $("#pfAch");
  if (!box) return;
  let d;
  try { d = await api(`/api/users/${encodeURIComponent(username)}/achievements`); } catch (_) { return; }
  if (!$("#pfAch")) return;
  const got = d.list.filter(a => a.earned).length;
  if (!d.list.length) { box.innerHTML = `<h3>🏆 Osiągnięcia</h3><p class="muted">${mine ? "Brak osiągnięć w grze." : "Ten gracz nie ma jeszcze osiągnięć."}</p>`; return; }
  const sorted = d.list.slice().sort((a, b) => b.earned - a.earned || a.hidden - b.hidden);
  box.innerHTML = `<h3>🏆 Osiągnięcia ${mine ? `<small class="muted">${got} / ${d.list.length}</small>` : `<small class="muted">${got}</small>`}</h3>
    <div class="ach-grid">${sorted.map(achTile).join("")}</div>`;
}
