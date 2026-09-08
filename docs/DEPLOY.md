# Venture OS Lite — telepítési útmutató

Ez a leírás nulláról végigvezet a teljes telepítésen egy Vultr szerverre. Nem
feltételez korábbi szerveres tapasztalatot: minden parancsot pontosan úgy kell
begépelni (vagy bemásolni), ahogy szerepel.

**Amire szükséged lesz:**

- egy bankkártya a Vultr-hoz (kb. 20–24 USD/hó),
- hozzáférés a `ventureco.agency` domain DNS-beállításaihoz,
- egy Anthropic, egy Google Cloud és egy Mailgun fiók,
- kb. 60–90 perc.

**Menet közben végig kelleni fog egy jegyzettömb.** Sok jelszót és kulcsot fogsz
generálni; írd fel őket egyesével, mert némelyiket csak egyszer mutatja meg a
szolgáltató.

---

> ## ⚠️ Fontos, mielőtt élesbe kapcsolod
>
> **A rendszer bejelentkezéssel védett.** Jelszó (bcrypt) és opcionális
> kétlépcsős azonosítás (TOTP, mint a Google Authenticator). A munkamenetek a
> szerver adatbázisában élnek, tehát bármikor visszavonhatók, és 12 óra után
> lejárnak.
>
> Az első tulajdonosi jelszót te állítod be a **7. lépésben**, parancssorból.
> Amíg ez nem történt meg, senki nem tud belépni — a telepítés alapból zárt.
>
> A három nyilvános aloldal (`audit.`, `quote.`, `meet.`) szándékosan **nincs**
> jelszóval védve: ezeket az ügyfeleknek kell tudniuk megnyitni. Ezek csak
> egyedi, kitalálhatatlan azonosítóval érhetők el.

---

## 1. lépés — Vultr szerver létrehozása

1. Regisztrálj a [vultr.com](https://www.vultr.com) oldalon, majd **Deploy** →
   **Deploy New Server**.
2. Állítsd be így:

   | Beállítás | Érték |
   |---|---|
   | Típus | **Cloud Compute – Shared CPU** |
   | Régió | **Frankfurt** vagy **Amsterdam** (EU — GDPR miatt kötelező) |
   | Image | **Ubuntu 24.04 LTS x64** |
   | Plan | **Regular Cloud Compute**, min. **2 vCPU / 4 GB RAM / 80 GB NVMe** |
   | Auto Backups | **Enable** (ajánlott, kb. +20% ár) |
   | SSH Key | add hozzá a saját kulcsod, ha van (különben jelszót emailben küld) |
   | Hostname | `ventureos` |

   > **Miért 4 GB?** A rendszerben fut egy fejnélküli Chrome böngésző, ami a
   > weboldal-auditokat és az összes PDF-et készíti. 2 GB-on ez elfogy.

3. Kattints a **Deploy Now** gombra, és várj kb. 2–3 percet.
4. Ha kész, nyisd meg a szervert a listából, és **írd fel az IP-címét** — ilyen
   formájú: `95.179.xxx.xxx`. Ezt a leírásban `SZERVER_IP`-ként hivatkozom.

### Belépés a szerverre

A saját gépeden nyiss egy terminált (macOS: Terminal, Windows: PowerShell):

```bash
ssh root@SZERVER_IP
```

Első alkalommal rákérdez, hogy megbízol-e a szerverben — írd be: `yes`.
Ha nem SSH-kulcsot használtál, a Vultr felületén a **Server Details** alatt
találod a root jelszót (a szem ikonra kattintva).

### Tűzfal beállítása

Másold be egyesével:

```bash
ufw allow 22/tcp      # SSH — ezen keresztül csatlakozol
ufw allow 80/tcp      # HTTP — a tanúsítvány kiállításához kell
ufw allow 443/tcp     # HTTPS — ezen fut az alkalmazás
ufw allow 443/udp     # HTTP/3
ufw --force enable
ufw status
```

Az utolsó parancs kimenetében mind a négy szabálynak látszania kell.

> ⚠️ **A 80-as portot ne zárd be** a telepítés után sem: a Let's Encrypt ezen
> keresztül újítja meg a tanúsítványokat 60 naponta.

---

## 2. lépés — DNS rekordok létrehozása

Lépj be oda, ahol a `ventureco.agency` domaint kezeled, és keresd meg a **DNS**
vagy **DNS records** menüpontot.

Hozz létre **öt darab A rekordot**, mindegyik ugyanarra a `SZERVER_IP`-re mutat:

| Típus | Név / Host | Érték | TTL |
|---|---|---|---|
| A | `@` (vagy üresen hagyva = a gyökér) | `SZERVER_IP` | 3600 |
| A | `www` | `SZERVER_IP` | 3600 |
| A | `audit` | `SZERVER_IP` | 3600 |
| A | `quote` | `SZERVER_IP` | 3600 |
| A | `meet` | `SZERVER_IP` | 3600 |

> A `@` a domain gyökerét jelenti, tehát magát a `ventureco.agency`-t. Néhány
> szolgáltatónál ezt üresen kell hagyni, másoknál a domain nevét kell beírni.

### A terjedés ellenőrzése

A DNS-változás 5 perctől 24 óráig terjedhet szét. Ellenőrizd a saját gépeden:

```bash
dig +short ventureco.agency
dig +short www.ventureco.agency
dig +short audit.ventureco.agency
dig +short quote.ventureco.agency
dig +short meet.ventureco.agency
```

Mind az öt parancsnak a `SZERVER_IP`-t kell visszaadnia. Ha nincs `dig`
parancsod, használd a [dnschecker.org](https://dnschecker.org) oldalt.

> ⛔ **Ne menj tovább, amíg mind az öt nem a szerver IP-jét adja vissza.** A
> Caddy csak akkor tud HTTPS-tanúsítványt kérni, ha a domainek már a szerverre
> mutatnak — különben a **3. troubleshooting pontnál** kötsz ki.

---

## 3. lépés — Docker telepítése (Ubuntu 24.04)

A szerveren (tehát az `ssh` munkamenetben) másold be **egyesével**:

```bash
# 1. Csomaglisták frissítése és alapok
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg git

# 2. A Docker hivatalos aláírókulcsa
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# 3. A Docker csomagforrás hozzáadása
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

# 4. Docker telepítése
apt update
apt install -y docker-ce docker-ce-cli containerd.io \
               docker-buildx-plugin docker-compose-plugin
```

Ellenőrzés:

```bash
docker --version          # pl. Docker version 27.x
docker compose version    # pl. Docker Compose version v2.x
```

Ha mindkettő verziószámot ír ki, kész vagy.

### Swap fájl (ajánlott)

4 GB memóriánál egy 2 GB-os swap megakadályozza, hogy egy nagy PDF-generálás
kilője a konténereket:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h    # a Swap sorban látszania kell a 2 GB-nak
```

---

## 4. lépés — A projekt letöltése és beállítása

### Kód letöltése

```bash
mkdir -p /opt
cd /opt
git clone <A-REPO-URL-JE> ventureos-lite
cd /opt/ventureos-lite
```

> A `<A-REPO-URL-JE>` helyére a saját Git-tárolód címe kerül. Privát repónál
> előbb hozz létre egy deploy kulcsot, vagy használj HTTPS-t felhasználónév +
> personal access token párossal.

### A `.env` fájl elkészítése

```bash
cp .env.production.example .env
```

Most töltsd ki. Nyisd meg a `nano` szerkesztővel:

```bash
nano .env
```

> **A `nano` használata:** nyilakkal mozogsz, sima gépeléssel írsz. Mentés:
> `Ctrl+O`, majd `Enter`. Kilépés: `Ctrl+X`.

Végig kell menned a fájlon, és minden `CHANGE-ME` szöveget valódi értékre kell
cserélned. Az alábbi táblázat megmondja, honnan szerzed be őket.

#### 4a. Jelszavak, amiket te találsz ki

Generálj hármat, és írd fel őket:

```bash
openssl rand -base64 32   # ezt tedd a NEXTAUTH_SECRET-hez
openssl rand -hex 24      # ezt tedd a POSTGRES_PASSWORD-höz
openssl rand -hex 24      # ezt tedd az APP_DB_PASSWORD-höz
```

> ⚠️ Az `APP_DB_PASSWORD` értékét **két helyre** kell beírni: a saját sorába
> **és** a `DATABASE_URL` sorába a `app_user:` után.

#### 4b. Anthropic (Claude) API kulcs

1. Menj a [console.anthropic.com](https://console.anthropic.com) oldalra.
2. **Settings → API keys → Create Key**.
3. A `sk-ant-` kezdetű kulcsot másold az `ANTHROPIC_API_KEY` sorba.

> A kulcsot csak egyszer mutatja meg. Tölts fel legalább 20 USD egyenleget
> (**Billing** menü), különben az AI-funkciók nem működnek.

#### 4c. Google Cloud kulcsok

1. Menj a [console.cloud.google.com](https://console.cloud.google.com) oldalra.
2. Hozz létre egy projektet: **Select a project → New Project**, neve legyen
   `ventureos`.
3. **APIs & Services → Library**, és kapcsold be ezt a hármat:
   - **Places API (New)**
   - **PageSpeed Insights API**
   - **Google Calendar API**
4. **APIs & Services → Credentials → Create Credentials → API key**. A kapott
   kulcsot másold be **kétszer**: `GOOGLE_PLACES_API_KEY` és
   `PAGESPEED_API_KEY`.
   - Kattints a kulcson a **Edit** ikonra → **Application restrictions** →
     **IP addresses** → add meg a `SZERVER_IP`-t. Így ellopva sem használható.
5. Naptárhoz: **Create Credentials → OAuth client ID** →
   **Application type: Web application**.
   - **Authorized redirect URIs** → **ADD URI** →
     `https://ventureco.agency/api/google/callback`
   - A kapott **Client ID** → `GOOGLE_CLIENT_ID`,
     **Client secret** → `GOOGLE_CLIENT_SECRET`.

> A Places API fizetős, de van havi ingyenkeret. Állíts be költségriasztást:
> **Billing → Budgets & alerts**.

#### 4d. Mailgun — KÉT külön domain

Ez a legfontosabb rész. **Két teljesen külön küldési domainre van szükség**, mert
a hideg megkeresések panaszai soha nem ronthatják el annak a domainnek a
hírnevét, amin az árajánlatok és szerződések mennek ki.

**A tranzakciós domain (`mg.ventureco.group`)** — ez már ellenőrzött:

1. [app.eu.mailgun.com](https://app.eu.mailgun.com) → **Send → Domains** →
   kattints a `mg.ventureco.group` sorra.
2. **Domain settings → Sending API keys → Add sending key**.
3. A kapott kulcs → `MAILGUN_API_KEY`.

**A hideg domain (`cold.ventureco.agency`)** — ezt most hozod létre:

1. **Send → Domains → Add New Domain**.
2. Írd be: `cold.ventureco.agency`. Régió: **EU**.
3. A Mailgun kiír néhány DNS-rekordot (TXT az SPF-hez és a DKIM-hez, MX-ek).
   **Vidd fel mindet** a domain DNS-beállításaiba, ugyanoda, ahol a 2. lépésben
   az A rekordokat csináltad.
4. Várj 15–30 percet, majd a Mailgunon **Verify DNS Settings**. Zöld pipákat kell
   látnod.
5. Ehhez a domainhez is: **Sending API keys → Add sending key**. A kulcs →
   `MAILGUN_COLD_API_KEY`.

Végül a webhook kulcs: **Settings → Webhooks → HTTP webhook signing key** →
`MAILGUN_WEBHOOK_SIGNING_KEY`.

> ⚠️ Ha a `MAILGUN_DOMAIN` és a `MAILGUN_COLD_DOMAIN` értéke azonos lenne, az
> alkalmazás **elindulni sem fog**, és pontosan ezt fogja kiírni. Ez szándékos.

#### 4e. Ellenőrzés mentés előtt

Mentsd el a fájlt (`Ctrl+O`, `Enter`, `Ctrl+X`), majd:

```bash
grep -n "CHANGE-ME" .env
```

Ha ez a parancs **semmit nem ír ki**, minden helyőrzőt kicseréltél. Ha kiír
sorokat, azokat még pótolnod kell.

Zárd le a fájl jogosultságait:

```bash
chmod 600 .env
```

---

## 5. lépés — Első indítás

```bash
cd /opt/ventureos-lite
docker compose -f docker-compose.prod.yml up -d --build
```

Ez az első alkalommal **10–20 percig** tart: letölti az alapképeket és lefordítja
az alkalmazást. Nyugodtan nézd, ahogy görög a kimenet.

Amikor visszakapod a promptot, nézd meg az állapotot:

```bash
docker compose -f docker-compose.prod.yml ps
```

Ezt kell látnod:

```
NAME                 STATUS
ventureos-app-1      Up (healthy)
ventureos-caddy-1    Up (healthy)
ventureos-db-1       Up (healthy)
ventureos-redis-1    Up (healthy)
ventureos-worker-1   Up (healthy)
```

A `ventureos-migrate-1` **nem** fog itt látszani, mert az egy egyszer lefutó
feladat (adatbázis-táblák létrehozása + a soronkénti biztonsági szabályok). Ha
kíváncsi vagy, mit csinált:

```bash
docker compose -f docker-compose.prod.yml logs migrate
```

> Az `(healthy)` állapot 1–2 percet vehet igénybe az indulás után. Ha valamelyik
> sor `Restarting`, ugorj a **Hibaelhárítás** fejezethez.

### Naplók megtekintése

```bash
# minden szolgáltatás, élőben (kilépés: Ctrl+C)
docker compose -f docker-compose.prod.yml logs -f

# csak az alkalmazás, utolsó 100 sor
docker compose -f docker-compose.prod.yml logs --tail=100 app
```

---

## 6. lépés — Működik-e?

### HTTPS-tanúsítványok

A Caddy indulás után magától kér tanúsítványt mind az öt névre. Ez 1–3 percig
tart. Ellenőrzés:

```bash
docker compose -f docker-compose.prod.yml logs caddy | grep -i "certificate obtained"
```

Öt sort kell látnod, egyet-egyet minden domainre.

### Nyisd meg a böngészőben

| Cím | Mit kell látnod |
|---|---|
| `https://ventureco.agency` | jelszókérő ablak, utána az alkalmazás |
| `https://www.ventureco.agency` | automatikusan átirányít a fentire |
| `https://audit.ventureco.agency` | nem hibaüzenet (üres/„nincs ilyen" oldal — ez helyes, mert a valódi címekben van egy egyedi azonosító is) |
| `https://quote.ventureco.agency` | ugyanígy |
| `https://meet.ventureco.agency` | ugyanígy |

Mindegyiknél **zöld lakat** kell legyen a címsorban.

> A három aloldal önmagában, azonosító nélkül szándékosan nem mutat semmit. Az
> igazi próbájuk az, amikor az alkalmazásból megosztasz egy auditot vagy
> árajánlatot — a kapott link `https://audit.ventureco.agency/AbC123...` alakú
> lesz, és annak meg kell nyílnia.

Gyors parancssori ellenőrzés a szerverről:

```bash
curl -sI https://ventureco.agency          | head -1   # HTTP/2 401  (a jelszókérés)
curl -sI https://www.ventureco.agency      | head -1   # HTTP/2 308  (átirányítás)
curl -s  https://ventureco.agency/api/health           # {"status":"ok",...}
```

---

## 7. lépés — Az első tulajdonos létrehozása

Az adatbázis még üres. Töltsd fel a kezdőadatokkal (munkaterület, sablonok,
foglalási oldal, az első felhasználó):

```bash
cd /opt/ventureos-lite
docker compose -f docker-compose.prod.yml run --rm worker npm run db:seed
```

Ez létrehozza a tulajdonost azzal az email-címmel, amit a `.env` fájl
`SEED_OWNER_EMAIL` sorába írtál (alapértelmezés: `director@ventureco.group`),
teljes jogosultságokkal — de **jelszó nélkül**, tehát még nem lehet belépni.

### Jelszó beállítása

```bash
docker compose -f docker-compose.prod.yml run --rm worker \
  npm run set-password -- director@ventureco.group
```

A parancs bekéri az új jelszót (kétszer, és nem írja ki a képernyőre). Minimum
**12 karakter**. Írj be egy hosszú, könnyen megjegyezhető mondatot — a hossz
véd, nem a `!@#` jelek.

> Ugyanez a parancs használható később is, ha valaki kizárta magát:
> ```bash
> # jelszó-visszaállítás
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run set-password -- valaki@ventureco.group
>
> # ha elveszett a telefon a kétlépcsős kóddal
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run set-password -- valaki@ventureco.group --clear-2fa
> ```
> A jelszó megváltoztatása minden meglévő munkamenetet érvénytelenít.

### Belépés

Nyisd meg a `https://ventureco.agency` címet, és lépj be az email-címeddel és az
imént beállított jelszóval.

### Kétlépcsős azonosítás bekapcsolása (erősen ajánlott)

1. **Settings → security → Set up two-factor**
2. Olvasd be a QR-kódot a telefonoddal (Google Authenticator, 1Password, Authy…).
3. Írd be a megjelenő 6 jegyű kódot, majd **Confirm**.

Ezután minden belépésnél kérni fogja a kódot. Ugyanitt látod, milyen eszközökön
vagy éppen bejelentkezve, és egy gombbal kiléptethetsz minden más eszközt.

> ⚠️ Ha elveszíted a telefonod és nincs másik bejelentkezett eszközöd, csak a
> fenti `--clear-2fa` paranccsal tudsz visszajutni. Ehhez SSH-hozzáférés kell a
> szerverhez — ezért fontos, hogy az SSH-kulcsod meglegyen.

### További felhasználók

**Settings → workspace → add member**: megadod az email-címet és a szerepkört.
A fiók létrejön, de jelszó nélkül — a jelszót a fenti `set-password` paranccsal
állítod be neki, és `--force-change` kapcsolóval kérheted, hogy első belépéskor
maga válasszon újat.

## 8. lépés — Éjszakai mentés beállítása

A mentőszkript minden éjjel készít egy adatbázis-dumpot és egy másolatot a
feltöltött fájlokról (PDF-ek, képernyőképek), és 14 napnyit tart meg belőlük.

Először próbáld ki kézzel:

```bash
cd /opt/ventureos-lite
./scripts/backup.sh
```

Ha jól ment, ilyesmit ír ki:

```
[backup 03:30:01] target /var/backups/ventureos (retention 14d)
[backup 03:30:02] dumping database ventureos
[backup 03:30:04] database ok (248K)
[backup 03:30:05] archiving /data/files
[backup 03:30:07] files ok (1.2M)
[backup 03:30:07] rotation removed 0 expired file(s)
[backup 03:30:07] done — 1 database backup(s) retained
```

Nézd meg a fájlokat:

```bash
ls -lh /var/backups/ventureos/
```

Most időzítsd be éjjel fél négyre:

```bash
crontab -e
```

(Ha megkérdezi, melyik szerkesztőt szeretnéd, válaszd a `nano`-t — az 1-es.)
Illeszd be a fájl végére ezt az egy sort:

```
30 3 * * * cd /opt/ventureos-lite && ./scripts/backup.sh >> /var/log/ventureos-backup.log 2>&1
```

Mentés: `Ctrl+O`, `Enter`, `Ctrl+X`. Ellenőrzés: `crontab -l`.

> ⚠️ **A mentés ugyanazon a gépen van, mint az adat.** Ha a szerver elveszik,
> a mentés is. Legalább hetente egyszer töltsd le magadhoz:
>
> ```bash
> scp root@SZERVER_IP:/var/backups/ventureos/db-*.dump ~/Downloads/
> ```
>
> Vagy kapcsold be a Vultr automatikus pillanatképeit (1. lépés).

> A 14 napos rotáció nem önkényes: ez teljesíti a GDPR törlési ígéretünket is —
> a részletek a [`docs/backup-erasure-policy.md`](backup-erasure-policy.md)
> fájlban.

### És negyedévente egy visszaállítási próba

A mentés akkor mentés, ha egyszer már visszaállt belőle valami. Egy
kipróbálatlan mentés csak egy jó méretű fájl a jó helyen — és a kettő
pontosan addig érződik ugyanannak, amíg el nem jön az a reggel, amikor
kiderül.

```bash
cd /opt/ventureos-lite
./scripts/restore-drill.sh
```

A szkript a legfrissebb dumpot betölti egy **külön, eldobható** adatbázisba az
élő mellé, kérdéseket tesz fel neki (visszajött-e a séma, van-e workspace és
user, mennyire friss a *tartalom*, megvannak-e az RLS policy-k), majd eldobja.
Az élő adatbázishoz nem ér hozzá, és mentési fájlt nem töröl. Nyolc-tíz perc.

Negyedévente, cronból:

```
0 4 1 */3 * cd /opt/ventureos-lite && ./scripts/restore-drill.sh >> /var/log/ventureos-drill.log 2>&1
```

A hibák jelentése, és a **valódi** visszaállítás rendje — beleértve azt, hogy
az élő adatbázist átnevezni kell, nem eldobni —
a [`docs/restore-drill.md`](restore-drill.md) fájlban van.

---

## 9. lépés — Frissítés későbbi verzióra

Amikor új verzió készül el:

```bash
cd /opt/ventureos-lite

# 1. Biztonsági mentés ELŐSZÖR — mindig
./scripts/backup.sh

# 2. Új kód letöltése
git pull

# 3. Újraépítés és újraindítás
docker compose -f docker-compose.prod.yml up -d --build

# 4. Ellenőrzés
docker compose -f docker-compose.prod.yml ps
```

Az adatbázis-módosítások automatikusan lefutnak indulás közben (a `migrate`
szolgáltatás), az adataid megmaradnak.

> ### ⚠️ A séma-migráció és az adat-migráció nem ugyanaz
>
> A `migrate` szolgáltatás **táblákat** hoz létre és módosít. Van néhány
> frissítés, amelyik ezen felül a **meglévő sorokat** is át akarja alakítani —
> ilyet a rendszer soha nem futtat magától, mert az adatot ír, és azt nem
> szabad egy konténerindulás mellékhatásaként megtenni.
>
> Ha a kiadás jegyzete adat-migrációt említ, az a `git pull` **után**, a
> `up -d --build` **után** következik, mindig ebben a három lépésben:
>
> ```bash
> # 1. Próba: nem ír semmit, csak megmutatja, mit tenne
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run deals:migrate -- --dry-run
>
> # 2. Éles futtatás — csak ha a próba kimenete rendben van
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run deals:migrate -- --apply
>
> # 3. Ellenőrzés — nem nulla kilépési kóddal jelez, ha bármi nem stimmel
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run deals:migrate -- --verify
> ```
>
> Ha a 3. lépés hibát jelez, van visszaút — a migráció csak az általa
> létrehozott sorokat törli, amit utána ember vitt fel, azt nem:
>
> ```bash
> docker compose -f docker-compose.prod.yml run --rm worker \
>   npm run deals:migrate -- --rollback
> ```
>
> A részletek — mi mire képződik le, és miért visszafordítható —
> a [`docs/migrations/p4-deals.md`](migrations/p4-deals.md) fájlban.

### Kiadási ellenőrzőlista

Frissítéskor ezt a sorrendet érdemes végigmenni; a sorrend nem önkényes, a
mentés attól ér valamit, hogy még az új kód előtt készül el.

| # | Lépés | Mit vársz |
|---|---|---|
| 1 | `./scripts/backup.sh` | `done — N database backup(s) retained` |
| 2 | `git pull` | a várt commitok |
| 3 | `.env` hiánylista (lásd lent) | üres kimenet, vagy tudod, mit pótolsz |
| 4 | `docker compose -f docker-compose.prod.yml up -d --build` | visszakapod a promptot |
| 5 | `docker compose -f docker-compose.prod.yml logs migrate` | `All migrations have been successfully applied.` és `Applied RLS` |
| 6 | adat-migráció, ha van (fent) | `--verify` nulla kilépési kóddal |
| 7 | `docker compose -f docker-compose.prod.yml ps` | öt sor, mind `Up (healthy)` |
| 8 | `curl -s https://ventureco.agency/api/health` | `{"status":"ok","database":"ok",...}` |

Ha az 5. lépés `P3005`-öt ír (`database schema is not empty`), az azt jelenti,
hogy az adatbázis nem migrációkkal épült. **Ne** futtass `db push`-t élesben —
állj meg, és nézd meg a `_prisma_migrations` táblát.

Ha a `.env.production.example` új sorokkal bővült, azokat kézzel kell átvezetned:

```bash
diff <(grep -o '^[A-Z_]*=' .env.production.example | sort) \
     <(grep -o '^[A-Z_]*=' .env | sort)
```

A `<` jellel kezdődő sorok hiányoznak a te `.env` fájlodból.

### Régi képek takarítása

Néhány frissítés után a lemezt megtöltik a régi Docker-képek:

```bash
docker system df           # mennyi helyet foglal
docker image prune -a -f   # a nem használt képek törlése
```

---

## Sor-szintű védelem (RLS) — be- és kikapcsolás

A bérlő-elválasztásnak két öve van (CLAUDE.md #1): a Prisma tenant-guard, ami
mindig fut, és a Postgres sor-szintű védelme, ami az adatbázisban is elutasítja
az idegen workspace sorait — **akkor is, ha a guard hibázna**. A másodikat egy
kapcsoló vezérli:

```bash
# BE
sed -i 's/^DB_RLS=.*/DB_RLS=on/' .env || echo "DB_RLS=on" >> .env
docker compose -f docker-compose.prod.yml up -d app worker

# KI (azonnali visszaállás, újraépítés nélkül)
sed -i 's/^DB_RLS=.*/DB_RLS=off/' .env
docker compose -f docker-compose.prod.yml up -d app worker
```

Bekapcsolva a workspace-hez kötött lekérdezések egy külön kapcsolat-medencén,
`app_user` szerepként futnak (nem superuser, nem kerülheti meg a szabályokat), és
minden lekérdezés elé bekerül a workspace deklarálása. Ehhez az `APP_DB_PASSWORD`
értékének egyeznie kell azzal, amivel a `migrate` lépés a szerepet létrehozta.

**Az `app` és `worker` DATABASE_URL-je szándékosan a tulajdonosé marad.** A
bejelentkezés a workspace létezése ELŐTT olvas globális táblákat, a publikus
oldalak pedig bérlőkön átnyúlva oldják fel a nem listázott slugot — egyik sem
lehetséges workspace-hez kötött szabály alatt. A védelem nem ezen a soron múlik.

Ellenőrzés bekapcsolás után (csak olvas, semmit nem ír):

```bash
WS=$(docker compose -f docker-compose.prod.yml exec -T db psql -U venture -d ventureos -t -A -c "select id from workspaces limit 1")
PW=$(grep "^APP_DB_PASSWORD=" .env | cut -d= -f2-)
# 1) deklaráció nélkül 0 sor, 2) a workspace deklarálva a valódi darabszám
docker compose -f docker-compose.prod.yml exec -T -e PGPASSWORD="$PW" db \
  psql -U app_user -d ventureos -c "select count(*) from leads;" \
  -c "select set_config('app.current_workspace','$WS',false); select count(*) from leads;"
```

Ha az első `0`, a második pedig a valós szám, a réteg működik.

---

## Hibaelhárítás

### 1. „port is already allocated" — foglalt port

Valami más már használja a 80-as vagy 443-as portot (jellemzően egy előre
telepített Apache vagy Nginx).

```bash
# ki használja?
ss -tulpn | grep -E ':(80|443)'

# ha apache2 vagy nginx:
systemctl stop apache2 nginx
systemctl disable apache2 nginx

# majd újra
docker compose -f docker-compose.prod.yml up -d
```

### 2. Nem működik a HTTPS / tanúsítványhiba

Nézd meg, mit mond a Caddy:

```bash
docker compose -f docker-compose.prod.yml logs caddy | tail -50
```

Leggyakoribb okok:

| Hibaüzenet | Ok és megoldás |
|---|---|
| `no such host` / `NXDOMAIN` | A DNS még nem terjedt szét. Ellenőrizd a 2. lépés `dig` parancsaival, és várj. |
| `timeout during connect` | A 80-as port zárva. `ufw allow 80/tcp` |
| `too many certificates already issued` | Elérted a Let's Encrypt heti limitjét (5 azonos névre). **Várnod kell egy hetet.** Ezért fontos, hogy csak akkor indítsd el, ha a DNS már jó. |
| `unauthorized` | A domain nem erre a szerverre mutat. Ellenőrizd az A rekordokat. |

### 3. Egy konténer folyton újraindul

```bash
docker compose -f docker-compose.prod.yml ps          # melyik?
docker compose -f docker-compose.prod.yml logs app    # miért?
```

**Ha `Environment check failed` van a naplóban:** hiányzik vagy hibás egy
beállítás a `.env`-ben. A hibaüzenet pontosan felsorolja, melyik és miért:

```
Environment check failed — 2 problems:
  ✗ MAILGUN_COLD_DOMAIN — must differ from MAILGUN_DOMAIN (both are "mg.ventureco.group")
  ✗ NEXTAUTH_SECRET — is still the placeholder — generate a real secret
```

Javítsd a `.env`-ben, majd:

```bash
docker compose -f docker-compose.prod.yml up -d
```

**Ha `Killed` vagy `OOMKilled` szerepel:** elfogyott a memória. Ellenőrizd, hogy
beállítottad-e a swapet (3. lépés), és nézd meg a fogyasztást:

```bash
docker stats --no-stream
```

**Ha az adatbázishoz nem tud kapcsolódni:** nézd meg, lefutott-e a `migrate`:

```bash
docker compose -f docker-compose.prod.yml logs migrate
```

### 4. Nem tudok belépni

| Tünet | Megoldás |
|---|---|
| „Incorrect email, password or code." | Rossz jelszó vagy kód. Öt sikertelen próbálkozás után 15 percre zárolódik a fiók. |
| „Too many attempts. Try again in 15 minutes." | Várj 15 percet, vagy állíts új jelszót — az feloldja a zárolást. |
| Elveszett a 2FA telefon | `npm run set-password -- <email> --clear-2fa` (lásd 7. lépés) |
| A kód mindig hibás | A telefon órája csúszik. Kapcsold be az automatikus időbeállítást. |

### 5. Mentés visszaállítása

> ⚠️ Ez **felülírja** a jelenlegi adatbázist. Csak akkor csináld, ha biztos vagy
> benne.

```bash
cd /opt/ventureos-lite

# 1. Melyik mentésből?
ls -lh /var/backups/ventureos/

# 2. Az alkalmazás és a worker leállítása (az adatbázis maradjon fent)
docker compose -f docker-compose.prod.yml stop app worker

# 3. Adatbázis visszatöltése (írd át a dátumot a saját fájlodéra)
cat /var/backups/ventureos/db-20260812-033001.dump \
  | docker compose -f docker-compose.prod.yml exec -T db \
      pg_restore -U venture -d ventureos --clean --if-exists --no-owner

# 4. Fájlok visszatöltése
cat /var/backups/ventureos/files-20260812-033001.tar.gz \
  | docker compose -f docker-compose.prod.yml run --rm -T --no-deps \
      --entrypoint sh worker -c 'tar -xzf - -C /data'

# 5. Indítás vissza
docker compose -f docker-compose.prod.yml up -d
```

A `pg_restore` néhány „does not exist" hibát kiírhat a `--clean` miatt — ezek
ártalmatlanok. Ellenőrizd a végén:

```bash
curl -s https://ventureco.agency/api/health
```

### 6. Teljes újraindítás (ha semmi nem segít)

```bash
cd /opt/ventureos-lite
./scripts/backup.sh                                      # előbb mentés!
docker compose -f docker-compose.prod.yml down           # a KÖTETEK megmaradnak
docker compose -f docker-compose.prod.yml up -d --build
```

> ⛔ A `down -v` kapcsolót **soha ne használd**: az törli az adatbázis-kötetet is,
> vagyis az összes adatot.

---

## Gyors parancs-összefoglaló

```bash
cd /opt/ventureos-lite

# állapot és naplók
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app

# újraindítás
docker compose -f docker-compose.prod.yml restart app

# frissítés
./scripts/backup.sh && git pull && \
  docker compose -f docker-compose.prod.yml up -d --build

# kézi mentés
./scripts/backup.sh

# erőforrás-használat
docker stats --no-stream
df -h
```

---

## Mi jön ezután?

- A napi működéshez (felhasználók, jogosultságok, sablonok, AI-költségkeret,
  GDPR-törlés) olvasd el a [`docs/HANDBOOK.md`](HANDBOOK.md) fájlt.
- A funkciók részletes leírása: [`docs/spec.md`](spec.md).
- Kapcsold be a kétlépcsős azonosítást minden fióknál (Settings → security).
