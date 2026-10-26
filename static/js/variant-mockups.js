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

// ---------------------------------------------------------------- CZARNO-BIAŁA Z FLAGĄ USA (nazwa robocza)
// Estetyka plakatów filmowych z lat 70 (jak plakaty „BlacKkKlansman”): kontrastowe czarno-białe zdjęcie, flaga USA,
// grube napisy, jeden mocny akcent koloru. Klasy z prefiksem ub-.

// flaga USA 76 x 40: 13 pasów, granatowe pole z 50 gwiazdami (kolory do podania - w czerni i bieli albo z czerwienią)
function ubFlag(red = "#1a1a1a", white = "#f2f2f2", blue = "#0c0c0c", star = "#f2f2f2") {
  let s = `<rect width="76" height="40" fill="${white}"/>`;
  for (let k = 0; k < 13; k += 2) s += `<rect y="${(k * 40 / 13).toFixed(2)}" width="76" height="${(40 / 13).toFixed(2)}" fill="${red}"/>`;
  s += `<rect width="30.4" height="21.54" fill="${blue}"/>`;
  for (let r = 0; r < 9; r++) for (let c = 0; c < (r % 2 ? 5 : 6); c++)
    s += vmStar(2.53 + c * 5.07 + (r % 2 ? 2.53 : 0), 2.15 + r * 2.15, .95, star);
  return s;
}
const ubStars = (n, cls) => vmScatter(n, cls, () => `--s:${vmN(.6, 1.4, 2)}`);
// pasek z gwiazdami przesuwający się w poprzek karty (jak taśma na plakacie)
const ubMarquee = txt => `<span class="ub-marquee"><b>${(txt + " ").repeat(8)}</b><b>${(txt + " ").repeat(8)}</b></span>`;

const VM_USBW = {
  key: "usbw", icon: "★", name: "Czarno-biała z flagą USA (nazwa robocza)", tag: "★ U.S.A. ★",
  about: "plakat filmowy z lat 70: kontrastowe czarno-białe zdjęcie, flaga USA, grube napisy i jeden mocny akcent koloru",
  looks: [
    {
      name: "Flaga na wietrze",
      desc: "Cała karta w czerni i bieli. Za zdjęciem wielka szara flaga faluje na wietrze (cienie fal przesuwają się po pasach), od góry pada światło reflektora, a po zdjęciu sypie się ziarno taśmy.",
      bg: () => `<div class="vm-bg"><i class="ub-flagbox">${vmSvg(ubFlag("#3a3a3a", "#d8d8d8", "#161616", "#e8e8e8"), "0 0 76 40", "ub-flag")}</i><i class="ub-ripple"></i><i class="ub-spot"></i></div>`,
      photo: () => '<i class="vm-photo ub-grain"></i>',
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame1"></i><i class="ub-dust"></i></div>',
      sub: () => "★ OPARTE NA FAKTACH ★",
    },
    {
      name: "Czerwony tytuł",
      desc: "Czarno-biały plakat z jednym kolorem: nazwa wielkimi czerwonymi literami, czerwony pas z przesuwającymi się gwiazdami pod zdjęciem, zdjęcie w drukarskim rastrze, nad nazwą napis jak z czołówki.",
      top: () => '<div class="ub-credit">SCAMBOX PRZEDSTAWIA</div>',
      bg: () => `<div class="vm-bg"><i class="ub-paper"></i>${ubStars(10, "ub-tw dark")}</div>`,
      photo: () => '<i class="vm-photo ub-halftone"></i><i class="vm-photo ub-burn"></i>',
      sub: () => ubMarquee("★ OPARTE NA PRAWDZIWYCH WYDARZENIACH ★"),
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame2"></i></div>',
    },
    {
      name: "Flaga przez twarz",
      desc: "Jak na plakacie: pasy flagi przechodzą przez połowę zdjęcia (wypłowiała czerwień na czarno-białej twarzy), w rogu zdjęcia pole z gwiazdami, ramka w czarno-białe ukośne pasy, pasy powoli płyną.",
      bg: () => '<div class="vm-bg"><i class="ub-dark"></i></div>',
      photo: () => `<i class="vm-photo ub-stripes"></i><i class="vm-photo ub-canton">${vmSvg(ubFlag("#b3263a", "#f2f2f2", "#141414", "#f2f2f2"), "0 0 30.4 21.54", "", "xMinYMin slice")}</i><i class="vm-photo ub-grain"></i>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-hazard"></i></div>',
      sub: () => "TO PRAWDZIWA HISTORIA",
    },
    {
      name: "Polaroid 1972",
      desc: "Zdjęcie jako wyblakły polaroid przyklejony taśmą, nazwa jak z maszyny do pisania, przypinka z flagą, co kilka sekund błysk flesza, kurz i rysy.",
      bg: () => `<div class="vm-bg"><i class="ub-cork"></i>${vmScatter(6, "ub-pin")}</div>`,
      photo: () => '<i class="vm-photo ub-fade"></i><i class="vm-photo ub-flash"></i>',
      deco: p => `<div class="vm-deco"><i class="ub-tape a"></i><i class="ub-tape b"></i><i class="ub-badge">${vmSvg(ubFlag("#c8283c", "#f4f4f4", "#1d2a5a", "#f4f4f4"), "0 0 76 40", "", "xMidYMid slice")}</i></div>`,
      sub: () => "COLORADO · JESIEŃ 1972",
    },
    {
      name: "Funk '70s",
      desc: "Groovy lata 70 w szarościach: za zdjęciem powoli obracają się promienie, nazwa grubą funkową czcionką z warstwowym cieniem, migoczące gwiazdy, a pod zdjęciem łopocze wstęga flagi.",
      bg: () => `<div class="vm-bg"><i class="ub-rays"></i>${ubStars(14, "ub-tw")}</div>`,
      photo: () => '<i class="vm-photo ub-grain"></i>',
      sub: () => `<span class="ub-ribbon">${vmSvg(ubFlag("#5a5a5a", "#efefef", "#1a1a1a", "#efefef"), "0 0 76 40", "", "none")}</span><b class="ub-ribbon-t">DIG IT!</b>`,
      deco: () => '<div class="vm-deco ub-clip"><i class="ub-frame5"></i></div>',
    },
    {
      name: "Gazeta",
      desc: "Pierwsza strona gazety: papier gazetowy z kolumnami tekstu w tle, winieta z tytułem i flagą nad nazwą, zdjęcie w rastrze, czerwona pieczątka EXTRA! pulsuje w rogu.",
      top: () => `<div class="ub-mast"><span>THE SCAMBOX TIMES</span><i>${vmSvg(ubFlag("#222", "#f4f0e6", "#111", "#f4f0e6"), "0 0 76 40", "", "xMidYMid slice")}</i><small>WTOREK · 10 PAŹDZIERNIKA 1972 · 25¢</small></div>`,
      bg: () => '<div class="vm-bg"><i class="ub-news"></i><i class="ub-cols"></i></div>',
      photo: () => '<i class="vm-photo ub-halftone dense"></i>',
      deco: () => '<div class="vm-deco"><i class="ub-extra">EXTRA!</i><i class="ub-fold"></i></div>',
      sub: () => "„NIKT BY W TO NIE UWIERZYŁ”",
    },
  ],
};

// ---------------------------------------------------------------- RETRO KOSMOS (nazwa robocza)
// Wczesna eksploracja kosmosu, lata 60 i 70: złoto i srebro, ziarniste nagrania i zdjęcia z misji (krzyżyki na zdjęciach
// z aparatów misji, telewizja z Księżyca), folia termiczna lądownika, pulpity kontroli lotów. Klasy z prefiksem ap-.

const apStars = n => vmScatter(n, "ap-star", () => `--s:${vmN(.4, 1.3, 2)};animation-duration:${vmN(1.6, 4, 1)}s`);
// krzyżyki na kliszy (płytka z siatką w aparacie z misji): siatka 5 x 5 małych "+"
const apReseau = (c = "#fff") => vmSvg(Array.from({ length: 25 }, (_, k) => {
  const x = 6 + (k % 5) * 12, y = 6 + Math.floor(k / 5) * 12;
  return `<path d="M${x - 1.6} ${y}H${x + 1.6}M${x} ${y - 1.6}V${y + 1.6}" stroke="${c}" stroke-width=".35"/>`;
}).join(""), "0 0 60 60", "ap-reseau");
// "mapa pulsarów" ze złotej płyty: linie z jednego punktu z kreskami (zapis binarny) - w jednostkach karty 63 x 88
function apPulsars() {
  let s = "";
  for (let k = 0; k < 14; k++) {
    const a = k * 25.7 * Math.PI / 180 + .2, len = 18 + (k * 7) % 22, x2 = 31.5 + Math.cos(a) * len, y2 = 44 + Math.sin(a) * len;
    s += `<path d="M31.5 44 L${x2.toFixed(1)} ${y2.toFixed(1)}" class="ap-pl"/>`;
    for (let t = 1; t < 7; t++) {
      if ((k * 3 + t * 5) % 3 === 0) continue;
      const px = 31.5 + Math.cos(a) * len * t / 7, py = 44 + Math.sin(a) * len * t / 7, nx = -Math.sin(a) * 1.1, ny = Math.cos(a) * 1.1;
      s += `<path d="M${(px - nx).toFixed(1)} ${(py - ny).toFixed(1)} L${(px + nx).toFixed(1)} ${(py + ny).toFixed(1)}" class="ap-pl"/>`;
    }
  }
  return s;
}
// folia termiczna lądownika: losowe trójkątne fasety w odcieniach złota (za każdym razem inne zgniecenia)
function apFoil() {
  const golds = ["#f5d27a", "#e8b84a", "#c8902a", "#fff0b0", "#b07818", "#ffe08a", "#d9a63c"];
  const pts = [];
  for (let r = 0; r <= 8; r++) for (let c = 0; c <= 6; c++)
    pts.push([c * 10.5 + (c && c < 6 ? rand(-3, 3) : 0), r * 11 + (r && r < 8 ? rand(-3, 3) : 0)]);
  let s = "";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 6; c++) {
    const a = pts[r * 7 + c], b = pts[r * 7 + c + 1], d = pts[(r + 1) * 7 + c], e = pts[(r + 1) * 7 + c + 1];
    const f = (p, q, t) => `<path d="M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}L${t[0].toFixed(1)} ${t[1].toFixed(1)}Z" fill="${vmPick(golds)}"/>`;
    s += f(a, b, e) + f(a, e, d);
  }
  return s;
}
// lampki pulpitu kontroli lotów (każda miga w swoim rytmie)
const apLamps = n => Array.from({ length: n }, () =>
  `<i class="ap-lamp ${vmPick(["amber", "green", "red", "white", "amber"])}" style="animation-delay:-${vmN(0, 3, 1)}s;animation-duration:${vmN(.8, 3.2, 1)}s"></i>`).join("");
// odliczanie T-minus: kolumna cyfr przewijana w CSS (apCount)
const apCount = () => `<span class="ap-count">T−00:00:<span class="ap-digits"><b>10</b><b>09</b><b>08</b><b>07</b><b>06</b><b>05</b><b>04</b><b>03</b><b>02</b><b>01</b><b>00</b><b>10</b></span></span>`;

const VM_APOLLO = {
  key: "apollo", icon: "🚀", name: "Retro kosmos (nazwa robocza)", tag: "◉ MISJA 69",
  about: "wczesna eksploracja kosmosu w latach 60 i 70: złoto i srebro, ziarniste nagrania i zdjęcia z misji, folia lądownika, pulpity kontroli lotów",
  looks: [
    {
      name: "Złota płyta",
      desc: "Czarna karta jak złota płyta wysłana w kosmos: za zdjęciem powoli obraca się wygrawerowany rowek płyty i mapa pulsarów, ramka mieni się złotem, zdjęcie w złotym tonie, po karcie przesuwa się połysk metalu.",
      bg: () => `<div class="vm-bg"><i class="ap-record"></i><i class="ap-pulsars">${vmSvg(apPulsars())}</i>${apStars(10)}</div>`,
      photo: () => '<i class="vm-photo ap-goldtone"></i>',
      deco: () => '<div class="vm-deco ap-clip"><i class="ap-sheen"></i><i class="ap-engrave"></i></div>',
      sub: () => "WIADOMOŚĆ DLA GWIAZD · 1977",
    },
    {
      name: "Transmisja z Księżyca",
      desc: "Ziarnisty czarno-biały obraz z telewizji z Księżyca: linie obrazu, przewijający się pasek zakłóceń, duch obrazu, szum, nad nazwą migające ● NA ŻYWO, srebrna obudowa telewizora.",
      top: () => '<div class="ap-live"><b>● NA ŻYWO</b><span>KSIĘŻYC → ZIEMIA · 10 KL/S</span></div>',
      bg: () => '<div class="vm-bg"><i class="ap-tvbg"></i></div>',
      photo: () => '<i class="vm-photo ap-ghost"></i><i class="vm-photo ap-scan"></i><i class="vm-photo ap-roll"></i><i class="vm-photo ap-noise"></i>',
      deco: () => '<div class="vm-deco ap-clip"><i class="ap-tvframe"></i></div>',
      sub: () => "TRANSMISJA SATELITARNA · 20.07.1969",
    },
    {
      name: "Hasselblad",
      desc: "Klatka z aparatu z misji: na zdjęciu siatka krzyżyków z kliszy, po bokach perforacja filmu, na brzegu numer klatki i dane misji, po zdjęciu przesuwa się odblask słońca w obiektywie.",
      photo: () => `<i class="vm-photo ap-moonfilm"></i><i class="vm-photo">${apReseau()}</i><i class="vm-photo ap-flare"></i>`,
      bg: () => '<div class="vm-bg"><i class="ap-filmbase"></i></div>',
      deco: () => '<div class="vm-deco ap-clip"><i class="ap-sprk l"></i><i class="ap-sprk r"></i><i class="ap-edge l">SCAMBOX 69 · 2137 · KODAK EKTACHROME</i><i class="ap-edge r">KLATKA 40-5903 ▸ 40-5904</i></div>',
      sub: () => "SB-69-2137 · 70 MM",
    },
    {
      name: "Folia termiczna",
      desc: "Cała karta w zgniecionej złotej folii lądownika księżycowego (za każdym razem inaczej pognieciona), po fasetach przesuwa się błysk słońca, panele jak czarne płyty pojazdu z nitami, zdjęcie z ciepłym złotym odblaskiem.",
      bg: () => `<div class="vm-bg"><i class="ap-foil">${vmSvg(apFoil())}</i><i class="ap-foilsheen"></i></div>`,
      photo: () => '<i class="vm-photo ap-goldtone soft"></i>',
      deco: () => `<div class="vm-deco">${["tl", "tr", "bl", "br"].map(c => `<i class="ap-rivet ${c}"></i>`).join("")}</div>`,
      sub: () => "LĄDOWNIK · ORZEŁ WYLĄDOWAŁ",
    },
    {
      name: "Kontrola lotów",
      desc: "Srebrny pulpit z centrum kontroli lotów: rzędy mrugających lampek, wskaźniki z drgającymi wskazówkami, odliczanie T-minus w podpisie, zdjęcie jak na monitorze kontrolnym.",
      top: () => `<div class="ap-panel">${apLamps(12)}</div>`,
      bg: () => '<div class="vm-bg"><i class="ap-brushed"></i></div>',
      photo: () => '<i class="vm-photo ap-monitor"></i><i class="vm-photo ap-scan"></i>',
      deco: () => '<div class="vm-deco"><i class="ap-gauge a"><i></i></i><i class="ap-gauge b"><i></i></i></div>',
      sub: () => apCount(),
    },
    {
      name: "Wschód Ziemi",
      desc: "Czarny kosmos z migoczącymi gwiazdami, z rogu karty wschodzi Ziemia ze złotą poświatą, dookoła karty krąży mały satelita z antenami, zdjęcie w szarym świetle Księżyca, srebrna ramka.",
      bg: () => `<div class="vm-bg"><i class="ap-space"></i>${apStars(28)}<i class="ap-horizon"></i></div>`,
      photo: () => '<i class="vm-photo ap-lunar"></i>',
      deco: () => '<div class="vm-deco"><i class="ap-earth"></i><i class="ap-orbit"><i class="ap-sat"></i></i><i class="ap-silver"></i></div>',
      sub: () => "WSCHÓD ZIEMI · ORBITA KSIĘŻYCA",
    },
  ],
};

// ---------------------------------------------------------------- PROPOZYCJE

const VARIANT_PROPOSALS = [VM_USBW, VM_APOLLO];
