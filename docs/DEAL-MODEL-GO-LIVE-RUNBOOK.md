# Deal model steps 1-3: go-live runbook

_Status: prepared 2026-10-19, nothing run. Every step needs the owner's go; every step ends with a verification; a
failed verification = STOP and use that step's rollback (section 9). PowerShell on the owner PC unless it says VPS._

Branches (a chain, each off the previous): `feat/deal-model-step1` (Migration A, web dual write) ->
`feat/deal-model-step2` (engine dual write, outbox dealId, reconcile from `Deal.reason`, parity, split harness) ->
`feat/deal-model-step3` (backfill script, Migration B `DealBackfillLog`, audit label, this runbook).
Separate and test-only: `fix/staff-2fa-tests`.

| # | Step | Who / where | Changes live? |
|---|---|---|---|
| 0 | ***680 / ***704: mark internal, reconcile balance to ledger | backoffice + owner PC | 2 test accounts only |
| 1 | Local merge + full verification (no push) | owner PC | no |
| 2 | Migrations A + B on live | owner PC | additive schema |
| 3 | Push main = Vercel production (web dual write) | owner PC | yes |
| 4 | Column grants for the read-only shadow role | owner PC | privileges |
| 5 | Engine deploy (risk mode, dual write) | VPS | yes |
| 6 | Gate: every new close writes its deal | owner PC | no |
| 7 | Backfill: dry run, compare, `--apply`, verify | owner PC | Deal rows, `initialVolume`, `reversedFromPositionId` |
| 8 | Step 7 correction (`realizedPnl` / `closePrice` from deals) | later | NOT in this release |
| 9 | Rollback table | | |

Window: a market-closed weekend for 5 (the engine restarts in risk mode) and 7 (no closes while batches run).
Steps 2-4 can run any time; 3 must follow 2 (the schema guard answers 503 while the database is behind the build).

Load the live URLs as in `STAGE6-RUNBOOK-FUTURIX-DEMO.md` 1.2 (host must be `ep-morning-glade`), then:

```powershell
$Live = $env:DIRECT_URL
$Psql = "C:\pg-scratch\pgsql\bin\psql.exe"     # options before -d (Windows psql ignores them after the URL)
```

## 0. The two test accounts (independent of the release; before 7 so its ledger check reads 0)

1. ***680 is internal since 2026-10-06 (audit `ACCOUNT_INTERNAL_FLAG_CHANGED`). Mark ***704 internal in the
   backoffice (BROKER_ADMIN, account card). Both then leave Book P/L, dashboard, exposure, risk radar and reports.
2. Reconcile (reviewed 2026-10-19: the balance gaps equal the whole difference on both accounts):

```powershell
& $Psql -X -v ON_ERROR_STOP=1 -f C:\vyx-secrets\reconcile-680-704.sql -d $Live              # rehearsal: ends ROLLED BACK
& $Psql -X -v ON_ERROR_STOP=1 -v commit=1 -f C:\vyx-secrets\reconcile-680-704.sql -d $Live  # apply: ends COMMITTED
```

**Verify:** the rehearsal prints `***680 | 189379.9377` and `***704 | 19795.9711` then `ROLLED BACK`; the apply
prints the same then `COMMITTED`. A `REFUSED`/`ERROR` line (balance or ledger moved, an open position) = nothing
changed: re-run `C:\vyx-secrets\ledger-chain-680-704.sql` and re-review before touching the numbers in the script.
The audit screen shows "Reconciled balance to the ledger" once 3 is live (the raw action name before).

## 1. Local merge and verification (nothing pushed)

In `C:\vyx\web` (clean tree; `newrepo/main` is Vercel production, so nothing is pushed in this step):

```powershell
git status --short                                   # must be empty
git fetch newrepo
git switch main; git merge --ff-only newrepo/main
git merge --no-ff newrepo/fix/staff-2fa-tests -m "Merge fix/staff-2fa-tests: staff-auth-batch4 tests create Required brokers"
git merge --no-ff newrepo/feat/deal-model-step1 -m "Merge deal model step 1: Migration A and web dual write"
git merge --no-ff newrepo/feat/deal-model-step2 -m "Merge deal model step 2: engine dual write, outbox dealId, reconcile from Deal.reason"
git merge --no-ff newrepo/feat/deal-model-step3 -m "Merge deal model step 3: deal backfill, DealBackfillLog, go-live runbook"
"MERGE: $(git rev-parse HEAD)"
```

Then on the scratch Postgres (never live): `migrate deploy` both URLs to `vyx_test`, `npx tsc --noEmit`,
`npm run build`, `npx vitest run` (full suite), `cargo test --workspace` in `engine` with the scratch URLs,
`scripts/parity/run-db.sh` (DB parity, all MATCH), `scripts/load/run-split.sh` (mixed and rust-all, 0 differences,
`tradePnlWithoutDeal` 0), then `cargo clean`.

**Verify:** no merge conflicts (main moved by 3 feed commits only, checked 2026-10-19); everything green; the only
known-failing tests are the weekend market-closed ones (`close-by.test.ts`, `bulk-close.test.ts`) if run on a weekend.
Note `<MERGE>`. If anything fails: `git reset --hard newrepo/main` (nothing was pushed) and report.

## 2. Migrations A + B on live

From `C:\vyx\web` at `<MERGE>` (the two folders are in it), live URLs loaded:

```powershell
npx prisma migrate status      # pending must be EXACTLY: 20261019120000_deal_model_a, 20261019130000_deal_backfill_log
npx prisma migrate deploy
npx prisma migrate status      # "Database schema is up to date!"
@'
SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name >= '20261019' ORDER BY 1;
SELECT count(*) AS deals FROM "Deal";
SELECT last_value, is_called FROM deal_ticket_seq;
SELECT count(*) FILTER (WHERE "initialVolume" IS NOT NULL) AS iv, count(*) FILTER (WHERE "reversedFromPositionId" IS NOT NULL) AS rf FROM "Position";
SELECT count(*) AS log FROM "DealBackfillLog";
'@ | & $Psql -X -q -d $Live
```

**Verify:** both migrations finished; 0 deals, sequence `10000001 | f`, 0 / 0, 0 log rows. The running web and
engine are unaffected (nothing reads or writes the new objects yet; the schema guard accepts a database ahead of
the build). Anything else listed as pending = STOP.

## 3. Web live (push main)

```powershell
git push newrepo main
```

Vercel Ready check as in `STAGE6-RUNBOOK-FUTURIX-DEMO.md` 3.3 (`npx vercel ls`, the newest production deployment
`Ready` and built from `<MERGE>`). Then place and close one 0.01 trade on a test account (***704 or the QA broker):

```powershell
@'
SELECT d.ticket, d.entry, d.reason, d.volume, d.price, d.profit, (d."transactionId" IS NOT NULL) AS linked, d."executedAt"
  FROM "Deal" d ORDER BY d.ticket DESC LIMIT 5;
'@ | & $Psql -X -q -d $Live
```

**Verify:** the IN and OUT of that trade, tickets from 10000001, the OUT linked. Logs: no `Deal` errors
(`npx vercel logs <deployment-url> | Select-String 'Deal|deal_ticket'` empty).

## 4. Grants: the read-only shadow role only

The engine and the web both connect as `neondb_owner` (owner, 2026-10-19), which owns `"Deal"` and
`deal_ticket_seq`: nothing to grant for them (`deploy/engine-deals-2026-10-24.ps1` proves the engine's deal write
before it stops the old engine). The one role that needs a grant is `vyx_shadow_ro` (`deploy/neon-shadow-readonly.sql`,
column grants): the shadow reconciler now joins `"Deal"` and reads `"transactionId"` and `reason`. Risk mode does not
run the shadow, so today nothing reads with that role; the grant is there so a fallback to shadow mode
(`STAGE6-RUNBOOK-FUTURIX-DEMO.md` 8, step 5.2) does not start with `shadow reconciler NOT running`.

```powershell
@'
GRANT SELECT ("transactionId", reason) ON "Deal" TO vyx_shadow_ro;
SELECT has_column_privilege('vyx_shadow_ro', '"Deal"', 'transactionId', 'SELECT') AS ro_txn,
       has_column_privilege('vyx_shadow_ro', '"Deal"', 'reason', 'SELECT') AS ro_reason,
       has_table_privilege('vyx_shadow_ro', '"Deal"', 'INSERT') AS ro_insert;
'@ | & $Psql -X -q -v ON_ERROR_STOP=1 -d $Live
```

**Verify:** `t | t | f` (it may read those two columns, it may not write). Rollback: `REVOKE SELECT ("transactionId",
reason) ON "Deal" FROM vyx_shadow_ro;`. Add the same GRANT line to `deploy/neon-shadow-readonly.sql` in the next
change to that file, so a rebuilt role keeps it.

## 5. Engine deploy (VPS, risk mode)

Script: `deploy/engine-deals-2026-10-24.ps1` (`engine-stage6.ps1` is shadow-only and refuses this engine). On the
VPS, elevated PowerShell, `<MERGE>` = the full sha of section 1:

```powershell
cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <MERGE>
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-deals-2026-10-24.ps1 -Branch main -Commit <MERGE> -OwnerGo "main@<MERGE>"
```

(`-Psql <full path>` if `psql` is not on the VPS PATH.) What it does, in order; any failure before the stop = `REFUSED
... Nothing touched.`, any failure after it = the previous exe put back and started:

1. owner-go gate (as `engine-stage6.ps1`): all three parameters, `-OwnerGo` = `main@<MERGE>`, HEAD = `<MERGE>`, on main;
2. pre-flight, nothing touched: `start-engine.cmd` says `ENGINE_ORDER_MANAGEMENT=risk` with a valid
   `VYX_RISK_FLIP_INTENT`; Migration A applied on the engine's own `DATABASE_URL`; **deal-write smoke check**: a
   rolled-back `INSERT INTO "Deal"` with the engine's column list on the newest position, `RETURNING ticket`; prints
   the engine-owned (RUST) brokers;
3. code markers (deal write, reconcile from `Deal.reason`, Stage 6, 10-05), build in `engine\build-tmp`, backup of the
   exe (and a copy of `start-engine.cmd`, never edited);
4. stop, swap, start, `/health` 200 within 30 s; then a **fresh risk heartbeat written after the restart** (database
   clock) within 30 s;
5. startup log of this start: required `risk mode: the pool is writable`, `risk heartbeat: written`, `post-close outbox
   dispatcher running`, `RISK MODE ACTIVE`, `risk mode: margin fires of engine-owned accounts`, `risk hook margin
   trigger enabled`, `risk trigger loop: decoupled`, `pricing cache loaded`, `pricing cache: reload on change
   subscribed`; refused: `RISK MODE REFUSED`, dispatcher not configured, first beat failed, heartbeat PAUSED, the
   flip-marker WARNING, any shadow / legacy / off mode, risk hook or margin trigger OFF;
6. the deal-write smoke check again; TRADE_PNL rows since the restart without a deal (a WARN, not a restore: a web
   path could be the writer; section 6 decides).

Each smoke check uses up one deal ticket (a sequence is not transactional), so tickets may show a gap of two.
Tested locally: every refusal of the gate; the SQL helpers, taken from the script's own text, on the scratch database
(the smoke insert leaves nothing, fails on a database without `"Deal"`; heartbeat, clock and gap queries).

**Verify:** last line `DEPLOY OK (risk mode ACTIVE, engine closes write their deals)`; every `OK` line printed. Then
the next engine close (or an SL on a test account of a RUST broker) has its OUT deal with reason SL / TP / STOP_OUT and
`transactionId` set, and its post-close outbox row carries `dealId`. Engine log 10 minutes: no `ERROR`.

## 6. Gate: no new close without a deal

```powershell
@'
SELECT count(*) AS without_deal_since_deploy FROM "Transaction" t
 WHERE t.type = 'TRADE_PNL' AND t."createdAt" >= '<time of step 5>' AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."transactionId" = t.id);
SELECT "transactionId", count(*) FROM "Deal" WHERE "transactionId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
'@ | & $Psql -X -q -d $Live
```

**Verify:** `0`, and no duplicate rows. Run it again after a trading session (or 24 h). Not 0 = a close path writes no
deal: STOP, do not backfill, report the rows' notes.

## 7. Backfill

From `C:\vyx\web` at `<MERGE>`, live URLs loaded, ideally with the market closed:

```powershell
npx tsx scripts/backfill-deals.ts --out C:\vyx-secrets\backfill-dry-run-golive.json | Out-File -Encoding utf8 C:\vyx-secrets\backfill-dry-run-golive.txt
```

**Verify against the 2026-10-19 review** (the counts grow only by positions opened since):
`schema: deal tables present; close fields present`; 0 AMBIGUOUS; the same 28 changed rows; the same 8 duplicates;
"derived / unrecognised" 0 (100000606 is now REVERSE); per-account ledger check: differing 0 (after section 0); Book
P/L per broker with ***680 and ***704 left out; "deals to write" now excludes the deals the dual write already wrote.
Any difference you cannot explain = STOP.

```powershell
npx tsx scripts/backfill-deals.ts --apply --confirm-host ep-morning-glade --out C:\vyx-secrets\backfill-apply-golive.json | Out-File -Encoding utf8 C:\vyx-secrets\backfill-apply-golive.txt
```

Interrupted: re-run with `--from <id>` from the last `batch written:` line (or simply re-run: it writes nothing twice).

```powershell
npx tsx scripts/backfill-deals.ts | Out-File -Encoding utf8 C:\vyx-secrets\backfill-after-golive.txt     # a dry run again
@'
SELECT count(*) AS without_deal FROM "Transaction" t WHERE t.type = 'TRADE_PNL' AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."transactionId" = t.id);
SELECT count(*) AS no_in FROM "Position" p WHERE NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."positionId" = p.id AND d.entry = 'IN');
SELECT count(*) AS closed_volume_mismatch FROM "Position" p
 WHERE p.status = 'CLOSED' AND p."initialVolume" <> (SELECT coalesce(sum(volume), 0) FROM "Deal" d WHERE d."positionId" = p.id AND d.entry IN ('OUT', 'OUT_BY'));
SELECT count(*) AS realized_or_close_price_changed FROM "DealBackfillLog";
'@ | & $Psql -X -q -d $Live
```

**Verify:** the apply ends `APPLIED: N deal(s) written.` with N = the dry run's "deals to write"; the dry run after
it plans 0 deals; `without_deal` 0, `no_in` 0, `closed_volume_mismatch` 0 (the 8 duplicates are 0-lot OUTs, so they
do not count), `DealBackfillLog` 0 (the backfill never touches `realizedPnl` / `closePrice`). Position rows,
balances and the ledger are unchanged (proven on scratch: `scripts/backfill-deals.test.ts`).

## 8. Step 7 correction: not in this release

`Position.realizedPnl` / `closePrice` from the deals, old values saved in `DealBackfillLog` first. Per
`POSITION-DEAL-MODEL.md` section 5 it runs after step 4 (the readers switch), with the owner's sign-off on the Book
P/L before / after. **The correction script does not exist yet** (half a day; `restoreFromLog` and its test are in
place). Its rollback will be `restoreFromLog(<runId>)` (puts every logged value back, once).

## 9. Rollback

| Step | Rollback | How | Note |
|---|---|---|---|
| 0 reconcile | balance back | `UPDATE "Account" SET balance = <oldValue of the LEDGER_RECONCILIATION audit row> WHERE id = <entityId> AND balance = <newValue>` + an audit row saying why, as the database owner | test accounts; isInternal is reverted in the backoffice |
| 1 merge | none | `git reset --hard newrepo/main` | nothing pushed |
| 2 migrations | leave them | additive; nothing reads them. Full removal ONLY after web and engine are back on code without deals (else every close fails): `DROP TABLE "DealBackfillLog"; DROP TABLE "Deal"; DROP TYPE "DealEntry"; DROP TYPE "DealReason"; ALTER TABLE "Position" DROP COLUMN "initialVolume", DROP COLUMN "reversedFromPositionId"; DELETE FROM _prisma_migrations WHERE migration_name IN ('20261019120000_deal_model_a', '20261019130000_deal_backfill_log');` (the sequence goes with the table) | a migration half applied: `npx prisma migrate resolve --rolled-back <name>`, then re-run deploy |
| 3 web | the previous Vercel deployment | `npx vercel ls`, then `npx vercel promote <previous Ready deployment url>`; later `git revert -m 1` the merges in reverse order and push | safe: the previous deployment is today's main (Stage 6 aware). Deals already written stay (harmless, re-covered by the backfill) |
| 4 grants | revoke | `REVOKE SELECT ("transactionId", reason) ON "Deal" FROM vyx_shadow_ro;` | read-only role; not used in risk mode |
| 5 engine | the old exe | the script restores it by itself on a failed check; manually: `nssm stop vyxtrader-engine`, copy the backup `trading-core-server.pre.exe` over the release exe, `nssm start vyxtrader-engine` (nssm: `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`) | the old engine writes no deals: its closes become backfill work (re-run 7) |
| 6 gate | | nothing changed | |
| 7 backfill | delete what it wrote | as the database owner, one transaction: `UPDATE "Position" SET "initialVolume" = NULL WHERE id IN (SELECT "positionId" FROM "Deal" WHERE backfilled AND entry = 'IN'); UPDATE "Position" SET "reversedFromPositionId" = NULL WHERE id IN (SELECT "positionId" FROM "Deal" WHERE backfilled AND entry = 'IN' AND reason = 'REVERSE'); DELETE FROM "Deal" WHERE backfilled;` | nothing reads deals before step 4; the dual-write deals (`backfilled = false`) stay |
| 8 step 7 | `restoreFromLog(runId)` | | later |
