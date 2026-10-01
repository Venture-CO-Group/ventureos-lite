#!/usr/bin/env bash
# Create a Prisma migration against the local test database and strip the
# unrelated drift Prisma keeps proposing on this machine (the user_pins index
# and the content_variants default), so each migration holds only its change.
set -euo pipefail
name="$1"
# Optional: a header comment (without the leading "-- "), written before the
# migration is applied so the stored checksum already includes it.
header="${2:-}"
export DATABASE_URL="${DATABASE_URL_LOCAL:-postgresql://venture:venture@localhost:55432/ventureos?schema=public}"
npx prisma migrate dev --create-only --name "$name" >/dev/null
dir=$(ls -d prisma/migrations/*_"$name" | tail -1)
python3 - "$dir/migration.sql" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'-- DropIndex\nDROP INDEX "user_pins_user_id_workspace_id_kind_at_idx";\n\n', '', s)
s = re.sub(r'-- AlterTable\nALTER TABLE "content_variants" ALTER COLUMN "updated_at" DROP DEFAULT;\n\n', '', s)
s = re.sub(r'-- CreateIndex\nCREATE INDEX "user_pins_user_id_workspace_id_kind_at_idx"[^\n]*\n\n?', '', s)
open(p, 'w').write(s)
PY
if [ -n "$header" ]; then
  { printf '%s\n' "$header" | sed 's/^/-- /'; echo; cat "$dir/migration.sql"; } > "$dir/migration.sql.tmp"
  mv "$dir/migration.sql.tmp" "$dir/migration.sql"
fi
echo "$dir"
