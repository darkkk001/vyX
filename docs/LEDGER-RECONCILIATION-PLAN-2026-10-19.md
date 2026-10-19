# Ledger reconciliation plan: ***680 and ***704 (2026-10-19)

Status: **prepared, not run.** Both are TEST accounts (owner, 2026-10-19). ***680 is internal since 2026-10-06; the
owner marks ***704 internal. The ledger chain (`C:\vyx-secrets\ledger-chain-680-704.txt`) explains the whole
difference on both: the sum of the balance gaps equals balance - ledger exactly (12,337.628 and 360.25), no row's own
after differs from before + amount, the last row's after equals the balance, no row is other than COMPLETED.
***704's gaps are concurrent staff and dealer closes, 2026-09-11 to 09-23. The run is section 0 of
`DEAL-MODEL-GO-LIVE-RUNBOOK.md`.

## 1. Findings (live, read-only, deal backfill dry run 2026-10-19)

| Account | Balance | Ledger | Balance - ledger |
|---|---|---|---|
| ***680 | 201,717.5657 | 189,379.9377 | +12,337.6280 |
| ***704 | 20,156.2211 | 19,795.9711 | +360.2500 |

Ledger = opening balance + every completed balance-moving row (the section 0 check of POSITION-DEAL-MODEL.md).

***680: on 2026-08-27 16:14:20-35 UTC positions 100000125 and 100000127 (5 lots each) were bulk-closed in 11 pieces
each, at the same time. About ten pairs of closes read the same balance and the later write overwrote the earlier
one: the ledger rows are right (each has its fill, matched by an STM_BULK_CLOSE audit row), the balance missed them.
The race was fixed by the account row lock in the 2026-10-08 order hotfix. Five of the eight duplicate bookings
(kind B: 100000045, 070, 073, 134, 139, -38.434 in all) are the same race. Together these explain 12,182.71 of the
12,337.63; the remaining 154.92 equals 100000127's final close and is to be confirmed with
`C:\vyx-secrets\ledger-chain-680-704.sql` (read-only, the owner runs it).

***704: not analysed yet; the same query covers it.

Signs that both may be test accounts: ***680 has an ADJUSTMENT "Adjustment test" of +200,000 and two "test
withdrawal" rows. The owner decides.

## 2. Correction (per account, only after the owner's go)

Script: `C:\vyx-secrets\reconcile-680-704.sql` (kept out of the repo: it names live tickets). Without `-v commit=1`
it ends with ROLLBACK (a rehearsal); with it, COMMIT.

- `Account.balance := ledger`, under the account's row lock, in one transaction.
- One AuditLog row per account: action `LEDGER_RECONCILIATION`, entity the Account, old and new balance, the
  difference and the reason.
- **No Transaction row.** The debits the balance missed are already ledger rows. An ADJUSTMENT row of
  (ledger - balance) would move the ledger by the same amount as the balance and leave the difference where it is,
  so the check would still fail. The statement's running balance already shows the ledger figure; after the
  correction the account header shows it too.
- Guards (any one fails = nothing changes): the balance and the ledger equal the reviewed values exactly; no open
  position on the account; the new balance is not negative.
- Afterwards: re-run the deal backfill dry run (per-account check: 0 differing). The engine reads Account.balance from
  the database (closes lock the row), so nothing restarts. The trader's terminal shows the new balance on its next
  account poll.
- `lib/audit-labels.ts` has `LEDGER_RECONCILIATION: "Reconciled balance to the ledger"` (live with the step 1-3
  web deploy; until then the audit screen shows the raw action).

Tested on scratch with a synthetic account and a lost update: ROLLBACK leaves the balance and the audit table
unchanged; a wrong reviewed balance refuses; COMMIT sets the balance to the ledger and writes one audit row.

If they are test accounts the correction is optional (it only makes the account consistent); if real, it is a
client-facing balance reduction (***680 -12,337.63, ***704 -360.25) and needs the broker told first.

## 3. Proposal: test accounts out of Book P/L

Nothing new to build: `Account.isInternal` ("a broker's own test / staff account", owner 2026-10-05) already leaves
an account out of every broker-wide figure: Book P/L (`lib/book-pnl.ts` heldSql), dashboard, total exposure limit,
risk radar, reports. A BROKER_ADMIN sets it in the backoffice (PATCH /api/manage/accounts/[id] `{ isInternal }`,
audited).

1. If ***680 / ***704 are test accounts: Futurix's BROKER_ADMIN marks them internal. Book P/L is computed on the
   fly, so their history leaves every figure at once, past periods included.
2. Done: the deal backfill dry run prints Book P/L per broker and currency with `lib/book-pnl.ts`'s filter (live,
   not internal, not coverage, not a demo sandbox, B-book), broker view; a test checks its "before" against
   `bookPnlRealized`.
