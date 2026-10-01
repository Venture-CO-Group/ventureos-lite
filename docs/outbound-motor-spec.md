# Venture OS — Outbound Motor
## Specifikáció v1.0 · termék-vezérelt leadgenerálás és jóváhagyásos megkeresés

*Készült: 2026. október 1. · Státusz: **JÓVÁHAGYVA** (2026-10-01) · v1.1*

---

## 1. Miért és mit

**A probléma.** 8-10 értékesíthető megoldás (üzbég partnertermékek + saját szolgáltatások), mindegyiknek más a vevője. A célcégek felkutatása és a megkeresések megírása ma kézi munka, ami Fanni idejének nagy részét elviszi — pedig a legtöbb értéket a sales meetingeken termeli.

**A cél.** Fanni ne keressen és ne gépeljen, hanem **döntsön**: naponta 15-25 kész, személyre szabott megkeresést néz át 10-15 perc alatt, jóváhagyja vagy elveti, és a rendszer kiküldi a saját Gmail-fiókjából. A felszabaduló idő a meetingeké.

**Amit a rendszer csinál:** célcég-lista összeállítása → cégadat-gazdagítás → weboldal-audit → kontaktszemély-feloldás → üzenetvázlat a termék és a konkrét audit-megállapítás alapján → jóváhagyási sor → küldés.

**Amit nem csinál:** nem küld jóváhagyás nélkül, nem automatizál LinkedIn-t, nem talál ki adatot.

---

## 2. A kritikus megkötés: a Cégadat API nem szegmens-kereső

A dokumentáció (v1.4) alapján a `/v1/search` végpont **kizárólag név, adószám vagy cégjegyzékszám alapján keres.** Nincs TEÁOR-szűrő, nincs árbevétel-tartomány, nincs megye- vagy létszám-szűrés. Vagyis **nem lehet azt kérdezni, hogy „minden 300M–2Mrd árbevételű gyártócég Pest megyében".**

A gazdag adat (TEÁOR, árbevétel, létszám, vezetők, e-mail, telefon, web) a `/v1/detail` végponton jön, **adószám alapján, egyesével** — a Haladó csomagban havi **5000 lekérés** (napi ~165, bőven elég a jóváhagyási sor volumenéhez).

**Ebből következik a kétfázisú architektúra:**

```
1. JELÖLT-FORRÁS (honnan jön az adószám-lista?)
   ├─ Google Places (meglévő Prospector) — helyhez kötött, kisvállalati szegmensek
   ├─ Importált lista (CSV) — a Cégadat „Marketing adatbázisok" / „Adatbázis építés"
   │   termékéből egyszeri szegmens-lista vásárolható; ez a szegmens-keresés hiányának
   │   valódi megoldása → JAVASLAT: kérj ajánlatot rá
   ├─ Névalapú keresés (/v1/search) — ha van cégnévlistád (rendezvény, kiállítói lista)
   └─ Meglévő CRM-cégek, akikre még nem futott kampány

2. SZŰRÉS ÉS GAZDAGÍTÁS (itt dől el, kit érdemes megkeresni)
   /v1/detail minden jelöltre → TEÁOR, árbevétel, létszám, megye, vezetők,
   e-mail, telefon, web, státusz → LOKÁLIS szűrés az ICP-profil szerint
```

A szűrés tehát **nálunk történik, a letöltött adatlapon** — ez a kvótát terheli, ezért a jelölt-lista minősége számít a legtöbbet. Egy rosszul összeállított 500-as lista elégeti a havi keret 10%-át haszontalanul.

**Teszt-hozzáférés:** a dokumentáció közöl egy teszt API-kulcsot hat valós céggel (WellData, Dayton Invest, Coca-Cola HBC, Budapest Film, két egyéni vállalkozó). A teljes integráció megépíthető és tesztelhető **előfizetés előtt** — a fejlesztés nem blokkolt.

---

## 3. Új fogalmak (adatmodell)

### 3.1 Product
A portfólió strukturáltan. Ma sehol nincs — ezért nem tud a rendszer célozni.

| Mező | Tartalom |
|---|---|
| name, slug | „Üzbég fintech core banking", „Weboldal-fejlesztés" |
| category | saját szolgáltatás / partnermegoldás |
| partner | a szállító (üzbég cég neve), ha partnertermék |
| problemSolved | 1-2 mondat: milyen fájdalomra válasz |
| valueProps[] | 3-5 állítás, mindegyik egy bizonyítékkal |
| proofPoints[] | referenciák, számok (csak valós) |
| priceBand | nagyságrend (az ajánlatot továbbra is Tamás adja) |
| assets[] | one-pager, deck, demóvideó linkje |
| status | aktív / szünetel / kifutó |
| language | a megkeresés alapnyelve (HU / EN) |

### 3.2 ICPProfile — így adod meg, kit keresel

A célzás három rétegből áll, és mindegyik külön is elég egy kampányhoz.

**(a) Szegmenstípus — emberi nyelven, nem TEÁOR-kóddal.**
A felületen felsorolt, előre definiált szegmensekből választasz (több is lehet): *biztosítók, bankok és pénzintézetek, magánklinikák és egészségügy, gyógyszertárak, logisztika és fuvarozás, gyártás, nagykereskedelem, építőipar, vendéglátás, kiskereskedelem, IT és szoftver, tanácsadás és könyvelés, ügyvédi irodák, ingatlan, oktatás, utazás és turizmus, autóipar, energetika, mezőgazdaság.* Minden szegmens mögött egy karbantartott **TEÁOR-kódkészlet** és egy **névtöredék-készlet** áll (lásd 4.1), ezeket a Settings-ben lehet finomhangolni, de alapból készen jönnek. Így a kampány indításakor azt mondod: „healthtech szoftver → magánklinikák + biztosítók + bankok", és nem kell kódokkal bajlódnod.

**(b) Méretsáv — EU-definíció szerint, létszám alapján** (`employeeCount`), opcionálisan árbevétellel kombinálva:

| Sáv | Létszám | Tipikus árbevétel |
|---|---|---|
| Mikro | 1–9 | < 1 Mrd Ft |
| Kisvállalat | 10–49 | < 5 Mrd Ft |
| Középvállalat | 50–249 | < 25 Mrd Ft |
| Nagyvállalat | 250+ | 25 Mrd Ft felett |

Több sáv is választható. Ha a cégnél hiányzik a létszámadat, az árbevétel dönt; ha az is hiányzik, a jelölt „méret ismeretlen" jelöléssel a sor végére kerül, nem esik ki automatikusan (te döntöd el profilonként, hogy beengeded-e).

**(c) Referenciacégek — „ilyeneket keresek".**
Megadsz 1-5 konkrét céget (PwC, KPMG, EPAM, vagy akár egy meglévő ügyfeled), és a rendszer lekéri az adatlapjukat, majd **kivonatolja a közös mintázatot**: fő TEÁOR-kódok, méretsáv, cégforma, régió. Ez előtölti a profilt, amit utána kézzel finomíthatsz. Két haszna van: gyorsabb, mint kézzel összeválogatni a szűrőket, és olyan TEÁOR-kódokat is behoz, amikre nem gondoltál volna.

A referenciák nem csak szűrésre jók: a megkeresés szövegében is felhasználhatók („hasonló profilú cégeknél, mint X, azt látjuk…") — de **kizárólag akkor, ha a referencia valóban a te ügyfeled.** Ha csak célzási mintaként adtad meg, a rendszer nem írhatja le a nevét a levélben; ezt a Product rekordon külön jelölöd.

**(d) Finomszűrők** (opcionális): megye/város, cégforma, alapítás éve, státusz („Aktív" az alapértelmezés), van-e weboldal, audit-pontszám tartomány, kötelező jelek, nevesített kontakt szükséges-e, meglévő ügyfél kizárása.

### 3.3 SourcingRun
Egy futás: honnan jöttek a jelöltek, mennyi kvótát evett, mi lett az eredmény. Minden lépés naplózva, visszakövethetően.

### 3.4 ProspectCandidate
Egy jelölt a futásban, állapotgéppel:
`SOURCED → ENRICHED → FILTERED_IN / FILTERED_OUT(ok) → AUDITED → CONTACT_RESOLVED / NO_CONTACT → DRAFTED → PENDING_APPROVAL → APPROVED / REJECTED(ok) → SENT → (REPLIED)`

Minden állapotváltás okkal és időbélyeggel. A `FILTERED_OUT` és `REJECTED` okok a tanulás alapanyaga.

### 3.5 OutreachDraft
A generált üzenet: tárgy, törzs, a felhasznált személyre szabási pontok listája (melyik audit-megállapítás, melyik cégadat), a termék, a sablonverzió, és a jóváhagyás/elvetés nyoma.

### 3.6 Kapcsolódás a meglévőhöz
A `Company`, `Lead`, `AuditResult`, `Campaign`, `EmailLog`, `Suppression`, `WorkflowRule`, `SavedView` **mind marad** — a motor ezekre épül, nem mellettük. A jóváhagyott megkeresés normál `Lead`-et hoz létre a pipeline-ban `source: outbound_engine` jelöléssel.

---

## 4. A futószalag lépésről lépésre

### 4.1 Jelölt-forrás — négy csatorna, szegmensenként más működik

A `/v1/search` **korlátlan** minden csomagban, és ez kihasználható: a magyar cégnevek jellemzően tartalmazzák a tevékenységet („… Fogászati Kft.", „… Biztosító Zrt.", „… Logisztika Kft."). Ezért a fő jelölt-forrás ingyenes.

**1. Névtöredék-aratás (`/v1/search`, ingyenes, ez a motor alapja).**
Szegmensenként karbantartott névtöredék-lista, pl. magánklinikák: *klinika, rendelő, fogászat, egészségközpont, medical, med center, orvosi, magánorvosi, diagnosztika, labor*. Minden töredékre lefut egy keresés `sensitivity=1` (részleges egyezés), `businessType=company`, `status=Aktív`, `limit=100`, lapozással. A találatok (`vatNumber`, `fullName`, `shortName`, `status`) **kvóta nélkül** gyűlnek egy jelölt-poolba. Egy éjszakai futás így több száz-ezer jelöltet szed össze ingyen, és csak a kiválasztottakra költ adatlapot.

**2. Kurált maglisták (véges univerzumú szegmensekhez).**
Bankból ~30, biztosítóból ~25 van Magyarországon — ezeket nem keresni kell, hanem egyszer összeírni. A rendszer szegmensenként tárolhat egy karbantartott maglistát (cégnév vagy adószám), amit a `/v1/search` old fel adószámmá. Nagyvállalati és pénzintézeti célzásnál ez pontosabb minden keresésnél.

**3. Importált szegmenslista** (CSV) — a Cégadat „Marketing adatbázisok" / „Adatbázis építés" termékéből vásárolt lista. Középvállalati, TEÁOR-alapú célzásnál ez a legtisztább forrás, mert nem a cégnévre hagyatkozik.

**4. Google Places** (meglévő Prospector) — helyhez kötött, kisvállalati szegmensekhez (étterem, szerelő, fogorvos), ahol a cégnév gyakran nem árulkodó.

**Olcsó előszűrés a kvóta előtt.** Mielőtt bármelyik jelöltre adatlapot kérnénk, ingyenes szűrés fut: már a CRM-ben van (adószám-egyezés) → kiesik; suppression-listán van → kiesik; a cégforma a névből kizárható (pl. nagyvállalatot keresünk, de „Bt." a név) → hátrasorolás; a korábbi futásokban már `FILTERED_OUT` volt ugyanerre a profilra → kiesik (90 napig). Így a fizetős adatlap-lekérés csak a valódi esélyesekre megy el.

**Prioritási sor.** A megmaradt jelöltek pontozást kapnak (névtöredék-találat erőssége, cégforma illeszkedés, korábbi futások tanulsága), és a motor **a legjobbaktól indulva** kér adatlapot, amíg össze nem gyűlik az aznapra kért mennyiség. A pool megmarad a következő éjszakára, tehát egy jó aratás napokig kiszolgálja a kampányt.

### 4.2 Gazdagítás (`/v1/detail`)
Adószámonként egy hívás, **90 napig cache-elve** (a cégadat lassan változik; a pénzügyi adat évente frissül). A válasz leképezése a `RegistryData` és `Company` mezőkre; a NAV-ellenőrzés megmarad a jogi dokumentumokhoz vezető úton. Kvótakezelés: napi plafon, havi keret-mérő a felületen, a limit (hibakód 7, HTTP 429) elérésekor a futás **szünetel, nem hibázik** — másnap folytatja.

### 4.3 Lokális szűrés
Az ICP-profil szabályai a letöltött adatlapra. Minden kiesés **okkal** naplózva („árbevétel 42M < min 300M"), mert ebből derül ki, hogy a jelölt-forrás rossz-e vagy a profil túl szűk.

### 4.4 Weboldal-audit
Csak a bennmaradtakra, a meglévő audit-motorral, kötegelve. Ez adja a megkeresés konkrét „miért most" érvét. Weboldal nélküli cégnél az audit kimarad, és a hiánya maga a hook.

### 4.5 Kontaktszemély-feloldás (vízesés)
Sorrendben, az első találat nyer; minden lépés naplózza, honnan jött az adat:

1. **Cégadat API** — `emailAddress`, `phoneNumber`, és a `managers[]` tömbből a vezető **neve**. A példaválaszban a weboldal és telefon üres volt, az e-mail megvolt: a lefedettség részleges, ezért kell a vízesés.
2. **Impresszum-kinyerés** a cég weboldaláról (már van weboldal-fetch kód) — magyar oldalaknál kötelező tartalom, meglepően jó arány.
3. **Meglévő CRM-kontakt** ugyanannál a cégnél.
4. **Nevesített vezető + általános cím párosítása** — ha tudjuk a nevet (`managers[]`), de csak `info@` címünk van, a levél megszólítása személyes, a címzett az általános postafiók.
5. **Csak `info@`** — más szöveggel: „kérem, továbbítsák az illetékesnek".
6. **Nincs kontakt** → a jelölt a **LinkedIn-sorba** kerül, Fanni kézi megkeresésére (a vezető nevével, hogy megtalálja).

Az e-mail-cím a küldés előtt **verifikáción megy át** (szintaxis, MX, eldobható-domain) — ez már specifikálva van (v3 P9/2).

### 4.6 Üzenetvázlat
Egy Claude-hívás jelöltenként (Sonnet), **kötelező bemenettel**: a termék adatai, az ICP-profil, a cégadatok, az audit-megállapítások és a kontakt neve. A prompt szabálya: a levélnek tartalmaznia kell **legalább egy konkrét, erre a cégre vonatkozó tényt** — ha nincs ilyen (se audit, se érdemi cégadat), a jelölt **nem kerül a sorba**, hanem `NO_HOOK` okkal kiesik. Sablonvázak terméken­ként, verziózva, a Signal Engine-nel mérve.

Költség: ~25 vázlat/nap ≈ havi 3-8 USD. A gazdagítás és az audit nem AI, tehát nem terheli a keretet.

### 4.7 Jóváhagyási sor — ez a termék lelke
Egy képernyő, kötegelt átnézésre tervezve:

- **Billentyűzet:** `J/K` léptetés, `A` jóváhagy, `E` szerkeszt, `X` elvet, `L` → LinkedIn-sorba.
- **Minden kártya mutatja:** a levelet úgy, ahogy kimegy (aláírással együtt), a címzettet és a feloldás forrását, a céget cégadatokkal, az audit-pontszámot és a felhasznált megállapítást, a terméket és az ICP-profilt, ami behozta — **tehát hogy miért ez a cég**.
- **Elvetés ok nélkül nem lehet:** rossz célzás / gyenge szöveg / rossz kontakt / rossz időzítés / egyéb. Ez tanítja a rendszert.
- **Szerkesztés helyben**, külön képernyő nélkül.
- **Napi kvóta** látható: „14 / 25 jóváhagyva ma".

### 4.8 Küldés
Gmail API-val, **Fanni saját fiókjából**, hogy a levelek a Küldöttek között legyenek és a válaszok oda érkezzenek.

**Fontos döntés — külön fiók:** a hideg megkeresés a `fanni.viragh@ventureco.agency` fiókból menjen, ne a `.group`-osból. Indok: a `.group` domain viszi az ajánlataidat, szerződéseidet és számláidat; ha egy hidegkampány rontja a reputációját, azok is spambe kerülhetnek. Ez havi egy Workspace-licenc ára, cserébe a két reputáció teljesen elválik. A `.group`-os fiók marad a meglévő ügyfeleknek.

**Aláírás:** a Gmail API nem teszi rá automatikusan — a `sendAs.signature` beállítást le kell kérni és a levéltörzsbe illeszteni, hogy a kimenő levél ugyanúgy nézzen ki, mintha kézzel írta volna.

**Volumen:** bemelegített Workspace-fiókból reálisan napi 20-40 hideg levél, az első 2-3 hétben ennek a fele. Nem korlát, hanem illeszkedés: a jóváhagyási sor úgyis ennyit bír emberi figyelemmel.

**Follow-up:** két érintés, válaszra leálló, az eddigi szabály szerint; a második ugyanígy jóváhagyáson megy át.

### 4.9 Válaszok
A meglévő e-mail-szinkronon keresztül az Inboxba, a lead idővonalára, a megszokott szándék- és kifogáselemzéssel. Innentől a folyamat a régi: kvalifikáció → meeting → Tamás.

---

## 4bis · Éjszakai futás — mire Fanni reggel bekapcsol

Ez a működés gerince: **a motor éjjel dolgozik, reggelre tele a sor.**

### Beállítás termékenként
Minden termékhez megadod a **napi lead-kvótát** (hány jóváhagyásra kész megkeresés készüljön), a hozzá tartozó ICP-profilt (vagy többet, súlyozva), és a futtatási napokat (alapértelmezés: hétfő–péntek éjjel, hogy Fanni ne hétfőn kapjon háromnapnyi anyagot). Példa beállítás:

| Termék | Napi kvóta | Profil |
|---|---|---|
| Healthtech szoftver | 8 | magánklinikák (közép) + biztosítók (nagy) |
| Weboldal-fejlesztés | 12 | vendéglátás + fogászat (mikro/kis), audit ≥ 60 |
| Üzbég core banking | 2 | bankok és pénzintézetek (nagy), account-mód |

A **napi összkvóta** workspace-szinten is korlátos (indulásnak 15, két hét után 25) — ha a termékek kvótáinak összege ezt meghaladná, a motor a termék-prioritás szerint oszt.

### Mit csinál a futás (03:00 körül)
1. Megnézi, mennyi **jóváhagyatlan vázlat** maradt a sorban az előző napról. Ha a sor még tele van, **kevesebbet gyárt** — a cél a sor szinten tartása, nem a feltöltése a végtelenségig. Ez védi Fannit attól, hogy 80 elintézetlen tétel nézzen vissza rá hétfőn.
2. Végigfuttatja a futószalagot (jelölt-pool → előszűrés → adatlap → ICP-szűrés → audit → kontakt → vázlat), amíg össze nem gyűlik a hiányzó mennyiség vagy ki nem merül a pool.
3. **Keretfigyelés:** a havi 5000-es adatlap-keretből napi részt oszt ki (alapértelmezés: havi keret / hónap hátralévő napjai, tartalékkal). A napi rész elérésekor a futás leáll, nem hibázik.
4. Ha a pool kimerül (nincs több jelölt a profilhoz), **névtöredék-aratást indít** a következő futásra, és jelzi a reggeli összefoglalóban, hogy a szegmens kimerülőben van.
5. Hibánál (API kiesés, audit-timeout) az adott jelölt megjelölve félreteszi magát, és másnap újrapróbálkozik — egy hiba soha nem állítja le a teljes futást.

### Reggeli összefoglaló
Fanni belépéskor a Dashboardon látja: *„23 megkeresés vár jóváhagyásra · healthtech 8, weboldal 12, core banking 3 · 41 jelölt esett ki (28 méret, 9 nincs kontakt, 4 nincs hook) · adatlap-keret: 1240/5000 ehavi."* Egy kattintás, és a jóváhagyási sorban van.

Ha egy futás nem érte el a kvótát, azt is kiírja, **miért** — ez a leghasznosabb visszajelzés a célzás finomításához.

## 5. Két kampánytípus

| | **Volumen-kampány** | **Account-kampány** |
|---|---|---|
| Kinek | magyar KKV, weboldal/marketing | nagyvállalat, üzbég IT-megoldások |
| Célcégek | 200-500 / futás | 30-80, kézzel válogatva |
| Kontakt/cég | 1 | 2-4 döntéshozó |
| Megkeresés | e-mail, audit-hookkal | e-mail + LinkedIn + telefon, több körben |
| Jóváhagyás | kötegelt | egyedi, Fanni és te együtt |
| Siker | válaszarány | megnyitott account |

A motor mindkettőt kezeli; a különbség a kvóta, a lépésszám és a jóváhagyás mélysége.

---

## 6. Védőkorlátok

- **Nincs küldés jóváhagyás nélkül.** Nincs „auto-approve" kapcsoló. A CLAUDE.md jelenlegi szabályát (emberi szerkesztés kötelező) **módosítani kell**: explicit jóváhagyás + látható szöveg = emberi kontroll. Ezt tudatosan írjuk át, nem megkerüljük.
- **Hook-kényszer:** konkrét tény nélkül nincs levél.
- **Suppression** minden kampányon átívelő, azonnali leiratkozással; a leiratkozás a cég minden kontaktjára hat.
- **Napi plafon és bemelegítés** a küldő fiókra; bounce-arány felett automatikus leállás.
- **Kvóta-védelem:** a Cégadat havi kerete látható mérőn, a futás kvótabecslést mutat indítás előtt.
- **GDPR:** jogos érdek, dokumentált érdekmérlegeléssel; minden levélben leiratkozás; a jelölt-adatok retenciója 12 hónap érdemi interakció nélkül, utána törlés. A `managers[]` és az e-mail személyes adat — a törlési kaszkádban benne.
- **Jogi alap:** a cold outreach ügyvédi jóváhagyása megvan; a rendszerben rögzíteni kell (ki, mikor, milyen körre), mert a modul kapuja ezt kéri.

---

## 7. Mérőszámok

Jelölt → bennmaradt (ICP-arány) → kontakt feloldva → vázlat → **jóváhagyási arány** (ez méri a célzás minőségét) → kiküldve → megnyitva → válasz → meeting. Plusz: adatlap-kvóta felhasználás, költség per meeting, és **elvetési okok megoszlása** — ha a „rossz célzás" dominál, a jelölt-forrás a hibás, nem a szöveg.

---

## 8. Fázisok

| Fázis | Tartalom | Előfeltétel |
|---|---|---|
| **F1** | Product + ICPProfile modell és admin felület | — |
| **F2** | Cégadat API provider (teszt kulccsal), gazdagítás, kvótakezelés, cache | — |
| **F3** | SourcingRun: jelölt-forrás, szűrés, audit-kötegelés, kontakt-vízesés | F1, F2 |
| **F4** | Vázlatgenerálás + jóváhagyási sor | F3 |
| **F5** | Gmail-küldés Fanni fiókjából, aláírás, follow-up, válaszkezelés | F4, új Workspace-fiók |
| **F6** | Account-kampány mód, mérőszámok, Signal Engine visszacsatolás | F5 |

Az F1–F4 teszt API-kulccsal fejleszthető, előfizetés nélkül.

---

## 9. Jóváhagyott döntések (2026-10-01)

| # | Döntés |
|---|---|
| 1 | **Küldő fiók:** `fanni.viragh@ventureco.agency` — külön Google Workspace-fiók, a `.group` domain reputációja elkülönítve marad |
| 2 | **Jelölt-forrás:** kizárólag a Cégadat API (Haladó) + a meglévő csatornák. Vásárolt adatbázis nincs → **a névtöredék-aratás és a kurált maglisták hordozzák a motort**, ezért ezek minősége kritikus (lásd 4.1 és 9bis) |
| 3 | **CLAUDE.md módosítása jóváhagyva:** a hideg megkeresés útvonalán az „emberi szerkesztés kötelező" szabályt az „explicit jóváhagyás + látható szöveg" váltja. A szabály máshol (LinkedIn-megkeresés, Outreach Studio) **változatlanul érvényben marad** |
| 4 | **Napi összkvóta:** induláskor 15, két hét után 25; termékenkénti bontás a felületen |
| 5 | **Indító termék:** weboldal-fejlesztés (audit-hook, rövid ciklus). A healthtech és az üzbég megoldások account-módban jönnek utána |
| 6 | **Referencia-megkülönböztetés megerősítve:** a Product rekordon minden referencia `isClient` jelölést kap; csak valódi ügyfél neve írható le a megkeresésben, célzási minta soha |

## 9bis · Ami a 2. döntésből következik

Vásárolt szegmenslista nélkül a jelölt-pool teljes egészében a **névtöredék-aratásból** és a **kurált maglistákból** jön. Ennek három következménye van, amit a fejlesztésbe be kell építeni:

1. **A névtöredék-készletek első osztályú, karbantartott tartalom.** Szegmensenként 10-25 töredék, Settings-ben szerkeszthető, verziózva. Minden töredékhez mérni kell, hány jelöltet hozott és azokból hány jutott el jóváhagyásig — a gyengén teljesítő töredékek kikerülnek, az erősek mintájára újak kerülnek be. Induló készletek a 19 szegmenshez előre feltöltve.
2. **A beszédes nevű szegmensek működnek jól** (fogászat, klinika, biztosító, logisztika, autószerviz), a semleges nevűek rosszul (IT-cégek, tanácsadók, gyártók gyakran fantázianevűek). Az utóbbiaknál a **maglista** és a Google Places a fő forrás, és ezt a felületen is jelezni kell: a szegmens kártyáján látszódjon, melyik forrás hordozza, és milyen eredményességgel.
3. **A pool kimerülése normál állapot, nem hiba.** Ha egy szegmensben elfogynak a jelöltek, a motor ezt jelzi a reggeli összefoglalóban, javasolja a töredékkészlet bővítését vagy a profil tágítását (pl. szomszédos megye, tágabb méretsáv), és addig a többi termék kvótájából tölt fel.

*Jóváhagyva. Következik: a repo dokumentációjának frissítése (docs/spec.md, CLAUDE.md), majd a fázisokra bontott fejlesztési promptok.*
