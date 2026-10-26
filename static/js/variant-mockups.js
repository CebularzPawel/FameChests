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

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza) - runda 5
// Wybrane z rundy 4: Wschód Ziemi, Orzeł nad Księżycem i Start Saturna V - teraz w złoto-srebrnej kliszy (złote i srebrne
// pasy światła na zmianę zamiast samego złota). Część makiet zostaje ze zdjęciami z misji, część ma w tle prawdziwy film
// z tamtych lat (krótkie ciche pętle w static/video/space/, wycięte z filmów z archiwum NASA - domena publiczna).
// Klasy z prefiksem ap-.

const AP_PHOTOS = {
  earthrise: "earthrise.jpg",    // as08-14-2383 - Apollo 8, 24.12.1968, „Wschód Ziemi”
  eagle: "eagle-earth.jpg",      // as11-44-6642 - Apollo 11, lądownik Eagle nad Księżycem, w tle Ziemia
  saturn: "saturn-v.jpg",        // 6900556 - start Apollo 11, Saturn V w locie, 16.07.1969
};
// filmy (images.nasa.gov, wersja ~mobile; w nawiasie sekunda początku wycinka)
const AP_FILMS = {
  saturnClimb: "saturn-climb",   // „Ultimate Saturn V Launch w Enhanced Sound” (146,4 s) - Saturn V po skosie na ciemnym niebie
  saturnSky: "saturn-sky",       // jw. (157,6 s) - Saturn V w błękicie
  lmOrbit: "lm-orbit",           // „HQ-194, Eagle Has Landed: The Flight of Apollo 11” (1355 s) - lądownik nad Księżycem
  moonOrbit: "moon-orbit",       // jw. (1298 s) - przelot nad kraterami
  descent: "lm-descent",         // jw. (739 s) - lądowanie, widok z okna lądownika
  eva: "gemini-eva",             // „HD 049 Mercury Gemini Apollo Resource Reel 1” (2513,3 s) - Gemini 4, spacer Eda White'a
  earth: "gemini-earth",         // jw. (2522,4 s) - Ziemia z okna Gemini
  apollo9: "apollo9-lm",         // jw. (3416 s) - Apollo 9, lądownik nad Ziemią
};
const apPhoto = (k, cls = "") => `<img class="ap-ph ${cls}" src="/static/img/space/${AP_PHOTOS[k]}" alt="" draggable="false" loading="lazy">`;
const apVideo = (k, cls = "") => `<video class="ap-film ${cls}" src="/static/video/space/${AP_FILMS[k]}.mp4" autoplay muted loop playsinline preload="auto" disablepictureinpicture></video>`;
const apScratches = n => vmScatter(n, "ap-scratch", () => `animation-duration:${vmN(1.2, 3, 1)}s`, [0, 0]);
// filtr całej karty: złoto-srebrne zabarwienie, ziarno, migotanie projektora, rysy, winieta
const apFilm = (extra = "") => `<div class="vm-deco ap-clip"><i class="ap-gs"></i><i class="ap-grain"></i><i class="ap-flicker"></i>${apScratches(2)}${extra}<i class="ap-vignette"></i></div>`;
// tło: zdjęcie albo film + przyciemnienie u góry (pod nazwą) i na dole (pod zdolnościami)
const apScene = inner => `<div class="vm-bg ap-scene">${inner}<i class="ap-shade"></i></div>`;
// licznik taśmy w rogu (w makietach z filmem)
const apReel = () => '<div class="vm-deco"><span class="ap-rec"><i></i>16 mm</span></div>';

const VM_APOLLO = {
  key: "apollo", icon: "🚀", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "runda 5: złoto-srebrna klisza; 3 makiety ze zdjęciami z misji i 5 z prawdziwym filmem z lat 60. w tle (archiwum NASA, domena publiczna)",
  looks: [
    {
      name: "Wschód Ziemi (zdjęcie)",
      desc: "Zdjęcie „Wschód Ziemi” z Apollo 8: Ziemia powoli wschodzi w pasie pod zdjęciem karty. Klisza złoto-srebrna: złote i srebrne smugi światła na zmianę, ziarno, migotanie.",
      bg: () => apScene(apPhoto("earthrise", "earthrise")),
      deco: () => apFilm(),
      sub: () => "WSCHÓD ZIEMI · APOLLO 8 · 24.12.1968",
    },
    {
      name: "Orzeł nad Księżycem (zdjęcie)",
      desc: "Lądownik Eagle z Apollo 11 nad Księżycem, nad horyzontem Ziemia - kamera powoli zjeżdża od Ziemi do lądownika i z powrotem.",
      bg: () => apScene(apPhoto("eagle", "eagle")),
      deco: () => apFilm(),
      sub: () => "ORZEŁ · POWRÓT NA ORBITĘ · 21.07.1969",
    },
    {
      name: "Start Saturna V (zdjęcie)",
      desc: "Czarno-białe zdjęcie startu Apollo 11: Saturn V ze smugą dymu przesuwa się po skosie przez kadr; obraz podskakuje jak w kronice.",
      bg: () => apScene(apPhoto("saturn", "saturn")),
      deco: () => apFilm('<i class="ap-dust"></i>'),
      cls: "ap-jitter",
      sub: () => "T+00:01:00 · APOLLO 11 · 16.07.1969",
    },
    {
      name: "Saturn V (film)",
      desc: "Prawdziwy film ze startu: Saturn V wznosi się po skosie na ciemnym niebie, z dysz bije ogień. Pętla kilku sekund, licznik taśmy w rogu.",
      bg: () => apScene(apVideo("saturnClimb", "f-saturn")),
      deco: () => apFilm('<i class="ap-dust"></i>') + apReel(),
      sub: () => "SATURN V · PRZYLĄDEK KENNEDY'EGO",
    },
    {
      name: "Orzeł nad Księżycem (film)",
      desc: "Film z Apollo 11: lądownik Eagle po odłączeniu dryfuje nad kraterami Księżyca, w pasie pod zdjęciem karty.",
      bg: () => apScene(apVideo("lmOrbit", "f-lm")),
      deco: () => apFilm() + apReel(),
      sub: () => "ORZEŁ ODŁĄCZA SIĘ · 20.07.1969",
    },
    {
      name: "Spacer w kosmosie (film)",
      desc: "Film z Gemini 4: Ed White unosi się na złotej linie nad błękitną Ziemią - pierwszy amerykański spacer kosmiczny.",
      bg: () => apScene(apVideo("eva", "f-eva")),
      deco: () => apFilm() + apReel(),
      sub: () => "SPACER W KOSMOSIE · GEMINI 4 · 1965",
    },
    {
      name: "Lądowanie (film)",
      desc: "Widok z okna lądownika Apollo 11 tuż przed lądowaniem: powierzchnia Księżyca przesuwa się coraz bliżej, obraz podskakuje.",
      bg: () => apScene(apVideo("descent", "f-descent")),
      deco: () => apFilm('<i class="ap-dust"></i>') + apReel(),
      cls: "ap-jitter",
      sub: () => "LĄDOWANIE · MORZE SPOKOJU · 20.07.1969",
    },
    {
      name: "Kronika misji (film)",
      desc: "Montaż jak w kronice filmowej: co 4 s cięcie na następne ujęcie - Saturn V w błękicie, Ziemia z okna Gemini, lądownik Apollo 9 nad Ziemią, przelot nad kraterami Księżyca.",
      bg: () => apScene(["saturnSky", "earth", "apollo9", "moonOrbit"].map((k, i) => apVideo(k, `f-cut c${i}`)).join("")),
      deco: () => apFilm('<i class="ap-dust"></i>') + apReel(),
      cls: "ap-jitter",
      sub: () => "KRONIKA · 1965–1969",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_APOLLO];
