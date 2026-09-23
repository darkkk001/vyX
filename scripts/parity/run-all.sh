#!/usr/bin/env bash
# Stage 0 parity harness, end to end (Git Bash, from anywhere). See engine/parity/README.md.
# Uses ONLY the local scratch Postgres on 127.0.0.1:5499 -- never the repo's .env DATABASE_URL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness
echo "[parity] database: $URL"
case "$URL" in postgresql://postgres@127.0.0.1:5499/*) ;; *) echo "refusing: not the scratch DB"; exit 2 ;; esac
/d/pg-scratch/pgsql/bin/psql.exe -h 127.0.0.1 -p 5499 -U postgres -d vyx_rust_harness -Atc "select 1" >/dev/null \
  || { echo "[parity] scratch DB not reachable -- start it / create vyx_rust_harness first (README)"; exit 2; }

cd "$ROOT"
DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts
(cd engine && cargo run -q -p parity)
node scripts/parity/diff.mjs "$@"
