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

// ---------------------------------------------------------------- KOMUNISTYCZNA - runda 3
// Prawdziwy wariant `komuna` jest już w grze (wyłączony, z naklejkami jak MLG, wygląd = makieta 1). Makiety łączą
// wybrane z rundy 2: czysty plakat z promieniami (1.) i stary plakat na murze (6.) - promienie wychodzą teraz z prawej
// strony, wszystko statyczne. Naklejki naklejone na wariant Komunistyczna (/stickers) widać też na makietach (stickers).
// Pokazane na karcie ze Skrzynki PRL (pid). Klasy z prefiksem km-.

const kmStar = (fill = "currentColor") => vmSvg(vmStar(10, 10.6, 9.6, fill), "0 0 20 20", "", "xMidYMid meet");
// nieruchome promienie z punktu (x, y w % karty), co "step" stopni
const kmRays = (x = 108, y = 96, a = "#ff3b30", b = "#b30e16", step = 6) =>
  `<i class="km-rays" style="--x:${x}%;--y:${y}%;--a:${a};--b:${b};--s:${step}deg"></i>`;
// plakat: promienie z prawej, czarny pas, ziarno papieru / zdjęcie w czerwonej farbie / margines i gwiazda
const kmPoster = (rays = kmRays()) => `<div class="vm-bg">${rays}<i class="km-band"></i><i class="km-paper"></i></div>`;
const kmInk = () => '<i class="vm-photo km-ink"></i><i class="vm-photo km-offset"></i>';
const kmFrame = (extra = "") => `<div class="vm-deco"><i class="km-margin"></i><i class="km-star">${kmStar()}</i>${extra}</div>`;
// zniszczenia: zagięcia na krzyż, plamy, taśma w rogach
const kmFold = () => '<i class="km-fold"></i>';
const kmStains = () => '<i class="km-stain"></i>';
const kmTape = (corners = ["tl", "tr", "bl", "br"]) => corners.map(c => `<i class="km-tape ${c}"></i>`).join("");

const VM_KOMUNA = {
  key: "komuna", icon: "☭", name: "Komunistyczna", tag: "★ PRL ★", pid: "prl_bareja", stickers: "komuna",
  about: "runda 3: połączenie czystego plakatu (1.) i starego plakatu na murze (6.), promienie z prawej; prawdziwy wariant już jest w grze (wyłączony) - naklejki dodane na /stickers widać też tutaj",
  looks: [
    {
      name: "Czysty plakat (jak w grze)",
      desc: "Tak wygląda prawdziwy wariant: nieruchome czerwone promienie z prawego dolnego rogu, czarny pas opadający w lewo, kremowy margines papieru, zdjęcie w czerwonej farbie z lekko przesuniętą drugą warstwą, złota gwiazda na lewym rogu zdjęcia.",
      bg: () => kmPoster(), photo: kmInk, deco: () => kmFrame(),
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Wyblakły na murze",
      desc: "Ten sam plakat po latach na murze: wypłowiałe kolory, zagięcia papieru na krzyż, zacieki i przetarcia, wszystkie rogi przyklejone pożółkłą taśmą.",
      bg: () => kmPoster(), photo: kmInk, deco: () => kmFrame(kmFold() + kmStains() + kmTape()),
      cls: "km-faded",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Zdarty róg",
      desc: "Plakat prawie jak nowy, ale prawy górny róg ktoś oderwał - spod spodu widać ceglany mur, a kawałek papieru zawija się do środka. Lekkie zagięcia, taśma tylko na dole.",
      bg: () => kmPoster(), photo: kmInk,
      deco: () => kmFrame(kmFold() + kmTape(["bl", "br"]) + '<i class="km-brick"></i><i class="km-curl"></i>'),
      cls: "km-light",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Strzępy innych plakatów",
      desc: "Plakat na tablicy ogłoszeń: przy brzegach przyklejone strzępy zerwanych plakatów (krem, błękit, żółć) z poszarpanymi krawędziami, pod papierem bąble kleju.",
      bg: () => kmPoster(), photo: kmInk,
      deco: () => kmFrame('<i class="km-under a"></i><i class="km-under b"></i><i class="km-under c"></i><i class="km-glue"></i>'),
      cls: "km-light",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Promienie z gwiazdy",
      desc: "Promienie wychodzą z wielkiej złotej gwiazdy przy prawej krawędzi pod zdjęciem - to ona jest źródłem światła; czarny pas pod nią, lekko wyblakły papier z zagięciami.",
      bg: () => `<div class="vm-bg">${kmRays(92, 66)}<i class="km-band low"></i><i class="km-bigstar">${kmStar()}</i><i class="km-paper"></i></div>`,
      photo: kmInk, deco: () => `<div class="vm-deco"><i class="km-margin"></i>${kmFold()}</div>`,
      cls: "km-light km-short",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
    {
      name: "Przetarty sitodruk",
      desc: "Druk z dwóch matryc, które się rozjechały: promienie z prawej jako rastrowe paski, czarna farba przesunięta względem czerwonej (nazwa i pas z cieniem obok), przetarcia na brzegach i jedno zagięcie.",
      bg: () => `${kmPoster(kmRays())}`,
      photo: () => '<i class="vm-photo km-ink"></i><i class="vm-photo km-offset big"></i><i class="vm-photo km-raster"></i>',
      deco: () => kmFrame('<i class="km-scuff"></i><i class="km-fold one"></i>'),
      cls: "km-misreg",
      sub: () => "NAPRZÓD KU JASNEJ PRZYSZŁOŚCI!",
    },
  ],
};

const VARIANT_PROPOSALS = [VM_KOMUNA];
