// Deal model step 4 (docs/POSITION-DEAL-MODEL.md 3.3 item 4): the read switch, one reader at a time.
//
// DEAL_READS is a comma list of readers that read the Deal table instead of the ledger (TRADE_PNL) and Position rows:
//   history   /api/trade/history `closes` (default view and ?closes=1)
//   book_pnl  realised Book P/L (lib/book-pnl.ts: Dashboard, Reports summary) = OUT deal profit by execution time
//   ib_lots   PER_LOT IB commission (lib/commission.ts) = the client's closed lots by each close's own time, so a
//             partial close accrues when it happens, not when the position finally closes
//   reports_trading  Reports trading CSV (/api/manage/reports/trading) = the MT5 Deals report of the last 30 days: each
//             open and each close at its own time (a partial on its own day), Profit adds up to the realised P/L
//   dealer_activity  Dealing desk history (lib/dealer-activity.ts): a closed position's close reason from its last
//             close deal's Deal.reason instead of parsing the TRADE_PNL note
// "all" turns every reader on. Unset or empty: every reader keeps its old query, so removing a name is the rollback
// (the deals keep being written either way).

export type DealReader = "history" | "book_pnl" | "ib_lots" | "reports_trading" | "dealer_activity";

export function dealReads(reader: DealReader, env: string | undefined = process.env.DEAL_READS): boolean {
  const list = (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes("all") || list.includes(reader);
}
