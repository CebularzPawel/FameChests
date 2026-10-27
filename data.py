"""Dane gry: rzadkości, skrzynki i karty.

To są DOMYŚLNE karty i skrzynki. Karty i skrzynki dodane/zmienione w panelu admina (/admin)
są zapisywane w bazie i nakładane na te dane (patrz catalog.py).
Pola osoby:
    id      - unikalny identyfikator (nie zmieniaj go, jeśli masz już takie karty w klaserze)
    name    - wyświetlana nazwa
    wiki    - (język wikipedii, tytuł artykułu) - stąd pobierane jest zdjęcie
    rarity  - green / blue / purple / red / gold / ultra / secret
    type    - kategoria (klucz z TYPES)
    hp      - punkty życia na karcie
    attack  - (nazwa ataku, obrażenia)
"""

STARTING_BALANCE = 20_000
CRATE_PRICE = 100
MAX_OPEN = 20

# Warianty kart: szansa na wariant przy każdym dropie i mnożnik wartości
VARIANTS = {
    "normal":  {"name": "Zwykła",       "chance": 0.0,   "mult": 1.0},
    "bw":      {"name": "Czarno-biała", "chance": 0.05,  "mult": 1.5},
    "reverse": {"name": "Reverse Holo", "chance": 0.05,  "mult": 1.8},
    # "off": wariant domyślnie WYŁĄCZONY - nie wypada nigdzie, dopóki admin nie włączy go (albo nie zaplanuje wydarzenia)
    # na stronie /variants (catalog.variant_enabled, ustawienia w tabeli catalog_variants)
    "bronze":  {"name": "Brązowa",      "chance": 0.04,  "mult": 2.0, "off": True,
                "desc": "Karta z brązu - ciepły, ciemniejszy metal, najczęstszy z metalowych wariantów."},
    "silver":  {"name": "Srebrna",      "chance": 0.03,  "mult": 2.5},
    "steel":   {"name": "Stalowa",      "chance": 0.02,  "mult": 4.5, "off": True,
                "desc": "Szczotkowana stal: ramka z blachy ryflowanej, śruby w rogach, zimne stalowe zdjęcie i światło przesuwające się po metalu."},
    "holo":    {"name": "Holo",         "chance": 0.025, "mult": 3.0},
    "pearl":   {"name": "Perłowa",      "chance": 0.015, "mult": 5.0, "off": True,
                "desc": "Cała karta z masy perłowej - mleczna biel z różowo-miętowo-błękitnymi refleksami, które przesuwają się po karcie."},
    "gold":    {"name": "Złota",        "chance": 0.01,  "mult": 7.5},
    "platinum": {"name": "Platynowa",   "chance": 0.006, "mult": 10.0, "off": True,   # metale: najdroższy po Złotej
                "desc": "Karta z platyny - jasny, chłodny metal o mocniejszym połysku niż srebro, z delikatnym błękitno-fioletowym refleksem."},
    "vintage": {"name": "Vintage",      "chance": 0.008, "mult": 8.5, "off": True,
                "desc": "Fotografia z XIX wieku: zdjęcie w sepii na kremowym kartonie ze złoconym brzegiem i pieczątką atelier."},
    # wyjątkowy: tylko ze skrzynek z tym wariantem, karta musi mieć ustawiony kraj (pole "country").
    # "layer": osobna warstwa - flagowa karta może mieć DODATKOWO inny wariant (extraChance, patrz niżej)
    "flag":    {"name": "Flagowa",      "chance": 0.008, "mult": 8.0, "exclusive": True, "layer": True, "extraChance": 0.4,
                "desc": "Karta w barwach flagi swojego kraju. Każda karta w skrzynce potrzebuje ustawionego kraju (np. PL). "
                        "40% flagowych kart ma dodatkowo inny wariant (np. Flagowa + Złota)."},
    # Halloweenowe (wyjątkowe, warstwowe, "always"): w skrzynce z nimi KAŻDA karta dostaje jeden z nich - losowany według
    # "weight" spośród włączonych w skrzynce - a do tego normalnie losuje się zwykły wariant (np. Halloweenowa + Złota).
    # "noCombo": ten wariant NIE łączy się z innymi (Lampionowa / Diabelska są zawsze same - tylko Halloweenowa łączy się).
    # "photo": karta może mieć własne zdjęcie w tym wariancie (panel admina); "photoFallback": gdy go brak - zdjęcie
    # z tamtego wariantu (Lampionowa / Diabelska -> Halloweenowa), a gdy i tego brak - zwykłe.
    "halloween": {"name": "Halloweenowa", "chance": 0.0, "mult": 1.0, "exclusive": True, "layer": True, "always": True,
                  "weight": 85, "photo": True,
                  "desc": "Noc z księżycem, dynie-lampiony, czaszka i nietoperze. Najczęstszy z wariantów halloweenowych."},
    "lantern":   {"name": "Lampionowa", "chance": 0.0, "mult": 2.0, "exclusive": True, "layer": True, "always": True,
                  "weight": 12, "photo": True, "photoFallback": "halloween", "noCombo": True,
                  "desc": "Karta w blasku świecy z dyni: zdjęcie w pomarańczowym świetle, migoczący blask, iskry."},
    "devil":     {"name": "Diabelska", "chance": 0.0, "mult": 4.0, "exclusive": True, "layer": True, "always": True,
                  "weight": 3, "photo": True, "photoFallback": "halloween", "noCombo": True,
                  "desc": "Najrzadszy wariant halloweenowy - piekielny ogień, rogi i czerwona poświata."},
    "popart":  {"name": "Pop-art",      "chance": 0.007, "mult": 8.0, "off": True,
                "desc": "Jak sitodruk Warhola: zdjęcie cztery razy w jaskrawych kolorach, żółte tło w czerwone kropki i komiksowe okienka."},
    "clear":   {"name": "Przezroczysta", "chance": 0.006, "mult": 9.0},
    "pixel":   {"name": "Pikselowa",    "chance": 0.005, "mult": 9.5, "off": True,
                "desc": "16-bitowa gra RPG: zdjęcie z dużych pikseli, niebieskie okienka z białą ramką, pasek HP i migająca strzałka."},
    "sketch":  {"name": "Rysunkowa",    "chance": 0.004, "mult": 10.0,
                "desc": "Karta narysowana piórem i tuszem na starym papierze."},
    "emerald": {"name": "Szmaragdowa",  "chance": 0.005, "mult": 11.0},
    # wyjątkowy, domyślnie w ŻADNEJ skrzynce - admin włącza go w nowej skrzynce. "stickers": admin może nakleić na ten
    # wariant własne grafiki (PNG) albo wbudowane (static/img/mlg/) i ustawić je, gdzie chce - strona /stickers
    "mlg":     {"name": "MLG",          "chance": 0.005, "mult": 12.0, "exclusive": True, "stickers": True,
                "desc": "Jak montaże „MLG” z 2014: tęczowa ramka, hitmarkery, napisy WOW i 360 NO SCOPE, oko Illuminati."},
    "neon":    {"name": "Neonowa",      "chance": 0.005, "mult": 10.0, "off": True,
                "desc": "Kontury twarzy jak świecące neonowe rurki, neonowa rurka dookoła karty i wszystkie napisy w neonowym stylu - co chwilę brzęczą i przygasają."},
    "thermal": {"name": "Termowizyjna", "chance": 0.005, "mult": 10.5, "off": True,
                "desc": "Obraz z kamery termowizyjnej: twarz świeci ciepłem, a po tle karty przesuwają się ciepłe plamy."},
    "blueprint": {"name": "Blueprint", "chance": 0.005, "mult": 9.0, "off": True,
                "desc": "Plan inżynierski: kontur twarzy białą kreską na niebieskim papierze z siatką, linie wymiarowe i tabelka rysunkowa."},
    "glitch":  {"name": "Glitch",       "chance": 0.004, "mult": 11.5, "off": True,
                "desc": "Uszkodzony plik: bloki pikseli w złych kolorach, przesunięte wiersze i obraz, który co chwilę się psuje na nowo."},
    "mosaic":  {"name": "Mozaikowa",    "chance": 0.006, "mult": 9.5, "off": True,
                "desc": "Portret z klocków z nopkami w kolorach klocków - czerwone, niebieskie, żółte - na zielonej płycie, w żółtej ramce."},
    "noir":    {"name": "Noir",         "chance": 0.006, "mult": 8.0, "off": True,
                "desc": "Klatka starego czarno-białego filmu: perforacja taśmy, rysy i kurz, migotanie, deszcz w tle i napis jak z napisów do filmu."},
    "glass":   {"name": "Witrażowa",    "chance": 0.004, "mult": 12.0, "off": True,
                "desc": "Lampa Tiffany: zdjęcie i całe tło z setek kawałków kolorowego szkła w chłodnych barwach, rozdzielonych ołowianymi liniami."},
    "marble":  {"name": "Marmurowa",    "chance": 0.005, "mult": 11.5, "off": True,
                "desc": "Biały marmur z szarymi żyłkami i złotymi liniami, a zdjęcie zamienia się w marmurowy posąg."},
    "amethyst": {"name": "Ametystowa",  "chance": 0.0045, "mult": 12.5},   # między Szmaragdową a Rubinową
    "toxic":   {"name": "Toksyczna",    "chance": 0.004, "mult": 13.0, "off": True,
                "desc": "Radioaktywny szlam: ciemna karta, jarzący się zielony glut, bąbelki, kałuża i taśma ostrzegawcza."},
    "ruby":    {"name": "Rubinowa",     "chance": 0.004, "mult": 14.0},
    "sapphire": {"name": "Szafirowa",   "chance": 0.0035, "mult": 16.0, "off": True,   # kamienie szlachetne: ciemny niebieski
                "desc": "Głęboki, ciemny błękit szafiru: pryzmatyczna obracająca się ramka, fasety, niebieskie zdjęcie i błyski."},
    "royal":   {"name": "Królewska",    "chance": 0.004, "mult": 15.0, "exclusive": True,   # wyjątkowy (Skrzynia Królów)
                "desc": "Ozdobna złota rama z ornamentami i złota korona na górze."},
    "diamond": {"name": "Diamentowa",   "chance": 0.003, "mult": 18.0},
    "blackdiamond": {"name": "Czarny diament", "chance": 0.0015, "mult": 24.0, "off": True,
                "desc": "Najrzadszy z kamieni: czarny diament - ciemne fasety, srebrno-czarna obracająca się ramka i białe błyski."},
    "galaxy":  {"name": "Galaktyczna",  "chance": 0.002, "mult": 20.0,
                "desc": "Kosmiczna karta: mgławice, gwiazdy i świecąca ramka."},
    "negative": {"name": "Negatyw",     "chance": 0.001, "mult": 30.0},
    # warianty z makiet wybranych na /variants (Propozycje) - domyślnie wyłączone ("off"), wygląd w cards2.css i app.js (VX_*)
    "cheese":  {"name": "Serowa",       "chance": 0.02,  "mult": 4.0, "off": True,
                "desc": "Żółty ser z dziurami, roztopiony ser kapiący z góry i trochę szlachetnej pleśni przy brzegach."},
    "matte":   {"name": "Matowa czerń", "chance": 0.012, "mult": 6.0, "off": True,
                "desc": "Ziarnista czarna skóra z przeszyciem wzdłuż brzegu, wytłoczone zdjęcie i błysk przesuwający się po nazwie."},
    "racing":  {"name": "Wyścigowa retro", "chance": 0.01, "mult": 7.0, "off": True,
                "desc": "Ramka w czerwono-kremową szachownicę, pas czerwony-biały-czerwony i białe koło z numerem jak na bolidzie z lat 50."},
    "fade":    {"name": "Gradient",     "chance": 0.007, "mult": 9.0, "off": True,
                "desc": "Klasyczny fade: żółty, pomarańczowy, różowy, fiolet i błękit płynnie przechodzą przez całą metaliczną kartę."},
    "slime":   {"name": "Szlamowa",     "chance": 0.006, "mult": 9.5, "off": True,
                "desc": "Dolna część karty pływa w szlamie z falującą powierzchnią i bąbelkami, z góry kapie glut, zdjęcie lekko zielone."},
    "wanted":  {"name": "Wanted",       "chance": 0.006, "mult": 10.5, "off": True,
                "desc": "Przypalony list gończy z dziurami po kulach: WANTED, DEAD OR ALIVE i nagroda w wysokości wartości karty."},
    "digital": {"name": "Cyfrowa",      "chance": 0.004, "mult": 13.5, "off": True,
                "desc": "Okno terminala hakera: za kartą lecą zielone znaki, nazwa pisze się i kasuje, zdjęcie z pikseli w zielonym monitorze."},
    "artdeco": {"name": "Art déco",     "chance": 0.004, "mult": 14.5, "off": True,
                "desc": "Czerń ze złotymi wachlarzami art déco, podwójnymi złotymi liniami i nazwą jak ze złotej folii."},
    "cyber":   {"name": "Cyberpunk",    "chance": 0.0035, "mult": 16.0, "off": True,
                "desc": "Nocne miasto z neonowymi oknami, deszcz w świetle różu i błękitu, zdjęcie w dwóch neonowych kolorach."},
    "bismuth": {"name": "Bizmutowa",    "chance": 0.003, "mult": 17.0, "off": True,
                "desc": "Trójwymiarowe schodki kryształu bizmutu na całym tle, mieniące się tęczowo, z obracającą się tęczową ramką."},
    # "stickers": "under" - admin dokleja grafiki na tło karty (pod zdjęciem i napisami), strona /stickers
    "honey":   {"name": "Miodowa",      "chance": 0.015, "mult": 5.5, "off": True,
                "desc": "Błyszczący plaster miodu, gęsty miód kapiący z góry karty i przelatujące pszczoły."},
    "aero":    {"name": "Frutiger Aero", "chance": 0.008, "mult": 8.0, "off": True,
                "desc": "Jak tapety z 2008: rybki pływają po niebie między chmurami i bańkami, na dole błyszcząca zielona łąka ze stokrotkami."},
    "chinese": {"name": "Chińska",      "chance": 0.0035, "mult": 15.5, "off": True, "stickers": "under",
                "desc": "Czerwień ze złotem: kołyszące się czerwone lampiony ze złotymi frędzlami i złote chmurki."},
    # trzecia partia makiet z /variants
    "moro":    {"name": "Moro",         "chance": 0.016, "mult": 5.0, "off": True,
                "desc": "Leśne moro, ramka z oliwkowego płótna z przeszyciem i nieśmiertelniki z nazwą karty na łańcuszku."},
    "beer":    {"name": "Piwna",        "chance": 0.012, "mult": 6.5, "off": True,
                "desc": "Zimne piwo w zaparowanym szkle: bąbelki wznoszące się z dna, gęsta piana u góry i krople rosy, które co chwilę spływają."},
    "electric": {"name": "Elektryczna", "chance": 0.006, "mult": 10.0, "off": True,
                "desc": "Burzowe niebo z deszczem: co chwilę uderza piorun z odgałęzieniami, a cała karta na moment się rozjaśnia."},
    "synthwave": {"name": "Synthwave",  "chance": 0.005, "mult": 11.5, "off": True,
                "desc": "Obraz z kasety VHS: PLAY i licznik, pasy zakłóceń, rozjechane kolory zdjęcia, a na dole zachodzi słońce w paski."},
    "motor":   {"name": "Motoryzacyjna", "chance": 0.0045, "mult": 12.5, "off": True,
                "desc": "Zdjęcie w środku obrotomierza: wskazówka wkręca się na czerwone pole i odbija od ogranicznika, miga lampka zmiany biegu, dookoła karbon."},
    # piąta partia makiet z /variants
    "chocolate": {"name": "Czekoladowa", "chance": 0.012, "mult": 6.5, "off": True,
                "desc": "Tabliczka czekolady w złotku: wypukłe kostki z połyskiem, ramka z pogniecionej złotej folii, zdjęcie w ciepłym brązie."},
    "candy":   {"name": "Cukierkowa",   "chance": 0.01, "mult": 7.0, "off": True,
                "desc": "Sklep ze słodyczami: przesuwające się paski markizy i falbanka nad nazwą, ramka w paski laski cukrowej, sypiąca się posypka i migoczący cukier."},
    "hollywood": {"name": "Hollywood '69", "chance": 0.005, "mult": 11.5, "off": True,
                "desc": "Seans o zmierzchu w Los Angeles 1969: snopy reflektorów, palmy na tle nieba, zdjęcie jak malowany plakat filmowy i migotanie starej taśmy."},
    "cobalt":  {"name": "Kobaltowa",    "chance": 0.007, "mult": 9.0, "off": True,
                "desc": "Kobalt-60 w basenie reaktora: ciemna woda, z dołu pulsuje niebieska poświata Czerenkowa, a po karcie faluje odbite światło."},
    # szósta partia makiet z /variants
    "banana":  {"name": "Bananowa",     "chance": 0.013, "mult": 6.0, "off": True,
                "desc": "Banan dojrzewa na oczach: karta i ramka przechodzą z zieleni przez żółć i brązowe plamki do brązu, a podpis zmienia się razem z nimi."},
    "uranium": {"name": "Uranowa",      "chance": 0.006, "mult": 10.0, "off": True,
                "desc": "Zielone szkło uranowe świecące w UV: pęcherzyki, pulsująca poświata, a zdjęcie zamienia się w zielone światło."},
    "mercury": {"name": "Rtęciowa",     "chance": 0.008, "mult": 8.5, "off": True,
                "desc": "Płynne srebro: przelewające się lustrzane plamy, chromowe sople, z których kapią krople, i kałuża rtęci na dole."},
    "californium": {"name": "Kalifornowa", "chance": 0.003, "mult": 16.0, "off": True,
                "desc": "Źródło neutronów: za zdjęciem rozżarzony do białości rdzeń, z którego na wszystkie strony lecą srebrne smugi neutronów."},
    "files":   {"name": "Akta",         "chance": 0.009, "mult": 7.5, "off": True,
                "desc": "Tekturowa teczka ze ściśle tajnymi aktami: zakładka z sygnaturą, zdjęcie przypięte spinaczem, czerwona pieczątka ŚCIŚLE TAJNE i napisy z maszyny do pisania."},
    "copper":  {"name": "Miedziana",    "chance": 0.012, "mult": 6.5, "off": True,
                "desc": "Szczotkowana miedź, która na oczach pokrywa się patyną: ciemnieje, wykwitają zielone plamy, a ramka i zdjęcie zielenieją razem z nią - i znów lśni."},
    "reflective": {"name": "Odblaskowa", "chance": 0.014, "mult": 5.5, "off": True,
                "desc": "Świecąca fluorescencyjna żółć jak kamizelka odblaskowa; gdy przelatuje światło reflektora, srebrne pasy rozbłyskują, a karta jarzy się mocniej."},
    "apollo":  {"name": "Apollo",       "chance": 0.005, "mult": 10.0, "off": True,
                "desc": "Retro kosmos: w tle prawdziwy film z Apollo 11, złoto-srebrna klisza, krzyżyki pomiarowe na zdjęciu i zegar misji nad nazwą."},
    "usa":     {"name": "Amerykańska",  "chance": 0.006, "mult": 9.0, "off": True,
                "desc": "Czarno-biały plakat filmu „opartego na faktach”: przekrzywiona flaga USA powiewa w tle, szare pasy płyną przez zdjęcie, w rogu pole z gwiazdami, ramka w ukośne pasy."},
    # wariant jednej karty (pole "cards"): Jan Paweł II. Tajna karta wypada raz na 2137 skrzynek, więc Negatyw JP2 to
    # 1 na 2 137 000 skrzynek - Rzulty ma być trochę rzadszy: 1 na 2 137 420 (szansa na wariant przy wypadnięciu JP2).
    # Może mieć własne zdjęcie (panel admina, edycja karty).
    "rzulty":  {"name": "Rzulty",       "chance": 2137 / 2_137_420, "mult": 31.0, "exclusive": True, "cards": ["pl_secret"],
                "desc": "Wariant tylko jednej karty (Jan Paweł II) - własne zdjęcie."},   # najrzadszy
    # warianty kart SPECJALNYCH (rzadkość "special"): karta specjalna istnieje tylko w jednym wariancie, który admin wybiera
    # w panelu (pole karty "fixedVariant") razem z wyglądem ("style", numer od 1, makiety: /mockups). Nie wypadają ze skrzynek.
    # Jokerowa ma jeden wygląd "Talia Kasynowa": karta do gry na zielonym suknie, czapka i żetony na marginesach
    # (static/css/joker-talia.css, jokerDeco w app.js) - dawne wyglądy 1-6 (special.css) zastąpione
    "joker":   {"name": "Jokerowa",     "chance": 0.0, "mult": 1.0, "exclusive": True, "special": True,
                "styles": ["Talia Kasynowa"],
                "desc": "Karta jak Joker z talii kart na zielonym suknie kasyna - indeksy JOKER z czapką błazna i żetony."},
    "jeans":   {"name": "Dżinsowa",     "chance": 0.0, "mult": 1.0, "exclusive": True, "special": True,
                "styles": ["Klasyczny dżins"],
                "desc": "Karta z dżinsu - pomarańczowe przeszycia i miedziane nity."},
    # wariant karty z UFO (źródło "ufo", karta "placeholder"): szary nieregularny ośmiokąt "Pustka" (static/css/ufo.css,
    # ufoDeco w app.js). Nazwa i napis rzadkości ("rarityName" zamiast "Specjalna") w alfabecie obcych.
    "ufo":     {"name": "⎍⎎⍜⌰⎍⎅", "chance": 0.0, "mult": 1.0, "exclusive": True, "special": True,
                "rarityName": "⌇⌿⟒☊⟊⏃⌰⋏⏃",
                "styles": ["Pustka"],
                "desc": "Karta nie z tej planety - szary nieregularny ośmiokąt, plaster heksagonów i znak obcych."},
}
# Warstwy (na razie tylko Flagowy): wszystkie warianty leżą na jednej warstwie, a flaga na osobnej. Gdy wypadnie
# flagowa karta, z szansą "extraChance" dostaje jeszcze jeden wariant - losowany z tymi samymi szansami co zwykle
# (spośród wariantów dostępnych w tej skrzynce). Taki wariant zapisujemy jako "flag+gold": wygląd obu wariantów,
# nazwa "Flagowa + Złota", mnożnik wartości = iloczyn (×8 · ×7,5 = ×60). Tych połączeń nie losujemy osobno ("combo").
# Połączenia warstw z "noCombo" (Lampionowa / Diabelska) też istnieją - tylko dla kart, które wypadły przed tą zmianą.
for _layer in [v for v, x in VARIANTS.items() if x.get("layer")]:
    for _base, _x in list(VARIANTS.items()):
        if _base == "normal" or _x.get("layer") or _x.get("combo") or _x.get("special"):
            continue
        VARIANTS[f"{_layer}+{_base}"] = {
            "name": f"{VARIANTS[_layer]['name']} + {_x['name']}", "chance": 0.0,
            "mult": round(VARIANTS[_layer]["mult"] * _x["mult"], 2), "exclusive": True, "combo": True,
            "layers": [_layer, _base]}
VARIANT_ORDER = sorted(VARIANTS, key=lambda v: VARIANTS[v]["mult"])   # od najtańszego do najdroższego
# Ustawienia wariantów z panelu admina (/variants, catalog.rebuild) nadpisują w VARIANTS szansę, wagę, opis i mnożnik
# wartości - tu zostają wartości z kodu, do których wraca "Przywróć domyślne"
VARIANT_DEFAULTS = {v: {"chance": x["chance"], "weight": x.get("weight"), "desc": x.get("desc", ""), "mult": x["mult"]}
                    for v, x in VARIANTS.items() if not x.get("combo")}
VARIANT_MULT_MAX = 1000     # najwyższy mnożnik wartości wariantu ustawiany w panelu
VARIANT_EVENT_MAX = 40      # najwięcej wydarzeń (wariant na czas) zapisanych przy jednym wariancie
VARIANT_BOOST_MAX = 50      # najwyższy mnożnik szansy w wydarzeniu
VARIANT_CHANCE_MAX = 0.2    # najwyższa szansa na jeden wariant ustawiana w panelu (20%)
# Warianty wyjątkowe ("exclusive"): nie da się ich dostać z kontraktu, ulepszacza ani kasyna.
EXCLUSIVE_VARIANTS = [v for v, x in VARIANTS.items() if x.get("exclusive")]
# Warianty przypinane do skrzynek (strona Warianty i edycja skrzynki w panelu admina): KAŻDY wariant wypada tylko ze
# skrzynek, do których jest przypięty (pole skrzynki "variants") - poza połączeniami, wariantami kart specjalnych
# i wariantami konkretnych kart ("cards"). Nowy wariant nie jest przypięty nigdzie.
CRATE_VARIANTS = [v for v, x in VARIANTS.items() if v != "normal" and not x.get("cards") and not x.get("combo")
                  and not x.get("special")]
SPECIAL_VARIANTS = [v for v, x in VARIANTS.items() if x.get("special")]   # warianty kart specjalnych (do wyboru w panelu)
STICKER_VARIANTS = [v for v, x in VARIANTS.items() if x.get("stickers")]  # warianty z naklejkami od admina (/stickers)
# Naklejki: wbudowane grafiki (static/img/mlg/<id>.svg) - do wyboru obok własnych plików PNG
STICKER_LIBRARY = {
    "glasses": "Okulary „deal with it”", "illuminati": "Oko Illuminati", "hitmarker": "Hitmarker", "scope": "Celownik",
    "chip": "Chips nacho", "soda": "Zielona puszka", "airhorn": "Trąbka", "wow": "Napis WOW", "noscope": "360 NO SCOPE",
}
STICKER_ANIMS = {"none": "Bez ruchu", "pulse": "Pulsowanie", "spin": "Obrót", "shake": "Trzęsienie", "float": "Unoszenie",
                 "drop": "Spada z góry (okulary)", "blink": "Miganie"}
STICKER_MAX = 30   # najwięcej naklejek na jednym wariancie


# Warianty z kreatora w panelu admina (strona /designer): klucz "cv_<nazwa>", projekt w tabeli catalog_variants (pole
# "custom"). catalog.rebuild woła register_custom_variants - wariant trafia do VARIANTS (zawsze "off" - włącza się go
# w zakładce Warianty, z naklejkami jak MLG), razem z połączeniami z warstwami (flag+cv_...), a listy wyliczane z VARIANTS
# są przeliczane W MIEJSCU (app.py importuje je po nazwie).
CUSTOM_PREFIX = "cv_"
CUSTOM_VARIANT_MAX = 60   # najwięcej wariantów z kreatora


def register_custom_variants(designs):
    """designs: {klucz: oczyszczony projekt (catalog.clean_custom_variant)} - podmienia wszystkie warianty z kreatora."""
    gone = [k for k, x in VARIANTS.items() if x.get("custom") or any(VARIANTS.get(p, {}).get("custom") for p in x.get("layers", []))]
    for k in gone:
        del VARIANTS[k]
        VARIANT_DEFAULTS.pop(k, None)
    for k, d in designs.items():
        VARIANTS[k] = {"name": d["name"], "chance": d["chance"], "mult": d["mult"], "off": True, "custom": True,
                       "stickers": True, "desc": d["desc"]}
        VARIANT_DEFAULTS[k] = {"chance": d["chance"], "weight": None, "desc": d["desc"], "mult": d["mult"]}
    for layer in [v for v, x in VARIANTS.items() if x.get("layer")]:
        for base in designs:
            VARIANTS[f"{layer}+{base}"] = {
                "name": f"{VARIANTS[layer]['name']} + {VARIANTS[base]['name']}", "chance": 0.0,
                "mult": round(VARIANTS[layer]["mult"] * VARIANTS[base]["mult"], 2), "exclusive": True, "combo": True,
                "layers": [layer, base]}
    VARIANT_ORDER[:] = sorted(VARIANTS, key=lambda v: VARIANTS[v]["mult"])
    EXCLUSIVE_VARIANTS[:] = [v for v, x in VARIANTS.items() if x.get("exclusive")]
    CRATE_VARIANTS[:] = [v for v, x in VARIANTS.items() if v != "normal" and not x.get("cards") and not x.get("combo")
                         and not x.get("special")]
    STICKER_VARIANTS[:] = [v for v, x in VARIANTS.items() if x.get("stickers")]
    CASINO_VARIANTS[:] = [v for v in VARIANT_ORDER if v == "normal" or (VARIANTS[v]["chance"] > 0 and not VARIANTS[v].get("exclusive"))]


def combine_variant(layer, base):
    """Wariant-warstwa (flaga) + zwykły wariant: "flag" + "gold" -> "flag+gold" (+ zwykła = sama flaga)."""
    return layer if base == "normal" else f"{layer}+{base}"


def card_variants(pid):
    """Warianty przypisane tylko do tej karty (np. Rzulty dla Jana Pawła II) - mogą mieć własne zdjęcie."""
    return [v for v, x in VARIANTS.items() if pid in (x.get("cards") or [])]
# domyślne warianty wyjątkowe skrzynek - dopóki admin nie zapisze w panelu własnego wyboru (skrzynka bez "variantsAll"
# dostaje do nich jeszcze włączone zwykłe warianty - catalog.chosen_crate_variants)
DEFAULT_CRATE_VARIANTS ={"skrzynia_krolow": ["royal"], "halloween": ["halloween", "lantern", "devil"]}
# wbudowane skrzynki dodane po tym, jak admini zaczęli edytować karty (catalog.rebuild dopisuje ich karty "shared"
# także do kart zapisanych wcześniej w panelu)
CRATES_ADDED_LATER = {"halloween"}

# Kuźnia - kontrakt: ile kart danej rzadkości daje 1 kartę rzadkości wyższej
# Liczby dobrane tak, żeby kontrakt NIE dawał zysku: średnio zwraca 81-87% wartości włożonych kart (jak ulepszacz <= 90%).
# Wcześniej (3 karty, bonus 50%) zwracał 146-162% - dało się zarabiać bez końca: skrzynki -> kontrakty -> sprzedaż.
# Przy zmianie wartości rzadkości / wariantów trzeba to przeliczyć.
CONTRACT_SIZE = {"green": 5, "uncommon": 5, "blue": 5, "purple": 6, "red": 6, "gold": 7}   # tajnych kart nie da się wytworzyć
# (wynikiem kontraktu jest następna rzadkość, która ma karty - pusta rzadkość, np. Niepospolita bez kart, jest pomijana)
CONTRACT_VARIANT_BONUS = 0.1   # każda karta w specjalnym wariancie zwiększa szanse na wariant o 10%
# Kasyno - ulepszacz "w ciemno": gracz wybiera tylko mnożnik wkładu (UPGRADE_MULTS), cel to losowa karta o najniższej
# wartości >= wkład × mnożnik - widać ją dopiero po wygranej. Szansa = wkład / wartość celu * UPGRADE_EDGE (max UPGRADE_MAX)
UPGRADE_EDGE = 0.9
UPGRADE_MAX = 0.8
UPGRADE_MAX_ITEMS = 10
UPGRADE_MULTS = [1.5, 2, 3, 5, 10, 20]

# Warianty usunięte z gry: przy starcie serwera karty graczy w nich stają się zwykłe (z połączenia zostaje warstwa,
# np. "flag+greek" -> "flag"), a wpisy w klaserze i Hall of Fame znikają - drop_removed_variants w app.py / startup.rs
REMOVED_VARIANTS = ["emo", "street", "greek", "dollar", "african"]
MAX_DEPOSIT = 1_000_000

# Skrzynki z pieniędzmi (codzienna nagroda za logowanie).
# Wylosowana kwota = min + (max - min) * los^curve  ->  im większe curve, tym rzadsze wysokie kwoty.
# (wersja 10: codzienna 5-20 tys. gr, MEGA 10-67 tys. gr)
MONEY_CHESTS = {
    "daily": {"name": "Codzienna skrzynka", "emoji": "🎁", "min": 5_000, "max": 20_000, "curve": 2.2,
              "color1": "#3ddc84", "color2": "#0f5a32"},
    "mega":  {"name": "MEGA skrzynka", "emoji": "💎", "min": 10_000, "max": 67_000, "curve": 2.0,
              "color1": "#ffd54a", "color2": "#8a5b00"},
}
# seria logowań: kto odbiera codzienną skrzynkę dzień w dzień, w DAILY_STREAK-tym dniu serii dostaje MEGA skrzynkę
# (potem seria liczy się od nowa); pominięty dzień zaczyna serię od 1. dnia
DAILY_STREAK = 7
SHOWCASE_SIZE = 6         # ile kart mieści gablota na profilu

# kolejność = od najpospolitszej do najrzadszej
RARITIES = {
    "green":  {"name": "Zwykła",           "weight": 56.3, "value": 10,   "color": "#9aa3ad"},
    # Niepospolita: na razie bez kart (szansa liczy się tylko w skrzynkach, w których są karty tej rzadkości)
    "uncommon": {"name": "Niepospolita",   "weight": 20.0, "value": 18,   "color": "#4fc34f"},
    "blue":   {"name": "Rzadka",           "weight": 25.0, "value": 30,   "color": "#4b8bff"},
    "purple": {"name": "Epicka",           "weight": 12.0, "value": 90,   "color": "#a35bff"},
    "red":    {"name": "Mityczna",         "weight": 5.5,  "value": 300,  "color": "#ff4040"},
    "gold":   {"name": "Legendarna",       "weight": 1.0,  "value": 1000, "color": "#ffc531"},
    # karty specjalne: NIE wypadają ze skrzynek (waga 0) - tylko z kasyna albo z linku od admina (pole karty "source");
    # zawsze w jednym wariancie (Jokerowa, Dżinsowa...), nie da się ich sprzedać grze, postawić ani zużyć w kuźni
    "special": {"name": "Specjalna",       "weight": 0.0,  "value": 2500, "color": "#19e6ff"},
    "ultra":  {"name": "ULTRA LEGENDARNA", "weight": 0.2,  "value": 4000, "color": "#ff5cf0"},
    "secret": {"name": "TAJNA",            "weight": 0.0,  "value": 25000, "color": "#f3e3b0"},
}
RARITY_ORDER = list(RARITIES)

# Tajna karta wypada dokładnie 1 raz na SECRET_ODDS otwartych skrzynek
SECRET_ODDS = 2137
RARITIES["secret"]["weight"] = sum(r["weight"] for k, r in RARITIES.items() if k != "secret") / (SECRET_ODDS - 1)

TYPES = {
    "polityka": {"name": "Polityka",  "icon": "🏛️"},
    "sport":    {"name": "Sport",     "icon": "⚽"},
    "muzyka":   {"name": "Muzyka",    "icon": "🎤"},
    "tv":       {"name": "Telewizja", "icon": "📺"},
    "kino":     {"name": "Kino",      "icon": "🎬"},
    "biznes":   {"name": "Biznes",    "icon": "💼"},
    "kuchnia":  {"name": "Kuchnia",   "icon": "🍳"},
    "internet": {"name": "Internet",  "icon": "📱"},
    "nauka":    {"name": "Nauka",     "icon": "🔬"},
    "wiara":    {"name": "Wiara",     "icon": "✝️"},
    "artysta":  {"name": "Artysta",   "icon": "🎨"},
    "wojsko":   {"name": "Wojsko",    "icon": "🪖"},
}

# Słabość / odporność (jak w kartach Pokémon) - czysto dekoracyjne
MATCHUPS = {
    "polityka": ("internet", "tv"),
    "sport":    ("kuchnia", "polityka"),
    "muzyka":   ("internet", "sport"),
    "tv":       ("polityka", "kino"),
    "kino":     ("tv", "muzyka"),
    "biznes":   ("polityka", "internet"),
    "kuchnia":  ("tv", "sport"),
    "internet": ("biznes", "polityka"),
    "nauka":    ("polityka", "internet"),
    "wiara":    ("internet", "polityka"),
    "artysta":  ("biznes", "internet"),
    "wojsko":   ("polityka", "sport"),
}

# Zdolności kart - rodzaj (kategoria) i co znaczy wartość: ofensywna (obrażenia), defensywna (osłona),
# lecząca (leczone HP), ekonomiczna (monety 🪙 w Arenie). Rodzaj ustawia admin w panelu.
# Pierwsze dwie to pola attack/dmg i attack2/dmg2 (rodzaj: kind1/kind2, domyślnie ofensywna),
# kolejne admin dodaje w panelu jako listę "abilities".
ABILITY_KINDS = {"off": {"name": "Ofensywna", "icon": "⚔️"}, "def": {"name": "Defensywna", "icon": "🛡️"},
                 "heal": {"name": "Lecząca", "icon": "💚"}, "eco": {"name": "Ekonomiczna", "icon": "🪙"}}
MAX_EXTRA_ABILITIES = 2
for _t, (_weak, _res) in MATCHUPS.items():
    TYPES[_t]["weak"] = _weak
    TYPES[_t]["resist"] = _res


def P(id, name, wiki, rarity, type, hp, attack, dmg):
    return {"id": id, "name": name, "wiki": wiki, "rarity": rarity, "type": type,
            "hp": hp, "attack": attack, "dmg": dmg}


PEOPLE_PL = [
    # TAJNA
    P("pl_secret", "Jan Paweł II", ("pl", "Jan Paweł II"), "secret", "wiara", 500, "Barka", 300),
    # ULTRA
    P("pl_lewandowski", "Robert Lewandowski", ("pl", "Robert Lewandowski"), "ultra", "sport", 300, "5 goli w 9 minut", 250),
    # GOLD
    P("pl_malysz", "Adam Małysz", ("pl", "Adam Małysz"), "gold", "sport", 200, "Małyszomania", 180),
    P("pl_walesa", "Lech Wałęsa", ("pl", "Lech Wałęsa"), "gold", "polityka", 210, "Skok przez płot", 170),
    # RED
    P("pl_swiatek", "Iga Świątek", ("pl", "Iga Świątek"), "red", "sport", 160, "Bajgiel 6:0", 140),
    P("pl_tusk", "Donald Tusk", ("pl", "Donald Tusk"), "red", "polityka", 150, "Powrót z Brukseli", 120),
    P("pl_kaczynski", "Jarosław Kaczyński", ("pl", "Jarosław Kaczyński"), "red", "polityka", 150, "Bez żadnego trybu", 130),
    # PURPLE
    P("pl_duda", "Andrzej Duda", ("pl", "Andrzej Duda"), "purple", "polityka", 120, "Długopis prezydencki", 100),
    P("pl_nawrocki", "Karol Nawrocki", ("pl", "Karol Nawrocki"), "purple", "polityka", 125, "Prawy prosty", 100),
    P("pl_stoch", "Kamil Stoch", ("pl", "Kamil Stoch"), "purple", "sport", 130, "Idealny telemark", 110),
    P("pl_doda", "Doda", ("pl", "Doda (piosenkarka)"), "purple", "muzyka", 115, "Nie daj się", 100),
    P("pl_maklowicz", "Robert Makłowicz", ("pl", "Robert Makłowicz"), "purple", "kuchnia", 120, "Ach, cóż za aromat", 90),
    P("pl_gessler", "Magda Gessler", ("pl", "Magda Gessler"), "purple", "kuchnia", 125, "Kuchenne rewolucje", 110),
    # BLUE
    P("pl_mentzen", "Sławomir Mentzen", ("pl", "Sławomir Mentzen"), "blue", "polityka", 90, "Piwo z wyborcami", 70),
    P("pl_trzaskowski", "Rafał Trzaskowski", ("pl", "Rafał Trzaskowski"), "blue", "polityka", 90, "Gówno w Wiśle", 70),
    P("pl_holownia", "Szymon Hołownia", ("pl", "Szymon Hołownia"), "blue", "polityka", 85, "Przywołanie do porządku", 70),
    P("pl_ibisz", "Krzysztof Ibisz", ("pl", "Krzysztof Ibisz"), "blue", "tv", 95, "Wieczna młodość", 60),
    P("pl_wojewodzki", "Kuba Wojewódzki", ("pl", "Kuba Wojewódzki"), "blue", "tv", 85, "Kąśliwe pytanie", 75),
    P("pl_kubica", "Robert Kubica", ("pl", "Robert Kubica"), "blue", "sport", 100, "Błyskawiczny pit stop", 80),
    P("pl_podsiadlo", "Dawid Podsiadło", ("pl", "Dawid Podsiadło"), "blue", "muzyka", 80, "Małomiasteczkowy", 70),
    P("pl_szczesny", "Wojciech Szczęsny", ("pl", "Wojciech Szczęsny"), "blue", "sport", 95, "Parada w okienko", 70),
    # GREEN
    P("pl_zenek", "Zenek Martyniuk", ("pl", "Zenon Martyniuk"), "green", "muzyka", 60, "Przez twe oczy zielone", 40),
    P("pl_rodowicz", "Maryla Rodowicz", ("pl", "Maryla Rodowicz"), "green", "muzyka", 55, "Małgośka", 40),
    P("pl_pudzianowski", "Mariusz Pudzianowski", ("pl", "Mariusz Pudzianowski"), "green", "sport", 70, "Rzut oponą", 50),
    P("pl_najman", "Marcin Najman", ("pl", "Marcin Najman"), "green", "sport", 50, "El Testosteron", 30),
    P("pl_korwin", "Janusz Korwin-Mikke", ("pl", "Janusz Korwin-Mikke"), "green", "polityka", 50, "Muszka bojowa", 40),
    P("pl_petru", "Ryszard Petru", ("pl", "Ryszard Petru"), "green", "polityka", 45, "Sześciu króli", 30),
    P("pl_sanah", "sanah", ("pl", "Sanah"), "green", "muzyka", 55, "Szampan", 40),
    P("pl_wojciechowska", "Martyna Wojciechowska", ("pl", "Martyna Wojciechowska"), "green", "tv", 65, "Kobieta na krańcu świata", 45),
    P("pl_wisniewski", "Michał Wiśniewski", ("pl", "Michał Wiśniewski"), "green", "muzyka", 55, "Czerwone włosy", 40),
    P("pl_quebonafide", "Quebonafide", ("pl", "Quebonafide"), "green", "muzyka", 60, "Bubbletea", 45),
    # --- dodane w wersji 2 ---
    P("pl_curie", "Maria Skłodowska-Curie", ("pl", "Maria Skłodowska-Curie"), "ultra", "nauka", 290, "Podwójny Nobel", 260),
    P("pl_pilsudski", "Józef Piłsudski", ("pl", "Józef Piłsudski"), "gold", "polityka", 215, "Wąsy Marszałka", 175),
    P("pl_krawczyk", "Krzysztof Krawczyk", ("pl", "Krzysztof Krawczyk"), "red", "muzyka", 155, "Parostatek", 135),
    P("pl_morawiecki", "Mateusz Morawiecki", ("pl", "Mateusz Morawiecki"), "red", "polityka", 150, "Polski Ład", 125),
    P("pl_zyla", "Piotr Żyła", ("pl", "Piotr Żyła"), "red", "sport", 145, "Śmiech na skoczni", 130),
    P("pl_hurkacz", "Hubert Hurkacz", ("pl", "Hubert Hurkacz"), "purple", "sport", 125, "As serwisowy", 105),
    P("pl_szydlo", "Beata Szydło", ("pl", "Beata Szydło"), "purple", "polityka", 115, "Po prostu się należało", 100),
    P("pl_bosak", "Krzysztof Bosak", ("pl", "Krzysztof Bosak"), "purple", "polityka", 120, "Spokojna riposta", 95),
    P("pl_gorniak", "Edyta Górniak", ("pl", "Edyta Górniak"), "purple", "muzyka", 120, "Hymn na mundialu", 100),
    P("pl_wlodarczyk", "Anita Włodarczyk", ("pl", "Anita Włodarczyk"), "blue", "sport", 100, "Rzut młotem", 85),
    P("pl_kowalczyk", "Justyna Kowalczyk", ("pl", "Justyna Kowalczyk"), "blue", "sport", 95, "Podbieg w Val di Fiemme", 80),
    P("pl_ziobro", "Zbigniew Ziobro", ("pl", "Zbigniew Ziobro"), "blue", "polityka", 85, "Zero tolerancji", 70),
    P("pl_czarnek", "Przemysław Czarnek", ("pl", "Przemysław Czarnek"), "blue", "polityka", 85, "Lex Czarnek", 70),
    P("pl_kazik", "Kazik Staszewski", ("pl", "Kazik Staszewski"), "blue", "muzyka", 90, "Twój ból jest lepszy niż mój", 75),
    P("pl_stanowski", "Krzysztof Stanowski", ("pl", "Krzysztof Stanowski (dziennikarz)"), "green", "internet", 60, "Kanał Zero", 45),
    P("pl_farna", "Ewa Farna", ("pl", "Ewa Farna"), "green", "muzyka", 55, "Ewakuacja", 40),
    P("pl_linda", "Bogusław Linda", ("pl", "Bogusław Linda"), "green", "kino", 65, "Psy", 50),
    P("pl_pazura", "Cezary Pazura", ("pl", "Cezary Pazura"), "green", "kino", 60, "Kiler", 45),
    P("pl_golota", "Andrzej Gołota", ("pl", "Andrzej Gołota"), "green", "sport", 70, "Cios poniżej pasa", 50),
    P("pl_kukiz", "Paweł Kukiz", ("pl", "Paweł Kukiz"), "green", "polityka", 55, "JOW-y", 40),
]

PEOPLE_WORLD = [
    # TAJNA
    P("w_secret", "Charlie Kirk", ("en", "Charlie Kirk"), "secret", "polityka", 500, "Prove Me Wrong", 300),
    # ULTRA
    P("w_trump", "Donald Trump", ("en", "Donald Trump"), "ultra", "polityka", 300, "Tweet o 3 w nocy", 250),
    # GOLD
    P("w_ronaldo", "Cristiano Ronaldo", ("en", "Cristiano Ronaldo"), "gold", "sport", 210, "SIUUU!", 190),
    P("w_messi", "Lionel Messi", ("en", "Lionel Messi"), "gold", "sport", 205, "Drybling przez pół boiska", 180),
    # RED
    P("w_musk", "Elon Musk", ("en", "Elon Musk"), "red", "biznes", 160, "Rakieta na Marsa", 140),
    P("w_obama", "Barack Obama", ("en", "Barack Obama"), "red", "polityka", 155, "Yes We Can", 130),
    P("w_swift", "Taylor Swift", ("en", "Taylor Swift"), "red", "muzyka", 150, "Eras Tour", 140),
    # PURPLE
    P("w_putin", "Władimir Putin", ("en", "Vladimir Putin"), "purple", "polityka", 120, "Bardzo długi stół", 100),
    P("w_biden", "Joe Biden", ("en", "Joe Biden"), "purple", "polityka", 110, "Lody czekoladowe", 90),
    P("w_kim", "Kim Dzong Un", ("en", "Kim Jong Un"), "purple", "polityka", 115, "Pokaz fajerwerków", 110),
    P("w_keanu", "Keanu Reeves", ("en", "Keanu Reeves"), "purple", "kino", 130, "You're breathtaking!", 110),
    P("w_beyonce", "Beyoncé", ("en", "Beyoncé"), "purple", "muzyka", 125, "Single Ladies", 100),
    P("w_lebron", "LeBron James", ("en", "LeBron James"), "purple", "sport", 130, "Wsad z linii rzutów", 110),
    # BLUE
    P("w_macron", "Emmanuel Macron", ("en", "Emmanuel Macron"), "blue", "polityka", 90, "Miażdżący uścisk dłoni", 70),
    P("w_merkel", "Angela Merkel", ("en", "Angela Merkel"), "blue", "polityka", 95, "Romb Merkel", 70),
    P("w_zelensky", "Wołodymyr Zełenski", ("en", "Volodymyr Zelenskyy"), "blue", "polityka", 100, "Potrzebuję amunicji", 80),
    P("w_rock", "Dwayne „The Rock” Johnson", ("en", "Dwayne Johnson"), "blue", "kino", 100, "Uniesiona brew", 80),
    P("w_rihanna", "Rihanna", ("en", "Rihanna"), "blue", "muzyka", 85, "Umbrella", 70),
    P("w_dicaprio", "Leonardo DiCaprio", ("en", "Leonardo DiCaprio"), "blue", "kino", 90, "Wreszcie Oscar", 75),
    P("w_zuckerberg", "Mark Zuckerberg", ("en", "Mark Zuckerberg"), "blue", "biznes", 80, "Senator, we run ads", 60),
    P("w_bolt", "Usain Bolt", ("en", "Usain Bolt"), "blue", "sport", 95, "Błyskawica", 85),
    # GREEN
    P("w_bieber", "Justin Bieber", ("en", "Justin Bieber"), "green", "muzyka", 55, "Baby, baby, baby", 40),
    P("w_kardashian", "Kim Kardashian", ("en", "Kim Kardashian"), "green", "tv", 55, "Selfie", 35),
    P("w_ramsay", "Gordon Ramsay", ("en", "Gordon Ramsay"), "green", "kuchnia", 70, "IT'S RAW!", 50),
    P("w_mrbeast", "MrBeast", ("en", "MrBeast"), "green", "internet", 65, "Rozdanie miliona $", 50),
    P("w_boris", "Boris Johnson", ("en", "Boris Johnson"), "green", "polityka", 60, "Fryzura na wietrze", 45),
    P("w_trudeau", "Justin Trudeau", ("en", "Justin Trudeau"), "green", "polityka", 55, "Kolorowe skarpetki", 40),
    P("w_gates", "Bill Gates", ("en", "Bill Gates"), "green", "biznes", 60, "Niebieski ekran", 45),
    P("w_bezos", "Jeff Bezos", ("en", "Jeff Bezos"), "green", "biznes", 60, "Dostawa w 24h", 45),
    P("w_shakira", "Shakira", ("en", "Shakira"), "green", "muzyka", 60, "Hips Don't Lie", 45),
    P("w_sheeran", "Ed Sheeran", ("en", "Ed Sheeran"), "green", "muzyka", 55, "Shape of You", 40),
    # --- dodane w wersji 2 ---
    P("w_einstein", "Albert Einstein", ("en", "Albert Einstein"), "ultra", "nauka", 290, "E = mc²", 260),
    P("w_jordan", "Michael Jordan", ("en", "Michael Jordan"), "gold", "sport", 210, "Air Jordan", 185),
    P("w_elizabeth", "Elżbieta II", ("en", "Elizabeth II"), "red", "polityka", 160, "Królewskie pozdrowienie", 130),
    P("w_mbappe", "Kylian Mbappé", ("en", "Kylian Mbappé"), "red", "sport", 150, "Turbo sprint", 140),
    P("w_arnold", "Arnold Schwarzenegger", ("en", "Arnold Schwarzenegger"), "red", "kino", 165, "I'll be back", 135),
    P("w_xi", "Xi Jinping", ("en", "Xi Jinping"), "purple", "polityka", 120, "Nowy Jedwabny Szlak", 100),
    P("w_cruise", "Tom Cruise", ("en", "Tom Cruise"), "purple", "kino", 125, "Mission: Impossible", 110),
    P("w_eminem", "Eminem", ("en", "Eminem"), "purple", "muzyka", 120, "Lose Yourself", 105),
    P("w_serena", "Serena Williams", ("en", "Serena Williams"), "purple", "sport", 130, "As serwisowy", 105),
    P("w_gaga", "Lady Gaga", ("en", "Lady Gaga"), "blue", "muzyka", 85, "Poker Face", 75),
    P("w_willsmith", "Will Smith", ("en", "Will Smith"), "blue", "kino", 95, "Policzek na gali", 80),
    P("w_depp", "Johnny Depp", ("en", "Johnny Depp"), "blue", "kino", 90, "Kapitan Jack Sparrow", 75),
    P("w_djokovic", "Novak Đoković", ("en", "Novak Djokovic"), "blue", "sport", 100, "Ściana na korcie", 80),
    P("w_greta", "Greta Thunberg", ("en", "Greta Thunberg"), "blue", "polityka", 80, "How dare you!", 70),
    P("w_snoop", "Snoop Dogg", ("en", "Snoop Dogg"), "green", "muzyka", 60, "Drop It Like It's Hot", 45),
    P("w_grylls", "Bear Grylls", ("en", "Bear Grylls"), "green", "tv", 70, "Szkoła przetrwania", 50),
    P("w_hilton", "Paris Hilton", ("en", "Paris Hilton"), "green", "tv", 50, "That's hot", 35),
    P("w_atkinson", "Rowan Atkinson", ("en", "Rowan Atkinson"), "green", "kino", 60, "Jaś Fasola", 45),
    P("w_norris", "Chuck Norris", ("en", "Chuck Norris"), "green", "kino", 70, "Kopniak z półobrotu", 50),
    P("w_chan", "Jackie Chan", ("en", "Jackie Chan"), "green", "kino", 65, "Kung-fu kaskader", 50),
]

PEOPLE_PRL = [
    # ULTRA
    P("prl_gierek", "Edward Gierek", ("pl", "Edward Gierek"), "ultra", "polityka", 290, "Pomożecie?", 250),
    # LEGENDARNE
    P("prl_hermaszewski", "Mirosław Hermaszewski", ("pl", "Mirosław Hermaszewski"), "gold", "nauka", 205, "Lot w kosmos", 180),
    P("prl_jaruzelski", "Wojciech Jaruzelski", ("pl", "Wojciech Jaruzelski"), "gold", "polityka", 205, "Przemówienie 13 grudnia", 180),
    # MITYCZNE
    P("prl_gomulka", "Władysław Gomułka", ("pl", "Władysław Gomułka"), "red", "polityka", 150, "Odwilż '56", 125),
    P("prl_urban", "Jerzy Urban", ("pl", "Jerzy Urban"), "red", "tv", 145, "Konferencja prasowa", 130),
    P("prl_bierut", "Bolesław Bierut", ("pl", "Bolesław Bierut"), "red", "polityka", 150, "Plan sześcioletni", 120),
    # EPICKIE
    P("prl_kiszczak", "Czesław Kiszczak", ("pl", "Czesław Kiszczak"), "purple", "polityka", 120, "Rozmowy w Magdalence", 100),
    P("prl_rakowski", "Mieczysław Rakowski", ("pl", "Mieczysław Rakowski"), "purple", "polityka", 115, "Ostatni premier PRL", 95),
    P("prl_walentynowicz", "Anna Walentynowicz", ("pl", "Anna Walentynowicz"), "purple", "polityka", 120, "Strajk w Stoczni", 105),
    P("prl_kuron", "Jacek Kuroń", ("pl", "Jacek Kuroń"), "purple", "polityka", 115, "Zupa Kuronia", 100),
    P("prl_bareja", "Stanisław Bareja", ("pl", "Stanisław Bareja"), "purple", "kino", 120, "Miś", 105),
    P("prl_deyna", "Kazimierz Deyna", ("pl", "Kazimierz Deyna"), "purple", "sport", 125, "Złoto w Monachium", 110),
    # RZADKIE
    P("prl_michnik", "Adam Michnik", ("pl", "Adam Michnik"), "blue", "polityka", 90, "Gazeta Wyborcza", 75),
    P("prl_boniek", "Zbigniew Boniek", ("pl", "Zbigniew Boniek"), "blue", "sport", 95, "Hat-trick z Belgią", 80),
    P("prl_szewinska", "Irena Szewińska", ("pl", "Irena Szewińska"), "blue", "sport", 95, "Rekord na 400 m", 80),
    P("prl_gorski", "Kazimierz Górski", ("pl", "Kazimierz Górski"), "blue", "sport", 90, "Orły Górskiego", 75),
    P("prl_niemen", "Czesław Niemen", ("pl", "Czesław Niemen"), "blue", "muzyka", 90, "Dziwny jest ten świat", 75),
    P("prl_cyrankiewicz", "Józef Cyrankiewicz", ("pl", "Józef Cyrankiewicz"), "blue", "polityka", 85, "Wieczny premier", 70),
    # ZWYKŁE
    P("prl_kozakiewicz", "Władysław Kozakiewicz", ("pl", "Władysław Kozakiewicz"), "green", "sport", 65, "Gest Kozakiewicza", 50),
    P("prl_tomaszewski", "Jan Tomaszewski", ("pl", "Jan Tomaszewski (piłkarz)"), "green", "sport", 70, "Obrona na Wembley", 50),
    P("prl_lato", "Grzegorz Lato", ("pl", "Grzegorz Lato"), "green", "sport", 60, "Król strzelców '74", 45),
    P("prl_kora", "Kora", ("pl", "Kora (wokalistka)"), "green", "muzyka", 55, "Boskie Buenos", 40),
    P("prl_jantar", "Anna Jantar", ("pl", "Anna Jantar"), "green", "muzyka", 55, "Tyle słońca w całym mieście", 40),
    P("prl_himilsbach", "Jan Himilsbach", ("pl", "Jan Himilsbach"), "green", "kino", 60, "Rejs", 45),
]

# Skrzynki. Pola dodatkowe:
#   shop       - czy skrzynkę można kupić w sklepie
#   restricted - czy kupić mogą tylko gracze, którym admin dał dostęp
#   weights    - (opcjonalnie) własne szanse rzadkości dla tej skrzynki
#   shared     - (opcjonalnie) karty z innych skrzynek, które też są w tej skrzynce
CRATES = {
    "pl": {"name": "Skrzynka Polska", "short": "Polska", "code": "PL", "emoji": "🦅",
           "color1": "#ffffff", "color2": "#dc143c", "price": CRATE_PRICE, "shop": True, "restricted": False,
           "desc": "polskie gwiazdy, politycy i sportowcy", "people": PEOPLE_PL},
    "world": {"name": "Skrzynka Świat", "short": "Świat", "code": "ŚW", "emoji": "🌍",
              "color1": "#3d7bff", "color2": "#0e2a7a", "price": CRATE_PRICE, "shop": True, "restricted": False,
              "desc": "światowe gwiazdy i politycy", "people": PEOPLE_WORLD},
    "prl": {"name": "Skrzynka PRL", "short": "PRL", "code": "PRL", "emoji": "🏭",
            "color1": "#c8102e", "color2": "#3c3c3c", "price": 500, "shop": True, "restricted": False,
            "desc": "Polska Ludowa 1945–1989: władza, opozycja i gwiazdy epoki",
            "weights": {"green": 40.0, "blue": 30.0, "purple": 18.0, "red": 9.0, "gold": 3.0, "ultra": 0.5},
            "shared": ["pl_secret", "pl_walesa", "pl_krawczyk", "pl_rodowicz"],
            "people": PEOPLE_PRL},
    # każda karta z tej skrzynki jest Halloweenowa (DEFAULT_CRATE_VARIANTS); na razie tylko Tusk jako karta próbna -
    # kolejne karty admin dodaje w panelu (zaznaczając tę skrzynkę), tam też wgrywa halloweenowe zdjęcia
    "halloween": {"name": "Skrzynia Halloween", "short": "Halloween", "code": "HW", "emoji": "🎃",
                  "color1": "#ff7a00", "color2": "#2b0a3d", "price": 300, "shop": True, "restricted": False,
                  "desc": "każda karta w wersji halloweenowej", "shared": ["pl_tusk"], "people": []},
    # karty specjalne (rzadkość Specjalna) - admin dodaje je w panelu. "special": tej skrzynki nie da się kupić ani
    # otworzyć (nawet adminowi) i nie ma jej w sklepie; jest w klaserze i w filtrach ekwipunku
    "specjalne": {"name": "Karty specjalne", "short": "Specjalne", "code": "SP", "emoji": "🃏",
                  "color1": "#19e6ff", "color2": "#3a0a5a", "price": CRATE_PRICE, "shop": False, "restricted": False,
                  "special": True, "desc": "tylko z kasyna albo z linku od admina", "people": [
                      # easter egg: bardzo rzadko sama pojawia się w ekwipunku i zabiera ją UFO (UFO_VISIT). Zdjęcie na razie Tuska.
                      dict(P("sp_placeholder", "placeholder", ("pl", "Donald Tusk"), "special", "polityka", 120, "Sonda", 90),
                           source="ufo", fixedVariant="ufo", style=1)]},
}
SPECIAL_CRATE = "specjalne"
# skąd gracz może dostać kartę specjalną (pole karty "source", wybór w panelu admina)
SPECIAL_SOURCES = {"casino": "🎰 Kasyno — wygrane w grach, które dają nowe karty (ruletka, blackjack)",
                   "link": "🔗 Link od admina — każdy gracz może go użyć raz",
                   "ufo": "🛸 UFO — na razie nie do zdobycia: czasem sama pojawia się w ekwipunku i zabiera ją UFO"}
# Wizyta UFO: przy każdym odpytaniu /api/me (co 30 s w otwartej grze) szansa, że karta ze źródłem "ufo" pojawi się graczowi
# w ekwipunku (na samej górze, bez powiadomień). Kliknięta - zabiera ją UFO; po wyjściu z ekwipunku znika. Gracz jej nie dostaje.
# Losowane przy każdym odpytaniu /api/me (ok. 120 razy na godzinę gry): 1/12000 = średnio raz na ~100 godzin gry -
# dużo rzadziej niż obrazek w bębnie (u aktywnego gracza raz na kilka tygodni-miesięcy).
UFO_VISIT = {"chance": 1 / 12000}
# Easter egg w bębnie: z tą szansą (na każdą otwieraną skrzynkę) jeden z obrazków przelatujących w bębnie to obrazek od admina
# (panel admina, sekcja 🥚). Nigdy nie zostaje na ekranie po zatrzymaniu bębna (spinEgg w app.js).
# 0.001 = średnio raz na 1000 skrzynek - u bardzo aktywnego gracza mniej więcej raz w tygodniu, u reszty rzadziej.
EASTER_EGG = {"chance": 0.001}
# Teksty na karcie (pole karty "texts", panel admina - karty specjalne): każdy napis na karcie można zmienić niezależnie
# od statystyk (np. inna cena na karcie, a wartość ta sama). Pusty = zwykły tekst. "atk1Name" itd. - zdolności po kolei.
CARD_TEXT_SLOTS = {
    "name": "Nazwa", "hpLabel": "Napis HP", "hp": "HP", "type": "Ikona typu", "sub": "Linia pod zdjęciem",
    **{f"atk{i}{k}": f"Zdolność {i}: {n}" for i in range(1, 5) for k, n in (("Cost", "koszt"), ("Name", "nazwa"), ("Value", "wartość"))},
    "weakLabel": "Napis „słabość”", "weak": "Słabość", "resistLabel": "Napis „odporność”", "resist": "Odporność",
    "retreatLabel": "Napis „wycofanie”", "retreat": "Wycofanie", "rarity": "Rzadkość", "number": "Numer karty",
    "value": "Cena", "deco1": "Napis ozdobny 1", "deco2": "Napis ozdobny 2",
}
CARD_TEXT_MAX = 60
# Karta specjalna z kasyna: przy każdej WYGRANEJ w ruletce i blackjacku (i innych grach, które dają nowe karty) szansa
# = wygrana w groszach / "per", najwyżej "max". Szansa rośnie z wygraną, więc małymi zakładami nie da się jej "wyfarmić":
# średnio kosztuje to tyle, ile jest warta (przewaga kasyna 1/37 · per / szansa na wygraną).
CASINO_SPECIAL = {"per": 50_000, "max": 0.05}

# Drugie zdolności - mają je wszystkie karty legendarne, ULTRA i tajne
SECOND_ATTACKS = {
    "pl_malysz": ("Bułka z bananem", 120),
    "pl_walesa": ("Plusy dodatnie, plusy ujemne", 130),
    "pl_pilsudski": ("Cud nad Wisłą", 150),
    "pl_lewandowski": ("Rekord Bundesligi", 220),
    "pl_curie": ("Odkrycie polonu", 230),
    "pl_secret": ("Nie lękajcie się!", 280),
    "w_ronaldo": ("Rzut wolny z 35 metrów", 160),
    "w_messi": ("Osiem Złotych Piłek", 170),
    "w_jordan": ("Sześć pierścieni", 160),
    "w_trump": ("You're fired!", 220),
    "w_einstein": ("Teoria względności", 230),
    "w_secret": ("Debata na kampusie", 260),
    "prl_gierek": ("Druga Polska", 210),
    "prl_hermaszewski": ("Eksperyment na orbicie", 130),
    "prl_jaruzelski": ("Ciemne okulary", 140),
    "pl_korwin": ("Muszka bojowa", 120),
}
for _c in CRATES.values():
    for _p in _c["people"]:
        if _p["id"] in SECOND_ATTACKS:
            _p["attack2"], _p["dmg2"] = SECOND_ATTACKS[_p["id"]]


def card_value(person, variant="normal"):
    # valueMult: karty dostępne tylko w droższych skrzynkach są warte proporcjonalnie więcej (catalog.rebuild)
    v = RARITIES[person["rarity"]]["value"] * person.get("valueMult", 1)
    return int(round(v * VARIANTS.get(variant, VARIANTS["normal"])["mult"]))


# ============================================================ ARENA (wersja testowa - tylko dla adminów; turowa walka kartami)
# Talia 8 kart z kolekcji, 4 miejsca na planszy, reszta na ławce. Wygrywa ten, kto pokona wszystkie karty rywala.
ARENA = {
    "deckSize": 8, "boardSlots": 4, "actions": 2, "maxCoins": 10,
    # koszt wystawienia karty z ławki na planszę (złote monety) - z rzadkości
    "cardCost": {"green": 1, "uncommon": 1, "blue": 2, "purple": 3, "red": 4, "gold": 5, "special": 5, "ultra": 6, "secret": 7},
    # domyślny koszt zdolności (monety) z jej wartości: [(od wartości, koszt)] - słabe za darmo
    "abilityCost": [[0, 0], [150, 1], [250, 2]],
    # nagrody: skrzynka z pieniędzmi (MONEY_CHESTS) za 1., 3. i 9. wygraną dnia
    "rewardWins": [1, 3, 9], "rewardChest": "daily",
}

# Wspólne efekty zdolności (admin przypisuje je w panelu). value / turns - co znaczą liczby przy danym efekcie.
# unique: efekt może mieć tylko JEDNA karta w grze (unikalne ataki).
ARENA_EFFECTS = {
    "burn":    {"name": "Podpalenie", "icon": "🔥", "value": "obrażenia na turę", "turns": True,
                "desc": "Zadaje obrażenia na początku każdej tury właściciela karty."},
    "poison":  {"name": "Trucizna", "icon": "☠️", "value": "obrażenia na turę", "turns": True,
                "desc": "Obrażenia co turę; zatrutej karty nie da się leczyć."},
    "stun":    {"name": "Ogłuszenie", "icon": "💫", "value": None, "turns": True,
                "desc": "Karta nie może nic robić przez podaną liczbę tur."},
    "shield":  {"name": "Tarcza", "icon": "🛡️", "value": "punkty osłony", "turns": True,
                "desc": "Pochłania obrażenia, zanim trafią w HP."},
    "heal":    {"name": "Leczenie", "icon": "💚", "value": "leczone HP", "turns": False,
                "desc": "Od razu przywraca HP (nie więcej niż na starcie)."},
    "taunt":   {"name": "Prowokacja", "icon": "📢", "value": None, "turns": True,
                "desc": "Rywal musi atakować tę kartę, dopóki prowokacja trwa."},
    "boost":   {"name": "Wzmocnienie", "icon": "💪", "value": "+obrażenia", "turns": True,
                "desc": "Zdolności tej karty zadają więcej obrażeń."},
    "weaken":  {"name": "Osłabienie", "icon": "🩸", "value": "-obrażenia", "turns": True,
                "desc": "Zdolności tej karty zadają mniej obrażeń."},
    "lifesteal": {"name": "Wampiryzm", "icon": "🧛", "value": "% zadanych obrażeń", "turns": False,
                  "desc": "Atakujący leczy się o część zadanych obrażeń."},
    "splash":  {"name": "Odłamki", "icon": "💥", "value": "obrażenia", "turns": False,
                "desc": "Rani też karty stojące obok celu."},
    # unikalne - każdy może mieć tylko jedna karta
    "steal_coins": {"name": "Kradzież monet", "icon": "💰", "value": "monety", "turns": False, "unique": True,
                    "desc": "Rywal ma mniej monet w następnej turze."},
    "extra_action": {"name": "Dodatkowa akcja", "icon": "⚡", "value": "akcje", "turns": False, "unique": True,
                     "desc": "Daje od razu dodatkowe akcje w tej turze."},
    "knockback": {"name": "Do ławki!", "icon": "🔁", "value": None, "turns": False, "unique": True,
                  "desc": "Odsyła trafioną kartę rywala z planszy na jego ławkę."},
}
ARENA_TARGETS = {"enemy": "wybrany wróg", "all_enemies": "wszyscy wrogowie", "self": "ta karta",
                 "ally": "wybrany sojusznik", "all_allies": "wszyscy sojusznicy"}
# cel efektu: "target" = ten sam co cel zdolności
ARENA_EFFECT_TARGETS = {"target": "cel zdolności", "self": "ta karta", "all_allies": "wszyscy sojusznicy",
                        "all_enemies": "wszyscy wrogowie", "random_enemy": "losowy wróg"}
# zabawne animacje zdolności
ARENA_VISUALS = {
    "hit":       {"name": "Zwykłe uderzenie", "icon": "👊"},
    "tomato":    {"name": "Rzut pomidorem", "icon": "🍅"},
    "lightning": {"name": "Piorun", "icon": "⚡"},
    "explosion": {"name": "Wybuch", "icon": "💥"},
    "money":     {"name": "Deszcz pieniędzy", "icon": "💸"},
    "mic":       {"name": "Fala z mikrofonu", "icon": "🎤"},
    "ball":      {"name": "Strzał piłką", "icon": "⚽"},
    "fire":      {"name": "Ogień", "icon": "🔥"},
    "ice":       {"name": "Lód", "icon": "❄️"},
    "hearts":    {"name": "Serduszka (leczenie)", "icon": "💖"},
    "bubble":    {"name": "Bańka ochronna", "icon": "🫧"},
}
MAX_ABILITY_EFFECTS = 3

# ============================================================ RYNEK KART (zakładka Rynek)
# Oferty za stałą cenę (kupujący może zaproponować niższą), licytacje i "Szukam" (zlecenia kupna).
# Karty wystawione na rynek i pieniądze z ofert / licytacji / zleceń są zablokowane, dopóki transakcja się nie skończy.
MARKET = {
    "fee": 0.0,               # prowizja gry od sprzedaży (0.05 = 5%) - na razie bez prowizji
    "maxPrice": 100_000_000,
    "maxListings": 50,        # aktywnych ofert jednego gracza
    "maxWanted": 20,          # aktywnych zleceń "Szukam" jednego gracza
    "auctionHours": [1, 6, 12, 24, 48],
    "snipeSeconds": 120,      # oferta w ostatnich 2 min. przedłuża licytację do 2 min. (bez "snajperów")
}

# ============================================================ KASYNO
# Ruletka europejska (0-36). Wygrana: karty wracają + wygrana w kartach o tej samej wartości (losowe karty
# ze skrzynek w sklepie, bez tajnych, także w wariantach z CASINO_VARIANTS); końcówka mniejsza niż najtańsza karta - w pieniądzach.
ROULETTE = {"maxCards": 20, "maxPayoutCards": 100}
# warianty, w których kasyno (ruletka, blackjack) wypłaca wygrane: zwykła + warianty, które wypadają z każdej skrzynki
# (bez wyjątkowych - Flagowa, Królewska, halloweenowe, Rzulty - i bez specjalnych). Wybieramy losowo spośród kart
# z górnej półki tego, co się jeszcze mieści (co najmniej CASINO_TOP × najdroższa pasująca), więc duże wygrane
# to droższe warianty, a małe - zwykłe karty.
CASINO_VARIANTS = [v for v in VARIANT_ORDER
                   if v == "normal" or (VARIANTS[v]["chance"] > 0 and not VARIANTS[v].get("exclusive"))]
CASINO_TOP = 0.75
ROULETTE_WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
                  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26]   # kolejność pól na kole
ROULETTE_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]
_RED = set(ROULETTE_RED)
# zakład: (nazwa, liczby, wypłata x:1)
ROULETTE_BETS = {
    "red":    ("Czerwone", [n for n in range(1, 37) if n in _RED], 1),
    "black":  ("Czarne", [n for n in range(1, 37) if n not in _RED], 1),
    "green":  ("Zielone (0)", [0], 35),
    "even":   ("Parzyste", list(range(2, 37, 2)), 1),
    "odd":    ("Nieparzyste", list(range(1, 37, 2)), 1),
    "low":    ("1–18", list(range(1, 19)), 1),
    "high":   ("19–36", list(range(19, 37)), 1),
    "dozen1": ("1–12", list(range(1, 13)), 2),
    "dozen2": ("13–24", list(range(13, 25)), 2),
    "dozen3": ("25–36", list(range(25, 37)), 2),
    "col1":   ("1. kolumna", list(range(1, 37, 3)), 2),
    "col2":   ("2. kolumna", list(range(2, 37, 3)), 2),
    "col3":   ("3. kolumna", list(range(3, 37, 3)), 2),
}
ROULETTE_BETS.update({f"n{n}": (f"Liczba {n}", [n], 35) for n in range(1, 37)})
# Blackjack: gracz przeciw krupierowi, stawką są karty (jak w ruletce). Przed każdym rozdaniem tasujemy "decks" talii,
# krupier od razu sprawdza, czy ma blackjacka, dobiera do 16 i staje na każdej 17 (także miękkiej). Wygrana 1:1,
# blackjack "blackjackPays":1 (wygrana w kartach jak w ruletce), remis - karty wracają. Podwojenie tylko na dwóch
# pierwszych kartach: gracz dokłada karty warte najwyżej tyle, co stawka, i dostaje dokładnie jedną kartę.
# Bez rozdzielania par i ubezpieczenia. Rozdanie czeka na serwerze (postawione karty w ESCROW), aż gracz je dokończy.
BLACKJACK = {"maxCards": 20, "decks": 6, "blackjackPays": 1.5}
# Jednoręki bandyta: 3 bębny, jedna linia (środkowy rząd), stawką są karty (jak w ruletce). Każdy bęben losuje symbol
# według "weight". Trzy jednakowe = wygrana stawka × "pays" (karty zostają + wygrana w kartach jak w ruletce), dokładnie
# dwie wiśnie ("pair") = stawka × "pairPays", inaczej postawione karty przepadają. Zwrot dla graczy ok. 90%.
SLOTS = {"maxCards": 20, "pair": "cherry", "pairPays": 1,
         "symbols": [{"id": "cherry", "icon": "🍒", "weight": 30, "pays": 4},
                     {"id": "lemon", "icon": "🍋", "weight": 24, "pays": 8},
                     {"id": "bell", "icon": "🔔", "weight": 18, "pays": 14},
                     {"id": "star", "icon": "⭐", "weight": 12, "pays": 25},
                     {"id": "diamond", "icon": "💎", "weight": 7, "pays": 60},
                     {"id": "seven", "icon": "7", "weight": 4, "pays": 150}]}
# Wyścigi konne: wspólny wyścig co "period" s (ten sam dla wszystkich graczy; zakłady przyjmujemy od "betOpen" s przed startem,
# czyli od startu poprzedniego wyścigu, do "betClose" s przed startem), albo wyścig solo na żądanie. Przebieg liczy serwer (horses.py) - przeglądarka go odtwarza.
# Zakład: karta/y na jednego konia; wygrana = stawka × "pays" (jak w ruletce - karty zostają + wygrana w kartach),
# przegrana (koń zdechł, uciekł, nie wygrał) - karty przepadają, gdy nikt nie wygra (samochód na torze) - stawki wracają.
# "speed": siła konia (wpływa na szansę); "pays" wyliczone symulacją (python horses.py odds: 0,85 / szansa - 1), zwrot dla graczy ok. 91%.
HORSE_RACE = {"period": 300, "minPlayers": 1, "betOpen": 300, "betClose": 8, "maxCards": 20, "maxBets": 3,
              "laps": 4, "dt": 0.25, "duration": (70, 170), "tail": 6,
              "formSpread": 0.45, "strength": 0.022, "noise": 0.06, "noiseTau": 8,
              "turboMult": 5, "turboLaps": 0.25,
              "turnChance": 0.2, "dieChance": 0.12, "carChance": 0.06, "tripChance": 0.002, "tripGap": 0.006, "tripDeath": 0.1, "carSpeed": 12, "carEntry": 2.5,
              "boxRows": (0.3, 0.75), "boxRespawn": 0.3, "itemDelay": (1.0, 4.0)}
# Skrzynki z przedmiotami jak w Mario Kart: rzędy "boxRows" (ułamek okrążenia) na każdym torze; koń, który przez nie przejedzie,
# dostaje przedmiot (jeśli nie ma już innego), a po "itemDelay" s go używa. Pierwsze okrążenie: każdy rząd jest dla każdego konia,
# kolejne: rząd wraca tylko dla niektórych koni (szansa "boxRespawn"). "w" = wagi losowania (koń z przodu, ze środka, z tyłu stawki).
HORSE_ITEMS = {
    "banana":    {"icon": "🍌", "name": "Skórka od banana", "w": (40, 24, 8)},    # leży za koniem, ślizga tego, kto za nim jedzie
    "rocket":    {"icon": "🚀", "name": "Rakieta", "w": (4, 20, 32)},             # leci w konia przed sobą i go przewraca
    "turbo":     {"icon": "🌈", "name": "Tęczowe turbo", "w": (0, 4, 10)},               # ćwierć okrążenia bardzo szybko (jedyne źródło turbo)
    "mushroom":  {"icon": "🍄", "name": "Grzyb", "w": (18, 24, 24)},              # chwilowe przyspieszenie
    "snail":     {"icon": "🐌", "name": "Ślimak", "w": (14, 14, 4)},              # zwalnia konia przed sobą
    "lightning": {"icon": "⚡", "name": "Piorun", "w": (0, 5, 14)},               # zwalnia wszystkich innych
    "star":      {"icon": "⭐", "name": "Gwiazda", "w": (0, 6, 14)},              # szybciej i nie do ruszenia
}
HORSES = [
    {"id": 0, "name": "Rączy Bolek", "color": "#e53935", "speed": 1.4, "pitch": 1.0, "pays": 3.5},
    {"id": 1, "name": "Kasztanka z Allegro", "color": "#fb8c00", "speed": 1.0, "pitch": 1.25, "pays": 5.0},
    {"id": 2, "name": "Pan Kuleczka", "color": "#fdd835", "speed": 0.7, "pitch": 0.85, "pays": 5.5},
    {"id": 3, "name": "Dżordż Klonik", "color": "#43a047", "speed": 0.4, "pitch": 1.1, "pays": 7.5},
    {"id": 4, "name": "Siwy Dym", "color": "#00acc1", "speed": 0.2, "pitch": 0.95, "pays": 7.5},
    {"id": 5, "name": "Koń Trojański", "color": "#1e88e5", "speed": 0.0, "pitch": 0.75, "pays": 10.5},
    {"id": 6, "name": "Galopujący Ziemniak", "color": "#5e35b1", "speed": -0.3, "pitch": 1.4, "pays": 11.0},
    {"id": 7, "name": "Wojtek Kopyto", "color": "#d81b60", "speed": -0.6, "pitch": 0.9, "pays": 14.5},
    {"id": 8, "name": "Madame Kłusak", "color": "#6d4c41", "speed": -1.0, "pitch": 1.3, "pays": 19.5},
    {"id": 9, "name": "Lord Siano", "color": "#b0bec5", "speed": -1.5, "pitch": 0.8, "pays": 25.0},
]
# Jackpot: lobby dla 2 graczy (publiczne / prywatne z zaproszeniami), obaj wybierają karty i akceptują; szansa na wygraną
# = wartość moich kart / wartość wszystkich, zwycięzca bierze wszystkie karty. Lobby bez ruchu przez expireHours się zamyka.
JACKPOT = {"maxCards": 20, "expireHours": 24}

# ============================================================ LISTA ZMIAN (pokazywana raz po aktualizacji)
# Najnowsza na górze. "v" musi rosnąć z każdą nową wersją - gracz zobaczy wpisy nowsze niż ostatnio obejrzany.
PATCH_NOTES = [
    {"v": 19, "date": "2026-10-27", "title": "Duplikaty",
     "items": [
         "🔁 Sortowanie po duplikatach ma dwie wersje: <b>najwięcej</b> (karty, których masz najwięcej) i <b>najdroższe</b> (najcenniejsze duplikaty na górze).",
         "💰 W ekwipunku są dwa przyciski sprzedaży duplikatów: <b>Sprzedaj duplikaty</b> (zostaje 1 karta w najlepszym wariancie) i <b>Sprzedaj duplikaty, zostaw warianty</b> (zostaje po 1 karcie w każdym wariancie i bez wariantu). Ulubione ⭐ zawsze zostają.",
     ]},
    {"v": 18, "date": "2026-10-27", "title": "Więcej osiągnięć",
     "items": [
         "🏆 Ponad 30 nowych <b>osiągnięć</b>: pierwsza skrzynka, karty Mityczne i Legendarne, warianty, kasyno, Arena… Za każde są nagrody.",
         "🕵️ Osiągnięcia na profilu mają teraz dwie zakładki: <b>zwykłe</b> i <b>ukryte</b> - ukryte poznasz dopiero, gdy je zdobędziesz.",
         "🔧 Poprawka: liczą się też karty z wymiany, rynku i jackpota, a powiadomienie nie gubi się po grze w jackpot.",
     ]},
    {"v": 17, "date": "2026-10-26", "title": "Osiągnięcia",
     "items": [
         "🏆 Nowe <b>osiągnięcia</b> - znajdziesz je w swoim profilu. Za spełnienie warunków (karty, skrzynki, kasyno, Arena...) dostajesz pieniądze, skrzynki albo karty, a z boku wysuwa się powiadomienie.",
         "🕵️ Niektóre osiągnięcia są ukryte - zobaczysz je dopiero po zdobyciu.",
     ]},
    {"v": 16, "date": "2026-10-25", "title": "Jednoręki bandyta",
     "items": [
         "🎰 Nowa gra w 🎰 <b>Kasynie</b>: <b>Jednoręki bandyta</b>. Postaw karty, chwyć kulkę dźwigni i <b>pociągnij ją w dół</b> - bębny ruszą.",
         "🍒 Liczy się środkowa linia: trzy takie same symbole wygrywają od <b>×4</b> (wisienki) do <b>×150</b> (siódemki), a dwie wisienki zwracają stawkę. "
         "Przy wygranej możesz też dostać kartę specjalną 🃏 Jokerową.",
         "🥇 Poprawka: komunikat „Pierwsza taka karta w grze” nie pokazuje się już przy kartach, które ktoś zdobył wcześniej.",
     ]},
    {"v": 15, "date": "2026-10-25", "title": "Poprawka Skrzyni Halloween",
     "items": [
         "🎃 Wariant <b>Halloweenowa</b> sam w sobie nie zwiększa już wartości karty (×1) - liczy się tylko drugi wariant, np. Halloweenowa + Złota = wartość Złotej.",
         "🏮 <b>Lampionowa</b> ma teraz mnożnik ×2 (było ×6), a <b>Diabelska</b> ×4 (było ×15) - nadal najrzadsze i najładniejsze, ale już nie psują cen.",
     ]},
    {"v": 14, "date": "2026-10-24", "title": "Wyścigi konne w kasynie",
     "items": [
         "🐎 Nowa gra w 🎰 <b>Kasynie</b>: <b>Wyścigi konne</b>. 10 koni na okrągłym torze, każdy z innym mnożnikiem wygranej.",
         "🕔 Wspólny wyścig startuje <b>co 5 minut</b> dla wszystkich graczy (trwa 1–3 min) - postaw karty na konia i kibicuj razem z innymi. Możesz też zagrać <b>solo</b>, od razu.",
         "📦 Na torze są skrzynki „?” jak w Mario Kart: konie rzucają skórki od banana 🍌, strzelają rakietami 🚀, jedzą grzyby 🍄, łapią tęczowe turbo 🌈 (ćwierć okrążenia), zwalniają się ślimakiem 🐌 i piorunem ⚡, łapią gwiazdę ⭐.",
         "🌈 W wyścigu dzieje się dużo: konie zawracają i uciekają z toru, potykają się o siebie i padają… a czasem wjedzie samochód 🚗 - wtedy nikt nie wygrywa i stawki wracają.",
         "🔔 Przed wyjściem z kasyna po przegranej gra zapyta, czy na pewno chcesz wyjść.",
     ]},
    {"v": 13, "date": "2026-10-24", "title": "Ulepszacz w kasynie - w ciemno",
     "items": [
         "⬆️ <b>Ulepszacz</b> przeniósł się z ⚒️ Kuźni do 🎰 <b>Kasyna</b>.",
         "🎲 Grasz teraz <b>w ciemno</b>: stawiasz karty i wybierasz mnożnik (×1,5 … ×20). Widzisz wartość nagrody i szansę, "
         "ale <b>jaką kartę</b> wygrasz, zobaczysz dopiero po wygranej.",
         "🃏 Przy wygranej w ulepszaczu — jak w ruletce i blackjacku — możesz dostać kartę specjalną <b>Jokerową</b>.",
     ]},
    {"v": 12, "date": "2026-10-21", "title": "Wygrane w kasynie w wariantach",
     "items": [
         "✨ Wygrane w <b>ruletce</b> i <b>blackjacku</b> mogą teraz przyjść w <b>wariantach</b> — Złota, Holo, Szmaragdowa, "
         "Diamentowa, Galaktyczna, Negatyw… Im większa wygrana, tym droższe warianty (wartość wygranej się nie zmienia).",
         "🃏 Przypominamy: przy każdej wygranej w blackjacku — tak jak w ruletce — możesz dostać kartę specjalną <b>Jokerową</b>.",
     ]},
    {"v": 11, "date": "2026-10-21", "title": "Blackjack, seria logowań, nowe kolory i wymiany bez pieniędzy",
     "items": [
         "🃏 Nowa gra w 🎰 Kasynie: <b>Blackjack</b>! Postaw karty (jak w ruletce) i zagraj z krupierem — "
         "<b>Dobierz</b>, <b>Stój</b> albo <b>Podwój</b> (dokładasz karty warte najwyżej tyle, co stawka, "
         "i dostajesz jeszcze jedną kartę).",
         "💰 Wygrana 1:1, <b>blackjack 3:2</b> — w kartach ze skrzynek ze sklepu, remis = karty wracają. "
         "Krupier staje na 17. Przy wygranej możesz też dostać kartę specjalną 🃏 Jokerową.",
         "🎨 Nowe kolory rzadkości: <b>Zwykła</b> jest teraz <b>szara</b>, a <b>Niepospolita</b> — <b>zielona</b>.",
         "🔄 <b>Wymiany</b> są już tylko na karty — nie da się w nich przekazywać pieniędzy. "
         "Czekające oferty z pieniędzmi nie dadzą się przyjąć (można je odrzucić albo wycofać).",
         "🔥 <b>MEGA skrzynka</b> 💎 nie zależy już od dnia tygodnia — dostajesz ją po <b>7 dniach logowania z rzędu</b> "
         "(odbierz codzienną skrzynkę dzień w dzień). Pominięty dzień zaczyna serię od nowa.",
         "🎁 <b>Codzienna skrzynka</b> daje teraz od <b>5 000 gr</b> do <b>20 000 gr</b>, a <b>MEGA skrzynka</b> "
         "od <b>10 000 gr</b> do <b>67 000 gr</b>.",
         "📋 Pod karuzelą w sklepie jest <b>lista wszystkich skrzynek</b> — kliknij skrzynkę, a karuzela od razu do niej przejedzie.",
     ]},
    {"v": 10, "date": "2026-10-21", "title": "Codzienna skrzynka",
     "items": [
         "🎁 <b>Codzienna skrzynka</b> daje teraz od <b>5 000 gr</b> do <b>15 000 gr</b>. MEGA skrzynka 💎 w niedzielę bez zmian.",
     ]},
    {"v": 9, "date": "2026-10-22", "title": "Ametyst i porządek z duplikatami",
     "items": [
         "💜 Nowy wariant <b>Ametystowa</b> — fioletowy kamień szlachetny we wszystkich skrzynkach, "
         "rzadszy od Szmaragdowej, częstszy od Rubinowej (wartość ×12,5).",
         "♻️ W <b>ruletce</b> i <b>jackpocie</b> jednym przyciskiem dodasz wszystkie <b>duplikaty</b> — z każdej karty "
         "zostaje jeden egzemplarz, a ulubione ⭐ zostają zawsze.",
         "🔁 Nowe sortowanie <b>Duplikaty</b> w ekwipunku, kasynie, kuźni, na rynku i w wymianach — karty, które masz "
         "kilka razy, są na górze.",
         "🃏 Nowy wygląd kart Jokerowych: <b>Talia Kasynowa</b> — karta do gry na zielonym suknie z żetonami.",
     ]},
    {"v": 8, "date": "2026-10-21", "title": "Karty specjalne i nowy sklep",
     "items": [
         "🃏 Nowa rzadkość <b>Specjalna</b> — między Legendarną a ULTRA. Kart specjalnych nie ma w skrzynkach!",
         "🎰 <b>Joker</b>: przy każdej <b>wygranej w ruletce</b> możesz dostać dodatkowo kartę specjalną w wariancie "
         "<b>Jokerowa</b>. Im większa wygrana, tym większa szansa (do 5%).",
         "🔗 Niektóre karty specjalne (np. w wariancie <b>Dżinsowa</b> 👖) rozdajemy linkiem — każdy gracz może go użyć raz.",
         "🔒 Kart specjalnych nie da się sprzedać grze, postawić w kasynie ani zużyć w kuźni — możesz je wymienić "
         "ze znajomym albo sprzedać na 🏪 Rynku.",
         "🎠 Sklep ze skrzynkami to teraz <b>karuzela</b> — skrzynki same się obracają, możesz je przesuwać strzałkami, "
         "palcem albo klawiszami ← →.",
         "🔍 W ekwipunku możesz wyszukać kartę po nazwie.",
     ]},
    {"v": 7, "date": "2026-10-20", "title": "Większe nagrody i płynniejsza gra",
     "items": [
         "🎁 <b>Codzienna skrzynka</b> daje teraz od <b>5 000 gr</b> do <b>100 000 gr</b>, a <b>MEGA skrzynka</b> 💎 "
         "(w niedzielę) od <b>25 000 gr</b> do <b>250 000 gr</b> — pięć razy więcej niż wcześniej.",
         "⚡ Gra działa dużo płynniej: otwieranie skrzynek, ekwipunek, kuźnia i kasyno nie zacinają się już, "
         "nawet gdy masz tysiące kart.",
         "🖼️ Zdjęcia w bębnach i na listach kart ładują się szybciej (lżejsze miniatury), a ekwipunek pobiera się "
         "kilkanaście razy szybciej.",
         "📜 Kliknięcie karty w kuźni albo w kasynie nie przewija już listy kart z powrotem na górę.",
     ]},
    {"v": 6, "date": "2026-10-19", "title": "Wyszukiwanie kart",
     "items": [
         "🏮😈 Karty <b>Lampionowe</b> i <b>Diabelskie</b> nie łączą się już z innymi wariantami (np. Diabelska + Złota) — "
         "to są osobne, rzadkie warianty. Łączyć się z innymi może tylko <b>Halloweenowa</b>. Karty, które już masz, zostają bez zmian.",
         "🔍 <b>Wyszukiwanie kart</b> w kontrakcie i ulepszaczu w kuźni (w kasynie, na rynku i w wymianach już było).",
         "🔍 Wyszukiwanie działa teraz także po wariancie i rzadkości (np. „złota”, „diabelska legendarna”) "
         "i bez polskich znaków („zlota” znajdzie „Złota”).",
     ]},
    {"v": 5, "date": "2026-10-19", "title": "Nowe warianty, grosze i sortowanie",
     "items": [
         "🎃 Nowa <b>Skrzynia Halloween</b> — każda karta z niej ma jeden z trzech wariantów halloweenowych: "
         "<b>Halloweenowa</b> (najczęstsza), <b>Lampionowa</b> 🏮 (rzadsza) albo <b>Diabelska</b> 😈 (najrzadsza) "
         "i może dodatkowo trafić w inny wariant, np. Diabelska + Złota. Tylko z tej skrzynki!",
         "✒️ Nowy wariant <b>Rysunkowa</b> — karta jak szkic ołówkiem. Może wypaść każda karta.",
         "🌌 Nowy wariant <b>Galaktyczna</b> — ruchome mgławice i gwiazdy, a co jakiś czas przelatuje spadająca gwiazda.",
         "💛 Wariant <b>Rzulty</b> nie ma już żółtego filtra (ma własne zdjęcie) i jest tylko dla Jana Pawła II.",
         "🟢 Nowa rzadkość <b>Niepospolita</b> — między Zwykłą a Rzadką. Karty tej rzadkości pojawią się wkrótce.",
         "🪙 Waluta gry to teraz <b>grosze</b> (gr) — zmienia się tylko nazwa, wartości zostają te same.",
         "🔃 Sortowanie kart w kuźni, kasynie, na rynku, w wymianach i przy wyborze ikony.",
         "🏳️ W podglądzie karty widać wszystkie możliwe połączenia z wariantem Flagowym (np. Flagowa + Złota).",
         "🏆 Hall of Fame pokazuje tylko graczy widocznych w rankingu.",
     ]},
    {"v": 4, "date": "2026-10-19", "title": "Jackpot jako lobby",
     "items": [
         "💰 <b>Jackpot</b> działa teraz jak lobby: załóż je jako <b>publiczne</b> albo <b>prywatne</b> (możesz to zmienić później) "
         "i zaproś graczy po nicku. Zaproszenia zobaczysz na zakładce 🎰 Kasyno.",
         "🃏 Obaj gracze wybierają karty w lobby i mogą je zmieniać. Losowanie startuje dopiero, gdy <b>obaj zaakceptują</b> — "
         "każda zmiana kart cofa akceptację.",
         "🏆 Zwycięzca bierze wszystkie karty z lobby — swoje z powrotem i karty rywala. Wynik zobaczysz od razu, "
         "nawet gdy jesteś w innej zakładce albo wrócisz do gry później.",
         "🔄 Ekwipunek i saldo same się odświeżają, gdy ktoś kupi twoją kartę na rynku albo wygrasz licytację.",
     ]},
    {"v": 3, "date": "2026-10-19", "title": "Rynek kart, Kasyno i flagowe karty z dodatkowym wariantem",
     "items": [
         "🏪 Nowa zakładka <b>Rynek</b> — wystawiaj karty za stałą cenę albo na <b>licytację</b> (cena wywoławcza i minimalne przebicie). "
         "Kupujący mogą zaproponować niższą cenę, a ty decydujesz, czy ją przyjąć.",
         "📢 <b>Szukam</b> — dodaj zlecenie kupna karty za wybraną cenę. Każdy, kto ją ma, może ci ją od razu sprzedać.",
         "🎰 Nowa zakładka <b>Kasyno</b>: <b>Ruletka</b> na karty (czerwone / czarne ×2, zielone ×36 i inne zakłady jak w prawdziwej ruletce) "
         "oraz <b>Jackpot</b> dla dwóch graczy — im więcej warte twoje karty, tym większa szansa, a zwycięzca bierze wszystkie karty ze stołu.",
         "🏳️ Flagowa karta ma teraz 40% szansy na <b>dodatkowy wariant</b> — np. Flagowa + Złota. Wartości obu wariantów się mnożą!",
         "💚 Nowe rodzaje zdolności kart: <b>lecząca</b> i <b>ekonomiczna</b> 🪙.",
         "⚒️ Kuźnia (kontrakt i ulepszacz) daje już tylko karty ze skrzynek, które są teraz w sklepie.",
     ]},
    {"v": 2, "date": "2026-10-15", "title": "Hall of Fame i wiele kontraktów naraz",
     "items": [
         "🏆 Nowa podstrona w Ekwipunku: <b>Hall of Fame</b> — kto pierwszy zdobył każdą kartę i każdy jej wariant, kiedy i ile ich wypadło.",
         "🥇 Zdobędziesz kartę albo wariant jako pierwsza osoba w grze? Dostaniesz powiadomienie i trafisz do Hall of Fame.",
         "📜 W Kuźni możesz zrobić <b>wiele kontraktów naraz</b> — karty dobierają się same (domyślnie tylko duplikaty, bez ulubionych, gabloty i specjalnych wariantów).",
     ]},
    {"v": 1, "date": "2026-10-14", "title": "Witaj w ScamBox!",
     "items": [
         "🏷️ Nowa nazwa: Skrzynki Sław to teraz <b>ScamBox</b>.",
         "👑 Nowy wariant <b>Królewski</b> — ozdobna złota rama i korona. Wypada tylko ze <b>Skrzyni Królów</b>.",
         "🏳️ Nowy wariant <b>Flagowy</b> — karta w barwach flagi swojego kraju. Tylko w wybranych skrzynkach.",
         "💎 Wyjątkowe warianty wypadają wyłącznie ze skrzynek, które je mają — nie zrobisz ich w kontrakcie ani ulepszaczu.",
         "📰 Po każdej aktualizacji zobaczysz tu, co się zmieniło. Listę zmian znajdziesz też na swoim profilu.",
     ]},
]
