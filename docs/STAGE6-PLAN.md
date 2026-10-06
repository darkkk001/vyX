# Stage 6: the engine becomes authoritative for risk, per account, with a warm WEB fallback

_Written 2026-10-06 on branch `engine/stage6` (worktree `D:\vyx-stage6`). Everything below is built and tested on this branch only:
NOT merged to main, NOT deployed (VPS or Vercel), the migration NOT applied to any production or Neon database (scratch Postgres
`127.0.0.1:5499` only). The owner reviews this document and the diffs first._

_Updated 2026-10-06 with the owner's review answers (a) to (e): the engine-down watchdog is built and is a HARD GATE before `riskAuthorityDemoOnly = false` (section 14), the shadow-alongside question is answered (section 15), the startup flip marker is built (section 16). The exact Futurix procedure, in order, with copy-paste commands and a check after every step, is `docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md`._

What "authoritative for risk" means here: for the accounts the per-broker rule assigns to RUST, the **engine** decides and acts on
SL / TP touches, margin calls (the notice), stop-outs and the trigger of resting orders; the **web** does none of those for them.
For every other account nothing changes, byte for byte.

## 0. The one-paragraph summary

One rule (`riskOwnerOf(broker, accountMode)`) decides the owner of every account, and it exists in three forms that are tested against each
other (TypeScript, Rust, SQL). Both sides check the owner twice: a cheap prefilter before they evaluate, and, the part that makes the split
airtight, **inside the transaction that acts**, with the account row and the broker row locked, so a flip of the owner and an acting
transaction are totally ordered by the database and no instant exists at which both sides can pass. The engine's per-tick fires (margin
trigger, SL / TP touches, resting-order crossings) go to its OWN unpinned live `evaluate_account`, carrying the tick that triggered them and
re-reading the account's current positions in one snapshot. The web skips engine-owned accounts at every path that acts on risk. Proven by:
the unit and DB tests below, a harness that runs the web and the engine **at the same time on one database** (every combination, three seeds,
checked against the web-only reference and against a per-action trace), and a **WEB-fallback drill under load** (flip RUST to WEB in the middle
of the run). Eight mutations that break a safeguard are each caught.

## 1. The plan in the owner's order

| # | Item | Status | Where |
|---|---|---|---|
| 1 | **Blocker**: margin fires, SL / TP touches and resting-order crossings of RUST-owned accounts go to the engine's own UNPINNED live evaluation | built | `market-data/src/risk_hook.rs` (`LiveFire`, `engine_touches`), `order-management/src/margin_watch.rs` (`set_live`), `monitor.rs` (`evaluate_live_fire`, `spawn_live_trigger`) |
| 2 | **Web skips RUST-owned accounts** at every path that acts on risk, same rule | built | section 4 lists every path |
| 3 | **Engine live mode**: write pool, post-close delivery on, per-broker authority from the DB reloaded on change | built | `ENGINE_ORDER_MANAGEMENT=risk` (`server/src/main.rs`), `authority.rs` |
| 4 | Airtight split, tested: no account by both, none by neither, every combination | built + proven | sections 7 and 8 |
| 5 | Flip during a pass never double-acts or misses; handoff defined | built + proven | section 6 |
| 6 | Cross-account effects follow the account that set them off | stated + tested | section 5 |
| 7 | WEB-fallback drill as a test, under load | built + passed | section 8.3, runbook section 9 |
| 8 | **Engine-down watchdog**: a heartbeat; stale = every RUST account is WEB on both sides, re-checked inside every acting transaction | built + proven (HARD GATE for demo-only off) | section 14 |
| 9 | Startup WARNING when a live mode is set without a flip marker | built + tested | section 16 |

The owner's flip sequence the build is designed for:

1. `riskAuthority = RUST`, `riskAuthorityDemoOnly = true`: the engine owns that broker's DEMO accounts, the web keeps its LIVE accounts.
2. Verify (section 9, with the exact queries).
3. `riskAuthorityDemoOnly = false`: the engine owns all of that broker's accounts.
4. At every step `riskAuthority = WEB` is the fallback, one statement, no restart.

## 2. The rule, in three forms that must agree

RUST only when the broker's `riskAuthority` is exactly `RUST`, the account's mode is exactly `DEMO` or `LIVE`, and (`riskAuthorityDemoOnly` is
exactly `false`, or the account is `DEMO`). Anything missing or unknown is WEB; a missing demo-only value counts as demo-only.

| Form | Where | Used for |
|---|---|---|
| `riskOwnerOf` | `lib/risk-authority.ts` | every web decision |
| `risk_owner_of` | `engine/order-management/src/authority.rs` | the engine's routing cache |
| `RUST_OWNED_SQL` | same file | the engine's pass listing, the tests' oracle |

Parity: `lib/risk-authority-cases.json` is a 196-case matrix (every shape a value can arrive in: right, wrong case, empty, null, unknown,
omitted; written by `scripts/stage6/gen-risk-authority-cases.mjs`). `lib/risk-authority.test.ts` runs `riskOwnerOf` on it,
`authority.rs` runs `risk_owner_of` on the same file, and `risk_split_db.rs` checks the SQL forms against `risk_owner_of` on every cell the
schema allows. A change to one form fails a suite.

## 3. How the fire carries the tick and the positions

Before this branch a margin-trigger fire only called the web's `margin-monitor?symbols=` route and handed the shadow a PINNED snapshot. In RUST mode
the web skips the broker, so a fire would have done nothing until the engine's next pass.

```
flush (every 250 ms) -> RiskHook::after_flush
   |- SL / TP touches:   engine_touches(): levels whose broker/mode the oracle says the engine owns -> LiveFire{account, ticks: {symbol: (bid, ask, tick time)}, SlTp}
   |- resting orders:    engine_touches(): crossed entries of engine-owned accounts -> GET /api/internal/pending-trigger?symbols=X (the web's FILL routine,
   |                     RUST scope), then LiveFire{Pending} for the account (the fill may have opened a position already at a stop-out level)
   |- margin trigger:    MarginWatch::decide(): the account fires (stop-out, or a margin-call edge, same damping as before) -> LiveFire{Margin, ticks: the
   |                     tick-cache prices it was measured at}; NOT returned for the web call, NOT handed to the shadow
   '- everything else (WEB-owned accounts): exactly the pre-Stage-6 path: shadow snapshot + `margin-monitor?symbols=` call
LiveFire -> spawn_live_trigger (one worker, batches queued fires, one evaluation per account, 8 accounts at a time)
         -> monitor::evaluate_live_fire -> evaluate_account_checked(Mode::Live) under book::with_tick_hint
```

* **The fire carries the tick, not the positions.** `LiveFire.ticks` is symbol -> (bid, ask, tick time) of the tick that crossed. While the
  evaluation runs, `book::TickHint` prices exactly those symbols at that tick (as long as it is within the web's 15 s freshness rule, judged against
  NOW) and every other symbol from the engine's ticks. So the close happens at the crossing price (the owner's "stop out on the crossing tick").
* **The positions are CURRENT, re-read inside the evaluation**, in the torn-read-safe snapshot that `calc::load_book_state` already takes (one
  `REPEATABLE READ, READ ONLY` transaction for funds, positions, sessions, fx), and again after every close, exactly as a pass does. A position opened
  after the fire is evaluated; one closed since is not resurrected. This is the opposite of the shadow's `book::Pin`, which reads the account as it
  stood at the fire. Test: `risk_split_db::the_fire_evaluates_the_accounts_current_positions_not_the_positions_at_the_fire` (mutation M8 makes it fail).
* **UNPINNED means the margin-call edge is live too:** `apply_margin_call_edge` and the outbox run from the fire, so the notice goes out on the tick,
  not at the next 5 s pass (gate test below, section 7).
* **A fill is seen at once (the owner's 2026-10-01 fill-event gate).** The book learns of a new position by a reload the web asks for (`order.filled` and the other
  book events); right after such a reload `MarginWatch::decide_engine_now` evaluates the engine-owned accounts of the new book at the LATEST price of every symbol,
  with the same damping as a tick. So a position opened just before a gap, which the gap tick could not see, is stopped out at the gap price when the reload lands, not at
  the next pass. Test: the gap tick alone does nothing; `request_reload` stops the position out (`risk_split_db`, mutation M9).
* **Floor under the fires:** `spawn_risk_passes`, a live pass over the engine-owned accounts every `MARGIN_MONITOR_INTERVAL_SECS` (5), idle-gated like the
  shadow pass (no fresh price anywhere = no work and no database read: the Neon lesson).
* A stale routing cache can only mis-ROUTE a fire; the evaluation reads the database's own answer first (`owner_of_account`) and drops an account that
  is not the engine's.

## 4. Web paths that act on risk (item 2): the complete list

All go through two functions; both are gated.

| Path | Caller(s) | Gate |
|---|---|---|
| SL / TP closes, stop-out closes, margin-call set / clear | `lib/risk-monitor.ts` `evaluateAccountRisk` | prefilter (`loadRiskOwners`) + `closePositionInTx(riskActor: "WEB")` and `setMarginCall` / `clearMarginCall` call `assertRiskActorInTx` inside their transactions |
| batch evaluation | `evaluateAccountsRisk` (margin-monitor full pass = the Vercel cron `*/5` and the engine backstop; the hook's `?symbols=` call via `evaluateRiskForSymbol`; the legacy `/api/internal/price-feed` tick path via `lib/price-feed.ts`) | `webOwnedAccountIds` drops engine-owned accounts before the shared read |
| trigger and fill of resting LIMIT / STOP orders | `lib/pending-trigger.ts` `evaluatePendingTriggers(symbols?, scope)` (margin-monitor `?symbols=` and full pass, scope WEB) | scope filter by owner; every claim (fill, queue for dealing, reject) re-checks inside its transaction (`triggerPendingOrder(..., actor)`) |
| the engine's own resting-order route | new `app/api/internal/pending-trigger/route.ts` (scope RUST) | fills ONLY engine-owned accounts' orders; same in-transaction check |
| SL / TP hook, shadow snapshots | engine `risk_hook.rs` | engine-owned levels are no longer sent to the web call nor the shadow |

Deliberately NOT gated, and why:

* **Manual / staff closes, dealer closes, bulk closes, close-by, mirror and coverage follow-up closes** are not risk evaluations: they run when a human or
  an effect asks, they never set `riskActor`, and the position's status-and-volume guard already makes every close exactly-once.
* **`POST /api/trade/orders/[id]/fill`** (an older terminal telling the server a pending order's price was reached, origin `client`): the client's own action; the
  claim is status-guarded, so an order can never be filled twice whoever asks.
* **The post-close delivery** (`/api/internal/post-close`, `drainPostCloseBackstop`): it delivers the consequences of an ENGINE close (mirror, coverage,
  notices, events). It runs for rows only the engine writes and is exactly-once by step markers.
* **Pre-trade margin checks, swap rollover, order placement**: not risk evaluations (section 10: they stay on the web).

## 5. Cross-account effects follow the account that set them off

Effects of a close are the web's code (`lib/post-close.ts` for an engine close, inline in `lib/risk-monitor.ts` for a web close). They are
writes on OTHER accounts, but they are not risk evaluations of those accounts: each is exactly-once on its own guard, and **ownership of the
target account is irrelevant to whether the effect runs**. The target's own risk stays with the target's owner.

| Effect | Triggered by | Lands on | What happens |
|---|---|---|---|
| mirror close (reverse / copy rules) | a risk close of the source | the follower's / master's target position (any mode) | closed once at the source price or the market (`mirror.onClose`, `closePositionInTx` without `riskActor`); guard = status + volume |
| coverage close / release | a risk close of a hedged client position, or of a coverage leg | the hedge leg on the coverage account (a LIVE, system-owned account), or the client position it hedged | `coverage.onClose`, same guards; `COVERAGE_STOP_OUT` notice to the desk |
| queued close cancel (dealer mode) | any risk close | the client's queued order | `cancelPendingClose`, once |
| stop-out notice, activity, `PositionClosed` event | a stop-out | the dealer / the terminal | once, buffered with their step |
| margin-call notice, event, margin-call-over notice | the margin-call edge | the account itself (+ staff) | engine: outbox rows `MARGIN_CALL` / `MARGIN_CALL_CLEARED`, delivered once; web: inline |
| IB / partner | **none exist on a close**: IB payouts are staff actions (`lib/ib-payout.ts`) and the IB accrual belongs to the order path | | nothing to split |
| auto-hedge OPEN, mirror OPEN (copy of a fill) | a FILL | the coverage / follower account | order path: stays on the web (section 10) |

**When a DEMO account's effect lands on a LIVE account** (broker RUST + demo-only, step 1 of the flip): the engine closes the DEMO account's position;
the outbox row is delivered to the web's post-close route; that route closes the LIVE follower's mirror target / the LIVE coverage leg once. The LIVE
account's equity moves, and the web (its owner) sees it at its next evaluation (a hook call, the 5 s backstop, at most seconds). No risk decision about
the LIVE account is taken by the engine, and the engine never holds a lock on it. Harness variant `cross` makes exactly this the whole population (clients
DEMO, masters and coverage accounts LIVE): the end state equals the web reference.

The reverse (a LIVE web close whose inline effect lands on a DEMO account the engine owns) is the same code on the other side of the table.

**Known limit, stated honestly:** a CASCADE that crosses sides (A closes, which closes B's mirror target, which pushes B under its stop-out, which
closes a position mirrored onto C, ...) with its hops owned by different actors is no longer evaluated in the web's id order, because two actors run
concurrently. Such cascades are order-dependent even on the web alone (the Stage 4 topologies exist because of that). The invariants (exactly once, nothing
by the wrong side, nothing left undone) are proven for them (`cross-topo`); the END STATE is proven equal to the web reference for every topology that stays
on one side, which is every cascade a broker can create inside one account mode.

## 6. The ownership handoff (flip during a pass)

An ownership read is never trusted past the transaction that acts on it.

* The acting transaction (a risk close, a margin-call set / clear / edge, a resting-order claim) runs, as its first locking step after the account row is
  locked: `SELECT ... FROM "Account" a JOIN "Broker" b ... FOR NO KEY UPDATE OF a FOR SHARE OF b`, computes the owner by the rule from what it just read,
  and proceeds only if it IS the owner. Otherwise it rolls back, writes nothing, and the evaluation stops acting on that account (`NotOwner`).
  Web: `lib/risk-owner.ts assertRiskActorInTx`. Engine: `authority::lock_owner_in_tx` from `book::close_position_as` / `apply_margin_call_edge_with`.
* A flip is `UPDATE "Broker" SET "riskAuthority" = ...` (or a mode change, `UPDATE "Account"`). The update needs a lock that conflicts with `FOR SHARE` on
  the broker row (and with `FOR NO KEY UPDATE` on the account row), so it **waits for every acting transaction that has already checked**, and **every
  transaction that checks after it commits reads the new value**. Hence for each account there is a total order between flips and actions: every committed
  action was taken by the owner at the moment it committed. There is no instant at which both sides pass. Lock order is Position, then Account, then Broker
  on both sides (the order every close already used), so no new deadlock cycle.
* A flip of a whole broker is ONE statement: atomic for all its accounts.
* **Not missing (the other direction):** after the flip commits the new owner finds its accounts without any cache: the engine's pass lists
  `RUST_OWNED_SQL` from the database every 5 s (idle gate permitting); the web's hook / backstop / cron read the database; the routing cache reloads on
  `config.changed`, on reconnect, and every 5 s while the market moves. The worst case for a RUST to WEB flip is therefore one backstop interval (5 s on the
  VPS, `VYX_RISK_HOOK_BACKSTOP_SECS=5`), for WEB to RUST one pass (5 s).
* A close the old owner committed before the flip stands (it was the owner's); the new owner re-reads and continues. An evaluation caught in the middle
  stops after its current close (`EvalReport.not_owner`), writes no margin-call edge, and the next evaluation drops the account at the prefilter.

Tests: `lib/risk-owner.test.ts` (the flip UPDATE is observed WAITING in `pg_stat_activity` on a transaction that already checked, then the next check sees
the new owner; same for a mode change; both directions), `risk_split_db::a_flip_waits_for_an_engine_close_in_flight_and_the_next_engine_close_is_refused`,
`risk_split_db::flipping_to_web_in_the_middle_of_an_engine_evaluation...` (three positions, flip after the first close committed: exactly one close,
no more, no margin-call edge), `lib/risk-split-flip.test.ts` (the mirror image on the web), `lib/risk-split-stale.test.ts` (a prefilter that LIES
cannot make the web act).

### The double-fire proof during the transition

The transition has three parts and each is covered:

1. **Routing** (who is called): a fire for an engine-owned account never reaches the web call (hook partition tests in `risk_hook.rs`); a fire for a
   web-owned account never reaches the engine. If the routing cache is stale, the engine's prefilter drops the fire and the web's prefilter skips it:
   the worst case is a delayed action, never a double one.
2. **Evaluation** (who reads): both sides re-read the database's owner before evaluating; both re-check in their transactions.
3. **Action** (who writes): only the owner commits (section 6). The position's status-and-volume guard stays underneath as before: even if the check
   were skipped, one position cannot be closed twice (`exactly-once.ts` asserts it on every harness run).

## 7. What is proven, and how

| Claim | Test |
|---|---|
| no account is acted on by BOTH, in every combination (WEB broker; WEB with demo-only off; RUST + demo-only with DEMO and LIVE; RUST + all) | `lib/risk-split.test.ts` (web: batch and single entry, state AND trace), `risk_split_db::every_combination_the_engine_pass_acts_on_exactly_the_accounts_the_rule_gives_it` and `...a_fire_for_any_account_acts_only_on_the_ones_the_engine_owns` (engine) |
| none by NEITHER | same tests assert every account the rule gives to a side WAS acted on by that side; the harness diffs the end state against the web-only reference |
| the three forms of the rule agree | `risk_authority_cases` (both languages), `risk_split_db::the_sql_forms_of_the_rule_agree...` |
| a stale prefilter or cache cannot cause a double action | `risk-split-stale.test.ts`, `risk_split_db` fire test (a fire for EVERY account, as if the cache said engine for all) |
| the flip handoff | section 6 tests |
| resting orders: scopes are disjoint | `risk-split.test.ts` (WEB scope fills the LIVE account's order only, RUST scope the DEMO account's, a wrong-side trigger claims nothing), hook tests |
| the fire is unpinned, current, and carries the tick | `risk_split_db`: current positions (a position opened after the fire is stopped out), carried tick price (a stale carried tick is ignored) |
| S3-shaped ramp in RUST mode: margin-call notice FROM THE FIRE (no pass runs) and stop-out on the crossing tick (the plan's 6.1 gate) | `risk_split_db::an_s3_ramp_sends_the_margin_call_notice_from_the_fire_and_stops_out_on_the_crossing_tick` |
| RUST mode loses nothing the web does: margin-call event, margin-call-over notice and event | `lib/post-close.test.ts` (new tests; found and fixed on this branch, section 12) |

## 8. The load proof: web and engine at the same time on one database

`scripts/load/run-split.sh --variant V --seed S --accounts N --walkers K` runs ONE seeded world (the Stage 4 generator: bulk book, mirror and coverage links,
queued closes, ten cascade topologies) twice:

1. the **web reference** alone on `vyx_load_web` (every broker WEB, the web's id-ordered walk);
2. the same world on `vyx_load_split`: broker flags and account modes assigned by `scripts/load/split.ts` (the one rule), then the web runner and the
   engine's K concurrent walkers (real passes, real dispatcher into the real post-close route) run **at the same time**, each acting on what it owns; then
   two settle rounds of both.

It then checks: (a) the end state equals the web reference id by id (`diff.mjs`: balances, credit, margin-call flags, every ledger row, every position,
queued orders, every notification and audit); (b) exactly-once (`exactly-once.ts`); (c) `split-check.ts` reads a per-action trace written by both sides
(`VYX_RISK_ACTION_TRACE`) and fails if an action was taken by a side that does not own the account, a position was closed by two actions, a risk-closed
position has no action (the NEITHER case), or a side that owns work took none.

Variants: `web`, `rust-demo`, `rust-all`, `mixed` (brokers alternate WEB / RUST demo-only / RUST all), `cross` (clients DEMO, masters and coverage LIVE: every
effect crosses sides), `cross-topo` (cascade topologies split per account: invariants only, see the known limit in section 5).

Results (2026-10-06, 100 clients + topologies, K = 2 walkers, seeds 1-3): all 18 runs PASS (web, rust-demo, rust-all, mixed, cross, cross-topo x seeds 1-3; the verification run and a re-run of cross for seeds 2-3 after the last check was added). For
the same 147 / 128 / 123 risk-closed positions of seeds 1 / 2 / 3, the split of who closed them:

| variant (accounts: engine-owned / web-owned) | seed 1 web / engine closes | seed 2 | seed 3 |
|---|---|---|---|
| web (0 / 152) | 147 / 0 | 128 / 0 | 123 / 0 |
| rust-demo (63 / 89) | 81 / 66 | 70 / 58 | 73 / 50 |
| rust-all (152 / 0) | 0 / 147 | 0 / 128 | 0 / 123 |
| mixed (58 / 94) | 83 / 64 | 67 / 61 | 75 / 48 |
| cross (112 / 40), effects across sides | 35 / 112 (66 effect closes landed on web-owned accounts from engine-owned sources) | 35 / 93 (70) | 35 / 88 (63) |
| cross-topo (86 / 66), invariants only | 56 / 93 | 45 / 85 | 48 / 77 |

In every run: the end state equals the web reference id by id (except cross-topo, invariants only), 0 differences, every outbox row DONE exactly once, no position closed by two actions,
no action by the wrong side, every risk-closed position has exactly one action by its owner. The `web` and `rust-all` rows are the two ends of the airtight claim: a side that owns nothing took
ZERO actions while the other side was running at full speed on the same database.

### 8.3 The WEB-fallback drill under load

`run-split.sh --variant rust-all --drill`: broker flags RUST (all accounts engine-owned), the engine running; after its first 10 stop-out closes ONE statement
flips every RUST broker to WEB (the runbook's SQL, timestamp taken from the database clock by the statement itself). The web, polling all along, takes
over the rest. Checked on top of (a)-(c): every engine close started before the flip, every web action came after it, BOTH sides worked, and the end state
still equals the web reference. Result: all three seeds PASS (150 + topologies, 212 accounts, every account engine-owned at the start). Seed 1: 24 engine closes before the flip, then the web took 188 closes and 38 margin-call writes;
seed 2: 16 engine / 174 web; seed 3: 16 engine / 169 web. In each: every engine close started before the flip, every web action came after it, the end state equals the web reference, and
exactly-once holds (a position closed in the flip window was closed by exactly one side).

## 9. Runbook: the flip sequence, the fallback, and how to confirm

Everything is `psql` against the live database as the owner. Replace `<S>` with the broker's subdomain. NOTHING here has been run on production.

**The exact Futurix procedure, in order, with a verification after each step, an audited flip and the engine-down drills, is `docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md`; this section is the generic form.** One difference since the first draft: ownership now also needs a LIVE engine (section 14), so the ownership query of 9.1 should be read with the heartbeat counted (the runbook's 5.4 query does).

### 9.0 Before the first flip (read only)

```sql
-- the Stage 6 columns exist and every broker is WEB
SELECT subdomain, "riskAuthority", "riskAuthorityDemoOnly" FROM "Broker" ORDER BY subdomain;
-- the outbox exists with its ordering column
SELECT column_name FROM information_schema.columns WHERE table_name = 'PostCloseEffect' AND column_name IN ('seq', 'doneSteps', 'pendingEvents');
```

On the VPS the engine log must say, since its last start: `RISK MODE ACTIVE` (and NOT `RISK MODE REFUSED`), `post-close outbox dispatcher running`, `risk mode: the pool is writable`,
`risk mode: the hook sends SL / TP touches ... to the engine`. If any is missing, do not flip: with a broker on RUST and the engine not in risk mode NOBODY acts.

### 9.1 Step 1: the engine owns the broker's DEMO accounts, the web keeps LIVE

```sql
UPDATE "Broker" SET "riskAuthority" = 'RUST', "riskAuthorityDemoOnly" = true WHERE subdomain = '<S>'
RETURNING id, subdomain, "riskAuthority", "riskAuthorityDemoOnly";
```

Within about 5 s the engine logs `risk authority: 1 broker(s) are RUST-owned`. Who owns what, from the database (the same rule):

```sql
SELECT a."accountMode", b."riskAuthority", b."riskAuthorityDemoOnly",
       CASE WHEN b."riskAuthority" = 'RUST' AND (b."riskAuthorityDemoOnly" = false OR a."accountMode" = 'DEMO') THEN 'ENGINE' ELSE 'WEB' END AS owner,
       count(*) AS accounts, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Position" p WHERE p."accountId" = a.id AND p.status = 'OPEN')) AS with_open_positions
FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE b.subdomain = '<S>' GROUP BY 1, 2, 3, 4;
```

### 9.2 Step 2: verify (who closed what)

An engine close always queues a follow-up row in the same transaction; a web close never does. So the side of every automatic close is visible in the database,
without any trace:

```sql
SELECT t."createdAt", acc."accountNumber", acc."accountMode", t."referenceId" AS position, left(t.note, 40) AS note,
       CASE WHEN e.id IS NULL THEN 'WEB' ELSE 'ENGINE' END AS closed_by
FROM "Transaction" t
JOIN "Account" acc ON acc.id = t."accountId"
JOIN "Broker" b ON b.id = t."brokerId"
LEFT JOIN "PostCloseEffect" e ON e."positionId" = t."referenceId" AND e.kind = 'POSITION_CLOSED'
WHERE b.subdomain = '<S>' AND t.type = 'TRADE_PNL'
  AND (t.note LIKE 'Stop-out%' OR t.note LIKE 'Stop loss%' OR t.note LIKE 'Take profit%')
  AND t."createdAt" > now() - interval '1 day'
ORDER BY t."createdAt" DESC;
```

Expected in step 1: every DEMO account's automatic close is `ENGINE`, every LIVE account's is `WEB`. A violation (an `ENGINE` row on a LIVE account, a `WEB` row on a DEMO account
created after the flip) means STOP: set the broker back to WEB (9.4) and send me the row.

Delivery of the engine's follow-ups (all must end `DONE`, none `DEAD`):

```sql
SELECT kind, status, count(*), max("createdAt") AS newest FROM "PostCloseEffect" WHERE "createdAt" > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
```

Margin calls of engine-owned accounts arrive as `MARGIN_CALL` / `MARGIN_CALL_CLEARED` rows (their notifications follow when the row is `DONE`).

The same checks for the final 7-scenario sweep on the exact cutover build: run the sweep with the bot's accounts as DEMO accounts of the flipped tenant (verify their `accountMode`
first) and read the `closed_by` column.

### 9.3 Step 3: the engine owns all of the broker's accounts

```sql
UPDATE "Broker" SET "riskAuthorityDemoOnly" = false WHERE subdomain = '<S>' AND "riskAuthority" = 'RUST'
RETURNING id, subdomain, "riskAuthority", "riskAuthorityDemoOnly";
```

Repeat 9.2: now every automatic close of the broker is `ENGINE`.

### 9.4 The WEB fallback, at any step

```sql
UPDATE "Broker" SET "riskAuthority" = 'WEB' WHERE subdomain = '<S>' RETURNING id, subdomain, "riskAuthority", "riskAuthorityDemoOnly";
```

No restart, no deploy. A transaction the engine had in flight finishes first (the statement waits for it, milliseconds); everything after is the web's.
**Confirm the web picks up the next stop-out** (this is the drill on the live system, with a demo account at a price that stops out, e.g. the shadow bot's S1):

1. within one backstop interval (5 s) the web's margin-monitor pass evaluates the account (Vercel log: `margin-monitor` 200);
2. run 9.2: the new close shows `closed_by = WEB` (no `PostCloseEffect` row), exactly one `TRADE_PNL` per position:
   ```sql
   SELECT "referenceId", count(*) FROM "Transaction" WHERE type = 'TRADE_PNL' AND "createdAt" > now() - interval '15 minutes' GROUP BY 1 HAVING count(*) > 1;  -- must return no rows
   ```
3. nothing missed: `SELECT count(*) FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Broker" b ON b.id = a."brokerId" WHERE p.status = 'OPEN' AND b.subdomain = '<S>';` -- no
   position that should have stopped out is still open a few seconds after the price crossed.

Returning to RUST afterwards is the 9.1 / 9.3 statement again.

## 10. The gates, split

### Blockers for RISK authority (must hold before ANY broker is RUST)

| Gate | Status | Reason |
|---|---|---|
| fires evaluated by the engine's own unpinned live `evaluate_account` | built here | in RUST mode the web skips the broker, so a fire that only called the web would do nothing |
| web skips engine-owned accounts at every acting path, with the in-transaction owner check | built here | otherwise both sides act |
| engine live mode: write pool verified, post-close delivery required, authority read from the database | built here | the engine must be able to write and deliver, and must not act on web-owned accounts |
| the margin-call event and the end-of-episode notice and event | built here (commit `9634b5d`) | a RUST-owned trader would silently lose real-time margin-call UI that WEB-owned traders have |
| `POST_CLOSE_SECRET` on Vercel and `VYX_POST_CLOSE_URL` / `VYX_POST_CLOSE_SECRET` on the VPS | deploy step | without them an engine close is not delivered (mirror, coverage, notices); risk mode refuses to start without them |
| fill-event evaluation: a position opened just before a gap is stopped out at once (the 2026-10-01 owner gate) | built here (`MarginWatch::decide_engine_now`, test `risk_split_db::a_position_opened_just_before_a_gap...`, mutation M9) | in RUST mode nobody else would catch it before the engine's next 5 s pass: the web skips the account |
| torn-read-safe snapshot, flap damping of margin-call edges, tick price source, FX age limit, idle gate | already deployed | the engine's decisions must equal the web's |
| soak: 7 clean days, 2 weekend reopens (the 2nd is Sun 2026-10-11 21:00-22:00 UTC), 1 NFP, then the final 7-scenario sweep on the exact cutover build | the owner's gate, unchanged | evidence |
| the heartbeat table (migration `20261007100000_risk_engine_heartbeat`) and the engine's write privilege on it | deploy step (runbook 2.4) | without a heartbeat nobody counts the engine as alive: every account is WEB. Risk mode refuses to start without the privilege |

### Hard gate before `riskAuthorityDemoOnly = false` (the owner's answer (b), 2026-10-06)

| Gate | Status | Reason |
|---|---|---|
| **Engine-down watchdog**: heartbeat row, stale = WEB on both sides, in-transaction re-check on both sides | **built here** (section 14) | with a broker on RUST and the engine unable to act, nobody would act on its accounts. The demo phase may use manual monitoring; the LIVE accounts may not |
| the watchdog drill passed on the live system in demo (runbook 7.B) | runbook | proof on the real deployment, not only on scratch |
| a full trading week of demo clean, the final sweep clean (runbook 9) | runbook | evidence |

### Needed only when the engine handles ORDERS (NOT in Stage 6: these paths stay on the web)

| Gate | Reason (one line) |
|---|---|
| swap-free (engine swap ignores `Account` / `Group.swapFree`) | swap rollover stays on the web, so a swap-free account is never charged by the engine |
| group max / min volume (the engine checks the symbol range only) | every order-opening path, including the resting-order fill, stays web code with all its gates |
| `groupCategoryAtOpen` | written by a database trigger at position INSERT; the engine inserts no positions in Stage 6 |
| credit / trading-rights batch (`be/credit-rights`) | gates opens by account status and rights; the engine opens nothing; credit in EQUITY is already the web's and the engine's rule (Model A) |
| resting-order FILL, requote, dealing queue, slippage, pricing engine fill price, commissions | all of it is the order path; the engine only decides WHEN an engine-owned account's resting order triggers and calls the web's fill routine |
| auto-hedge OPEN, mirror OPEN (copies of a fill) | triggered by fills, which stay on the web |
| pre-trade margin including the opening cost (product question 6.2) | order path |
| IB accruals, KYC and withdrawal gates | not risk |

## 11. Deploy order and rollback

Deploy order (after the soak gate, not before):

1. **Migrations** `20261007090000_broker_risk_authority` and `20261007100000_risk_engine_heartbeat` (both additive and idempotent; every broker defaults to WEB and demo-only and the heartbeat row is born stale: they change nothing by themselves; they must precede the web), with
   `prisma migrate deploy` and BOTH `DATABASE_URL` and `DIRECT_URL` set to the live database (never `migrate dev`). Then the one-line grants of `deploy/neon-shadow-readonly.sql` for the
   shadow role if the shadow keeps running elsewhere.
2. **Web** (Vercel, main): the web with the skip and the in-transaction check. **The migration MUST be applied first**: the generated Prisma client selects every `Broker` column
   (`riskAuthority`, `riskAuthorityDemoOnly` included) in every unrestricted broker query, so a web built from this branch against a database without the columns fails on those queries
   (the web's own risk helpers tolerate the missing column and answer WEB, but that does not save the rest of the app). Set `POST_CLOSE_SECRET` (the same value the VPS will use). Verify: `/api/internal/pending-trigger` answers 401 without the bearer, a
   margin-monitor pass logs 200.
3. **Engine** (VPS): `ENGINE_ORDER_MANAGEMENT=risk`, `VYX_POST_CLOSE_URL`, `VYX_POST_CLOSE_SECRET` (and, optionally, `VYX_PENDING_TRIGGER_URL`; it defaults to the hook URL with
   `/pending-trigger`). Risk mode REPLACES the shadow in the same process (the shadow refuses when the post-close variables are set): the soak instrumentation for WEB-owned accounts stops
   at this deploy. Verify the four log lines of 9.0. No broker is RUST yet, so the engine owns nothing.
4. Then 9.1 (the flip), 9.2 (verify), 9.3, with 9.4 ready.

Rollback, from the smallest to the largest:

| Level | What | How | Note |
|---|---|---|---|
| per broker | back to WEB | 9.4, one statement | seconds, no restart; the engine drops its accounts at the prefilter |
| engine | back to shadow | **first** flip every broker to WEB (9.4), **then** restart the engine without `ENGINE_ORDER_MANAGEMENT=risk` | the other order leaves RUST brokers with NO owner |
| web | previous Vercel deployment | **first** flip every broker to WEB, **then** roll back | a web without this change does not skip engine-owned accounts: it would double-act |
| schema | none needed | the columns are additive; leave them, everything is WEB | do not drop them while any code reads them |

## 12. Findings on this branch, and open decisions for the owner

Found and fixed while building (all additive, none touches a WEB-owned account):

* RUST mode would have lost the real-time `MarginCall` event, the trader's "Margin call over" notification and its "cleared" event (the engine wrote the flag only). Fixed:
  `MARGIN_CALL_CLEARED` outbox rows and the web's delivery (`lib/post-close.ts`), tests in `lib/post-close.test.ts`.
* `riskOwnerOf` answered RUST for an unknown account mode when the broker owned everything; it now answers WEB (the spec's "anything unknown is WEB"), and the cases matrix pins it.

Open decisions (none blocks the build; each changes the deploy):

1. **Shadow beside risk mode: answered (a), accepted for now** (risk mode replaces the shadow; the bot sweep is the regression check). The "could it run alongside" question is section 15. Not built.
2. **Engine liveness watchdog: built (answer (b)).** Not an alert but an automatic fallback to the web, made safe by checking the heartbeat inside every acting transaction (the objection recorded in the first draft, that an automatic flip while the engine might still be alive is the double-action case, is what the in-transaction check closes). Section 14.
3. **Resting-order fills for engine-owned accounts stay web code** (the engine decides WHEN, the web's routine decides WHETHER), because the fill is an order action with every order gate. Porting
   the fill to Rust is the ORDERS stage; say if you want it earlier.
4. **Cascades across sides** are not in the web's id order (section 5). If a broker ever configures a mirror or coverage chain whose accounts sit on different sides, the result can differ from the web-only
   result in the order-dependent cases (never in the exactly-once invariants). The product answer is to keep a chain on one side (same broker authority AND the same account mode).
5. The legacy `ENGINE_ORDER_MANAGEMENT=1` mode now also enforces ownership (it would otherwise act on every account it is handed). It acts on nothing until a broker is RUST, and (answer (e)) it logs the flip-marker WARNING like `risk`. It never writes a heartbeat, so with a RUST broker it counts as a dead engine: the web owns everything.
6. **Heartbeat window and cadence (new, section 14):** N = 30 s, beat every 3 s, written only while the idle gate is open (Neon). Alternatives: a longer window, or beating always (28,800 one-row writes a day, Neon compute never suspends; the 2026-09-26 quota outage was exactly that kind of leak). Say if you want it always-on.
7. **Vercel cron cadence while any broker is RUST (new, section 14):** the web's own floor when the engine is down is the cron every 5 minutes. One minute is possible on the current plan; not changed.
8. **A stale-heartbeat alert (new):** the watchdog acts by itself, but nobody is TOLD. A page or a mail when the heartbeat is older than 60 s during market hours is the obvious companion; not built (the demo phase watches by hand, runbook 6).

## 13. Verification record (2026-10-06, scratch databases only)

| Gate | Baseline (60baeda) | This branch |
|---|---|---|
| `cargo test --no-fail-fast`, all crates (`scripts/test-engine.sh` stops at the first failing binary, so the counts need `--no-fail-fast`) | 360 passed, 0 failed, 1 ignored | **377 passed, 0 failed, 1 ignored** (+17: 2 authority, 6 hook partition, 9 `risk_split_db`) |
| known flake `reconcile_soak_gate_db::pairs_stored_without_a_broker_since_the_soak_start_get_it_filled_in` | fails in some full runs, passes alone | same, unrelated to this branch (seen in the fail-fast run, passes alone) |
| parity `scripts/parity/run-db.sh` | 27 / 27 | **27 / 27 MATCH**, 0 FAIL |
| `scripts/load/shadow-gate.sh` | green | **GREEN**, 0 unexplained |
| `scripts/load/run.sh` seeds 1-3, 100 accounts, 2 walkers (Stage 4, engine alone) | 0 differences | **0 differences**, 3 / 3 |
| split matrix (section 8) | n/a | 18 / 18 + 3 / 3 drills PASS |
| post-close gate (`lib/post-close.test.ts` on the harness DB) | 27 tests | **29 passed** (the margin-call event and end-of-episode delivery) |
| web `vitest run` with `REDIS_URL=redis://localhost:6379` | 127 files passed + 1 skipped, 1910 tests | **131 files passed + 1 skipped, 1935 tests passed** (+4 files: risk-owner, risk-split, risk-split-stale, risk-split-flip) |
| `npx tsc --noEmit` | clean | clean |
| `npm run build` | n/a | passes |
| mutation check (`scripts/stage6/mutation-check.sh`) | n/a | **9 / 9 detected** |

The 9 mutations, each caught by a named test (the script prints which): M1 a web path that does not skip engine-owned accounts; M2 the web's in-transaction check removed; M3 both
(the web acts on engine-owned accounts: detected as a double action by the trace); M4 the engine acts on a WEB-owned account; M5 the engine's in-transaction check removed; M6 the
demo-only scope ignored (engine rule); M7 the same (web rule); M8 the live fire still PINNED; M9 the announced reload not evaluating at once.
`bash scripts/stage6/verify-all.sh` runs the whole record in one go.

Commits on `engine/stage6` (pushed to `newrepo` after each): `ad778c9` web skip and handoff, `da941fd` engine risk mode and fire channel, `2ecc12b` split harness and drill,
`9634b5d` margin-call parity, then the fill-event evaluation, the verification scripts, the test hygiene and this document.

## 14. The engine-down watchdog (HARD GATE before `riskAuthorityDemoOnly = false`)

**The problem.** With a broker on RUST and the engine unable to act, nobody acts on its accounts: the web skips them, the engine does nothing. The first draft proposed an alert only, because an automatic flip to the web while the engine might still be alive and acting is the double-action case. The owner's answer (b) asks for the automatic fallback; the in-transaction check below is what makes it safe.

**The design.**

| Piece | Choice |
|---|---|
| the heartbeat | one row, `"RiskEngineHeartbeat"` name `risk` (migration `20261007100000_risk_engine_heartbeat`): `beatAt` (timestamptz), `staleAfterSecs`, `engineVersion`, `instance`. Seeded born-stale (epoch): until an engine has beaten, nobody counts it as alive |
| who writes | the engine only: `authority::beat` is one upsert, `beatAt = clock_timestamp()` (the DATABASE clock: one clock for both sides, no skew between the VPS and Vercel) |
| **N** | `staleAfterSecs`, **default 30 s**, one value in the row, read by both sides (change it with one `UPDATE`, no deploy; minimum 5 by a CHECK). Beat interval 3 s (`VYX_RISK_HEARTBEAT_SECS`): ten beats fit in the window, and the engine warns at startup if N is under three beats. 30 s is above any normal pass (5 s), a slow Neon round trip (about 10 s at worst) and the web's own 15 s price freshness, and short enough that a hung engine is out of the way before a stop-out ramp finishes |
| the rule | `effectiveRiskOwner(broker, mode, engineAlive)` (web, `lib/risk-authority.ts`) and `effective_owner` (engine): when the heartbeat is stale or missing the owner is WEB for every account, whatever `riskAuthority` says. The three forms of the split rule (TypeScript, Rust, SQL) are unchanged; the liveness is one more input, SQL form `ENGINE_ALIVE_SQL` |
| where it applies | the web prefilter (`loadRiskOwners`, so every batch path), the web's acting transactions (`assertRiskActorInTx`); the engine's prefilter (`owner_of_account`), its pass listing (`rust_owned_account_ids_with_open_positions`), and its acting transactions (`lock_owner_in_tx`: every close and margin-call edge) |
| the handoff | the acting transaction locks the heartbeat row `FOR SHARE` (after the account and broker rows, so no new lock cycle) and judges it with `clock_timestamp()`, never `now()` (a transaction's `now()` is its START: a long-running transaction would judge a stale heartbeat fresh). A beat is an UPDATE of that row, so it **waits for every acting transaction that has already read it**: a stale reading cannot turn fresh under an action decided on it |
| the engine returns | it **beats first**: the fire worker and the pass call `touch` (a rate-limited beat) before they evaluate, the timer beats while the idle gate is open, and the first beat is written at startup before anything can act. What it acts on afterwards is read fresh (every evaluation re-reads the book) |
| the drill switch | `VYX_RISK_HEARTBEAT_PAUSE_FILE`: while that file exists the engine writes no heartbeat (timer and touch both go through `beat`), everything else keeps running. Unset = no such switch. It can only move ownership toward the WEB. Runbook 7.B uses it |

**No double action, argued.** An action is a transaction that locks the account row (`FOR NO KEY UPDATE`), so for one account the two sides' actions are totally ordered by the database. Each checks, after taking that lock, who owns the account at that instant: the engine acts only if it reads a fresh heartbeat, the web only if it reads a stale one (or the broker is WEB). The heartbeat row's share lock keeps a beat from landing between a reading and its action. The one boundary instant (the age crosses N while an engine transaction is open) is serialized by the account lock: the second transaction reads the state the first left, and the position's status-and-volume guard (unchanged, underneath) means no position can be closed twice by anyone. What can differ across the boundary is WHICH side takes the next, different action on the account, never the same action twice.

**Where the web's own triggers are when the engine is down: findings, stated plainly.**

1. The engine hosts the market-data ingest. If the whole engine process is dead, no fresh price reaches anybody (the web's decisions need a price at most 15 s old too), so there is nothing to close until the engine returns, and it beats before it acts. The watchdog's real work is the case where the process lives and its RISK subsystem does not: the beat fails (database error, lost privilege), a task is wedged, the pool is exhausted, or an operator pauses it.
2. The web's triggers in that case: the engine's own backstop calls the web's full margin-monitor pass every 5 s (alive as long as the process is), and the Vercel cron every 5 minutes. With the backstop alive the fallback is N + 5 s at worst (measured by the drill in the harness; runbook 7.B proves it on the live system). With the whole process dead the floor is the cron every 5 minutes, and prices are dead anyway. Open decision 7.
3. **Idle gate and Neon.** The timer beats only while the idle gate is open (a fresh quote on a symbol the book holds): a beat every 3 s all weekend would keep the live Neon compute awake (the 2026-09-26 quota outage). So at a quiet time the heartbeat goes stale on purpose, the web "owns" the RUST accounts, and nothing happens because nothing can move. The first fire or pass after the quiet `touch`es before it acts; a fire right after a reopen is never refused as stale. The web may evaluate a RUST account for the first moments after a reopen, which is harmless (both decide the same, and the in-transaction check keeps them in order). Open decision 6 if you prefer always-on.
4. Risk mode only. The shadow and the legacy mode (`=1`) never write a heartbeat.

**Proof.**

| Claim | Test |
|---|---|
| a stale or missing heartbeat hands every account to the web in every engine form (prefilter, pass listing, in-transaction read, close, margin-call edge, whole evaluation, fire); a beat hands them back | `risk_split_db::a_stale_heartbeat_hands_every_account_to_the_web_in_every_form_and_a_beat_hands_them_back` |
| a beat waits for a transaction that has read the heartbeat (engine side) | `risk_split_db::a_beat_waits_for_a_transaction_that_has_read_the_heartbeat` |
| **engine stalls, the web stops the account out exactly once, the engine returns, nothing is duplicated** (engine half) | `risk_split_db::an_engine_stall_the_web_stops_out_once_and_the_returning_engine_duplicates_nothing` |
| the same, web half: the web leaves a fresh engine's account alone, stops a stale engine's account out (every position once), skips it again after the return, leaves no engine follow-up row | `lib/risk-watchdog.test.ts` |
| web prefilter and in-transaction check follow the heartbeat (stale, missing, the row's threshold); a beat waits for a web transaction | `lib/risk-watchdog.test.ts` |
| the pause file stops the beats and removing it resumes them | `risk_split_db::the_pause_file_stops_the_heartbeat_and_removing_it_resumes_it` |
| **the real web and the real engine walking one database: the engine stalls mid-run, the web takes over, the engine returns while the web is still working** | `scripts/load/run-split.sh --variant rust-all --stall`, seeds 1 to 3 (section 13): every engine close started before the stall or after the return, every web action came after the stall (none later than 3 s after the return), no position closed twice, the end state equals the web-only reference |
| mutations that break the watchdog are caught (M10 to M16, section 13) | `scripts/stage6/mutation-check.sh` |

**Gate list entry.** The watchdog is a HARD GATE for `riskAuthorityDemoOnly = false` (section 10 and runbook section 9). The demo phase may be watched by hand.

### 14.1 Owner decision (a): the heartbeat beats only while trading is active; what an idle gap does (2026-10-07)

**Decision.** Unchanged behaviour: the timer beats only while the idle gate is open; a quiet market lets the heartbeat go stale on purpose and Neon sleep. This section proves that the idle gap, and the first tick after it, can never act twice or miss an action.

**The idle gap itself.** While idle (no fresh tick on anything the book holds) nothing can be decided by either side: every SL / TP, stop-out and pending trigger needs a price at most 15 s old. The heartbeat is stale, so the web counts as owner of the RUST accounts, and nothing happens because nothing can move. Test: `an_idle_gap_with_nothing_to_do_acts_on_nothing_on_either_side_and_ownership_returns_with_the_first_beat` (three stale/beat cycles over a healthy account: no close, no outbox row, no margin-call edge).

**The first tick after the idle gap.**

| Claim | How it holds | Test |
|---|---|---|
| the first FIRE restores RUST ownership BEFORE it evaluates, within the same batch | `spawn_live_trigger` calls `authority::touch` before it builds the batch; the evaluation then reads a fresh heartbeat | `the_first_fire_after_an_idle_gap_beats_before_it_evaluates_and_acts_as_the_owner`: heartbeat two days old, a gapped stop-out, every close is the engine's, `beatAt` is not later than the first close, every action traced RUST, one `TRADE_PNL` per position |
| the first PASS does the same | `spawn_risk_passes` touches before `run_pass_guarded` lists the engine's accounts, so the stale heartbeat never hides them | `the_first_pass_after_an_idle_gap_beats_before_it_lists_and_acts_as_the_owner` |
| a web pass at that very moment cannot double-act | the in-transaction check: the web reads the heartbeat `FOR SHARE` inside its acting transaction, after locking the account; the engine's beat (an UPDATE of that row) waits for it; the account lock totally orders the two sides' actions; a position's status-and-volume guard stands underneath | `weekend_gap_the_engine_fire_and_a_web_pass_race_and_exactly_one_side_acts_once`: heartbeat two days old, three positions gapped through a stop-out plus an account in the margin-call band, the web's closes and the engine's fire started at 8 different relative offsets (0 to 80 ms): over the 8 rounds the web closed first in 7 and the engine in 1; in every round exactly one `TRADE_PNL` per position, never two actions on one position, the account fully closed, and exactly one margin-call outbox row |
| the web's own real code does it too | the real web evaluation, stale heartbeat, RUST broker | `lib/risk-watchdog.test.ts`, `lib/risk-fallback.test.ts` (stale: the web stops the account out exactly once, a second pass finds nothing), and `run-split.sh --stall` |

**Weekend gap, said plainly.** Positions held over the weekend, heartbeat stale since Friday, first Sunday tick gaps through stop-outs. Whichever side's transaction takes the account lock first reads the heartbeat in that transaction: the engine's `touch` has committed a fresh beat only if it ran first. Either way there is exactly one actor per position, and what the first actor leaves is what the second reads (the engine re-reads the book for every evaluation, the web's `closePositionInTx` guards on status and volume). The weekend race test above is that scenario.

**Is there a flapping hazard? No harmful one found.** Looked for: (1) a beat that fails or is rate-limited while the DB row is stale: `touch` skips only when THIS process committed a beat in the last second, and only this process writes the row (the tests wait that second out; the drill file bypasses beats entirely and can only move ownership toward the WEB); (2) the idle gate closing for a few seconds in an active market: the heartbeat window is 30 s and the gate needs no fresh tick for 15 s, so a gate gap shorter than 15 s never even approaches the window, and a longer one is a market in which nothing can be decided; (3) a fire arriving at a RUST broker's account while the heartbeat is stale: it is routed to the engine, which touches first; (4) the web's cron firing in the first milliseconds after a reopen: harmless, proven by the race test (the web may act, once, on what the engine would have decided identically). The only cost of the design is the one stated in section 14 (finding 3): the web may evaluate a RUST account in the first moments after a reopen. No code change was needed. If the owner prefers a heartbeat that never goes stale, that is open decision 6 (it keeps Neon awake all weekend).

Mutation checks: M17 (the fire worker does not beat first) and M18 (the pass does not beat first) are both DETECTED by the two first-tick tests.

### 14.2 Owner decision (b): the web fallback every minute while any broker is RUST (2026-10-07)

**Built.** A second Vercel cron, `/api/internal/risk-fallback`, schedule `* * * * *` (`vercel.json`). The 5-minute `margin-monitor` cron is unchanged and is the only schedule for WEB-only operation (its body moved to `lib/margin-pass.ts`, one function used by both routes; behaviour identical).

The fallback is a no-op unless all three hold, checked in this order so Neon is not woken for nothing:

1. **Trading is active**: the engine's own book gate over HTTP (`marginPassGate`, no database). "Closed" returns immediately, no database read. An unreadable engine counts as active (that is when the fallback matters most).
2. **At least one broker is RUST**: `lib/risk-fallback.ts anyBrokerRust`, an indexed `SELECT 1 FROM "Broker" WHERE "riskAuthority" = 'RUST' LIMIT 1`, cached per server instance (120 s while the answer is "none", 30 s while it is "some"). A flip to RUST is therefore noticed within 2 minutes at worst, and the engine is the primary owner anyway: the fallback only has work when the engine is already failing.
3. **The engine's heartbeat is stale** (one row, database clock). Fresh = the engine acts; the web's other triggers (the engine's 5 s backstop, the 5-minute cron) cover the accounts the web owns. Stale = the web runs the full pass (`runFullMarginPass`; the owner prefilter inside it makes every RUST account WEB-owned for that pass).

**Neon trade-off, stated.** A quiet market (weekend, feed down while the engine answers) costs no database read: step 1 returns. While trading is active and NO broker is RUST the cost is one indexed read per warm instance per 2 minutes (the database is awake in that period anyway: the engine's shadow reads it every pass, the hook calls and the 5-minute cron too). While a broker is RUST and the market is active the engine's own beats keep Neon awake, and the fallback adds one single-row read per minute. The fallback cannot hold Neon open by itself. Residual cost to accept: a serverless invocation every minute (Vercel cost, not Neon); the 5-minute cron stays as the floor if the owner wants to cut it.

**Vercel cron frequency.** `vercel.json` already carries `*/5 * * * *`, and Vercel's Hobby plan only deploys crons that run once a day, so this project is on a plan that allows sub-daily crons (Pro: down to every minute, 40 cron jobs per project). `* * * * *` is the Pro minimum. The repo cannot show the plan itself: confirm in the Vercel dashboard (Settings, Cron Jobs) after the deploy (runbook 3.3). `maxDuration` is 15 s.

**Where the fallback is slower than the engine's backstop.** With a live engine process the engine's own backstop calls the web's pass every 5 s; the 1-minute cron is the floor under it when the process is dead (and then prices are dead too). Worst case from heartbeat stale to a web action, process dead: N (30 s) plus up to a minute of cron phase.

Tests: `lib/risk-fallback.test.ts` (8): the secret; idle market = zero database reads; no RUST broker = no pass and a cached answer (the second call reads nothing); the cache expiry both ways; fresh heartbeat = no pass; stale heartbeat = the web stops the account out exactly once and a second call does nothing more; an unreadable engine still runs the fallback; the ops alert end to end. Mutations M19 (pass despite a fresh heartbeat), M20 (idle gate ignored), M21 (no cache) are DETECTED.

### 14.3 Owner decision (c): the stale-heartbeat alert, super-admin only (2026-10-07)

**Channel.** The existing ops mechanism: `OPS_ALERT_EMAIL` through `sendPlatformEmail`, the one the Caddy health check already uses (`lib/infra-health.ts`). It is NOT the broker notification path (`prisma.notification`, used by the price-source alert): brokers never see infrastructure, and a test asserts the alert code writes no `Notification` row and never calls the notification helpers. State is in Redis (shared by every serverless instance), the transitions are single atomic commands (`lib/risk-engine-alert.ts`).

**Rule.** Evaluated once a minute by the fallback route, only when at least one broker is RUST AND trading is active (the idle gate is open or unreadable; a stale heartbeat over a weekend raises nothing).

| Event | Condition | Sent |
|---|---|---|
| alert | stale (older than the row's own `staleAfterSecs`, N = 30 s) on 2 consecutive checks, and not inside the 10-minute cooldown after a recovery | ONE mail "Risk engine heartbeat is STALE: the web has taken over"; the incident is "open", nothing more is sent however long it lasts |
| recovery | while open, fresh on checks spanning 60 s | ONE mail "Risk engine heartbeat is back"; the incident closes and the cooldown starts |
| flapping | a stale check between fresh ones restarts the recovery clock; a new outage inside the cooldown waits and alerts when it persists | no spam, no lost persistent outage |
| idle market | `active` false | nothing counts, nothing opens or closes (an open incident stays open) |
| no broker RUST | flipped back to WEB | counters cleared, an open incident cleared silently |
| mail fails | | the state is left as before, the next check retries |

Tests: `lib/risk-engine-alert.test.ts` (9) plus the end-to-end case in `lib/risk-fallback.test.ts`; mutations M22 (no debounce), M23 (idle counted), M24 (recovery without the fresh minute), M25 (one mail per stale check) are DETECTED. The drill (runbook 7.B steps 7 and 8) proves it on the live system.

## 15. Could the shadow run alongside risk mode for WEB-owned accounts? (answer (a): how, and what it would cost; not built)

**Yes, in principle.** Today the modes are exclusive: `ENGINE_ORDER_MANAGEMENT=risk` takes one branch of `server/src/main.rs` and `shadow` another, and the shadow refuses to start when the post-close variables are set (a guard so a shadow can never deliver).

**How it would work.**

1. Run both in one process: the shadow on its OWN read-only pool (`VYX_SHADOW_DATABASE_URL`, role `vyx_shadow_ro`, the same as today), risk mode on the write pool. Two pools, one tick cache, one idle gate.
2. Relax the refusal guard: it keys on the mere presence of the post-close variables; it should key on "this pool can write".
3. The shadow evaluates only the accounts the web still acts on: add `NOT RUST_OWNED` (the SQL form of the rule, with liveness) to the shadow's pass listing and to its per-tick snapshot routing. For a RUST-owned account there is no web close to pair with, so a shadow decision about it would be unpairable noise.
4. The reconciler pairs only web closes, as now. Nothing about pairing changes.

**What it would cost.**

* *Neon load.* The shadow's measured cost after the 2026-10-05 deploy is 4 statements per pass (1.04 calls/s at a 4 s pass, idle-gated), read-only, plus the per-tick snapshot reads. Next to risk mode's own pass (a similar 4 to 5 statements per 5 s, plus the reads of each fire) that roughly doubles the engine's steady-state reads while WEB-owned accounts hold positions. No extra writes. With Futurix's LIVE accounts WEB-owned (demo-only) it runs only while they hold positions on a moving symbol (the idle gate); a flat or closed book costs nothing, as today.
* *Code.* Estimated 1 to 2 days: the wiring in `main.rs` (two pools, two gates), the listing filter, the relaxed guard, tests (the shadow never touches an engine-owned account; it never writes the book; the reconciler pairs only web closes; the two run together without disturbing each other) and two mutation checks.
* *Value.* It keeps the soak evidence coming for the WEB-owned accounts (Futurix LIVE during the demo-only phase, every other broker) and gives regression evidence for any later engine change. For the demo phase the bot sweep is enough (the owner's answer); it becomes worth building at the first engine change after the flip, or when WEB-owned LIVE volume is large.

## 16. The startup flip marker (answer (e))

`ENGINE_ORDER_MANAGEMENT` stays `shadow` until the flip. A live mode (`risk`, or the legacy `1` / `true` / `on` / `yes`) without an explicit marker is most likely a mistake (a stray variable, a copied service file), so the server logs at startup:

> `WARNING: ENGINE_ORDER_MANAGEMENT=risk is a LIVE mode (the engine writes to the book) but VYX_RISK_FLIP_INTENT is not set. Until the flip the engine stays in shadow. If this flip is intended, set VYX_RISK_FLIP_INTENT=<broker subdomain>:<YYYY-MM-DD> (e.g. futurixglobal:2026-10-12); if not, set ENGINE_ORDER_MANAGEMENT=shadow and restart.`

The marker is `VYX_RISK_FLIP_INTENT=<broker subdomain>:<YYYY-MM-DD>` (who is being flipped and on which day). With a valid marker the server logs `flip marker present: a live mode is intended for this process` instead. It authorises nothing (the per-broker flag in the database is the switch); it records that a person meant it. A malformed marker counts as no marker. Built as `authority::flip_marker_warning` (pure, unit-tested for every live mode, every malformed marker and every non-live mode; mutation M16 removes the warning and the test fails) and wired in `server/src/main.rs` before the mode branches. `deploy/engine-stage6.ps1` refuses to run when `start-engine.cmd` already carries a marker or is not in shadow, and restores the old exe when the new build prints the warning.

### 13.1 Watchdog verification record (2026-10-06, scratch databases only)

| Gate | Result |
|---|---|
| `scripts/stage6/verify-all.sh`: cargo test all crates, parity run-db, shadow-gate, load seeds 1-3, split matrix (now incl. the `--stall` drill, seeds 1-3), post-close gate | **PASS** (6 of 8 gates finished at the time of writing) |
| full web vitest, `tsc --noEmit`, mutation check M1-M16 | still running when this was written; M10-M16 were run on their own earlier and all DETECTED (see section 14); the web watchdog tests, the 4 split suites and `tsc` passed individually |
| `npm run build` | not yet run on the final commit |
| local 7-path sweep (`scripts/stage6/sweep-7path.sh`) | rust-all seeds 1-3: all 7 paths taken by the engine, 0 web actions, PASS; mixed, WEB-fallback drill, stall drill: end state equals reference, every path covered by either side (the first full run failed only on an over-strict per-path rule in the drill run, fixed with `--either`; rerun on the final commit pending) |

## 17. The merge of `newrepo/main` into `engine/stage6` (2026-10-07)

`newrepo/main` was 23 commits ahead (steps 1 to 3, the credit / trading-rights migration `20261006120000`, group minimum volume, the backoffice and terminal 1.0.63 feeds). One conflict, in `docs/RUST-CUTOVER-PLAN.md` (both sides edited the group-volume gate paragraph: both kept). Everything else merged cleanly.

**Migration order.** Main's `20261006090000_book_pnl_group_min_volume` and `20261006120000_credit_and_trading_rights` sort before this branch's `20261007090000_broker_risk_authority` and `20261007100000_risk_engine_heartbeat`; all are idempotent. Proven on a scratch database restored to the pre-merge state (13.2): `migrate deploy` applied the three pending ones in exactly that order.

**Trading rights, status and group minimum volume against the RUST / WEB split.**

* They are gates on the OPEN paths only (client order, requote accept, pending trigger, dealer accept, desk flush, admin open, copy-rule open, reverse). They run inside the shared open functions, after the ownership claim where there is one (the pending-trigger claim `assertRiskActorInTx`), so they are owner-agnostic: the same refusal whether the broker is WEB or RUST, and the engine places and fills no order in risk mode (the resting-order fill stays the web's routine, so the engine needs no copy of these gates).
* **Risk closes are never blocked by them.** `lib/risk.ts` says so (staff closes and the automatic actions never call `checkAccountTradingRights`); proven by `lib/risk-closes-ignore-rights.test.ts` (a stop-out closes a READ_ONLY + SUSPENDED or CLOSE_ONLY + ACTIVE account of a WEB broker and, with a dead engine, a READ_ONLY + CLOSED or SUSPENDED account of a RUST broker, below the group minimum volume; the open gates still refuse the same accounts; a source guard that `lib/risk-monitor.ts` and `lib/position-close.ts` never call them) and its engine twin `risk_closes_ignore_trading_rights_status_and_the_group_minimum_volume` (engine stop-out of READ_ONLY / SUSPENDED / CLOSED accounts, group minimum 5 lots, position of 1 lot).
* `Position.groupCategoryAtOpen` (trigger-stamped): the engine's risk path inserts no position, so the cutover gate "engine opens carry the group category" stays as logged in `docs/RUST-CUTOVER-PLAN.md` 6.1 (NOT BUILT, only relevant once the engine opens positions).
