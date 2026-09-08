# Kimenő webhookok

> **Miért van ez.** A szoftver eddig csak *fogadni* tudott webhookot
> (`api/webhooks/mailgun`). Azt nem tudta megmondani egy külső rendszernek,
> hogy egy lead stádiumot váltott vagy egy ajánlatot elfogadtak. Ez a
> különbség egy eszköz és egy sziget között.

Beállítás: **Settings → admin settings → kimenő webhookok**. Csak Owner látja
és állíthatja — egy webhook egy állandó utasítás arra, hogy a munkaterület
adatai egy megadott címre menjenek, tehát egy lejárati idő nélküli export.

---

## Amit egy végpontnak tudnia kell

Minden esemény egy `POST`, `application/json` törzzsel, ezekkel a fejlécekkel:

| Fejléc | Tartalom |
|---|---|
| `X-Venture-Event` | Az esemény azonosítója, pl. `lead.stage_changed` |
| `X-Venture-Timestamp` | Unix másodperc, az aláírás része |
| `X-Venture-Signature` | `HMAC-SHA256(secret, "<timestamp>.<body>")`, hexben |
| `X-Venture-Delivery` | A küldés azonosítója — idempotenciához |
| `User-Agent` | `VentureOS-Webhook/1` |

A törzs mindig ugyanilyen alakú:

```json
{
  "event": "lead.stage_changed",
  "occurredAt": "2026-09-08T10:12:44.102Z",
  "workspaceId": "cmtsf...",
  "data": {
    "leadId": "cmtsg...",
    "from": "RESEARCHED",
    "to": "CONTACTED",
    "reason": null,
    "icpScore": 4,
    "companyId": "cmtsh..."
  }
}
```

A boríték (`event`, `occurredAt`, `workspaceId`, `data`) minden eseménynél
azonos. Aki egy eseményre megírja a fogadót, az összes többit is tudja
irányítani nélkül, hogy második értelmezőt írna.

---

## Az aláírás ellenőrzése

Ez nem opcionális. Aláírás nélkül bárki `POST`-olhat ugyanarra a címre, és a
fogadó nem tudja megmondani, hogy tőlünk jött-e.

```js
const crypto = require("node:crypto");

function verify(req, rawBody, secret) {
  const ts = Number(req.headers["x-venture-timestamp"]);
  const sig = req.headers["x-venture-signature"];
  if (!ts || !sig) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  // Fix idejű összehasonlítás: a === byte-onként szivárogtatja az aláírást
  // annak, aki elég kérést tesz.
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  // A timestamp azért van az aláírt anyagban, hogy a visszajátszás
  // észrevehető legyen. Öt perc bőven elég.
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= 300;
}
```

Két dolog, ami könnyen elromlik:

1. **A nyers törzset kell aláírni**, nem a `JSON.parse` után újra
   sorosítottat. Express-ben: `express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } })`.
2. **A titkot csak egyszer mutatjuk meg** — létrehozáskor és
   újragenerálásnál. Nem azért, mert nem lehetne visszaolvasni (kell hozzá,
   hogy az aláírást ki tudjuk számolni), hanem mert egy képernyő, ami örökre
   kiírja, egy képernyő, amiről előbb-utóbb screenshot készül.

---

## Események

| Esemény | Mikor |
|---|---|
| `lead.created` | Új lead — kézi felvitel, LinkedIn beillesztés, prospector, publikus audit, foglalólap, szektor-riport letöltés. **CSV importra nem**: egy 500 soros import nem 500 esemény. |
| `lead.stage_changed` | Lead stádiumot váltott (a pontszám-kapu után) |
| `deal.stage_changed` | Deal másik stádiumba került |
| `deal.won` | Deal megnyerve — külön esemény, hogy ne kelljen a stádiumneveinket ismerni hozzá |
| `document.finalized` | Az Owner véglegesített egy dokumentumot (lekerült a DRAFT vízjel) |
| `document.accepted` | Az ügyfél elfogadta az ajánlatot a publikus lapon |
| `invoice.issued` | Számla kiállítva — **a Számlázz.hu visszaigazolása után**, soha előtte |
| `meeting.booked` | Megbeszélés lefoglalva, appból vagy publikus foglalólapról |
| `audit.completed` | Weboldal-audit végigfutott — csak a `done` állapotot elérő futásokra |

---

## Újrapróbálkozás

Hat kísérlet, növekvő várakozással: kb. 1, 5, 25 perc, 2 óra, 10 óra. Ez
átível egy éjszakai kiesést anélkül, hogy szétvernénk a fogadó szervert.

- **2xx** → megérkezett.
- **4xx** (kivéve 408 és 429) → **nem próbáljuk újra**. A 404 azt jelenti, hogy
  a cím rossz, a 401 azt, hogy a titok rossz; egyik sem lesz jobb attól, hogy
  ötször megkérdezzük.
- **408, 429, 5xx, időtúllépés (10s), fel nem oldható tartománynév** →
  újrapróbálás.
- **Belső címre mutató URL** → azonnali végleges hiba. Aki tíz óra múlva is
  belülre mutat, az tíz óra múlva sem lesz külső rendszer.

Húsz egymást követő hiba után a **végpont kikapcsol**, és a beállításokban
kiírjuk, miért. Egy sor, ami soha nem ürül ki, nem hibatűrés, hanem lassú
szivárgás.

A küldési napló a beállításokban látszik: az utolsó öt küldés végpontonként,
válaszkóddal. A `Teszt küldése` gomb azonnal küld egyet, és megmondja, mi jött
vissza — anélkül csak úgy lehetne kipróbálni, hogy megvárunk egy igazi leadet,
és utána találgatunk, hogy a csend azt jelenti-e, hogy „nincs esemény", vagy
azt, hogy „rossz a cím".

A küldési napló nem örök: a sikeres küldések 30 nap, a hibásak 90 nap után
törlődnek. Teljes payload-másolatokat tartalmaz — lead-neveket,
szerződés-összegeket —, tehát ugyanolyan bérlői adat, mint minden más.

---

## Amit szándékosan nem lehet

- **`http://`** — a payload ügyféladatot tartalmaz.
- **IP-cím helyett** csak tartománynév. Az IP-vel való címzés az, amivel a
  privát tartományokat és a cloud metadata végpontot
  (`169.254.169.254`) el lehet érni.
- **`localhost`, `db`, `redis`, `app`, `worker`,** bármi `.local` /
  `.internal` végű, és minden egy-címkés név. Ezek mind elérhetők a
  konténerből, és egyik sem az interneten van.
- **Felhasználónév/jelszó az URL-ben**, és `#` töredék.
- **Átirányítás követése** (`redirect: "manual"`): egy 302 egy belső címre
  átsétálna a DNS-ellenőrzés mellett.

A tartománynevet **küldés előtt feloldjuk**, és minden kapott címet
megvizsgálunk: egy nyilvános név is mutathat `127.0.0.1`-re. Aki egy DNS
rekordot birtokol, nem kap kérést a `db:5432`-re.
