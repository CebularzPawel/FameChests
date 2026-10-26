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

// ---------------------------------------------------------------- CZARNO-BIAŁA Z FLAGĄ USA (nazwa robocza) - runda 2
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
  about: "runda 2: przekrzywiona flaga powiewa w tle (jak w 1.), a na zdjęciu różne sposoby nałożenia flagi (jak w 3.)",
  looks: [
    {
      name: "Szara flaga przez twarz",
      desc: "Jak 3., ale cała w czerni i bieli: szare pasy płyną przez połowę zdjęcia, w rogu czarne pole z białymi gwiazdami. W tle przekrzywiona flaga faluje na wietrze, ramka w czarno-białe ukośne pasy.",
      bg: () => `<div class="vm-bg">${ubWaving()}</div>`,
      photo: () => `<i class="vm-photo ub-stripes bw"></i><i class="vm-photo ub-canton">${ubCanton("#0c0c0c", "#f2f2f2")}</i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-hazard"></i><i class="ub-dust"></i></div>',
      sub: () => "TO PRAWDZIWA HISTORIA",
    },
    {
      name: "Czerwień tylko na twarzy",
      desc: "Tło całe szare (powiewająca przekrzywiona flaga), a jedyny kolor na karcie to wypłowiała czerwień pasów na zdjęciu i czerwony cień pod nazwą.",
      bg: () => `<div class="vm-bg">${ubWaving()}</div>`,
      photo: () => `<i class="vm-photo ub-stripes"></i><i class="vm-photo ub-canton">${ubCanton("#141414", "#f2f2f2")}</i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-hazard"></i></div>',
      sub: () => "TO PRAWDZIWA HISTORIA",
    },
    {
      name: "Flaga na skos",
      desc: "Pasy flagi idą po skosie przez całe zdjęcie i zanikają w stronę twarzy, a w tle druga flaga powiewa pod przeciwnym kątem - dwie flagi się krzyżują. Dookoła migoczą gwiazdy.",
      bg: () => `<div class="vm-bg">${ubWaving("rev")}${ubStars(8, "ub-tw")}</div>`,
      photo: () => '<i class="vm-photo ub-diag"></i><i class="vm-photo ub-grain"></i>',
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame1"></i><i class="ub-dust"></i></div>',
      sub: () => "★ OPARTE NA FAKTACH ★",
    },
    {
      name: "Światło przez flagę",
      desc: "Flaga jak rzucone na twarz światło projektora: jasne i ciemne pasy (falujące) i świetliste gwiazdy w rogu, z boku snop światła. W tle ciemna, przekrzywiona flaga powiewa w mroku.",
      bg: () => `<div class="vm-bg">${ubWaving("dim")}<i class="ub-beam"></i></div>`,
      photo: () => `<i class="vm-photo ub-light"></i><i class="vm-photo ub-lstars">${vmSvg(ubFlag("#0000", "#0000", "#0000", "#fff"), "0 0 30.4 21.54", "", "xMinYMin slice")}</i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame1"></i><i class="ub-vignette"></i></div>',
      sub: () => "NOC · COLORADO · 1972",
    },
    {
      name: "Podwójna ekspozycja",
      desc: "Flaga prześwituje przez całe zdjęcie jak druga klatka naświetlona na tej samej kliszy i lekko faluje. W tle przekrzywiona flaga, nazwa z czerwonym cieniem, ramka jak brzeg odbitki.",
      bg: () => `<div class="vm-bg">${ubWaving()}</div>`,
      photo: () => `<i class="vm-photo ub-expo">${vmSvg(ubFlag("#2a2a2a", "#f2f2f2", "#0c0c0c", "#f2f2f2"), "0 0 76 40", "", "xMidYMid slice")}</i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-print"></i><i class="ub-dust"></i></div>',
      sub: () => "TO PRAWDZIWA HISTORIA",
    },
    {
      name: "Zdarty plakat",
      desc: "Na zdjęciu przyklejony szary plakat z flagą, zdarty po skosie - spod niego wychodzi twarz, oderwany róg się zawija. Zszywki w rogach zdjęcia, w tle przekrzywiona flaga powiewa.",
      bg: () => `<div class="vm-bg">${ubWaving()}</div>`,
      photo: () => `<i class="vm-photo ub-torn">${vmSvg(ubFlag("#3a3a3a", "#e8e8e8", "#141414", "#e8e8e8"), "0 0 76 40", "", "xMinYMin slice")}</i><i class="vm-photo ub-curl"></i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame1"></i></div><div class="vm-deco"><i class="ub-staple a"></i><i class="ub-staple b"></i></div>',
      sub: () => "★ OPARTE NA FAKTACH ★",
    },
  ],
};

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza) - runda 2
// Realistyczny Księżyc (faktura z filtrów SVG: szum + oświetlenie = kratery i nierówności, ciemne morza, cień
// terminatora) i cała karta jak nagranie albo transmisja telewizyjna z lat 60/70: złoty filtr na całej karcie, ziarno,
// linie obrazu, zakłócenia, migotanie. Klasy z prefiksem ap-.

// Księżyc w pełni albo w fazie (shade 0 - pełnia, 1 - mocny cień z lewej), seed - inny rozkład nierówności,
// crescent - sierp (ciemna strona zakrywa większość tarczy, zostaje ledwo widoczna poświata Ziemi)
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
// powierzchnia Księżyca (horyzont z kraterami, faktura jak u Księżyca) - w jednostkach karty 63 x 88
function apSurface(seed = 3) {
  const f = vmId("apSf"), g = vmId("apSg");
  const craters = Array.from({ length: 9 }, () => {
    const x = rand(2, 61), y = rand(66, 86), rx = rand(1.5, 5);
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${(rx * .3).toFixed(1)}" fill="#0005" stroke="#fff5" stroke-width=".3"/>`;
  }).join("");
  return vmSvg(`<defs><filter id="${f}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".09 .3" numOctaves="4" seed="${seed}" result="t"/>
      <feDiffuseLighting in="t" lighting-color="#e8e6de" surfaceScale="2"><feDistantLight azimuth="10" elevation="30"/></feDiffuseLighting></filter>
      <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></linearGradient>
      <clipPath id="${f}c"><path d="M-2 66 Q10 61 22 64 T44 62 T66 65 V90 H-2Z"/></clipPath></defs>
    <g clip-path="url(#${f}c)"><rect y="55" width="63" height="35" filter="url(#${f})"/>${craters}<rect y="58" width="63" height="32" fill="url(#${g})"/></g>`);
}
// gwiazdy (migoczą) i linia telemetrii zmieniająca liczby (CSS steps)
const apStars = n => vmScatter(n, "ap-star", () => `--s:${vmN(.4, 1.3, 2)};animation-duration:${vmN(1.6, 4, 1)}s`);
const apTelemetry = () => `<span class="ap-tele"><span>ALT</span><span class="ap-roll">${[" 102 400", " 101 950", " 101 310", " 100 820", " 100 260", " 99 870", " 102 400"].map(x => `<b>${x}</b>`).join("")}</span><span>STOPY</span></span>`;
// znaczniki klatki z kroniki filmowej (kółko w rogu pod koniec rolki), rysy na taśmie
const apScratches = n => vmScatter(n, "ap-scratch", () => `animation-duration:${vmN(1.2, 3, 1)}s`, [0, 0]);
// filtry całej karty: złoty odcień, ziarno, migotanie, winieta (wspólne dla wszystkich makiet tej grupy)
const apFilm = (extra = "") => `<div class="vm-deco ap-clip"><i class="ap-gold"></i><i class="ap-grain"></i><i class="ap-flicker"></i>${extra}<i class="ap-vignette"></i></div>`;

const VM_APOLLO = {
  key: "apollo", icon: "🌕", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "runda 2: realistyczny Księżyc i cała karta jak nagranie albo transmisja telewizyjna z lat 60/70 - złoty filtr, ziarno, linie obrazu, zakłócenia",
  looks: [
    {
      name: "Księżyc na kliszy",
      desc: "Wielki realistyczny Księżyc (kratery, morza, cień) wschodzi za zdjęciem, cała karta w złotym tonie starej kliszy: ziarno, migotanie projektora, rysy na taśmie i winieta.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(18)}<i class="ap-moon big">${apMoon(.35, 7)}</i></div>`,
      deco: () => apFilm(apScratches(2)),
      sub: () => "8 MM · KOLOR · BEZ DŹWIĘKU",
    },
    {
      name: "Transmisja TV 1969",
      desc: "Cała karta jak obraz z czarno-białego telewizora z lekko złotym odcieniem: horyzont Księżyca pod zdjęciem, linie obrazu, przewijający się pasek zakłóceń, co jakiś czas szum, zaokrąglony ekran kineskopu i migające ● NA ŻYWO.",
      top: () => '<div class="ap-live"><b>● NA ŻYWO</b><span>KSIĘŻYC → ZIEMIA</span></div>',
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(10)}<i class="ap-earth-s"></i>${apSurface(3)}</div>`,
      photo: () => '<i class="vm-photo ap-ghost"></i>',
      deco: () => apFilm('<i class="ap-scan"></i><i class="ap-roll-bar"></i><i class="ap-static"></i><i class="ap-crt"></i>'),
      sub: () => "TRANSMISJA SATELITARNA · 20.07.1969",
    },
    {
      name: "Kronika filmowa 16 mm",
      desc: "Sepiowo-złota kronika filmowa: obraz lekko podskakuje jak w projektorze, rysy i kurz na taśmie, co kilka sekund kółko znacznika zmiany rolki. Z rogu karty wychodzi Księżyc w fazie.",
      bg: () => `<div class="vm-bg"><i class="ap-space warm"></i>${apStars(10)}</div>`,
      deco: () => `<div class="vm-deco"><i class="ap-moon corner">${apMoon(.7, 11)}</i></div>${apFilm(`${apScratches(3)}<i class="ap-dust"></i><i class="ap-cue"></i>`)}`,
      cls: "ap-jitter",
      sub: () => "KRONIKA · LĄDOWANIE NA KSIĘŻYCU",
    },
    {
      name: "Sierp i telemetria",
      desc: "Ogromny sierp Księżyca z poświatą Ziemi za zdjęciem, na zdjęciu lekko złote nakładki telemetrii (wysokość spada jak przy lądowaniu) i krzyżyki z kliszy, całość jak nagranie z kamery lądownika.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(16)}<i class="ap-moon crescent">${apMoon(.3, 4, true)}</i></div>`,
      photo: () => `<i class="vm-photo ap-reticle"></i>${apTelemetry()}`,
      deco: () => apFilm('<i class="ap-scan soft"></i>'),
      sub: () => "LĄDOWNIK · 500 STÓP · W PORZĄDKU",
    },
    {
      name: "Odbicie w wizjerze",
      desc: "Zdjęcie jak przez złoty wizjer hełmu astronauty: złoty połysk, w szybce odbija się Księżyc i horyzont. W tle powierzchnia Księżyca i wisząca nad nią Ziemia, całość w ziarnie starej kliszy.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(12)}<i class="ap-earth-s high"></i>${apSurface(9)}</div>`,
      photo: () => `<i class="vm-photo ap-visor"></i><i class="vm-photo ap-reflect">${apMoon(.2, 5)}</i><i class="vm-photo ap-visor-hi"></i>`,
      deco: () => apFilm(),
      sub: () => "SPACER PO KSIĘŻYCU · EVA 1",
    },
    {
      name: "Atlas Księżyca",
      desc: "Złota tablica z atlasu: realistyczny Księżyc w pełni z siatką współrzędnych i podpisami mórz, powoli się obraca, a cała karta drga jak obraz z telewizora - linie obrazu i złoty odcień.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i><i class="ap-moon atlas">${apMoon(.08, 2)}<i class="ap-grid"></i>
        <b class="ap-lbl" style="left:20%;top:24%">MARE IMBRIUM</b><b class="ap-lbl" style="left:50%;top:20%">MARE SERENITATIS</b><b class="ap-lbl" style="left:44%;top:32%">MARE TRANQUILLITATIS</b><b class="ap-lbl" style="left:6%;top:40%">OCEANUS PROCELLARUM</b></i></div>`,
      deco: () => apFilm('<i class="ap-scan soft"></i>'),
      sub: () => "ATLAS · STRONA WIDOCZNA · 1:10 000 000",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_USBW, VM_APOLLO];
