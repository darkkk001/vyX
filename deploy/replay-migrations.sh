#!/usr/bin/env bash
# Replay the whole prisma/migrations chain on an EMPTY database: CI, disaster recovery, a new environment.
# NEVER against the live database (it already has every migration; nothing here is needed or safe there).
#
# Why this script exists (deploy/replay-migrations.md): 20260921160000_stage3a_group_the_ungrouped is a DATA-only
# migration written for production. It assigns groups to 18 named production accounts and aborts when any of them is
# missing, which on an empty database is always. It creates no schema, so on a fresh database it is marked applied
# without running, and everything else replays with plain `prisma migrate deploy`. The file itself is not edited: it is
# applied on production and its checksum must not change.
#
# Usage (from the web repo root, DATABASE_URL and DIRECT_URL set to the empty target):
#   bash deploy/replay-migrations.sh
# A target that is not localhost / 127.0.0.1 is refused unless REPLAY_ALLOW_REMOTE=1 (a brand-new DR / environment
# database). A database that already has any migration applied is refused.
set -euo pipefail

STAGE3A=20260921160000_stage3a_group_the_ungrouped
FIRST=20260811000000_init

: "${DATABASE_URL:?DATABASE_URL must point at the empty target database}"
: "${DIRECT_URL:?DIRECT_URL must point at the empty target database}"

host_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
for url in "$DATABASE_URL" "$DIRECT_URL"; do
  h="$(host_of "$url")"
  if [ "$h" != "localhost" ] && [ "$h" != "127.0.0.1" ] && [ "${REPLAY_ALLOW_REMOTE:-}" != "1" ]; then
    echo "replay: refusing a non-local target ($h); set REPLAY_ALLOW_REMOTE=1 only for a brand-new, empty database" >&2
    exit 2
  fi
done

# Empty means: not even the first migration is applied. `migrate status` lists unapplied ones under this header.
status="$(npx prisma migrate status 2>&1 || true)"
if ! printf '%s\n' "$status" | sed -n '/have not yet been applied/,$p' | grep -q "$FIRST"; then
  echo "replay: refusing, the target already has migrations applied (this is only for an empty database)" >&2
  exit 3
fi

echo "replay: marking $STAGE3A applied without running it (production-only data step, no schema)"
npx prisma migrate resolve --applied "$STAGE3A"
echo "replay: applying every other migration"
npx prisma migrate deploy
npx prisma migrate status
