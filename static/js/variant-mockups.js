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

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza) - runda 3
// Cała karta jak stara złota klisza (filtr z makiety 1. z rundy 2: złoty odcień, ziarno, migotanie projektora, rysy,
// winieta, a jak w 3. - podskakujący obraz) i sceny z wczesnej eksploracji kosmosu: realistyczny Księżyc i jego
// powierzchnia (faktura z filtrów SVG), wschodząca Ziemia, Sputnik, lądownik Apollo, start rakiety, sonda, łazik.
// Scena jest w odsłoniętym pasie pod skróconym zdjęciem i za półprzezroczystymi panelami. Klasy z prefiksem ap-.

// Księżyc w pełni albo w fazie (shade 0 - pełnia, 1 - mocny cień z lewej), seed - inny rozkład nierówności,
// crescent - sierp (ciemna strona zakrywa większość tarczy)
function apMoon(shade = .55, seed = 7, crescent = false) {
  const f = vmId("apMf"), b = vmId("apMb"), c = vmId("apMc"), s = vmId("apMs");
  const maria = [[38, 34, 13, 9], [56, 28, 9, 7], [62, 48, 11, 8], [44, 56, 9, 7], [27, 50, 7, 9], [70, 64, 6, 5], [50, 74, 7, 4]]
    .map(([x, y, rx, ry]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`).join("");
  const craters = Array.from({ length: 14 }, () => {
    const x = rand(14, 86), y = rand(14, 86), r = rand(1, 3.4);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#0003" stroke="#fff6" stroke-width=".35"/>`;
  }).join("") + '<circle cx="34" cy="82" r="3" fill="#fff4"/><path d="M34 82 L20 98 M34 82 L48 97 M34 82 L30 99 M34 82 L10 86" stroke="#fff2" stroke-width=".7"/>';
  return vmSvg(`<defs>
      <filter id="${f}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="5" seed="${seed}" result="t"/>
        <feDiffuseLighting in="t" lighting-color="#f4f2ea" surfaceScale="2.6"><feDistantLight azimuth="20" elevation="52"/></feDiffuseLighting></filter>
      <filter id="${b}"><feGaussianBlur stdDeviation="1.6"/></filter>
      <radialGradient id="${s}" cx="${70 - shade * 25}%" cy="38%" r="${78 - shade * 18}%"><stop offset="${.55 - shade * .25}" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${.55 + shade * .43}"/></radialGradient>
      <clipPath id="${c}"><circle cx="50" cy="50" r="48"/></clipPath></defs>
    <g clip-path="url(#${c})"><rect width="100" height="100" filter="url(#${f})"/>
      <g fill="#20201e" opacity=".5" filter="url(#${b})">${maria}</g>${craters}
      <circle cx="50" cy="50" r="48" fill="url(#${s})"/>${crescent ? `<circle cx="36" cy="46" r="47" fill="#05060a" opacity=".9" filter="url(#${b})"/>` : ""}</g>
    <circle cx="50" cy="50" r="48" fill="none" stroke="#fff3" stroke-width=".5"/>`, "0 0 100 100", "ap-moon-svg", "xMidYMid meet");
}
// powierzchnia Księżyca: horyzont na wysokości y (jednostki karty 63 x 88), kratery i faktura jak u Księżyca
function apSurface(seed = 3, y = 58) {
  const f = vmId("apSf"), g = vmId("apSg"), d = y - 64;
  const craters = Array.from({ length: 10 }, () => {
    const x = rand(2, 61), cy = rand(y + 3, 86), rx = rand(1.5, 5);
    return `<ellipse cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${(rx * .3).toFixed(1)}" fill="#0005" stroke="#fff5" stroke-width=".3"/>`;
  }).join("");
  return vmSvg(`<defs><filter id="${f}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".09 .3" numOctaves="4" seed="${seed}" result="t"/>
      <feDiffuseLighting in="t" lighting-color="#e8e6de" surfaceScale="2"><feDistantLight azimuth="10" elevation="30"/></feDiffuseLighting></filter>
      <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></linearGradient>
      <clipPath id="${f}c"><path d="M-2 ${66 + d} Q10 ${61 + d} 22 ${64 + d} T44 ${62 + d} T66 ${65 + d} V90 H-2Z"/></clipPath></defs>
    <g clip-path="url(#${f}c)"><rect y="${y - 9}" width="63" height="${97 - y}" filter="url(#${f})"/>${craters}<rect y="${y + 2}" width="63" height="${88 - y}" fill="url(#${g})"/></g>`);
}
// Sputnik 1: srebrna kula z czterema długimi antenami
const apSputnik = () => vmSvg(`<defs><radialGradient id="apSpG" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#c8ccd2"/><stop offset="1" stop-color="#3a3e46"/></radialGradient></defs>
  <path d="M12 8 L40 1 M12.5 9.4 L40 7 M12.5 10.6 L40 13 M12 12 L40 19" stroke="#d8dce2" stroke-width=".45"/>
  <circle cx="8" cy="10" r="6" fill="url(#apSpG)"/><circle cx="6" cy="8" r="1.4" fill="#fff8"/>`, "0 0 40 20", "", "xMidYMid meet");
// lądownik księżycowy (LM): złota folia na stopniu lądowania, szary stopień startowy z oknami, nogi z talerzami
const apLM = () => vmSvg(`<defs><linearGradient id="apLmG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset=".35" stop-color="#b07818"/>
    <stop offset=".6" stop-color="#f5d27a"/><stop offset="1" stop-color="#7a5010"/></linearGradient>
    <linearGradient id="apLmS" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e8eaee"/><stop offset=".6" stop-color="#9aa0aa"/><stop offset="1" stop-color="#5a5e66"/></linearGradient></defs>
  <g stroke="#cfd2d8" stroke-width=".8" fill="none"><path d="M9 21 L2 31 M31 21 L38 31 M13 23 L10 33 M27 23 L30 33 M9 21 L13 23 M31 21 L27 23"/></g>
  <g fill="#9aa0aa"><ellipse cx="2" cy="31.5" rx="2.2" ry=".7"/><ellipse cx="38" cy="31.5" rx="2.2" ry=".7"/><ellipse cx="10" cy="33.4" rx="2" ry=".6"/><ellipse cx="30" cy="33.4" rx="2" ry=".6"/></g>
  <path d="M7 16 L33 16 L35 24 L5 24 Z" fill="url(#apLmG)" stroke="#5a3a08" stroke-width=".3"/>
  <path d="M9 18 L14 22 M20 17 L18 23 M26 18 L30 22" stroke="#fff6" stroke-width=".4"/>
  <path d="M11 16 L13 7 L18 4 L24 4 L28 8 L29 16 Z" fill="url(#apLmS)" stroke="#3a3e46" stroke-width=".3"/>
  <path d="M15 9 L18 7.5 L18 11 Z M25 9 L22 7.5 L22 11 Z" fill="#14161a"/><rect x="18.5" y="2.2" width="3" height="1.8" fill="#cfd2d8"/>
  <path d="M28 6 L32 2" stroke="#cfd2d8" stroke-width=".4"/><ellipse cx="32.6" cy="1.6" rx="1.6" ry=".9" fill="#e8eaee"/>
  <path d="M17 24 L16 27 L24 27 L23 24 Z" fill="#3a3e46"/>`, "0 0 40 35", "", "xMidYMid meet");
// rakieta Saturn V (biała z czarnymi pasami), płomień i dym są osobno w CSS
const apRocket = () => vmSvg(`<path d="M6 0 L4.2 5 L7.8 5 Z" fill="#e8e8e8"/><rect x="5.6" y="-1.5" width=".8" height="2" fill="#cfd2d8"/>
  <rect x="4.2" y="5" width="3.6" height="9" fill="#f2f2f2"/><rect x="4.2" y="9" width="3.6" height="1.2" fill="#1a1a1a"/>
  <rect x="3.6" y="14" width="4.8" height="12" fill="#f4f4f4"/><rect x="3.6" y="16" width="2.4" height="3" fill="#1a1a1a"/><rect x="6" y="21" width="2.4" height="3" fill="#1a1a1a"/>
  <rect x="3.2" y="26" width="5.6" height="16" fill="#f8f8f8"/><rect x="3.2" y="28" width="2.8" height="5" fill="#1a1a1a"/><rect x="6" y="35" width="2.8" height="5" fill="#1a1a1a"/>
  <path d="M3.2 38 L1 44 L3.2 42 Z M8.8 38 L11 44 L8.8 42 Z" fill="#1a1a1a"/><rect x="3.4" y="42" width="5.2" height="1.6" fill="#5a5e66"/>`, "0 0 12 44", "", "xMidYMid meet");
// wieża startowa (kratownica)
const apTower = () => vmSvg(`<g stroke="#2a1e0a" stroke-width=".5" fill="none"><path d="M2 2 V60 M7 2 V60"/>${Array.from({ length: 15 }, (_, k) =>
  `<path d="M2 ${2 + k * 4} L7 ${6 + k * 4} M7 ${2 + k * 4} L2 ${6 + k * 4}"/>`).join("")}<path d="M7 14 H13 M7 30 H12"/></g>`, "0 0 14 60", "", "xMidYMax meet");
// sonda (jak Voyager): biała antena paraboliczna, korpus, długie wysięgniki
const apProbe = () => vmSvg(`<g stroke="#cfd2d8" stroke-width=".35"><path d="M16 14 L39 24 M14 16 L1 27 M18 12 L28 3"/></g>
  <circle cx="39" cy="24" r="1" fill="#e8eaee"/><rect x="0" y="26" width="3" height="2" fill="#9aa0aa"/>
  <path d="M10 15 L20 15 L21 19 L9 19 Z" fill="#7a808a"/><path d="M11 15 L19 15 L18 13 L12 13 Z" fill="#c8a24a"/>
  <ellipse cx="15" cy="9" rx="11" ry="4" fill="#f4f4f0" stroke="#9aa0aa" stroke-width=".3"/><ellipse cx="15" cy="9.6" rx="8.5" ry="2.6" fill="#d8d8d2"/><path d="M15 9 V4" stroke="#9aa0aa" stroke-width=".4"/>
  <circle cx="13.5" cy="17" r="1.1" fill="#f0c86a"/>`, "0 0 40 30", "", "xMidYMid meet");
// łazik księżycowy z anteną-parasolem
const apRover = () => vmSvg(`<path d="M3 8 L27 8 L28 10 L2 10 Z" fill="#b8bcc4"/><path d="M8 8 L9 5 L13 5 L13 8 M15 8 L16 5 L20 5 L20 8" fill="none" stroke="#5a5e66" stroke-width=".6"/>
  <path d="M23 8 V2" stroke="#cfd2d8" stroke-width=".4"/><path d="M20 2.5 Q23 -.5 26 2.5 Z" fill="#e8eaee"/>
  <g fill="#2a2a2a" stroke="#9aa0aa" stroke-width=".4"><circle cx="6" cy="11" r="2.6"/><circle cx="24" cy="11" r="2.6"/></g>
  <path d="M2 9 Q6 6 10 9 M20 9 Q24 6 28 9" fill="none" stroke="#d8b25a" stroke-width=".6"/>`, "0 0 30 14", "", "xMidYMid meet");
const apStars = n => vmScatter(n, "ap-star", () => `--s:${vmN(.4, 1.3, 2)};animation-duration:${vmN(1.6, 4, 1)}s`);
const apScratches = n => vmScatter(n, "ap-scratch", () => `animation-duration:${vmN(1.2, 3, 1)}s`, [0, 0]);
// filtr całej karty (makieta 1. z rundy 2): złoty odcień, ziarno, migotanie projektora, rysy, winieta
const apFilm = (extra = "") => `<div class="vm-deco ap-clip"><i class="ap-gold"></i><i class="ap-grain"></i><i class="ap-flicker"></i>${apScratches(2)}${extra}<i class="ap-vignette"></i></div>`;
// Ziemia (kula z oceanem, lądem, chmurami i nocną stroną) - rozmiar i miejsce w CSS
const apEarth = cls => `<i class="ap-earth ${cls}"></i>`;

const VM_APOLLO = {
  key: "apollo", icon: "🚀", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "runda 3: filtr starej złotej kliszy z makiety 1. (i podskakujący obraz z 3.) i sceny z wczesnej eksploracji kosmosu - wschodząca Ziemia, Sputnik, lądownik Apollo, start rakiety, sonda, łazik",
  looks: [
    {
      name: "Wschód Ziemi",
      desc: "Nad horyzontem Księżyca powoli wschodzi Ziemia (z nocną stroną i chmurami) i znów zachodzi, migoczą gwiazdy - jak słynne zdjęcie z orbity Księżyca, na starej złotej kliszy.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(18)}${apEarth("rise")}${apSurface(3, 59)}</div>`,
      deco: () => apFilm(),
      sub: () => "WSCHÓD ZIEMI · ORBITA KSIĘŻYCA · 1968",
    },
    {
      name: "Sputnik",
      desc: "Nad krawędzią Ziemi (z niebieską poświatą atmosfery) przelatuje Sputnik z antenami i nadaje swoje „bip-bip” - rozchodzące się kręgi sygnału. Złota klisza z ziarnem.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(22)}<i class="ap-limb"></i></div>`,
      deco: () => `<div class="vm-deco ap-clip"><i class="ap-sputnik"><i class="ap-beep"></i><i class="ap-beep b"></i>${apSputnik()}</i></div>${apFilm()}`,
      sub: () => "BIP · BIP · BIP · SPUTNIK 1 · 4.10.1957",
    },
    {
      name: "Lądownik na Księżycu",
      desc: "Lądownik Apollo stoi na powierzchni Księżyca i rzuca długi cień, nad nim wisi Ziemia, gwiazdy migoczą; obraz podskakuje jak w kronice filmowej.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(16)}${apEarth("sky")}${apSurface(8, 59)}<i class="ap-lm">${apLM()}</i><i class="ap-lmshadow"></i></div>`,
      deco: () => apFilm('<i class="ap-dust"></i>'),
      cls: "ap-jitter",
      sub: () => "ORZEŁ WYLĄDOWAŁ · 20.07.1969",
    },
    {
      name: "Start rakiety",
      desc: "O świcie z wieży startowej wznosi się Saturn V: płomień z silników, kłęby dymu na dole, rakieta powoli ucieka w górę. Złota kronika filmowa, obraz podskakuje.",
      bg: () => `<div class="vm-bg"><i class="ap-dawn"></i><i class="ap-tower">${apTower()}</i><i class="ap-launch"><i class="ap-rocket">${apRocket()}</i><i class="ap-flame"></i></i>${
        Array.from({ length: 7 }, (_, k) => `<i class="ap-smoke" style="left:${30 + k * 6}%;animation-delay:-${(k * .5).toFixed(1)}s"></i>`).join("")}</div>`,
      deco: () => apFilm('<i class="ap-dust"></i>'),
      cls: "ap-jitter",
      sub: () => "T+00:00:08 · WIEŻA OPUSZCZONA",
    },
    {
      name: "Sonda w kosmosie",
      desc: "Sonda z białą anteną i długimi wysięgnikami powoli dryfuje i obraca się na tle odległego Saturna z pierścieniami; po drodze błyska złota płyta na jej boku.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(24)}<i class="ap-saturn"><i class="ap-ring"></i></i></div>`,
      deco: () => `<div class="vm-deco ap-clip"><i class="ap-probe">${apProbe()}</i></div>${apFilm()}`,
      sub: () => "SONDA · 1977 → GRANICA UKŁADU",
    },
    {
      name: "Łazik księżycowy",
      desc: "Po powierzchni Księżyca jedzie łazik z anteną-parasolem i wzbija za sobą pył, nad horyzontem wisi Ziemia; obraz jak z kamery na łaziku, złota klisza.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(16)}${apEarth("sky b")}${apSurface(12, 59)}<i class="ap-rover">${apRover()}<i class="ap-trail"></i></i></div>`,
      deco: () => apFilm(),
      sub: () => "ŁAZIK · 18 KM/H · DOLINA TAURUS-LITTROW",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_USBW, VM_APOLLO];
