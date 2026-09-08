#!/usr/bin/env bash
# =============================================================================
# Venture OS Lite — restore drill.
#
# ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
#
# `scripts/backup.sh` runs nightly and there are fifty dumps on the server. The
# thing nobody had ever done is RESTORE one. An untested backup is not a backup;
# it is a file of the right size in the right place, which is a different thing
# and feels identical right up until the morning it matters.
#
# So: take the newest dump, load it into a throwaway database beside the live
# one, and ask it questions. If the answers are sensible, the backup is a
# backup. Then the scratch database is dropped.
#
# ── WHAT IT WILL AND WILL NOT TOUCH ──────────────────────────────────────────
#
# It creates and drops ONE database, named `ventureos_restore_drill` by default,
# and refuses to run at all if that name matches the live `POSTGRES_DB`. It
# never writes to the live database, never deletes a backup file, and never
# touches /data/files — the archive is only listed, never extracted over
# anything.
#
# Usage:   scripts/restore-drill.sh [backup-dir] [dump-file]
# Cron:    quarterly is enough. 0 4 1 */3 *
# Record the result in docs/restore-drill.md — an undocumented drill is a drill
# nobody can prove happened.
# =============================================================================
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${1:-${BACKUP_DIR:-/var/backups/ventureos}}"
DRILL_DB="${DRILL_DB:-ventureos_restore_drill}"

cd "$(dirname "$0")/.."

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -f .env ] || fail ".env not found in $(pwd)"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing from .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing from .env}"

# The one guard that matters. Everything below runs as the superuser against a
# database named by a variable; if that variable ever names the live database
# the drill becomes the incident.
[ "$DRILL_DB" != "$POSTGRES_DB" ] || fail "DRILL_DB must not be the live database ($POSTGRES_DB)"
case "$DRILL_DB" in
  *_restore_drill) : ;;
  *) fail "DRILL_DB must end in _restore_drill — refusing to touch '$DRILL_DB'" ;;
esac

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
psql_drill() { compose exec -T db psql -qtAX -U "$POSTGRES_USER" -d "$DRILL_DB" -c "$1"; }
psql_admin() { compose exec -T db psql -qtAX -U "$POSTGRES_USER" -d postgres -c "$1"; }

# ---- 1. pick the dump -------------------------------------------------------
if [ -n "${2:-}" ]; then
  DUMP="$2"
else
  DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.dump' | sort | tail -1)"
fi
[ -n "$DUMP" ] && [ -s "$DUMP" ] || fail "no usable dump found in $BACKUP_DIR"
log "dump $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)), taken $(date -u -r "$DUMP" +%Y-%m-%dT%H:%M:%SZ)"

# The age of the newest backup is itself a finding. A drill that passes against
# a dump from six weeks ago has proved the restore works and the schedule does
# not.
AGE_DAYS=$(( ( $(date -u +%s) - $(date -u -r "$DUMP" +%s) ) / 86400 ))
log "newest backup is ${AGE_DAYS} day(s) old"
[ "$AGE_DAYS" -le 2 ] || log "WARNING: the nightly backup is stale — check the cron entry"

# ---- 2. restore into a scratch database -------------------------------------
log "dropping and recreating $DRILL_DB"
psql_admin "DROP DATABASE IF EXISTS \"$DRILL_DB\";" > /dev/null
psql_admin "CREATE DATABASE \"$DRILL_DB\";" > /dev/null

log "restoring"
# --no-owner and --no-privileges: the drill proves the DATA survived, and role
# grants belong to whichever server it lands on.
if ! compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$DRILL_DB" \
      --no-owner --no-privileges --exit-on-error < "$DUMP"; then
  fail "pg_restore could not load the dump — THE BACKUP IS NOT A BACKUP"
fi

# ---- 3. ask it questions ----------------------------------------------------
# A restore that produces an empty schema exits zero. The counts are the test.
TABLES=$(psql_drill "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
log "tables restored: $TABLES"
[ "${TABLES:-0}" -ge 40 ] || fail "only $TABLES tables in the restored database — expected the full schema"

problems=0
check_rows() {
  local table="$1" minimum="$2" n
  n=$(psql_drill "SELECT count(*) FROM \"$table\";" || echo "")
  if [ -z "$n" ]; then
    log "  $table: MISSING"
    problems=$((problems + 1))
    return
  fi
  log "  $table: $n row(s)"
  if [ "$n" -lt "$minimum" ]; then
    log "  ^ expected at least $minimum"
    problems=$((problems + 1))
  fi
}

log "row counts:"
# The tables whose loss would end the business, in that order. A workspace and a
# user must exist or nobody can log in to a restored system at all.
check_rows workspaces 1
check_rows users 1
check_rows companies 0
check_rows leads 0
check_rows documents 0
check_rows audit_logs 0

# Migrations, because a dump that predates a migration restores into a schema
# the running code cannot use.
MIGRATIONS=$(psql_drill "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" || echo 0)
LATEST=$(psql_drill "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;" || echo "?")
log "migrations applied: $MIGRATIONS (latest $LATEST)"
[ "${MIGRATIONS:-0}" -ge 1 ] || fail "the restored database has no migration history"

# Freshness of the DATA, not of the file. A dump can be an hour old and hold a
# week-old snapshot if the schedule dumps a replica that stopped replicating.
NEWEST_LOG=$(psql_drill "SELECT coalesce(max(at)::text,'none') FROM audit_logs;")
log "newest audit-log entry in the restore: $NEWEST_LOG"

# RLS is half of the tenancy promise (CLAUDE.md rule 1). `pg_dump` carries
# policies, and a restore that silently drops them is a restore into a system
# with one of its two guards missing.
POLICIES=$(psql_drill "SELECT count(*) FROM pg_policies WHERE schemaname='public';")
log "row-level-security policies restored: $POLICIES"
if [ "${POLICIES:-0}" -lt 1 ]; then
  log "  ^ none — after a real restore, run: npm run rls:apply"
  problems=$((problems + 1))
fi

# ---- 4. the files archive ---------------------------------------------------
FILES_ARCHIVE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'files-*.tar.gz' | sort | tail -1)"
if [ -n "$FILES_ARCHIVE" ]; then
  log "files archive $(basename "$FILES_ARCHIVE") ($(du -h "$FILES_ARCHIVE" | cut -f1))"
  # Listed, never extracted: extracting over a live volume during a drill is
  # how a drill becomes the outage it was meant to prevent.
  ENTRIES=$(tar -tzf "$FILES_ARCHIVE" | wc -l | tr -d ' ')
  log "  entries: $ENTRIES"
  [ "$ENTRIES" -ge 1 ] || { log "  ^ the archive is empty"; problems=$((problems + 1)); }
else
  log "no files archive found — screenshots and PDFs would NOT survive"
  problems=$((problems + 1))
fi

# ---- 5. clean up ------------------------------------------------------------
if [ "${KEEP_DRILL_DB:-0}" = "1" ]; then
  log "keeping $DRILL_DB for inspection (KEEP_DRILL_DB=1)"
else
  log "dropping $DRILL_DB"
  psql_admin "DROP DATABASE IF EXISTS \"$DRILL_DB\";" > /dev/null
fi

if [ "$problems" -gt 0 ]; then
  log "DRILL FINISHED WITH $problems PROBLEM(S) — the restore path is not clean"
  exit 1
fi
log "drill passed — this backup restores"
