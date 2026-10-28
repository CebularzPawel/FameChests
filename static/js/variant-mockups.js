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

// ---------------------------------------------------------------- KOMUNISTYCZNA - runda 4
// Prawdziwy wariant `komuna` jest już w grze (wyłączony, z naklejkami jak MLG). Wybrany czysty plakat (1.) w lekko
// wyblakłych kolorach z 4. wersji poprzedniej rundy - i sześć pomysłów zamiast czarno-żółtego pasa w tle. Naklejki
// z /stickers widać na makietach (stickers). Pokazane na karcie ze Skrzynki PRL (pid). Klasy z prefiksem km-.

const kmStar = (fill = "currentColor") => vmSvg(vmStar(10, 10.6, 9.6, fill), "0 0 20 20", "", "xMidYMid meet");
// nieruchome promienie z prawego dolnego rogu
const kmRays = () => '<i class="km-rays"></i>';
const kmInk = () => '<i class="vm-photo km-ink"></i><i class="vm-photo km-offset"></i>';
const kmFrame = () => `<div class="vm-deco"><i class="km-margin"></i><i class="km-star">${kmStar()}</i></div>`;
// tło: promienie + to, co zamiast pasa + ziarno papieru
const kmBg = (extra = "") => `<div class="vm-bg">${kmRays()}${extra}<i class="km-paper"></i></div>`;
// sylwetka pochodu: maszty ze sztandarami (jednostki karty 63 x 88, sztandary w pasie pod zdjęciem, ziemia y = 78)
const kmBanners = (c = "#3a0608") => vmSvg(`<g fill="${c}">${[[4, 57, 1], [14, 60, -1], [23, 56, 1], [33, 59, 1], [43, 56.5, -1], [52, 60, 1], [60, 57, -1]].map(([x, y, d]) =>
  `<rect x="${x}" y="${y}" width=".7" height="${78 - y}"/><path d="M${x + (d > 0 ? .7 : 0)} ${y} q${d * 4} -1 ${d * 7} 1.2 v6 q${-d * 3} -1.4 ${-d * 7} -.6 Z"/>`).join("")}
  <path d="M-2 78 q4 -4 8 0 q4 -5 8 0 q4 -4 8 0 q4 -5 8 0 q4 -4 8 0 q4 -5 8 0 q4 -4 8 0 q4 -5 8 0 V88 H-2 Z"/></g>`, "0 0 63 88", "km-svg");
// sylwetka fabryki (ziemia y = 76)
const kmFactory = (c = "#3a0608") => vmSvg(`<g fill="${c}"><path d="M-1 76 V64 L5 60 V64 L11 60 V64 L17 60 V64 L23 60 V76 Z"/>
  <rect x="26" y="46" width="2.8" height="30"/><rect x="32" y="40" width="3.2" height="36"/><rect x="39" y="50" width="2.6" height="26"/>
  <path d="M24 76 V66 H46 V76 Z M46 76 V58 H54 V76 Z M54 76 V70 H64 V76 Z"/><path d="M-2 76 H66 V88 H-2 Z"/></g>
  <g fill="${c}" opacity=".45"><circle cx="29" cy="43" r="2.4"/><circle cx="31" cy="39.5" r="3"/><circle cx="34" cy="35.5" r="3.4"/><circle cx="40" cy="47" r="2.2"/></g>`, "0 0 63 88", "km-svg");

const VM_KOMUNA = {
  key: "komuna", icon: "☭", name: "Komunistyczna", tag: "★ PRL ★", pid: "prl_bareja", stickers: "komuna",
  about: "runda 4: czysty plakat w lekko wyblakłych kolorach - sześć pomysłów zamiast czarno-żółtego pasa; naklejki z /stickers widać też tutaj",
  looks: [
    {
      name: "Same promienie",
      desc: "Bez pasa: nieruchome promienie z prawego dolnego rogu przez całe tło, przy dole karty ciemniejsza czerwień (jak farba gęściej nałożona), kolory lekko wyblakłe.",
      bg: () => kmBg('<i class="km-dark"></i>'), photo: kmInk, deco: kmFrame,
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Bordowy pas",
      desc: "Zamiast czarno-żółtego - szeroki pas w ciemnym bordo, bez obwódki, prawie ton w ton z promieniami (spokojniejszy, jak druga farba na plakacie).",
      bg: () => kmBg('<i class="km-band2"></i>'), photo: kmInk, deco: kmFrame,
      cls: "km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Hasło na kremowym pasie",
      desc: "Pas z kremowego papieru (jak margines plakatu), a na nim czerwone hasło „NAPRZÓD!” powtarzane przez całą szerokość - pas widać pod zdjęciem.",
      bg: () => kmBg(`<i class="km-slogan"><b>NAPRZÓD! ★ NAPRZÓD! ★ NAPRZÓD! ★ NAPRZÓD!</b></i>`), photo: kmInk, deco: kmFrame,
      cls: "km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Pochód ze sztandarami",
      desc: "Pod zdjęciem ciemnobordowa sylwetka pochodu pierwszomajowego: tłum i maszty z powiewającymi sztandarami na tle promieni.",
      bg: () => kmBg(kmBanners()), photo: kmInk, deco: kmFrame,
      cls: "km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Fabryka",
      desc: "Pod zdjęciem ciemnobordowa sylwetka fabryki - hale z szedami, kominy z dymem - promienie wychodzą zza niej jak wschód słońca nad zakładem.",
      bg: () => kmBg(kmFactory()), photo: kmInk, deco: kmFrame,
      cls: "km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Wielka gwiazda",
      desc: "Zamiast pasa - wielka gwiazda w ciemnym bordo z cienką złotą obwódką, częściowo schowana za zdjęciem i panelami; promienie rozchodzą się za nią.",
      bg: () => kmBg(`<i class="km-bigstar">${kmStar()}</i>`), photo: kmInk, deco: kmFrame,
      cls: "km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
  ],
};

const VARIANT_PROPOSALS = [VM_KOMUNA];
