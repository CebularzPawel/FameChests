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

// ---------------------------------------------------------------- KOMUNISTYCZNA (nazwa robocza) - runda 1
// Wariant wyjątkowy Skrzynki PRL (jak MLG i Halloweenowe w swoich skrzynkach): wypada tylko z niej, nie z kuźni ani kasyna.
// Sześć pomysłów na wygląd z życia w PRL. Pokazane na karcie z tej skrzynki (pid). Klasy z prefiksem km-.

const kmStar = (fill = "currentColor") => vmSvg(vmStar(10, 10.6, 9.6, fill), "0 0 20 20", "", "xMidYMid meet");
// kratki kartki żywnościowej: nazwa towaru i miesiąc; część kratek już wycięta (wykorzystana)
const KM_GOODS = ["MIĘSO", "CUKIER", "MASŁO", "MĄKA", "WÓDKA", "CZEKOL.", "BENZYNA", "MYDŁO", "KAWA", "RYŻ", "OBUWIE", "MIĘSO"];
const kmCoupons = () => Array.from({ length: 24 }, (_, k) => {
  const cut = Math.random() < .3;
  return `<em class="${cut ? "cut" : ""}"><small>${["VII", "VIII", "IX"][k % 3]}</small>${KM_GOODS[k % KM_GOODS.length]}<small>${vmPick(["1 kg", "0,5 kg", "2,5 kg", "1 szt.", "0,5 l", "10 l"])}</small></em>`;
}).join("");

const VM_KOMUNA = {
  key: "komuna", icon: "☭", name: "Komunistyczna (nazwa robocza)", tag: "★ PRL ★", pid: "prl_bareja",
  about: "wariant wyjątkowy Skrzynki PRL (jak MLG i Halloweenowe) - sześć pomysłów na wygląd z życia w PRL",
  looks: [
    {
      name: "Plakat propagandowy",
      desc: "Konstruktywistyczny plakat: z rogu karty powoli obracają się czerwone promienie, przez tło idzie czarny ukośny pas, zdjęcie w czerwieni i czerni jak druk z jednej matrycy, nazwa na czarnym pasku, złota gwiazda w rogu.",
      bg: () => '<div class="vm-bg"><i class="km1-rays"></i><i class="km1-band"></i></div>',
      photo: () => '<i class="vm-photo km1-ink"></i>',
      deco: () => `<div class="vm-deco"><i class="km1-frame"></i><i class="km1-star">${kmStar()}</i></div>`,
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Kartki na żywność",
      desc: "Karta jak kartka zaopatrzenia z 1981 r.: szary papier z kratkami (mięso, cukier, wódka…), część kratek już wycięta, brzegi z perforacją, na zdjęciu fioletowa pieczątka „WYKORZYSTANO”, zdjęcie w sepii.",
      top: () => '<div class="km2-top">KARTA ZAOPATRZENIA · M-I</div>',
      bg: () => `<div class="vm-bg"><div class="km2-grid">${kmCoupons()}</div></div>`,
      photo: () => '<i class="vm-photo km2-stamp"><b>WYKORZYSTANO</b><small>WRZ 1981</small></i>',
      deco: () => '<div class="vm-deco"><i class="km2-perf"></i></div>',
      sub: () => "KARTKA ŻYWNOŚCIOWA · IX 1981",
    },
    {
      name: "Legitymacja partyjna",
      desc: "Okładka legitymacji z czerwonej skóry: tłoczone złote ramki, napis „LEGITYMACJA CZŁONKOWSKA” nad nazwą, wypukła pieczęć w rogu zdjęcia, przez złocenia co chwilę przechodzi połysk.",
      top: () => '<div class="km3-top">★ LEGITYMACJA CZŁONKOWSKA ★</div>',
      bg: () => '<div class="vm-bg"><i class="km3-leather"></i><i class="km3-emboss"></i><i class="km3-sheen"></i></div>',
      photo: () => `<i class="vm-photo km3-seal"><b>${kmStar("#e8c870")}</b></i>`,
      sub: () => "Nr 2137 · ważna do odwołania",
    },
    {
      name: "Mozaika na bloku",
      desc: "Socrealistyczna mozaika ze ściany bloku z wielkiej płyty: tło z małych płytek (czerwień, ochra, błękit) z wielką gwiazdą, zdjęcie poprzecinane fugami jak z płytek, ramka z betonu.",
      bg: () => `<div class="vm-bg"><i class="km4-tiles"></i><i class="km4-star">${kmStar()}</i><i class="km4-grout"></i></div>`,
      photo: () => '<i class="vm-photo km4-grid"></i>',
      deco: () => '<div class="vm-deco"><i class="km4-concrete"></i></div>',
      sub: () => "BUDUJEMY SOCJALIZM · OSIEDLE 1974",
    },
    {
      name: "Dziennik Telewizyjny",
      desc: "Karta jak telewizor z lat 70.: obudowa z fornirowanego drewna, zdjęcie na wypukłym ekranie z liniami obrazu i migotaniem, nad nazwą panel z napisem „DZIENNIK TELEWIZYJNY 19:30” i gałkami.",
      top: () => '<div class="km5-top"><span><i></i>DZIENNIK TELEWIZYJNY · 19:30</span><span class="km5-knobs"><b></b><b></b></span></div>',
      bg: () => '<div class="vm-bg"><i class="km5-wood"></i></div>',
      photo: () => '<i class="vm-photo km5-scan"></i><i class="vm-photo km5-glass"></i>',
      sub: () => "PROGRAM I · TVP",
    },
    {
      name: "Czerwony sztandar",
      desc: "Pod zdjęciem przez całą kartę powiewa czerwony sztandar ze złotymi frędzlami (fale przesuwają się po materiale), tło jak wieczorne niebo nad pochodem, złota ramka, w rogu zdjęcia order na biało-czerwonej wstążce.",
      bg: () => '<div class="vm-bg"><i class="km6-sky"></i><i class="km6-flag"><i class="km6-ripple"></i></i><i class="km6-fringe"></i></div>',
      deco: () => `<div class="vm-deco"><i class="km6-medal"><b class="rib"></b><b class="disc">${kmStar("#c8102e")}</b></i></div>`,
      sub: () => "ORDER SZTANDARU PRACY I KLASY",
    },
  ],
};

const VARIANT_PROPOSALS = [VM_KOMUNA];
