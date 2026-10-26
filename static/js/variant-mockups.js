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

// ---------------------------------------------------------------- CZARNO-BIAŁA Z FLAGĄ USA (nazwa robocza) - runda 3
// Połączenie makiet 3 (flaga nachodzi na zdjęcie) i 1 (flaga powiewa w tle) z pierwszej rundy: przekrzywiona flaga
// faluje w tle, a na zdjęciu - różne sposoby nałożenia flagi. Kontrastowe czarno-białe zdjęcie. Klasy z prefiksem ub-.

// flaga USA 76 x 40: 13 pasów, pole z 50 gwiazdami (kolory do podania - czerń i biel albo z czerwienią)
function ubFlag(red = "#1a1a1a", white = "#f2f2f2", blue = "#0c0c0c", star = "#f2f2f2") {
  let s = `<rect width="76" height="40" fill="${white}"/>`;
  for (let k = 0; k < 13; k += 2) s += `<rect y="${(k * 40 / 13).toFixed(2)}" width="76" height="${(40 / 13).toFixed(2)}" fill="${red}"/>`;
  s += `<rect width="30.4" height="21.54" fill="${blue}"/>`;
  for (let r = 0; r < 9; r++) for (let c = 0; c < (r % 2 ? 5 : 6); c++)
    s += vmStar(2.53 + c * 5.07 + (r % 2 ? 2.53 : 0), 2.15 + r * 2.15, .95, star);
  return s;
}
// samo pole z gwiazdami (do rogu zdjęcia)
const ubCanton = (blue, star) => vmSvg(ubFlag("#000", "#000", blue, star), "0 0 30.4 21.54", "", "xMinYMin slice");
// powiewająca flaga w tle, przekrzywiona (kąt w CSS), z przesuwającymi się cieniami fal i światłem z góry
const ubWaving = (cls = "", c = ["#3a3a3a", "#d0d0d0", "#141414", "#e4e4e4"]) =>
  `<i class="ub-tilt ${cls}"><i class="ub-flagbox">${vmSvg(ubFlag(...c), "0 0 76 40")}</i><i class="ub-ripple"></i></i><i class="ub-spot"></i>`;
const ubStars = (n, cls) => vmScatter(n, cls, () => `--s:${vmN(.6, 1.4, 2)}`);

const VM_USBW = {
  key: "usbw", icon: "★", name: "Czarno-biała z flagą USA (nazwa robocza)", tag: "★ U.S.A. ★",
  about: "runda 3: wybrana wersja 1. z poprzedniej rundy (szare pasy przez twarz) bez efektu starego filmu - flaga w tle ustawiona na 4 sposoby, żeby było widać pole z gwiazdami",
  looks: [
    {
      name: "Gwiazdy pod zdjęciem",
      desc: "Flaga w tle przesunięta tak, że pole z gwiazdami faluje w odsłoniętym pasie pod zdjęciem (po lewej), a pasy uciekają w prawo i w górę za zdjęcie.",
      pos: "pos-a",
    },
    {
      name: "Gwiazdy przez środek",
      desc: "Pole z gwiazdami duże, na środku karty - widać je pod zdjęciem i przez półprzezroczyste panele ze zdolnościami; pasy po bokach i za nazwą.",
      pos: "pos-b",
    },
    {
      name: "Gwiazdy przy nazwie",
      desc: "Flaga przekrzywiona w drugą stronę: pole z gwiazdami w górnym prawym rogu, wystaje za nazwą i obok zdjęcia, pasy spływają w dół pod zdjęcie.",
      pos: "pos-c",
    },
    {
      name: "Gwiazdy w rogu u dołu",
      desc: "Flaga odwrócona (pole z gwiazdami w prawym dolnym rogu, przy wartości karty) i mocniej przekrzywiona - pasy przechodzą ukośnie przez całe tło.",
      pos: "pos-d",
    },
  ].map(l => Object.assign({
    bg: () => `<div class="vm-bg">${ubWaving(l.pos)}</div>`,
    photo: () => `<i class="vm-photo ub-stripes bw"></i><i class="vm-photo ub-canton">${ubCanton("#0c0c0c", "#f2f2f2")}</i>`,
    deco: () => '<div class="vm-deco ub-clip"><i class="ub-hazard"></i></div>',
    sub: () => "TO PRAWDZIWA HISTORIA",
  }, l)),
};

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza) - runda 4
// Prawdziwe zdjęcia z misji (static/img/space/, archiwum NASA images.nasa.gov - domena publiczna; ID w komentarzach)
// w tle karty, ustawione tak, żeby najważniejszy obiekt był w odsłoniętym pasie pod skróconym zdjęciem, z powolnym
// ruchem kamery. Na całej karcie filtr starej złotej kliszy (złoty odcień, ziarno, migotanie, rysy, winieta) z rundy 2,
// a w części makiet podskakujący obraz jak w kronice filmowej. Klasy z prefiksem ap-.

const AP_PHOTOS = {
  earthrise: "earthrise.jpg",    // as08-14-2383 - Apollo 8, 24.12.1968, „Wschód Ziemi”
  eagle: "eagle-earth.jpg",      // as11-44-6642 - Apollo 11, lądownik Eagle nad Księżycem, w tle Ziemia
  moon: "full-moon.jpg",         // as11-44-6667 - Apollo 11, Księżyc w pełni ze statku
  lm: "lm-surface.jpg",          // as11-40-5927 - Apollo 11, lądownik na powierzchni Księżyca
  saturn: "saturn-v.jpg",        // 6900556 - start Apollo 11, Saturn V w locie, 16.07.1969
  sputnik: "sputnik.jpg",        // 9248168 - replika Sputnika 1
  rover: "lrv.jpg",              // as15-86-11603 - Apollo 15, łazik księżycowy, 31.07.1971
};
const apPhoto = (k, cls = "") => `<img class="ap-ph ${cls}" src="/static/img/space/${AP_PHOTOS[k]}" alt="" draggable="false" loading="lazy">`;
const apScratches = n => vmScatter(n, "ap-scratch", () => `animation-duration:${vmN(1.2, 3, 1)}s`, [0, 0]);
// filtr całej karty: złoty odcień, ziarno, migotanie projektora, rysy, winieta
const apFilm = (extra = "") => `<div class="vm-deco ap-clip"><i class="ap-gold"></i><i class="ap-grain"></i><i class="ap-flicker"></i>${apScratches(2)}${extra}<i class="ap-vignette"></i></div>`;
// tło ze zdjęciem: zdjęcie + przyciemnienie u góry (pod nazwą) i na dole (pod zdolnościami)
const apScene = (k, cls) => `<div class="vm-bg ap-scene">${apPhoto(k, cls)}<i class="ap-shade"></i></div>`;

const VM_APOLLO = {
  key: "apollo", icon: "🚀", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "runda 4: prawdziwe zdjęcia z misji (archiwum NASA, domena publiczna) w tle, z powolnym ruchem kamery, pod filtrem starej złotej kliszy",
  looks: [
    {
      name: "Wschód Ziemi",
      desc: "Prawdziwe zdjęcie „Wschód Ziemi” z Apollo 8: Ziemia powoli wschodzi nad horyzontem Księżyca w pasie pod zdjęciem karty, na złotej kliszy z ziarnem i migotaniem.",
      bg: () => apScene("earthrise", "earthrise"),
      deco: () => apFilm(),
      sub: () => "WSCHÓD ZIEMI · APOLLO 8 · 24.12.1968",
    },
    {
      name: "Orzeł nad Księżycem",
      desc: "Lądownik Eagle z Apollo 11 wraca z powierzchni Księżyca na orbitę - kamera powoli unosi się i opada razem z nim nad kraterami.",
      bg: () => apScene("eagle", "eagle"),
      deco: () => apFilm(),
      sub: () => "ORZEŁ · POWRÓT NA ORBITĘ · 21.07.1969",
    },
    {
      name: "Lądownik na Księżycu",
      desc: "Lądownik Apollo 11 w złotej folii stoi na powierzchni Księżyca (zdjęcie z krzyżykami z kliszy), kamera powoli się przybliża; obraz podskakuje jak w kronice.",
      bg: () => apScene("lm", "lm"),
      deco: () => apFilm('<i class="ap-dust"></i>'),
      cls: "ap-jitter",
      sub: () => "ORZEŁ WYLĄDOWAŁ · 20.07.1969",
    },
    {
      name: "Start Saturna V",
      desc: "Czarno-białe zdjęcie startu Apollo 11: Saturn V ze smugą dymu przesuwa się po skosie przez kadr, jak w kronice filmowej - obraz podskakuje, migocze.",
      bg: () => apScene("saturn", "saturn"),
      deco: () => apFilm('<i class="ap-dust"></i>'),
      cls: "ap-jitter",
      sub: () => "T+00:01:00 · APOLLO 11 · 16.07.1969",
    },
    {
      name: "Sputnik",
      desc: "Srebrna kula Sputnika z długimi antenami w ciepłym świetle, kamera powoli krąży wokół; po karcie rozchodzą się kręgi sygnału „bip-bip”.",
      bg: () => apScene("sputnik", "sputnik"),
      deco: () => `<div class="vm-deco ap-clip"><i class="ap-beep"></i><i class="ap-beep b"></i></div>${apFilm()}`,
      sub: () => "BIP · BIP · BIP · SPUTNIK 1 · 4.10.1957",
    },
    {
      name: "Łazik księżycowy",
      desc: "Łazik z Apollo 15 z anteną-parasolem w dolinie u stóp księżycowych gór, kamera powoli przesuwa się w bok; złota klisza, kurz na taśmie.",
      bg: () => apScene("rover", "rover"),
      deco: () => apFilm('<i class="ap-dust"></i>'),
      sub: () => "ŁAZIK · APOLLO 15 · DOLINA HADLEY",
    },
    {
      name: "Pełnia",
      desc: "Księżyc w pełni sfotografowany z Apollo 11 powoli wschodzi zza panelu ze zdolnościami i lekko się obraca, gwiazdy migoczą w złotej kliszy.",
      bg: () => `<div class="vm-bg ap-scene">${vmScatter(16, "ap-star", () => `--s:${vmN(.4, 1.3, 2)};animation-duration:${vmN(1.6, 4, 1)}s`)}${apPhoto("moon", "moon")}<i class="ap-shade"></i></div>`,
      deco: () => apFilm(),
      sub: () => "PEŁNIA · Z POKŁADU APOLLO 11",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_USBW, VM_APOLLO];
