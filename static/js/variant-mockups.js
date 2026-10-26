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

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza) - runda 6
// Wybrana makieta 5. z rundy 5: w tle prawdziwy film z Apollo 11 (lądownik Orzeł po odłączeniu dryfuje nad kraterami),
// złoto-srebrna klisza (srebrne zdjęcie osoby, złotawa scena, złote smugi, ziarno, migotanie, rysy, winieta). Film i filtr
// zostają - makiety różnią się samym wyglądem karty: ramką, napisami, panelami i ozdobami. Klasy z prefiksem ap-.

// film: „HQ-194, Eagle Has Landed: The Flight of Apollo 11” (images.nasa.gov, domena publiczna), wycinek od 1355 s,
// wersja ~mobile, cicha pętla 10 s
const AP_FILM = "lm-orbit";
const apScratches = n => vmScatter(n, "ap-scratch", () => `animation-duration:${vmN(1.2, 3, 1)}s`, [0, 0]);
// filtr całej karty: złote smugi, ziarno, migotanie projektora, rysy, winieta
const apFilm = (extra = "") => `<div class="vm-deco ap-clip"><i class="ap-gs"></i><i class="ap-grain"></i><i class="ap-flicker"></i>${apScratches(2)}${extra}<i class="ap-vignette"></i></div>`;
// tło: film + przyciemnienie u góry (pod nazwą) i na dole (pod zdolnościami); extra - nad filmem, pod napisami
const apScene = (extra = "") => `<div class="vm-bg ap-scene"><video class="ap-film" src="/static/video/space/${AP_FILM}.mp4" autoplay muted loop playsinline preload="auto" disablepictureinpicture></video>${extra}<i class="ap-shade"></i></div>`;
// licznik taśmy w rogu zdjęcia
const apReel = () => '<div class="vm-deco"><span class="ap-rec"><i></i>16 mm</span></div>';
// cyfra, która sama odlicza 0-9 (pionowy pasek cyfr przesuwany co sekundę)
const apTick = () => '<span class="ap-tick"><i>0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9</i></span>';
// naszywka misji w rogu zdjęcia: napis dookoła, Księżyc nad horyzontem i gwiazda
function apPatch() {
  const id = vmId("apP");
  return vmSvg(`<defs><path id="${id}" d="M20 20 m-14.6 0 a14.6 14.6 0 1 1 29.2 0 a14.6 14.6 0 1 1 -29.2 0"/>
    <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1c1"/><stop offset=".45" stop-color="#c9952c"/><stop offset=".55" stop-color="#e8ecf2"/><stop offset="1" stop-color="#8a909a"/></linearGradient></defs>
    <circle cx="20" cy="20" r="19" fill="#0b0d14" stroke="url(#${id}g)" stroke-width="1.6"/><circle cx="20" cy="20" r="11.4" fill="#141824" stroke="#c8ccd4" stroke-width=".5"/>
    <text font-family="Orbitron, sans-serif" font-weight="900" font-size="3.9" letter-spacing=".7" fill="url(#${id}g)"><textPath href="#${id}">APOLLO · ORZEŁ · 1969 ·</textPath></text>
    <path d="M9.6 25 Q20 20.5 30.4 25 L29 28.5 Q20 33 11 28.5 Z" fill="#8a909a"/><circle cx="23.5" cy="15.2" r="3.4" fill="#e8ecf2"/><circle cx="24.7" cy="14.4" r="3" fill="#141824"/>
    ${vmStar(15.2, 16, 2.3, "#f2d27a")}`, "0 0 40 40", "", "xMidYMid meet");
}

const VM_APOLLO = {
  key: "apollo", icon: "🚀", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "runda 6: film z Apollo 11 i złoto-srebrna klisza bez zmian - cztery wersje wyglądu karty (ramka, napisy, panele, ozdoby)",
  looks: [
    {
      name: "Klisza (obecna)",
      desc: "Obecny wygląd: złoto-srebrna ramka, nazwa w złoto-srebrnym gradiencie, półprzezroczyste czarne panele, licznik taśmy „16 mm” w rogu zdjęcia.",
      bg: () => apScene(),
      deco: () => apFilm() + apReel(),
      sub: () => "ORZEŁ ODŁĄCZA SIĘ · 20.07.1969",
    },
    {
      name: "Kontrola misji",
      desc: "Jak ekran w centrum kontroli lotu: nad nazwą pasek z zegarem misji (sekundy same odliczają), na zdjęciu krzyżyki pomiarowe jak na kliszach Hasselblada z Księżyca i złote narożniki kadru, w pasie filmu odczyty wysokości i prędkości. Ramka z cienkich złotych i srebrnych linii, napisy maszynowe.",
      top: () => `<div class="ap2-bar"><span>CAPCOM · HOUSTON</span><span class="ap2-met">MET 102:45:4${apTick()}</span></div>`,
      bg: () => apScene('<span class="ap2-tm l">ALT 47 920 FT<br>VEL 1 604 FT/S</span><span class="ap2-tm r">ORZEŁ ▲<br>KOLUMBIA ▼</span>'),
      photo: () => '<i class="vm-photo ap2-reseau"></i><i class="vm-photo ap2-corners"></i>',
      deco: () => apFilm() + '<div class="vm-deco"><i class="ap2-lines"></i></div>',
      sub: () => "▲ ORZEŁ ODŁĄCZA SIĘ · 20.07.1969",
    },
    {
      name: "Naszywka misji",
      desc: "Jak plakat misji z lat 60.: nazwa wielkimi złotymi literami, w rogu zdjęcia okrągła naszywka misji (napis dookoła, Księżyc, gwiazda), podpis na złoto-srebrnej wstędze z wciętymi końcami, ramka złota z cienkim srebrnym paskiem w środku, w rogach karty migoczące gwiazdki.",
      bg: () => apScene(),
      photo: () => `<i class="vm-photo ap3-patch">${apPatch()}</i>`,
      deco: () => apFilm() + `<div class="vm-deco">${["tl", "tr", "bl", "br"].map(c => `<i class="ap3-star ${c}"></i>`).join("")}</div>`,
      sub: () => "ORZEŁ ODŁĄCZA SIĘ · 20.07.1969",
    },
    {
      name: "Panel przyrządów",
      desc: "Jak kabina lądownika: ramka z pogniecionej złotej folii (u dołu srebrnej), zdjęcie w metalowej oprawie z czterema śrubami, panele jak czarne płyty przyrządów ze śrubami w rogach, nad nazwą przyciski ABORT / ABORT STAGE w obwódkach w paski, podpis wygrawerowany na tabliczce.",
      top: () => '<div class="ap4-btns"><b>ABORT</b><b>ABORT STAGE</b><i class="ap4-led"></i><span>PGNS · AGS</span></div>',
      bg: () => apScene(),
      photo: () => `<i class="vm-photo ap4-bezel">${["tl", "tr", "bl", "br"].map(c => `<i class="ap4-screw ${c}"></i>`).join("")}</i>`,
      deco: () => apFilm(),
      sub: () => "ORZEŁ ODŁĄCZA SIĘ · 20.07.1969",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_APOLLO];
