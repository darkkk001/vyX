# Position / deal model

Status: **research + proposal, nothing built.** Written 2026-10-12 for owner review. Sources: code on `main`
(web), `master` (native), `engine/stage6` (Rust engine), and two read-only, anonymised queries against the live
database (ep-morning-glade, session `default_transaction_read_only=on`).

Problem in one line: a trade is one mutable `Position` row and every close is one ledger row, so a partial close,
a close-by or a reversal has no record of its own. Volume, price and the link between legs live in note text, and
the position row keeps only the last piece.

---

## 0. Owner decisions (2026-10-12)

1. **Ship the hotfix first** (section 5, step 0). Its scope is wider than first estimated: every close path
   (terminal, WebTrader, dealer-queued, staff, SL / TP / stop-out, close-by) writes the closed lots, close price, P/L
   and pro-rata swap as structured fields instead of note text. `Position` keeps cumulative realised P/L and
   closed volume, and close-by links both legs by id on every path. There are tests for each path.
2. **Swap on a partial close is pro rata by closed volume**: the remainder stays on the position, and the statement's
   parent row shows the total (section 3.2).
3. **The historical correction of the 25 multi-close positions is approved** with conditions:
   - a dry run first, printing per-position old -> new P/L and volume;
   - a per-account check that the ledger sum equals the balance, which stops the run if any account differs;
   - total Book P/L before and after.
   
   The owner runs it on live after reviewing the dry run.

## 1. Current model

### 1.1 Tables

| Table | What it holds for trading | Links |
|---|---|---|
| `Position` | One row per opening fill. `ticket` (= opening order's ticket), `side`, `volume` (**remaining** open volume, reduced in place), `openPrice`, `slPrice`/`tpPrice`, `status` OPEN / CLOSED / VOIDED, `closePrice`, `realizedPnl`, `closedAt`, `swap` and `commission` running totals, `bookType`, `groupCategoryAtOpen`, coverage fields (`covered`, `autoHedged`, `coveragePositionId`), dealer lock `closePendingOrderId` | `originOrderId` (unique) -> Order |
| `Order` | Opening orders, and **queued** closes only (`closesPositionId`, `closeVolume`, dealer-managed accounts). An instant close writes no Order. | `closesPositionId` -> Position |
| `Transaction` | The money ledger. Each close writes one `TRADE_PNL` row; commission is one `COMMISSION` row written at open; credit / negative-balance-protection rows when a loss needs them. No volume, price, ticket or close-kind column. | `referenceType = 'Position'`, `referenceId = Position.id`. `SWAP` is one row per account per day with no position link. |
| `AuditLog` | Staff and automatic actions (MANUAL_POSITION_CLOSE, MANUAL_POSITION_REVERSE, MIRROR_CLOSED, POSITION_COVERAGE_AUTO_CLOSED, CLOSED_TRADE_VOID, DEALING_CLOSE_QUEUED, ...) | JSON `oldValue` / `newValue` |
| `MirrorLink` | Source position -> copy position | `sourcePositionId`, `targetPositionId` (both unique) |
| `PostCloseEffect` | Outbox written in the close transaction; the web runs mirror / coverage / notices from it | `positionId`, payload `closedLots`, `sourceVolumeBeforeClose`, `closePrice`, `realizedPnl` |

There is no Deal, Fill or Execution table, and no netting: every fill opens a new Position
(`Broker.hedgingAllowed = false` only refuses an opposite-side open, `lib/hedging.ts:14-24`).

### 1.2 What each event writes

All web closes go through `closePositionInTx` (`lib/position-close.ts:38-221`); the engine's twin is
`close_position_as` (`engine/order-management/src/book.rs:765-919` on `engine/stage6`). Both use the guard
`UPDATE ... WHERE id AND status = 'OPEN' AND volume = <volume read>`.

| Event | Position row | Ledger | Order | How the pieces are linked |
|---|---|---|---|---|
| Open | new row, `volume` = filled lots | `COMMISSION` (note "Commission: V lots @ R/lot"), `Position.commission += c` | opening Order FILLED | `originOrderId`, `referenceId` |
| **Partial close** | same id and ticket; only `volume` is reduced; status stays OPEN | one `TRADE_PNL`, amount = P/L of the closed lots, note "Partial close: V lots @ P" (client / dealer path) or "Manual partial close by admin: V lots @ P" (staff); mirror / coverage partials carry their own notes **without** lots or price | none (instant) or the queued close Order | note text only |
| Full close (incl. last piece) | CLOSED, `closePrice` = this close's price, `realizedPnl` = **this close's P/L only**, `volume` = **the last remaining piece** | one `TRADE_PNL`; note null for a plain client close, else the reason ("Stop loss hit (automatic)", "Stop-out (automatic): ...", "Bulk close (ALL)", "Dealer close (...)", "Manual close by admin @ P", "Mirror close (...)", "Coverage auto-close (...)") | as above | `referenceId` |
| **Close-by** (client, instant, `lib/close-by.ts:106-174`) | both legs closed in one tx at **one mid price** `(bid+ask)/2`, volume = the smaller leg; the larger leg is a partial | one `TRADE_PNL` per leg, note "Close by <other position id>" (overrides "Partial close:", so the larger leg's partial has no lots / price) | none | note text + `closedAt` within 5 s |
| Close-by (dealer-queued / staff) | executed as ordinary closes | notes "Dealer close ..." / "Manual close by admin ..." | queued close Orders | **link lost** (the "Close by #ticket" text only reaches the AuditLog) |
| Reverse in place (staff) | `side` flipped on the same row | none | none | AuditLog |
| Reverse close-and-reopen (staff) | old row closed, new row opened opposite | `TRADE_PNL` "Reversed (close & reopen) by admin @ P" | new Order (source ADMIN) | **AuditLog JSON only** (`newPositionId`) |
| Void | status VOIDED | `ADJUSTMENT` reversing the sum of COMMISSION + TRADE_PNL + CREDIT + NBP for the position | none | `referenceId` |

Margin call closes nothing. Stop-out (web and engine) closes the single worst position per loop, always in full.
The engine never partial-closes and has no close-by (`monitor.rs:135`); a position the web has reduced makes the
engine's volume guard miss, which is a benign no-op (`book.rs:777`, test `book_db.rs:110`).

### 1.3 What the History API returns

`GET /api/trade/history` (`app/api/trade/history/route.ts`) returns CLOSED, non-deleted Position rows (1000 by
default, 5000 max), newest `closedAt` first, with the raw row fields. Since 2026-10-12 (web 40433fe) a position
with more than one close, or a close-by, also carries `closes[]` (`at, volume, price, pnl, closedByTicket, final`)
built by `lib/history-closes.ts`. That works by parsing note text: the default "Partial close: V lots @ P" and
"Close by <id or #ticket>". The final piece takes `Position.volume` / `closePrice`. **Any other note (staff partial,
mirror, coverage) makes the whole position flat**, and a position that is still OPEN after partial closes is not
in History at all, so its realised P/L shows nowhere until the last close.

Staff readers (`/api/manage/deals`, `reports/trading`, `reports/summary`, `lib/book-pnl.ts`, `lib/commission.ts`,
`lib/risk-radar.ts`, account risk / activity routes, WebTrader history and CSV) read `Position.realizedPnl`,
`volume` and `closedAt` directly. None of them read the ledger.

### 1.4 Live examples (read-only, anonymised)

Counts on the live DB, 2026-10-12: 2,135 positions closed in one piece, **25** with two or more closes, **10**
close-by ledger rows (6 of them between legs of different sizes), 0 positions still open after a partial close.
Note shapes on `TRADE_PNL`: null 817, "Bulk close (...)" 772, "Stop-out (automatic)" 210, "Manual close by admin"
111, "Dealer close" 100, "Partial close: V lots @ P" 37, SL 33, coverage 8, TP 6.

**Partial close.** BUY XAUUSD, opening order 0.02 lots @ 4143.35:

| Row | Volume | Price | P/L | Note |
|---|---|---|---|---|
| Opening Order | 0.02 | 4143.35 | | MARKET, FILLED |
| TRADE_PNL, +11 s | | | -0.16 | Partial close: 0.01 lots @ 4143.19 |
| TRADE_PNL, +14 s | | | -0.23 | (null) |
| **Position row after** | **0.01** | close **4143.12** | realizedPnl **-0.23** | |

The trade's real result is 0.02 lots, P/L -0.39. The row says 0.01 lots, -0.23. On all 25 multi-close positions
`realizedPnl` equals the last piece only (25 of 25), and on 17 of 25 the row's volume is below the opening order's.
None of the 25 has a close Order row.

**Close-by.** Leg A BUY 0.53 @ 2006.30, leg B SELL 0.53 @ 2000.00, both closed at 1996.07 at the same second:
A TRADE_PNL -542.19 "Close by <B's id>", B TRADE_PNL +208.29 "Close by <A's id>", plus each leg's COMMISSION -26.50
written at open. Net -333.90 before commission. The two legs are tied only by those notes.

### 1.5 Consequences today (independent of any redesign)

1. **Book P/L, Deals (DLS), reports/trading, risk-radar win rate, the CLI card win rate, mirror-rule stats and
   WebTrader history totals under-count every partially-closed trade**: they read `Position.realizedPnl`, which
   is the last piece only.
2. **IB per-lot commission under-counts** partially-closed trades (`lib/commission.ts` sums `Position.volume`, the
   last piece).
3. Terminal DAY / WEEK P/L (`MarketDataService.cs:2494-2526`) uses the row's `RealizedPnl` and final `ClosedAt`, so a
   partial's P/L lands on the day of the last close, and only the last piece counts. The History footer and the
   statement use the `closes` sum, so the terminal shows two different numbers for the same trade.
4. Commission sign differs between `StatementExport.cs:31` (raw add) and `HistoryTotals.cs:27` (minus |c|); the
   ShareCard uses the last piece's volume.
5. `closeReasonFromNote` (`lib/dealer-activity.ts:166`) reads "Manual partial close", coverage closes and null notes
   as MANUAL.

Items 1-2 are money-reporting errors that exist now. A small hotfix (sum `TRADE_PNL` per position instead of
reading `realizedPnl`; IB lots from the opening order) would fix them without the new model. Owner's call whether
to ship that first (section 5, step 0).

---

## 2. The MT5 model

MT5 keeps three things apart: **orders** (requests), **deals** (executions; the accounting truth) and
**positions** (the current open state, derived from deals).

- A **position** has an identifier (`POSITION_IDENTIFIER`) equal to the ticket of the order that opened it. It never
  changes, through partial closes, and on a netting account through reversals.
- A **deal** has its own ticket and: `DEAL_ORDER`, `DEAL_POSITION_ID`, `DEAL_TIME`, `DEAL_TYPE` (BUY, SELL, and the
  non-trade types BALANCE, CREDIT, CHARGE, CORRECTION, BONUS, COMMISSION ...), `DEAL_ENTRY`, `DEAL_VOLUME`,
  `DEAL_PRICE`, `DEAL_PROFIT`, `DEAL_COMMISSION`, `DEAL_SWAP`, `DEAL_FEE`, `DEAL_REASON` (CLIENT, MOBILE, WEB, EXPERT,
  SL, TP, SO = stop-out, DEALER, ROLLOVER, VMARGIN, SPLIT ...), `DEAL_SYMBOL`, `DEAL_MAGIC`, `DEAL_COMMENT`.
- `DEAL_ENTRY`: **IN** (opens or adds), **OUT** (reduces or closes), **INOUT** (netting reversal: closes and opens
  the opposite side in one deal), **OUT_BY** (closed by an opposite position).

How the cases are derived:

| Case | Deals written |
|---|---|
| Open 1.00 | IN 1.00 @ open price (commission on the deal) |
| Partial close 0.30, then 0.70 | OUT 0.30 @ p1 (profit 1), OUT 0.70 @ p2 (profit 2); the position keeps its identifier, its volume goes 1.00 -> 0.70 -> 0 |
| Close-by of BUY 1.00 with SELL 0.40 | two OUT_BY deals of 0.40, one per position, at the **open price of the closing position**; the remaining 0.60 of the BUY stays open |
| Netting reversal (BUY 1.00 open, SELL 1.50 sent) | one INOUT 1.50 (profit realised on 1.00, new SELL 0.50 position state) |
| Stop-out | OUT with reason SO |

Statements and history views are **derived from deals**:

- "Positions" history groups deals by `DEAL_POSITION_ID`: volume = the IN volume, open time / price = the IN deal,
  close time = the last OUT, close price = the volume-weighted average of the OUT prices, profit = the sum of the
  OUT profits, commission and swap = the sums over the position's deals.
- "Deals" history lists every deal, including balance and credit operations.
- The standard report's summary counts trades from deals, splits short / long, and computes the balance as the sum of
  all deals' profit + commission + swap + fee.

---

## 3. Proposed target model

### 3.1 Principles

1. **Add, don't rewrite.** A new `Deal` table sits beside the ledger. `Transaction` stays the money record with
   `referenceType = 'Position'`, `referenceId = Position.id` unchanged, so the engine's pin rewind
   (`calc.rs:185-190`), the void reversal and every balance reader keep working.
2. **One deal per execution, written in the same transaction** as the ledger row it explains; the link is a unique
   `Deal.transactionId` (exactly-once by construction).
3. `Position` keeps being the open-state row (open volume, SL/TP, coverage, dealer lock), so the risk hook, margin
   watch and the open-position screens don't change.
4. Hedging only for now (every fill is a new position). INOUT is reserved for the netting / Position Mode work
   (`project_hedging_netting_plan`), not built now.

### 3.2 Schema

```prisma
enum DealEntry { IN OUT OUT_BY INOUT }
enum DealReason { CLIENT DEALER ADMIN SL TP STOP_OUT BULK MIRROR COVERAGE CLOSE_BY REVERSE EXPIRY }

model Deal {
  id            String     @id @default(cuid())
  ticket        BigInt     @unique              // own sequence deal_ticket_seq, never reuses order tickets
  brokerId      String
  accountId     String
  positionId    String                           // Position.id (the position identifier)
  orderId       String?                          // opening Order, or the queued close Order
  symbolId      String
  side          OrderSide                        // direction of THIS deal (a close of a BUY is a SELL deal)
  entry         DealEntry
  reason        DealReason
  source        OrderSource?                     // channel (WEB / DESKTOP_NATIVE / ...), when a client acted
  volume        Decimal    @db.Decimal(10, 2)
  price         Decimal    @db.Decimal(18, 5)
  profit        Decimal    @default(0) @db.Decimal(18, 2)   // account currency, = the TRADE_PNL amount
  commission    Decimal    @default(0) @db.Decimal(18, 2)
  swap          Decimal    @default(0) @db.Decimal(18, 2)
  byPositionId  String?                          // OUT_BY: the opposite position
  transactionId String?    @unique              // the TRADE_PNL (OUT) or COMMISSION (IN) ledger row
  adminId       String?                          // staff actor
  executedAt    DateTime   @db.Timestamptz(3)
  backfilled    Boolean    @default(false)       // true = derived from history, see backfillNote
  backfillNote  String?
  createdAt     DateTime   @default(now()) @db.Timestamptz(3)

  @@index([accountId, executedAt])
  @@index([positionId])
  @@index([brokerId, executedAt])
}
```

`Position` gains `initialVolume Decimal?` (the IN volume, immutable) and `reversedFromPositionId String? @unique`
(close-and-reopen link). `Position.volume` keeps meaning "open now". After the switch `realizedPnl` means the sum
of the position's OUT profits and `closePrice` the volume-weighted average exit price (MT5's position view).

Swap (owner decision 2026-10-12): the ledger keeps one SWAP row per account per day, so swap is already paid and
nothing moves on a close. A partial close is attributed swap **pro rata by closed volume**: closed lots / open lots
before the close x the swap accrued on the position and not yet attributed. The remainder stays on the position and
goes to the next close. The final close takes whatever is left. `Position.swap` stays the position's total accrued
swap, and the statement's parent row shows that total. The OUT deals (and, in the hotfix, the close fields on the
TRADE_PNL row) carry each close's share, and the shares add up to the total.

### 3.3 Migration and backfill (no data loss, reversible)

1. **Migration A (additive only):** create `Deal`, the two enums, `deal_ticket_seq`, `Position.initialVolume`,
   `Position.reversedFromPositionId`. Nothing reads them yet. Revert = drop them.
2. **Dual write**, web and engine together, behind no flag (the table is write-only until step 4):
   - open fill -> IN deal (commission on it, `transactionId` = the COMMISSION row), `initialVolume` set;
   - `closePositionInTx` and the engine's `close_position_as` -> OUT / OUT_BY deal with the price, lots, reason and
     `transactionId` of the TRADE_PNL row they already write;
   - close-by -> two OUT_BY deals with `byPositionId` both ways, including the dealer-queued and staff paths (the
     queued close Order gets `byPositionId` so the link survives execution);
   - reverse close-and-reopen -> sets `reversedFromPositionId`.
3. **Backfill script** (`scripts/backfill-deals.ts`, dry run by default, `--apply --confirm-host`, batches of 500,
   idempotent through the unique `transactionId`, resumable):
   - IN deal per position from its opening Order (volume = `Order.volume`, price = `filledPrice` or `openPrice`,
     time = `openedAt`, commission = the position's COMMISSION row). Positions with no opening Order (staff / mirror /
     coverage opens: to be counted first) use `Position.openPrice` and the IN volume from step c.
   - OUT deal per TRADE_PNL row of the position, ordered by `createdAt`; profit = amount; time = `createdAt`:
     a. the last row: volume = `Position.volume`, price = `Position.closePrice`;
     b. earlier rows: volume and price parsed from "Partial close: V lots @ P" / "Manual partial close by admin: V
        lots @ P"; "Close by <id>" rows become OUT_BY with the counterpart and volume = min of the legs (price = the
        counterpart's close price, same second);
     c. a row that can't be parsed (mirror / coverage partial notes): volume = IN volume minus the known OUT volumes
        when exactly one row is unknown; price back-solved from profit, contract size and the account's conversion
        at that time; `backfilled = true` with a note. More than one unknown row on a position -> the script stops
        and lists it for the owner.
   - `initialVolume` = IN volume; checks per position: sum(OUT volume) = IN volume for CLOSED,
     sum(OUT profit) = sum(TRADE_PNL).
   - On the live data this is 2,160 positions, of which 25 have several closes and 10 close-by rows; the ambiguous
     set is expected to be a handful and is listed in the dry run before anything is written.
4. **Read switch** (section 3.4), one reader at a time, each comparing old vs new numbers on staging first.
5. **realizedPnl correction**: after the switch, `Position.realizedPnl` and `closePrice` are recomputed from deals for
   the 25 multi-close positions. The old values are saved first in `DealBackfillLog(positionId, field, oldValue,
   newValue)`, so the correction is reversible row by row. This changes historical Book P/L (it was under-counted):
   owner sign-off needed.

Rollback at any step before 5: stop reading deals (readers fall back to the current queries), keep writing them.
Full rollback: drop the table; nothing else was altered.

### 3.4 What changes where

| Component | Change |
|---|---|
| Web close / open paths | `closePositionInTx`, `lib/close-by.ts`, `lib/queued-close.ts`, `lib/position-actions.ts` (staff close, reverse, void), `lib/mirror.ts`, `lib/coverage.ts`, `lib/bulk-close.ts`, `lib/risk-monitor.ts`, order fill paths (`orders/route.ts`, `pending-trigger.ts`, `dealing.ts`, `manage/positions/route.ts`) write deals. The note text stays for humans; nothing parses it any more. |
| Web APIs | `/api/trade/history` builds `closes[]` from deals (same JSON shape, so terminal 1.0.69 keeps working) and drops `lib/history-closes.ts`; adds `GET /api/trade/deals` (MT5 Deals view). `/api/manage/deals` gains `view=positions|deals`. `lib/book-pnl.ts`, `reports/*`, `lib/commission.ts` (IB lots from deals), `lib/risk-radar.ts`, account risk / activity, mirror-rule stats and `lib/dealer-activity.ts` (reason from `Deal.reason`) read deals. Daily loss limits (`lib/risk.ts:598`, `lib/mirror.ts:205`) can stay on the ledger. Void: also marks the position's deals voided. |
| WebTrader | History table, totals and CSV from the positions view; optional Deals tab. |
| Terminal | Nothing required for the first switch (`closes` keeps its shape). Then: DAY / WEEK P/L from deal times and profit (fixes item 3 in 1.5), statement Deals section, one commission sign rule (`StatementExport` = `HistoryTotals`), ShareCard uses the position view, the stream's CLOSED event carries the deal so partials appear without a refetch. |
| Backoffice | DLS: Positions / Deals toggle; CLI card trades tab, win rate and statement CSV (`StatementCsv` CLOSED DEALS becomes real deals); Dealing NET strip and group / coverage history by deal time; SDM closed list pairs legs by deal; Reports and IB screens unchanged (server numbers). |
| Statements | Terminal HTML / Excel and backoffice CSV: Positions section (grouped, as now) + a Deals section + balance operations, MT5 report order. |
| Reports / Book P/L | Realised Book P/L = sum of OUT deal profit by `executedAt` in the range (a partial counts on its own day); floating unchanged. |
| Rust engine | `close_position_as` writes the OUT deal in the same transaction (owner check `lock_owner_in_tx` still wraps it); the post-close outbox payload adds `dealId` and the remaining volume, `dedupeKey` per deal; `reconcile.rs` detects web closes from `Deal.reason` instead of note prefixes; parity `AccountOutcome` / `PositionState` (`db_mode.rs`, `parity/src/lib.rs`, `scripts/parity/run-ts.ts`) and the 27 scenarios assert deals; the split-harness `diff.mjs` diffs the Deal table. Risk hook, margin watch and book reads are unchanged (they read open `Position` rows). If partial stop-out or close-by in the engine is ever wanted, the close becomes "reduce by N lots" with a `volume >= N` guard. |

---

## 4. Cutover gate (before Stage 6 uses it)

Stage 6 makes the engine the risk authority per account (SL / TP / stop-out closes), so the engine and the web
write closes side by side. Before any broker is flipped to RUST with the deal model live:

1. **Same writes from both sides:** every engine close and every web close writes exactly one OUT deal per TRADE_PNL
   row, in the same transaction. Check on the live DB: `TRADE_PNL` rows without a deal = 0;
   `GROUP BY transactionId HAVING count(*) > 1` = 0 (the unique index makes it structural).
2. **Backfill complete and reconciled:** for every CLOSED position, sum(OUT volume) = `initialVolume` and
   sum(OUT profit) = sum(TRADE_PNL); the ambiguous list signed off by the owner.
3. **Parity:** the 27 parity scenarios extended with expected deals and passing in both runners; new scenarios for a
   partial then SL, a partial then stop-out, and a close-by followed by an engine SL on the remaining leg.
4. **Split harness:** web + engine on one DB, the Deal table diffed id by id against the web-only reference, 0 diffs,
   including the flip-to-WEB drill under load.
5. **Reconciler:** reads `Deal.reason`; a soak day with 0 unexplained pairs.
6. **Readers switched** for Book P/L, deals, history and IB, with the old-vs-new comparison report attached.
7. Proposed addition to the gates in `docs/RUST-CUTOVER-PLAN.md`: "Engine must use the same position / deal model
   (one position ticket, a deal per open / partial / close) before cutover". Not edited yet (this job is doc only).

Tests to add:

| Area | Tests |
|---|---|
| Web (vitest, scratch DB) | open writes IN; full close writes OUT; partial writes OUT and keeps the position; close-by writes two OUT_BY with `byPositionId` both ways (instant, dealer-queued, staff); reverse close-and-reopen links the new position; void marks deals; mirror / coverage partial deals carry lots and price; exactly-once under the double-close race; history `closes` built from deals equals today's output for parseable cases; Book P/L and IB lots from deals |
| Backfill | dry run changes nothing; idempotent rerun = 0 changes; parse cases; unknown-row derivation; stops on two unknowns; `DealBackfillLog` restore puts the old values back |
| Engine (Rust, DB tests) | `book_db.rs`: close writes OUT deal with the TRADE_PNL id; rollback leaves no deal; stale volume writes nothing; `risk_split_db.rs` with deals; reconcile reads deals; parity scenarios with deals |
| Native | `HistoryGroupsTests` unchanged against deal-built `closes`; DAY / WEEK P/L by deal time; statement Deals section; one commission sign rule; DLS deals view; CLI win rate by position |

---

## 5. Effort and order

Estimates are working days for one builder, including tests.

| Step | Work | Days |
|---|---|---|
| 0 (optional, now) | Hotfix the current under-counts: Book P/L, DLS, reports, risk-radar and CLI win rate read the TRADE_PNL sum per position; IB lots from the opening order; dealer-activity reason for staff / coverage partials | 1.5 |
| 1 | Migration A + web dual write on every open / close path (incl. close-by link through the dealer queue) + tests | 3 |
| 2 | Engine dual write + outbox `dealId` + reconcile from `Deal.reason` + parity scenarios + split-harness diff | 3.5 |
| 3 | Backfill script, dry run on a copy of live, owner review of the ambiguous list, apply | 2 |
| 4 | Web readers: history from deals, `/api/trade/deals`, `/api/manage/deals` views, Book P/L, reports, IB, risk-radar, WebTrader | 3 |
| 5 | Terminal: DAY / WEEK P/L, statement Deals section, commission sign, ShareCard, stream event (one terminal release) | 2 |
| 6 | Backoffice: DLS deals view, CLI card, Dealing NET / history, SDM pairing, statement CSV (one backoffice release) | 2.5 |
| 7 | `realizedPnl` / `closePrice` correction with the backfill log, Book P/L before-after report, owner sign-off | 0.5 |
| 8 | Stage 6 gate run: split harness, flip drill, soak with the reconciler | 2 (+ the soak's calendar time) |
| | **Total** | **about 20 days** (18.5 without step 0) |

Order: 0 -> 1 -> 2 -> 3 -> 4 -> 7 -> 5 / 6 -> 8. The web and engine dual writes (1, 2) must land before the backfill
so no close is missed between the backfill and the switch; readers (4) switch only after the backfill reconciles.
Terminal and backoffice releases (5, 6) can follow in either order since the API shapes stay compatible.

Risks: a missed close path writing no deal (mitigated by the "TRADE_PNL without deal = 0" check run daily); the
engine and web drifting on deal fields (parity + split harness); the historical P/L correction surprising brokers
(report it before applying); swap allocation on partial deals (owner decision in 3.2).
