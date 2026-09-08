# Hol lehet a meglévő funkciókat érdemben feljebb tolni

*Készült: 2026-09-08. Alapja a kód átolvasása és a helyi/éles futtatás, nem
általános ötletelés. Minden tétel megnevezi, mit láttam, és mi az ára.*

Jelölés:
**[M]** = mérhető, ma is bizonyítható hiányosság · **[B]** = bővítés, ami a
meglévőre épül · **[K]** = kockázat, ami ma csendben van jelen

---

## 1. Site Audit

### 1.1 A pontszám 33 ellenőrzésből 13-at vesz figyelembe **[M]**

Ez a legnagyobb egyetlen probléma, amit találtam, és nem látszik sehol.

`DEFAULT_AUDIT_THRESHOLDS.weights` tizenhárom kulcsot tartalmaz. Az
`analyzeAudit` viszont — a P1/3c bővítés óta — **33 ellenőrzést** ad ki egy
átlagos oldalra. A pontozás `thresholds.weights[c.key] ?? 0`, tehát a maradék
**20 ellenőrzés nulla pontot ér**.

Lefuttattam egy szintetikus, mindenben bukó oldalra:

```
checks emitted:            33
checks with a weight:      13
checks worth 0 points:     20
failing-everything score:  91 STRONG
```

Vagyis: egy oldal, amelynek **lejár a tanúsítványa 5 nap múlva**, nincs HSTS-e,
nincs CSP-je, kevert tartalmat tölt, nincs SPF/DMARC rekordja, nincs
impresszuma, nincs adatkezelési tájékoztatója, és **21 súlyos
akadálymentességi hibája** van — ugyanannyi pontot kap ezekért, mint egy oldal,
amelyik mindegyiket teljesíti: **nullát**.

Ez két irányban is fáj. A pontszám kevésbé diszkriminatív, mint lehetne; és a
riportban ott van húsz megállapítás, amiről a vevő joggal hiszi, hogy számít.

**Javaslat:** a Settings → audit súlyok panel kapja meg mind a 33 kulcsot,
kategóriánként csoportosítva, alapértelmezett súlyokkal. Migrációt nem igényel
(a `weights` már szabad JSON), de a `schemaVersion` léptetése kell, hogy a
delta ne jelentsen romlást ott, ahol csak mi változtunk.

### 1.2 Képernyőkép-összevetés két audit között **[B]**

Minden auditnál eltárolunk desktop + mobil PNG-t, és a `delta` már tudja, mi
változott számokban. A két kép egymás mellé rakása — "ez volt júliusban, ez
van most" — az eddigi legerősebb tárgyalási eszköz lenne, és **nem igényel új
adatot**, csak egy nézetet.

### 1.3 Az audit-megállapításokból legyen board **[B]**

A P2/4 prioritási mátrix már kiszámolja, mit érdemes előbb csinálni. Most, hogy
van task board, egy gomb ("Terv készítése ebből") létrehozhatna egy boardot
`Gyors nyeremények / Nagyobb munkák / Később` szekciókkal, feltöltve a
megállapításokkal. Ez köti össze az auditot a szállítással.

### 1.4 A crawl mód nem látszik a riportban **[M]**

A P2/9 eldönti, hogy statikus vagy renderelt bejárás kell-e, és a döntés
szerepel a logban — de a riportban nem. Egy 10 oldalas renderelt bejárás és egy
15 oldalas statikus két különböző mélységű vizsgálat, és az ügyfélnek joga van
tudni, melyiket kapta.

### 1.5 PageSpeed kulcs nélkül a modul fele néma volt **[K]** — *részben javítva*

A mai javítás után a riport kiírja, ha a PageSpeed nem mérhető. Amit még
érdemes: a Settings → Integrations mutassa a **napi kvótafogyást** (az
`ApiCosts` panel már gyűjti a hívásszámot), mert a kvóta elfogyása
munkaidő közben is bekövetkezhet.

---

## 2. Lead Engine

### 2.1 Mentett nézet exportja ütemezetten **[B]**

Az export ma a képernyőn lévő oszlopokat viszi, és ez helyes. A következő lépés
a **mentett nézethez kötött export**: "minden hétfőn 8-kor a *Qualified,
Budapest* nézet XLSX-ben a postafiókomba". A mentett nézetek (`saved_views`) és
a BullMQ ütemező már megvan; csak a kettő összekötése hiányzik.

### 2.2 Egyedi mezők tömeges szerkesztése **[M]**

A tömeges sáv tud stádiumot, jelzést és tulajdonost állítani — de **egyedi
mezőt nem**. Egy Owner által definiált „Szerződés típusa" mezőt ma
ötven leaden ötvenszer kell átállítani.

### 2.3 Duplikátum-átnézeti sor **[B]**

A `findProspectDuplicate` szigorú (domain/telefon). Ami hiányzik: egy
**gyanús párok** lista fuzzy névegyezés alapján, amit egy ember jóváhagy vagy
elvet. A `data.merge` képesség és a `merge_records` tábla már létezik hozzá.

---

## 3. Tasks *(ma épült — amit szándékosan kihagytam)*

### 3.1 Függőségek („X csak Y után") **[B]**

Asana-alapfunkció. Kihagytam, mert egy rosszul megrajzolt függőségi gráf
könnyen olyan táblát csinál, amin semmi nem indulhat el. Ha kell, egyszerű
`blockedBy` reláció + ciklusdetektálás.

### 3.2 Ismétlődő feladatok **[B]**

„Minden hónap első hétfőjén: számlák egyeztetése." A wakeups sor és a cron
minta már adott.

### 3.3 Board-sablonok **[B]**

Az ügyfél-onboarding minden alkalommal ugyanaz a nyolc lépés. A
`project_templates` tábla pontosan ezt a mintát oldja meg a szállítási
oldalon — a task boardok újrahasznosíthatnák.

### 3.4 „Az én munkám" nézet boardokon át **[M]**

Ma a dashboard-panel mutatja a saját feladatokat, de **board-tudat nélkül**: nem
látszik, melyik boardról jött. Egy külön, boardokon átívelő nézet határidő
szerint rendezve az, amit reggel az ember először néz.

### 3.5 Csatolmányok **[B]**

A `/data/files` kötet és a hitelesített kiszolgáló útvonal már megvan; egy
task-csatolmány ugyanaz a minta, mint az audit-képernyőkép.

---

## 4. Dokumentumok és pénz

### 4.1 Valódi elektronikus aláírás **[M]**

A `acceptance-provider.ts` saját kommentje mondja ki: amit ma gyűjtünk, az
**„assent evidence, NOT a qualified e-signature"** — időbélyeg, IP,
user-agent. Egy szerződésnél ez a különbség számít. A modul szándékosan hagyott
helyet ("plugs into this exact slot"), tehát ez betervezett, nem hiányzó.

**Ára:** eIDAS-megfelelő szolgáltató (Dokobit, Namirial) vagy saját tanúsítvány-
kezelés. Ez a legnagyobb tétel ezen a listán.

### 4.2 Fizetési emlékeztetők **[B]**

A `invoice-poll` napi sweep már látja, mi van kifizetve. Ami nincs: a
**lejárt számlához tartozó emlékeztető-lánc** (7/14/30 nap), emberi
jóváhagyással — összhangban a „soha nem küld magától" szabállyal.

### 4.3 Árajánlat-verziók összevetése **[B]**

Ha egy ajánlat harmadik körben megy vissza, ma nem látszik egy helyen, mi
változott a másodikhoz képest. A dokumentumok verziózottak, tehát az adat
megvan.

---

## 5. Biztonság és üzemeltetés

### 5.1 Kétlépcsős azonosítás munkaterület-szintű kikényszerítése **[K]**

Ma a 2FA **felhasználónként** opcionális. Nincs olyan kapcsoló, hogy „ebben a
munkaterületben mindenkinek kötelező". Egy ügyféladatokat tartalmazó rendszernél
ez a szokásos elvárás, és a `mustEnrollTotp` mező már létezik hozzá — csak a
politika hiányzik, ami beállítja.

### 5.2 Kimenő webhookok / API **[B]**

Van `api/webhooks/mailgun` (bejövő). Ami nincs: **kimenő** események
(lead stádiumot váltott, ajánlat elfogadva) egy külső rendszer felé. Ez az,
ami a szoftvert integrálhatóvá teszi ahelyett, hogy sziget lenne.

### 5.3 Az audit log exportja és megőrzése **[M]**

A napló olvasható a felületen, de **nem exportálható**, és nincs rá megőrzési
szabály. Egy adatvédelmi incidensnél az első kérés a naplókivonat.

### 5.4 Visszaállítási próba **[K]**

A `scripts/backup.sh` naponta ment, és 50 mentés van a szerveren — ezt ma
láttam futni. Amit **soha senki nem próbált ki**: hogy ezekből vissza lehet-e
állítani. Egy negyedéves, dokumentált visszaállítási próba egy üres adatbázisba
az egyetlen dolog, ami a mentést mentéssé teszi.

---

## 6. Munkaterületek és jogosultságok

### 6.1 Munkaterület-sablonok **[B]**

Az új munkaterület ma megkapja az alap pipeline-okat és sablonokat (ez a mai
javítás). A következő szint: egy meglévő munkaterület beállításait — márka,
egyedi mezők, workflow szabályok, quote szabályok — **átmásolni** az újba.

### 6.2 `PUBLIC_INTAKE_WORKSPACE_ID` a második workspace-nél kötelezővé válik **[K]** — *figyelmeztetés kirakva*

A `getPublicIntakeWorkspaceId()` nem tippel: egy workspace-nél azt használja,
többnél `PUBLIC_INTAKE_WORKSPACE_ID` nélkül **megtagadja**. Ilyenkor a
self-serve audit (`audit.`), a publikus riport-index és a `meet.` foglalólapok
üres állapotot mutatnak.

Ez elméleti probléma volt, amíg a második workspace használhatatlan héj volt.
Most, hogy működő, ez élő csapda — ezért a `/settings/workspaces` kiírja, ha
egynél több workspace van és a változó nincs beállítva, a beírandó sorral
együtt. **Amikor ezen a szerveren létrejön a második workspace, ezt be kell
állítani, különben három ügyfél felé néző felület elhallgat.**

### 6.3 Kliens-hozzáférés (read-only szerep) **[B]**

Az `isTrustedMember` kommentje maga jelzi, hogy egy read-only szerep egy
szerkesztéssel bevezethető. Egy ügyfél, aki látja a saját projektjét és a
dokumentumait, de semmi mást — ez az, ami a szállítási oldalt eladhatóvá teszi.

### 6.4 A meghívó levélben is menjen ki **[B]**

A mai meghívó linket ad, amit az Owner elküld. Egy „küldd el nekem emailben"
gomb (tranzakciós domain, kifejezett gombnyomásra) kényelmesebb lenne — a
CLAUDE.md szabálya ezt megengedi, mert explicit felhasználói művelet.

---

## Amit én a helyedben ebben a sorrendben csinálnék

| # | Tétel | Miért ez |
|---|---|---|
| 1 | **1.1 Audit-súlyok** | Ma is rossz számot ad egy eladási eszköz. Egy konfigurációs panel + egy schemaVersion. |
| 2 | **5.4 Visszaállítási próba** | Nem fejlesztés, egy délután. A kockázat, amit fed, a teljes üzlet. |
| 3 | **5.1 2FA kikényszerítés** | Kis munka, nagy megnyugvás, a mező már megvan. |
| 4 | **1.2 Képernyőkép-összevetés** | Nincs új adat, csak egy nézet — és ez lesz a legerősebb dia a tárgyaláson. |
| 5 | **3.4 „Az én munkám"** | A task rendszer csak akkor él, ha van egy hely, ahol reggel elkezdődik. |
| 6 | **2.1 Ütemezett export** | A két fél (mentett nézet, ütemező) kész, össze kell kötni. |
| 7 | **4.1 E-aláírás** | A legnagyobb üzleti érték és a legnagyobb munka. Külön projekt. |
