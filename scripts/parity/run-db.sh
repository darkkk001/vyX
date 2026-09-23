#!/usr/bin/env bash
# Stage 1 gate: the web path vs the engine's REAL monitor on the REAL schema (scratch DB only).
# For each scenario: the web run (run-ts.ts, out/ts) as in run-all.sh, then the scenario is re-seeded and
# `cargo run -p parity -- --db` runs order_management::monitor::evaluate_account over book.rs (out/rust-db).
# See engine/parity/README.md. Uses ONLY 127.0.0.1:5499/vyx_rust_harness.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness
case "$URL" in postgresql://postgres@127.0.0.1:5499/*) ;; *) echo "refusing: not the scratch DB"; exit 2 ;; esac
cd "$ROOT"
DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts
(cd engine && cargo build -q -p parity)
for f in engine/parity/scenarios/*.json; do
  name="$(basename "$f" .json)"
  PARITY_SEED_ONLY=1 DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts "$name"
  (cd engine && cargo run -q -p parity -- --db "$name")
done
node scripts/parity/diff.mjs --rust-dir rust-db "$@"
