"use strict";
// Quest dnia (routes/quests.rs): wspólny cel dla wszystkich graczy, widoczny nad sklepem. Stan przychodzi z /api/me
// (S.quest; null = questy wyłączone). Kto pierwszy, dostaje tę kartę w wariancie Wanted i jej wartość w groszach.

function questTarget(q) {
  return q.person ? `kartę <b>${esc(person(q.person).name)}</b>` : `dowolną kartę w wariancie <b>${esc(variantName(q.variant))}</b>`;
}

function renderQuest() {
  const box = $("#questBox");
  if (!box) return;
  const q = S.quest;
  box.hidden = !q;
  if (!q) return;
  const who = q.wonPerson || q.person;
  const reward = q.done ? q.money : q.reward;
  const state = !q.done ? ""
    : q.mine ? `<span class="pos-txt">🏆 Quest jest twój!<br>+${fmt(q.money)}</span>`
    : `<span class="muted">Quest przepadł. Wygrana: ${esc(q.winner || "?")}</span>`;
  box.innerHTML = `<div class="quest-box${q.done ? " done" : ""}${q.mine ? " mine" : ""}">
    <div class="q-thumb">${who ? `<img src="${person(who).masked ? `/img/${who}` : imgUrl(who, null, true)}" alt="">` : "🎯"}</div>
    <div class="q-body">
      <b class="q-title">🎯 Quest dnia</b>
      <p>Zdobądź ${questTarget(q)}. Kto pierwszy, ten wygrywa, dla reszty zadanie przepada.</p>
      <small>Nagroda: ta karta w wariancie ${esc(variantName("wanted"))}${reward ? ` + ${fmt(reward)}` : " + jej wartość w groszach"}. Liczą się karty ze skrzynek, kuźni, ulepszacza i kasyna, nie z rynku ani wymian.</small>
    </div>
    ${state ? `<div class="q-state">${state}</div>` : ""}
  </div>`;
}

// stan z /api/me; wygrana questa pokazuje się raz (także gdy karta wypadła w innej zakładce)
function noteQuest(q) {
  const was = JSON.stringify(S.quest ?? null), now = JSON.stringify(q ?? null);
  S.quest = q || null;
  if (was !== now) renderQuest();
  if (!q?.mine) return;
  const key = `questWon:${q.day}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (_) {}
  toast(`🎯 Quest dnia wypełniony! ${person(q.wonPerson).name} w wariancie ${variantName("wanted")} i +${fmt(q.money)} są twoje`);
  Sound.win();
  confetti(["#ffcf3f", "#fff", "#c8402a"], 160);
}
