#!/usr/bin/env bash
# Stage 6 mutation check: the split proofs must FAIL when the safeguard they prove is broken. Each mutation edits one source file, runs
# the tests that must notice, expects a non-zero exit, and puts the file back (git checkout). A mutation the tests do not notice is
# reported MISSED and the script exits 1.
#
#   bash scripts/stage6/mutation-check.sh [M1 M2 ...]       (default: all)
#
#   M1  a web path that does not skip RUST-owned accounts (both prefilters removed; the in-transaction guard still holds)
#   M2  the web's in-transaction owner check removed (a stale prefilter then lets the web act on an engine-owned account)
#   M3  M1 + M2: the web acts on engine-owned accounts at all -> detected as a double action
#   M4  the engine acts on a WEB-owned account (the rule hands everything to the engine)
#   M5  the engine's in-transaction owner check removed (the flip no longer stops its next close)
#   M6  the demo-only scope ignored, engine rule
#   M7  the demo-only scope ignored, web rule
#   M8  the live fire still PINNED (it evaluates the account as it stood at the fire, not its current positions)
#
# Needs a clean working tree for the files it touches; restores them on exit. Scratch database only (vyx_test).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export ENGINE_TEST_DATABASE_URL="${ENGINE_TEST_DATABASE_URL:-postgresql://postgres@127.0.0.1:5499/vyx_test}"
export VYX_REQUIRE_DB_TESTS=1
WEBENV="DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test DIRECT_URL=postgresql://postgres@127.0.0.1:5499/vyx_test REDIS_URL=redis://localhost:6379"
MUT="node scripts/stage6/mutate.mjs"
FILES="lib/risk-monitor.ts lib/risk-owner.ts lib/position-close.ts lib/risk-authority.ts engine/order-management/src/authority.rs engine/order-management/src/book.rs engine/order-management/src/monitor.rs"
git diff --quiet -- $FILES || { echo "[mutation] refusing: uncommitted changes in $FILES"; exit 2; }
restore() { git checkout -q -- $FILES; }
trap restore EXIT

WANT="${*:-M1 M2 M3 M4 M5 M6 M7 M8}"
MISSED=0
web_tests() { env $WEBENV npx vitest run "$@" > /tmp/mutation-web.log 2>&1; }
engine_tests() { (cd engine && cargo test -q -p order-management "$@" -- --test-threads=1) >> /tmp/mutation-engine.log 2>&1; }
report() { # name, exit code of the tests (non-zero = the mutation was detected)
  # a mutation that merely breaks the BUILD is not a detection: the tests never ran
  if [ "$2" -ne 0 ] && grep -qE 'could not compile|error\[E[0-9]+\]|SyntaxError|Transform failed|Failed to resolve' /tmp/mutation-engine.log /tmp/mutation-web.log 2>/dev/null; then
    echo "BROKEN    $1  (the mutated code does not build: fix the mutation)"; MISSED=1
  elif [ "$2" -ne 0 ]; then
    echo "DETECTED  $1"
    grep -hE -- '--- FAILED| FAIL  ' /tmp/mutation-engine.log /tmp/mutation-web.log 2>/dev/null | sort -u | head -3 | sed 's/^/            by: /'
  else
    echo "MISSED    $1"; MISSED=1
  fi
  : > /tmp/mutation-engine.log; : > /tmp/mutation-web.log
}
want() { case " $WANT " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

M_NO_WEB_PREFILTER() {
  $MUT lib/risk-monitor.ts 'if (!preloaded?.ownerChecked && (await loadRiskOwners(prisma, [accountId])).get(accountId) === "RUST") {' 'if (false) {' || return 2
  $MUT lib/risk-monitor.ts 'const accountIds = await webOwnedAccountIds(prisma, accountIdsAll);' 'const accountIds = accountIdsAll;' || return 2
}
M_NO_WEB_GUARD() {
  $MUT lib/risk-owner.ts 'export async function assertRiskActorInTx(tx: Prisma.TransactionClient, accountId: string, actor: RiskOwner): Promise<void> {' 'export async function assertRiskActorInTx(tx: Prisma.TransactionClient, accountId: string, actor: RiskOwner): Promise<void> {
  if (actor) return;' || return 2
}

if want M1; then M_NO_WEB_PREFILTER && web_tests lib/risk-split.test.ts; report "M1 web path does not skip RUST-owned accounts (prefilters removed)" $?; restore; fi
if want M2; then M_NO_WEB_GUARD && web_tests lib/risk-split-stale.test.ts lib/risk-split-flip.test.ts; report "M2 web in-transaction owner check removed (stale prefilter, flip mid-pass)" $?; restore; fi
if want M3; then M_NO_WEB_PREFILTER && M_NO_WEB_GUARD && web_tests lib/risk-split.test.ts; report "M3 web acts on engine-owned accounts at all: detected as a double action" $?; restore; fi
if want M4; then
  $MUT engine/order-management/src/authority.rs 'pub fn risk_owner_of(authority: Option<&str>, demo_only: Option<bool>, account_mode: Option<&str>) -> RiskOwner {' 'pub fn risk_owner_of(authority: Option<&str>, demo_only: Option<bool>, account_mode: Option<&str>) -> RiskOwner {
    let _ = (authority, demo_only, account_mode);
    return RiskOwner::Rust;' \
  && $MUT engine/order-management/src/authority.rs "(b.\"riskAuthority\"::text = 'RUST' AND (b.\"riskAuthorityDemoOnly\" = false OR a.\"accountMode\"::text = 'DEMO'))" "(true)" \
  && engine_tests --test risk_split_db
  report "M4 engine acts on a WEB-owned account (rule and SQL hand it everything)" $?; restore
fi
if want M5; then
  $MUT engine/order-management/src/book.rs 'if let Some(actor) = actor {
        let owner = crate::authority::lock_owner_in_tx(tx, &account_id).await?.unwrap_or(crate::authority::RiskOwner::Web);' 'if let Some(actor) = None::<crate::authority::RiskOwner> {
        let owner = crate::authority::lock_owner_in_tx(tx, &account_id).await?.unwrap_or(crate::authority::RiskOwner::Web);
        let _ = actor;' \
  && engine_tests --test risk_split_db
  report "M5 engine in-transaction owner check removed (the flip no longer stops its next close)" $?; restore
fi
if want M6; then
  $MUT engine/order-management/src/authority.rs 'let demo_only = demo_only != Some(false);' 'let demo_only = false;' \
  && engine_tests --lib authority && engine_tests --test risk_split_db
  R=$?; report "M6 demo-only scope ignored (engine rule)" $R; restore
fi
if want M7; then
  $MUT lib/risk-authority.ts 'const demoOnly = broker?.riskAuthorityDemoOnly !== false;' 'const demoOnly = false;' \
  && web_tests lib/risk-authority.test.ts lib/risk-split.test.ts lib/risk-owner.test.ts
  report "M7 demo-only scope ignored (web rule)" $?; restore
fi
if want M8; then
  $MUT engine/order-management/src/monitor.rs '    let hint = book::TickHint { ticks: fire.ticks };
    book::with_tick_hint(hint, evaluate_account_checked(pool, nats, &fire.account_id, true, &Mode::Live, None, false)).await' '    let hint = book::TickHint { ticks: fire.ticks };
    // MUTATION: the fire is PINNED to the moment it is evaluated at (positions opened after it are invisible)
    let pin = book::Pin { at: chrono::Utc::now(), ticks: hint.ticks.clone(), measured: Vec::new() };
    book::with_pin(pin, book::with_tick_hint(hint, evaluate_account_checked(pool, nats, &fire.account_id, true, &Mode::Live, None, false))).await' \
  && engine_tests --test risk_split_db
  report "M8 the live fire is still pinned" $?; restore
fi
echo
[ $MISSED -eq 0 ] && echo "every mutation was detected" || echo "AT LEAST ONE MUTATION WAS MISSED"
exit $MISSED
