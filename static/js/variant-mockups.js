"use strict";
// Propozycje nowych wariantów (strona /variants, zakładka „Propozycje”) - makiety do wyboru, jeszcze NIE w grze.
// Każda makieta = zwykła karta + klasy vm-<wariant> vm-<wariant>-<nr> (static/css/variant-mockups.css) i ozdoby:
// bg (tło w środku karty, pod napisami), photo (na zdjęciu), deco (nad całą kartą), top (w środku karty nad nazwą),
// sub (tekst zamiast "typ · skrzynka") - vrProposalCard w variants.js. cls - klasy pożyczone z istniejącego wariantu.
// Po wyborze wygląd przechodzi do cards2.css / app.js jako prawdziwy wariant, a jego makiety stąd znikają.

const vmN = (a, b, d = 0) => rand(a, b).toFixed(d);
const vmPick = arr => arr[Math.floor(Math.random() * arr.length)];
const vmSvg = (body, vb = "0 0 63 88", cls = "", par = "none") =>
  `<svg class="${cls}" viewBox="${vb}" preserveAspectRatio="${par}" aria-hidden="true">${body}</svg>`;
// rzeczy rozrzucone po karcie (kropki, iskry, gwiazdki): losowe miejsce i opóźnienie animacji
const vmScatter = (n, cls, extra = () => "", y = [2, 96]) => Array.from({ length: n }, () =>
  `<i class="${cls}" style="left:${vmN(2, 96)}%;top:${vmN(...y)}%;animation-delay:-${vmN(0, 6, 1)}s;${extra()}"></i>`).join("");
// gwiazda pięcioramienna (środek x, y, promień r) - do flagi i ozdób
const vmStar = (x, y, r, fill) => `<path fill="${fill}" d="M${Array.from({ length: 10 }, (_, k) => {
  const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * .4 : r;
  return `${(x + Math.cos(a) * rr).toFixed(2)} ${(y + Math.sin(a) * rr).toFixed(2)}`;
}).join(" L")}Z"/>`;
// unikalne id dla filtrów / gradientów SVG (na stronie jest wiele kart naraz)
let vmIdN = 0;
const vmId = p => `${p}${++vmIdN}`;

// ---------------------------------------------------------------- PROPOZYCJE

// ---------------------------------------------------------------- KOMUNISTYCZNA (nazwa robocza) - runda 2
// Wariant wyjątkowy Skrzynki PRL (jak MLG i Halloweenowe w swoich skrzynkach): wypada tylko z niej, nie z kuźni ani kasyna.
// Wybrany z rundy 1 plakat propagandowy, rozwinięty w sześć kierunków - wszystko statyczne (bez obracających się promieni),
// jak druk z jednej-dwóch farb. Pokazane na karcie z tej skrzynki (pid). Klasy z prefiksem km-.

const kmStar = (fill = "currentColor") => vmSvg(vmStar(10, 10.6, 9.6, fill), "0 0 20 20", "", "xMidYMid meet");
// promienie z jednego punktu (x, y w % karty), co "step" stopni - statyczne
const kmRays = (x, y, a = "#ff3b30", b = "#b30e16", step = 6) =>
  `<i class="km-rays" style="--x:${x}%;--y:${y}%;--a:${a};--b:${b};--s:${step}deg"></i>`;
// sylwetka fabryki: kominy, hala z szedami, dźwig (jednostki karty 63 x 88, linia ziemi y = 60 + 7 = w pasie pod zdjęciem)
const kmFactory = (c = "#111") => vmSvg(`<g transform="translate(0 7)"><g fill="${c}">
  <path d="M0 60 V50 L5 46 V50 L10 46 V50 L15 46 V50 L20 46 V60 Z"/>
  <rect x="22" y="36" width="2.6" height="24"/><rect x="27" y="30" width="3" height="30"/><rect x="33" y="40" width="2.4" height="20"/>
  <path d="M21 60 V52 H40 V60 Z"/><path d="M40 60 V44 H50 V60 Z"/>
  <path d="M50 60 V54 H63 V60 Z"/><path d="M52 54 V34 H53.2 V54 Z M52.6 34 H63 V35.2 H52.6 Z M61 35.2 V41 H61.8 V35.2 Z"/>
  </g><g fill="${c}" opacity=".35"><circle cx="25" cy="33" r="2.4"/><circle cx="27" cy="29.5" r="3"/><circle cx="30" cy="25.5" r="3.6"/>
  <circle cx="29" cy="27" r="2.6"/><circle cx="34" cy="37.5" r="2"/><circle cx="36" cy="34.5" r="2.6"/></g></g>`, "0 0 63 88", "km-factory");

const VM_KOMUNA = {
  key: "komuna", icon: "☭", name: "Komunistyczna (nazwa robocza)", tag: "★ PRL ★", pid: "prl_bareja",
  about: "runda 2: wybrany plakat propagandowy w sześciu wersjach - wszystko statyczne, jak druk na papierze",
  looks: [
    {
      name: "Plakat z promieniami",
      desc: "Jak 1. z poprzedniej rundy, ale nieruchomy i bardziej jak druk: nieruchome czerwone promienie z dolnego rogu, czarny ukośny pas, biały margines papieru dookoła, lekkie ziarno farby, zdjęcie w czerwieni i czerni z przesuniętą farbą, złota gwiazda na rogu zdjęcia.",
      bg: () => `<div class="vm-bg">${kmRays(-8, 96)}<i class="km1-band"></i><i class="km-paper"></i></div>`,
      photo: () => '<i class="vm-photo km-ink"></i><i class="vm-photo km-offset"></i>',
      deco: () => `<div class="vm-deco"><i class="km-margin"></i><i class="km1-star">${kmStar()}</i></div>`,
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Czerwony klin",
      desc: "Konstruktywizm jak u El Lissitzky'ego: kremowy papier, czerwony klin wbija się w czarne koło w pasie pod zdjęciem, ukośne cienkie linie, nazwa czerwonymi literami na kremowym tle, czarne panele.",
      bg: () => '<div class="vm-bg"><i class="km2-paper"></i><i class="km2-circle"></i><i class="km2-wedge"></i><i class="km2-lines"></i></div>',
      photo: () => '<i class="vm-photo km2-half"></i>',
      deco: () => '<div class="vm-deco"><i class="km2-bar"></i></div>',
      sub: () => "CZERWONYM KLINEM BIJ BIAŁYCH!",
    },
    {
      name: "Hasło na całą kartę",
      desc: "Ogromne hasło „NAPRZÓD!” wydrukowane kremową farbą na czerwonym tle, przekrzywione za zdjęciem (widać je przy brzegach i pod zdjęciem), zdjęcie z rastra kropek jak w gazecie, czarne panele z kremowym tekstem.",
      bg: () => '<div class="vm-bg"><i class="km3-word a">NAPRZÓD!</i><i class="km3-word b">NAPRZÓD!</i><i class="km3-word c">NAPRZÓD!</i><i class="km-paper"></i></div>',
      photo: () => '<i class="vm-photo km-ink"></i><i class="vm-photo km3-dots"></i>',
      deco: () => '<div class="vm-deco"><i class="km-margin"></i></div>',
      sub: () => "PLAN SZEŚCIOLETNI WYKONAMY!",
    },
    {
      name: "Fabryka o świcie",
      desc: "Socrealistyczny plakat: nad fabryką z kominami i dźwigiem wschodzi słońce z nieruchomymi promieniami (żółć i czerwień), fabryka jako czarna sylwetka w pasie pod zdjęciem, dym z kominów, zdjęcie w ciepłej sepii z czerwienią.",
      bg: () => `<div class="vm-bg">${kmRays(50, 72, "#ffd24a", "#f39a1e", 7.5)}<i class="km4-sun"></i>${kmFactory("#1a0c08")}<i class="km4-ground"></i><i class="km-paper"></i></div>`,
      photo: () => '<i class="vm-photo km4-warm"></i>',
      deco: () => '<div class="vm-deco"><i class="km-margin"></i></div>',
      sub: () => "PRACA · POKÓJ · SOCJALIZM",
    },
    {
      name: "Pierwszy Maja",
      desc: "Plakat na Święto Pracy w biało-czerwonym: tło przecięte po skosie na biel i czerwień, pod zdjęciem wielki biały napis „1 MAJA” z czarnym konturem i rząd białych gwiazd, zdjęcie czarno-białe, nazwa czarna na białym pasku.",
      bg: () => `<div class="vm-bg"><i class="km5-split"></i><i class="km5-one">1 MAJA</i><i class="km5-stars">${[0, 1, 2, 3, 4].map(k => `<b style="--k:${k}">${kmStar()}</b>`).join("")}</i><i class="km-paper"></i></div>`,
      deco: () => '<div class="vm-deco"><i class="km-margin"></i></div>',
      sub: () => "1 MAJA · ŚWIĘTO PRACY",
    },
    {
      name: "Stary plakat na murze",
      desc: "Plakat z promieniami po latach na murze: wyblakłe kolory, zagięcia papieru na krzyż, plamy i przetarcia, rogi przyklejone taśmą, rysy - cały wygląd 1. wersji, ale zniszczony.",
      bg: () => `<div class="vm-bg">${kmRays(-8, 96)}<i class="km1-band"></i><i class="km-paper"></i></div>`,
      photo: () => '<i class="vm-photo km-ink"></i><i class="vm-photo km-offset"></i>',
      deco: () => `<div class="vm-deco"><i class="km-margin"></i><i class="km1-star">${kmStar()}</i><i class="km6-fold"></i><i class="km6-stain"></i>${
        ["tl", "tr", "bl", "br"].map(c => `<i class="km6-tape ${c}"></i>`).join("")}</div>`,
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
  ],
};

const VARIANT_PROPOSALS = [VM_KOMUNA];
