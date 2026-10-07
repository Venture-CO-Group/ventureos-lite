#!/usr/bin/env bash
# =============================================================================
# Venture OS Lite — nightly backup.
#
# Takes a consistent Postgres dump plus the /data/files tree (audit
# screenshots, generated PDFs, GDPR exports) and keeps 14 days of them.
#
# GDPR (CLAUDE.md rule 9): backups honour erasure by expiring. Fourteen days is
# the stated retention window, so a lead erased today is gone from every backup
# within 14 days. Do NOT lengthen the rotation without revisiting that promise.
#
# Usage:   scripts/backup.sh [target-dir]
# Cron:    30 3 * * *  cd /opt/ventureos && ./scripts/backup.sh >> /var/log/ventureos-backup.log 2>&1
# =============================================================================
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${1:-${BACKUP_DIR:-/var/backups/ventureos}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# Run from the repo root regardless of where cron invoked us.
cd "$(dirname "$0")/.."

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "aborted on line $LINENO"' ERR

[ -f .env ] || fail ".env not found in $(pwd)"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing from .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing from .env}"

mkdir -p "$BACKUP_DIR"
log "target $BACKUP_DIR (retention ${RETENTION_DAYS}d)"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ---- 1. database -------------------------------------------------------------
# Custom format (-Fc): compressed, and restorable selectively with pg_restore.
DB_TMP="$BACKUP_DIR/.db-$STAMP.dump.partial"
DB_OUT="$BACKUP_DIR/db-$STAMP.dump"
log "dumping database $POSTGRES_DB"
compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner > "$DB_TMP"
[ -s "$DB_TMP" ] || fail "pg_dump produced an empty file"
# Prove the dump is readable before it counts as a backup.
compose exec -T db pg_restore --list < "$DB_TMP" > /dev/null \
  || fail "pg_dump output did not survive a pg_restore --list check"
mv "$DB_TMP" "$DB_OUT"
log "database ok ($(du -h "$DB_OUT" | cut -f1))"

# ---- 2. files ----------------------------------------------------------------
FILES_TMP="$BACKUP_DIR/.files-$STAMP.tar.gz.partial"
FILES_OUT="$BACKUP_DIR/files-$STAMP.tar.gz"
log "archiving /data/files"
compose run --rm --no-deps -T --entrypoint sh worker \
  -c 'tar -czf - -C /data files' > "$FILES_TMP"
[ -s "$FILES_TMP" ] || fail "file archive is empty"
gzip -t "$FILES_TMP" || fail "file archive failed its gzip integrity check"
mv "$FILES_TMP" "$FILES_OUT"
log "files ok ($(du -h "$FILES_OUT" | cut -f1))"

# ---- 3. rotation --------------------------------------------------------------
# Only ever deletes this script's own artefacts, never anything else in the dir.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) \
  -mtime "+$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
# Clean up any partials left by an interrupted earlier run.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.*.partial' -mtime +1 -delete
log "rotation removed $DELETED expired file(s)"

REMAINING=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.dump' | wc -l | tr -d ' ')
log "done — $REMAINING database backup(s) retained"
