#!/usr/bin/env bash
# After deploy/replay-migrations.sh: does the database the migrations built match prisma/schema.prisma?
#
# `prisma migrate diff --exit-code` alone would fail today on drift that is known and waiting for owner decisions
# (deploy/replay-migrations.md, "Known drift"). So the diff is compared with the committed baseline
# deploy/known-drift.sql instead: ANY other difference fails, a new one or a missing one (a fix that is not yet
# reflected in the baseline). When the baseline is empty this is exactly `migrate diff --exit-code`.
#
# Usage (repo root, DIRECT_URL = the replayed database):  bash deploy/check-migration-drift.sh [--update]
#   --update rewrites deploy/known-drift.sql from the current diff (only together with a reviewed schema change).
set -euo pipefail

BASELINE="deploy/known-drift.sql"
: "${DIRECT_URL:?DIRECT_URL must point at the replayed database}"

# the SQL Prisma would run to turn the replayed database into schema.prisma; CR and blank lines dropped, and the
# "-- This is an empty migration." line Prisma prints when there is nothing to do (so no drift = an empty string)
current="$(npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script 2>/dev/null \
  | tr -d '\r' | sed '/^[[:space:]]*$/d; /^-- This is an empty migration\.$/d')"

if [ "${1:-}" = "--update" ]; then
  printf '%s\n' "$current" | sed '/^$/d' > "$BASELINE"
  echo "drift: baseline rewritten ($(grep -c . "$BASELINE" || true) lines)"
  exit 0
fi

expected="$(tr -d '\r' < "$BASELINE" | sed '/^[[:space:]]*$/d')"
if [ "$current" = "$expected" ]; then
  if [ -z "$current" ]; then echo "drift: none"; else echo "drift: only the known baseline ($BASELINE)"; fi
  exit 0
fi

echo "drift: the replayed migrations and prisma/schema.prisma differ from the known baseline ($BASELINE)" >&2
diff <(printf '%s\n' "$expected") <(printf '%s\n' "$current") >&2 || true
echo "drift: '<' = in the baseline only, '>' = new. Fix the schema / add a migration, or (reviewed) --update the baseline." >&2
exit 1
