# Stage 6: the engine becomes authoritative for risk, per account, with a warm WEB fallback

_Written 2026-10-06 on branch `engine/stage6` (worktree `D:\vyx-stage6`). Everything below is built and tested on this branch only:
NOT merged to main, NOT deployed (VPS or Vercel), the migration NOT applied to any production or Neon database (scratch Postgres
`127.0.0.1:5499` only). The owner reviews this document and the diffs first._

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

Results (2026-10-06, 100 clients + topologies, K = 2 walkers, seeds 1-3): __MATRIX_RESULT__

### 8.3 The WEB-fallback drill under load

`run-split.sh --variant rust-all --drill`: broker flags RUST (all accounts engine-owned), the engine running; after its first 10 stop-out closes ONE statement
flips every RUST broker to WEB (the runbook's SQL, timestamp taken from the database clock by the statement itself). The web, polling all along, takes
over the rest. Checked on top of (a)-(c): every engine close started before the flip, every web action came after it, BOTH sides worked, and the end state
still equals the web reference. Result: __DRILL_RESULT__

## 9. Runbook: the flip sequence, the fallback, and how to confirm

Everything is `psql` against the live database as the owner. Replace `<S>` with the broker's subdomain. NOTHING here has been run on production.

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
| the margin-call event and the end-of-episode notice and event | built here (commit `__MC_COMMIT__`) | a RUST-owned trader would silently lose real-time margin-call UI that WEB-owned traders have |
| `POST_CLOSE_SECRET` on Vercel and `VYX_POST_CLOSE_URL` / `VYX_POST_CLOSE_SECRET` on the VPS | deploy step | without them an engine close is not delivered (mirror, coverage, notices); risk mode refuses to start without them |
| fill-event evaluation (a position opened < 1 s before a gap is stopped out on the gap tick) | already deployed (`068a7dc`, 2026-10-05) | the engine's trigger book must contain a new position at once |
| torn-read-safe snapshot, flap damping of margin-call edges, tick price source, FX age limit, idle gate | already deployed | the engine's decisions must equal the web's |
| soak: 7 clean days, 2 weekend reopens (the 2nd is Sun 2026-10-11 21:00-22:00 UTC), 1 NFP, then the final 7-scenario sweep on the exact cutover build | the owner's gate, unchanged | evidence |

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

1. **Migration** `20261007090000_broker_risk_authority` (additive, idempotent, every broker defaults to WEB and demo-only: it changes nothing by itself), with
   `prisma migrate deploy` and BOTH `DATABASE_URL` and `DIRECT_URL` set to the live database (never `migrate dev`). Then the one-line grants of `deploy/neon-shadow-readonly.sql` for the
   shadow role if the shadow keeps running elsewhere.
2. **Web** (Vercel, main): the web with the skip and the in-transaction check. Before the migration it answers WEB for every account (a missing column is handled), so the order
   migration then web is safe, and web then migration is safe too. Set `POST_CLOSE_SECRET` (the same value the VPS will use). Verify: `/api/internal/pending-trigger` answers 401 without the bearer, a
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

1. **Shadow beside risk mode.** Risk mode replaces the shadow in the process. To keep soaking the WEB-owned (LIVE) accounts after the first flip, the shadow would have to run next to
   risk mode and evaluate only WEB-owned accounts (it refuses today when the post-close variables are set, a guard that exists so a shadow can never deliver). Not built; say if you want it before step 1.
2. **Engine liveness watchdog.** With a broker on RUST and the engine down, nobody acts on its accounts until the owner flips to WEB (an automatic flip by the web would be unsafe while the
   engine might still be alive and acting, which is the double-action case). Proposed instead: an alert (not an action) when RUST accounts hold open positions and the engine
   has not heartbeat for N seconds. Not built.
3. **Resting-order fills for engine-owned accounts stay web code** (the engine decides WHEN, the web's routine decides WHETHER), because the fill is an order action with every order gate. Porting
   the fill to Rust is the ORDERS stage; say if you want it earlier.
4. **Cascades across sides** are not in the web's id order (section 5). If a broker ever configures a mirror or coverage chain whose accounts sit on different sides, the result can differ from the web-only
   result in the order-dependent cases (never in the exactly-once invariants). The product answer is to keep a chain on one side (same broker authority AND the same account mode).
5. The legacy `ENGINE_ORDER_MANAGEMENT=1` mode now also enforces ownership (it would otherwise act on every account it is handed). It acts on nothing until a broker is RUST.
