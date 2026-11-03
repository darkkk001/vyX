"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import StatusChip from "@/components/room/StatusChip";
import { useRoom, type RoomTx } from "@/components/room/RoomData";
import { money, pnlClass, dayTimeCompact } from "@/components/room/format";

// Artboard "History": Transactions / Trades, account / type / period filters, pages of 20, CSV export.
type Trade = { id: string; ticket: string; account: string; symbol: string; side: "BUY" | "SELL"; lots: string; openPrice: string; closePrice: string; profit: string; status: string; openedAt: string; closedAt: string };
type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

const sel = { background: "var(--r-card)", border: "1px solid var(--r-input)", borderRadius: 6, color: "var(--r-text)", fontSize: 12.5, padding: "8px 10px" } as const;
const TH = ({ children, right }: { children: string; right?: boolean }) => (
  <th style={{ padding: "12px 10px", fontSize: 10.5, borderBottom: "1px solid var(--r-border)", textAlign: right ? "right" : "left" }}>{children}</th>
);
const td = { padding: "12px 10px" } as const;

export default function RoomHistory() {
  const { data } = useRoom();
  const [tab, setTab] = useState<"transactions" | "trades">("transactions");
  const [account, setAccount] = useState("all");
  const [type, setType] = useState("all");
  const [period, setPeriod] = useState("90d");
  const [page, setPage] = useState(1);
  const [tx, setTx] = useState<Page<RoomTx> | null>(null);
  const [trades, setTrades] = useState<Page<Trade> | null>(null);
  const query = `tab=${tab}&account=${account}&type=${tab === "transactions" ? type : "all"}&period=${period}`;

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/room/history?${query}&page=${page}`, { cache: "no-store" });
      if (!res.ok || !live) return;
      const body = await res.json();
      if (tab === "transactions") setTx(body); else setTrades(body);
    })();
    return () => { live = false; };
  }, [query, page, tab]);

  const current = tab === "transactions" ? tx : trades;
  const shown = current ? current.rows.length : 0;
  const lastPage = current ? Math.max(1, Math.ceil(current.total / current.pageSize)) : 1;
  const ccy = data?.accounts[0]?.currency ?? "USD";
  const reset = () => setPage(1);

  return (
    <>
      <RoomHeader title="History" />
      <div className="r-body" style={{ gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div role="tablist" style={{ display: "inline-flex", background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 7, padding: 3 }}>
            {(["transactions", "trades"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); reset(); }}
                style={{ background: tab === t ? "var(--r-accent)" : "none", color: tab === t ? "var(--r-on-accent)" : "var(--r-text-2)", border: "none", borderRadius: 5, fontSize: 12.5, fontWeight: tab === t ? 600 : 500, padding: "7px 18px", cursor: "pointer" }}>
                {t === "transactions" ? "Transactions" : "Trades"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select aria-label="Account" className="mono" style={sel} value={account} onChange={(e) => { setAccount(e.target.value); reset(); }}>
              <option value="all">All accounts</option>
              {(data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.accountNumber}</option>)}
            </select>
            {tab === "transactions" ? (
              <select aria-label="Type" style={sel} value={type} onChange={(e) => { setType(e.target.value); reset(); }}>
                <option value="all">All types</option>
                {["Deposit", "Withdrawal", "Transfer", "Credit", "Adjustment"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : null}
            <select aria-label="Period" style={sel} value={period} onChange={(e) => { setPeriod(e.target.value); reset(); }}>
              <option value="90d">Last 90 days</option>
              <option value="30d">Last 30 days</option>
              <option value="ytd">This year</option>
              <option value="all">All time</option>
            </select>
            <a className="r-btn-ghost" style={{ fontSize: 12.5, padding: "8px 14px" }} href={`/api/room/history?${query}&format=csv`} download>Export CSV</a>
          </div>
        </div>

        <div className="r-card" style={{ padding: "6px 18px 14px" }}>
          <div className="r-table-wrap">
            {tab === "transactions" ? (
              <table className="r-table" style={{ fontSize: 13 }}>
                <thead><tr><TH>DATE</TH><TH>ID</TH><TH>TYPE</TH><TH>ACCOUNT</TH><TH>METHOD</TH><TH right>{`AMOUNT ${ccy}`}</TH><TH>STATUS</TH></tr></thead>
                <tbody className="mono" style={{ fontSize: 12.5 }}>
                  {(tx?.rows ?? []).map((t) => (
                    <tr key={t.id}>
                      <td style={{ ...td, color: "var(--r-text-2)" }}>{dayTimeCompact(t.at)}</td>
                      <td style={{ ...td, color: "var(--r-text-2)" }}>{t.ref}</td>
                      <td style={{ ...td, fontFamily: "var(--r-sans)" }}>{t.type}</td>
                      <td style={td}>{t.account}</td>
                      <td style={{ ...td, fontFamily: "var(--r-sans)", color: "var(--r-text-2)" }}>{t.method}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(t.amount)}</td>
                      <td style={{ ...td, fontFamily: "var(--r-sans)" }}><StatusChip status={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="r-table" style={{ fontSize: 13 }}>
                <thead><tr><TH>CLOSED</TH><TH>TICKET</TH><TH>ACCOUNT</TH><TH>SYMBOL</TH><TH>SIDE</TH><TH right>LOTS</TH><TH right>OPEN</TH><TH right>CLOSE</TH><TH right>{`PROFIT ${ccy}`}</TH></tr></thead>
                <tbody className="mono" style={{ fontSize: 12.5 }}>
                  {(trades?.rows ?? []).map((t) => (
                    <tr key={t.id}>
                      <td style={{ ...td, color: "var(--r-text-2)" }}>{dayTimeCompact(t.closedAt)}</td>
                      <td style={{ ...td, color: "var(--r-text-2)" }}>{t.ticket}</td>
                      <td style={td}>{t.account}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{t.symbol}</td>
                      <td style={{ ...td, fontWeight: 600 }} className={t.side === "BUY" ? "profit" : "loss"}>{t.side}{t.status === "Voided" ? <span style={{ color: "var(--r-muted)", fontWeight: 500, marginLeft: 8, fontFamily: "var(--r-sans)", fontSize: 11 }}>VOIDED</span> : null}</td>
                      <td style={{ ...td, textAlign: "right" }}>{t.lots}</td>
                      <td style={{ ...td, textAlign: "right" }}>{t.openPrice}</td>
                      <td style={{ ...td, textAlign: "right" }}>{t.closePrice}</td>
                      <td style={{ ...td, textAlign: "right" }} className={pnlClass(t.profit)}>{money(t.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {current && current.total === 0 ? <div className="r-empty">{tab === "transactions" ? "No transactions in this period." : "No closed trades in this period."}</div> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 14, fontSize: 12, color: "var(--r-muted)" }}>
            <span>{current ? `Showing ${shown} of ${current.total}` :" "}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" aria-label="Previous page" className="mono" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ background: "none", border: "1px solid var(--r-btn)", borderRadius: 6, color: page <= 1 ? "var(--r-muted)" : "var(--r-text)", fontSize: 12, padding: "6px 12px", cursor: page <= 1 ? "default" : "pointer" }}>←</button>
              <button type="button" aria-label="Next page" className="mono" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)} style={{ background: "none", border: "1px solid var(--r-btn)", borderRadius: 6, color: page >= lastPage ? "var(--r-muted)" : "var(--r-text)", fontSize: 12, padding: "6px 12px", cursor: page >= lastPage ? "default" : "pointer" }}>→</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
