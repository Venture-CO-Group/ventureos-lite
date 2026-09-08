# Visszaállítási próba

> **Miért van ez a fájl.** A `scripts/backup.sh` minden éjjel fut, és ötven
> mentés van a szerveren. Amit soha senki nem próbált ki: hogy ezekből
> **vissza lehet-e állítani**. Egy kipróbálatlan mentés nem mentés, hanem egy
> jó méretű fájl a jó helyen — és ez a kettő pontosan addig érződik
> ugyanannak, amíg el nem jön az a reggel, amikor kiderül.

A próba egy szkript: `scripts/restore-drill.sh`. A legfrissebb dumpot betölti
egy **külön, eldobható** adatbázisba az élő mellé, kérdéseket tesz fel neki, és
utána eldobja. Nyolc-tíz perc, negyedévente egyszer.

---

## Mit csinál, és mit nem

**Csinál:**

- kiválasztja a legfrissebb `db-*.dump`-ot,
- létrehozza a `ventureos_restore_drill` adatbázist,
- `pg_restore --exit-on-error`-ral betölti,
- megszámolja a táblákat és a sorokat a fontos táblákban,
- megnézi a migrációs történetet és a legutolsó migráció nevét,
- megnézi a legfrissebb audit-log bejegyzés dátumát — ez a **tartalom**
  frissessége, nem a fájl dátuma,
- megszámolja a visszaállt RLS policy-ket,
- kilistázza a `files-*.tar.gz` tartalmát,
- eldobja a próba-adatbázist.

**Nem csinál:**

- nem ír az élő adatbázisba,
- nem töröl mentési fájlt,
- nem bontja ki a fájl-archívumot semmi fölé — csak listázza. Egy próba közben
  élő volume fölé kibontani pontosan az az üzemszünet, amit a próba megelőzni
  hivatott,
- nem indul el egyáltalán, ha a `DRILL_DB` neve megegyezik az élő adatbázissal,
  vagy nem `_restore_drill`-re végződik.

---

## Hogyan futtasd

```bash
cd /opt/ventureos-lite
./scripts/restore-drill.sh
```

Sikeres futás vége:

```
[drill 04:00:01] dump db-20260908-033001.dump (2.1M), taken 2026-09-08T03:30:04Z
[drill 04:00:01] newest backup is 0 day(s) old
[drill 04:00:02] dropping and recreating ventureos_restore_drill
[drill 04:00:09] tables restored: 71
[drill 04:00:09] row counts:
[drill 04:00:09]   workspaces: 1 row(s)
[drill 04:00:09]   users: 3 row(s)
[drill 04:00:10]   companies: 412 row(s)
[drill 04:00:10]   leads: 388 row(s)
[drill 04:00:10]   documents: 24 row(s)
[drill 04:00:10]   audit_logs: 1204 row(s)
[drill 04:00:10] migrations applied: 63 (latest 20260908050000_task_deps_recurrence_templates)
[drill 04:00:10] newest audit-log entry in the restore: 2026-09-08 03:12:44.102
[drill 04:00:11] row-level-security policies restored: 68
[drill 04:00:11] files archive files-20260908-033001.tar.gz (18M)
[drill 04:00:12]   entries: 341
[drill 04:00:13] dropping ventureos_restore_drill
[drill 04:00:13] drill passed — this backup restores
```

A szkript **nem nullával tér vissza**, ha bármelyik ellenőrzés elhasalt, tehát
cronból is használható:

```
0 4 1 */3 * cd /opt/ventureos-lite && ./scripts/restore-drill.sh >> /var/log/ventureos-drill.log 2>&1
```

Ha meg akarod nézni a visszaállított adatbázist a próba után is:

```bash
KEEP_DRILL_DB=1 ./scripts/restore-drill.sh
docker compose -f docker-compose.prod.yml exec db \
  psql -U venture -d ventureos_restore_drill
```

---

## Mit jelent, ha valami elhasal

| Amit kiír | Mit jelent | Mit tegyél |
|---|---|---|
| `pg_restore could not load the dump` | **A mentés nem mentés.** | Nézd meg a `/var/log/ventureos-backup.log`-ot, futtass kézzel `./scripts/backup.sh`-t, és ellenőrizd, van-e szabad hely (`df -h`). |
| `only N tables in the restored database` | A dump csonka — általában az történt, hogy a lemez betelt írás közben. | `df -h`, majd új mentés kézzel. |
| `workspaces: 0 row(s)` vagy `users: 0 row(s)` | A séma visszajött, az adat nem. Egy ilyen rendszerbe **senki nem tud belépni**. | Próbáld az eggyel korábbi dumpot: `./scripts/restore-drill.sh /var/backups/ventureos <fájl>`. |
| `newest backup is 9 day(s) old` | A visszaállítás működik, **az időzítés nem**. | `crontab -l`, és a 8. lépés a `DEPLOY.md`-ben. |
| `newest audit-log entry` hetekkel korábbi | A fájl friss, a tartalom nem. | Nézd meg, hogy a `db` konténer valóban az élő adatbázis-e. |
| `row-level-security policies restored: 0` | A tenancy két védvonala közül az egyik hiányzik. | Egy **valódi** visszaállítás után: `npm run rls:apply`. A Prisma tenant guard közben is véd, de a CLAUDE.md 1. szabálya mindkettőt kéri. |
| `no files archive found` | A képernyőképek és a PDF-ek nem élnék túl. | A `backup.sh` 2. szakasza — általában a `worker` konténer nem futott. |

---

## Egy valódi visszaállítás — a rend

Ez nem a próba. Ez az, ha tényleg elveszett az adat.

```bash
cd /opt/ventureos-lite

# 1. Állítsd le az appot, hogy senki ne írjon közben.
docker compose -f docker-compose.prod.yml stop app worker

# 2. Az élő adatbázist NEVEZD ÁT, ne dobd el. Amíg ott van, van hova visszalépni.
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U venture -d postgres -c \
  'ALTER DATABASE ventureos RENAME TO ventureos_before_restore;'
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U venture -d postgres -c 'CREATE DATABASE ventureos;'

# 3. Töltsd be a dumpot.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U venture -d ventureos --no-owner --no-privileges --exit-on-error \
  < /var/backups/ventureos/db-YYYYMMDD-HHMMSS.dump

# 4. Fájlok. FIGYELEM: ez felülírja a /data/files tartalmát.
docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  --entrypoint sh worker -c 'tar -xzf - -C /data' \
  < /var/backups/ventureos/files-YYYYMMDD-HHMMSS.tar.gz

# 5. RLS policy-k.
docker compose -f docker-compose.prod.yml exec -T app npm run rls:apply

# 6. Indítsd vissza.
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

A 2. lépés a lényeg: az élő adatbázist átnevezzük, nem eldobjuk. Ha a
visszaállítás félresikerül, egy `ALTER DATABASE ... RENAME` visszahoz mindent.
Ha eldobtad volna, nem hozna vissza semmit. Amikor néhány nap után biztos
vagy benne, hogy jó, akkor lehet a `ventureos_before_restore`-t eldobni.

---

## A próbák naplója

Írd be minden lefutást. Egy dokumentálatlan próba olyan próba, amiről senki
nem tudja bizonyítani, hogy megtörtént.

| Dátum | Ki | A dump | Eredmény | Megjegyzés |
|---|---|---|---|---|
| 2026-09-08 11:33 UTC | Claude (deploy) | `db-20260908-112927.dump` (540K, 0 nap) | ✅ **átment** | Az első valódi próba ezen a szerveren. 83 tábla, 1 workspace, 3 user, 149 cég, 139 lead, 79 RLS policy, 82 fájl az archívumban. A migrációs történet 55-nél állt (`…_membership_suspension`), mert a mentés a deploy **előtt** készült — pontosan így helyes. Következő: 2026-12-01. |
