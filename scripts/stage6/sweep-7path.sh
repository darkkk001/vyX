#!/usr/bin/env bash
# Stage 6: the LOCAL 7-path sweep on the exact cutover build, RUST mode (docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md section 10). Scratch databases only.
#
#   bash scripts/stage6/sweep-7path.sh [accounts] [walkers]
#
# The shadow bot (branch shadow-bot, tools/shadow-bot) drives seven scenarios against the zzshadowbot tenant through HIS hard-coded hosts, so it cannot
# be pointed at a scratch database; that run is the live one (runbook section 10.2). The LOCAL sweep runs the same seven RISK PATHS through the real code
# of this branch: the real web risk routines, the real engine passes and post-close dispatcher, one database, every account engine-owned (variant
# rust-all), then the engine-owned DEMO / web-owned LIVE split (mixed), the WEB-fallback drill and the engine-stall drill. PASS = for every run:
#   - the end state equals the web-only reference, id by id (diff.mjs), exactly-once holds, no action by the wrong side (split-check);
#   - every one of the seven paths was taken by the ENGINE at least once (scripts/stage6/sweep-paths.mjs); in the runs where the web legitimately takes part
#     (mixed, the drills) by either side;
#   - the engine-owned runs show ZERO web actions (the web skipped every engine-owned account).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
N="${1:-150}"; K="${2:-2}"
OUT="$ROOT/engine/parity/out/load"
FAIL=0
run() { # label, expected web actions ("zero" or "any"), run-split args...
  local label="$1" web="$2"; shift 2
  local log; log="$(mktemp)"
  if bash scripts/load/run-split.sh --accounts "$N" --walkers "$K" "$@" > "$log" 2>&1; then
    local seed variant tag
    seed="$(echo " $* " | sed -E 's/.* --seed ([0-9]+) .*/\1/')"
    tag="$(echo " $* " | sed -E 's/.* --variant ([a-z-]+) .*/\1/')$(echo " $* " | grep -q -- '--drill' && echo -drill)$(echo " $* " | grep -q -- '--stall' && echo -stall)-s$seed-n$N-k$K"
    echo "PASS  run-split $label"
    node scripts/stage6/sweep-paths.mjs "$(cygpath -m "$OUT/split-$tag" 2>/dev/null || echo "$OUT/split-$tag")" $([ "$web" = any ] && echo --either) || FAIL=1
    if [ "$web" = zero ] && [ -s "$OUT/split-$tag/web-trace.jsonl" ]; then echo "  FAIL  the web took actions in an all-engine run"; FAIL=1; fi
  else
    echo "FAIL  run-split $label (log kept: $log)"; FAIL=1
  fi
}
for seed in 1 2 3; do
  run "rust-all seed $seed (every account engine-owned)" zero --seed "$seed" --variant rust-all
done
run "mixed seed 1 (WEB / RUST demo-only / RUST all brokers at once)" any --seed 1 --variant mixed
run "WEB-fallback drill seed 1 (RUST -> WEB mid-run)" any --seed 1 --variant rust-all --drill
run "engine-stall drill seed 1 (heartbeat stale -> web takes over -> engine returns)" any --seed 1 --variant rust-all --stall
[ $FAIL -eq 0 ] && echo "7-PATH SWEEP (local): PASS" || echo "7-PATH SWEEP (local): FAIL"
exit $FAIL
