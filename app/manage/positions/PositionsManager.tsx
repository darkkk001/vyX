"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type ExposureRow = {
  symbol: string;
  count: number;
  buyVolume: string;
  sellVolume: string;
  netExposure: string;
  currentPrice: string | null;
};

export type PositionRow = {
  id: string;
  accountNumber: string;
  accountFullName: string;
  symbolName: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  currentPrice: string | null;
  floatingPnl: string | null;
  openedAt: string;
};

export type AccountOption = { id: string; accountNumber: string; fullName: string };
export type SymbolOption = { id: string; name: string };

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const mono: React.CSSProperties = { fontFamily: "monospace" };

// Exposure table (display only) + an "open a position" form + the open
// positions table with a per-row Close action (full or partial volume).
// Same fetch/error/submitting-state shape as SymbolConfigTable.tsx.
export default function PositionsManager({
  exposureRows,
  positionRows,
  accounts,
  symbols,
}: {
  exposureRows: ExposureRow[];
  positionRows: PositionRow[];
  accounts: AccountOption[];
  symbols: SymbolOption[];
}) {
  const router = useRouter();

  // --- Open position form ---
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [symbolId, setSymbolId] = useState(symbols[0]?.id ?? "");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [volume, setVolume] = useState("0.01");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function openPosition(e: React.FormEvent) {
    e.preventDefault();
    setOpening(true);
    setOpenError(null);
    const response = await fetch("/api/manage/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, symbolId, side, volume }),
    });
    setOpening(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setOpenError(body.error ?? "failed to open position");
      return;
    }
    router.refresh();
  }

  // --- Close action, per row ---
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeErrors, setCloseErrors] = useState<Record<string, string>>({});
  const [partialVolume, setPartialVolume] = useState<Record<string, string>>({});

  async function closePosition(row: PositionRow) {
    setClosingId(row.id);
    setCloseErrors((prev) => ({ ...prev, [row.id]: "" }));

    const requestedVolume = partialVolume[row.id]?.trim();
    const response = await fetch(`/api/manage/positions/${row.id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestedVolume ? { volume: requestedVolume } : {}),
    });

    setClosingId(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCloseErrors((prev) => ({ ...prev, [row.id]: body.error ?? "close failed" }));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <h2>Exposure by symbol</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th align="left" style={th}>Symbol</th>
            <th align="right" style={th}>Positions</th>
            <th align="right" style={th}>Buy volume</th>
            <th align="right" style={th}>Sell volume</th>
            <th align="right" style={th}>Net exposure</th>
            <th align="right" style={th}>Current price</th>
          </tr>
        </thead>
        <tbody>
          {exposureRows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ padding: "12px 8px", color: "#999" }}>No open positions.</td>
            </tr>
          ) : (
            exposureRows.map((e) => (
              <tr key={e.symbol}>
                <td style={{ ...td, ...mono }}>{e.symbol}</td>
                <td align="right" style={td}>{e.count}</td>
                <td align="right" style={{ ...td, ...mono }}>{e.buyVolume}</td>
                <td align="right" style={{ ...td, ...mono }}>{e.sellVolume}</td>
                <td
                  align="right"
                  style={{ ...td, ...mono, color: Number(e.netExposure) === 0 ? undefined : Number(e.netExposure) > 0 ? "green" : "crimson" }}
                >
                  {Number(e.netExposure) > 0 ? "+" : ""}
                  {e.netExposure}
                </td>
                <td align="right" style={{ ...td, ...mono }}>{e.currentPrice ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>Open a position</h2>
      <form
        onSubmit={openPosition}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "2rem" }}
      >
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber} — {a.fullName}
            </option>
          ))}
        </select>
        <select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} required>
          {symbols.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder="Volume"
          style={{ width: 80, ...mono }}
          required
        />
        <button type="submit" disabled={opening || !accountId || !symbolId}>
          {opening ? "Opening..." : "Open position"}
        </button>
        {openError ? <span style={{ color: "crimson" }}>{openError}</span> : null}
      </form>

      <h2>Open positions</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={th}>Account</th>
            <th align="left" style={th}>Symbol</th>
            <th align="left" style={th}>Side</th>
            <th align="right" style={th}>Volume</th>
            <th align="right" style={th}>Open price</th>
            <th align="right" style={th}>Current price</th>
            <th align="right" style={th}>Floating P&L</th>
            <th align="left" style={th}>Opened</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {positionRows.length === 0 ? (
            <tr>
              <td colSpan={9} style={{ padding: "12px 8px", color: "#999" }}>No open positions.</td>
            </tr>
          ) : (
            positionRows.map((p) => (
              <tr key={p.id}>
                <td style={td}>
                  {p.accountNumber}
                  <div style={{ fontSize: 11, color: "#999" }}>{p.accountFullName}</div>
                </td>
                <td style={{ ...td, ...mono }}>{p.symbolName}</td>
                <td style={{ ...td, color: p.side === "BUY" ? "green" : "crimson" }}>{p.side}</td>
                <td align="right" style={{ ...td, ...mono }}>{p.volume}</td>
                <td align="right" style={{ ...td, ...mono }}>{p.openPrice}</td>
                <td align="right" style={{ ...td, ...mono }}>{p.currentPrice ?? "—"}</td>
                <td
                  align="right"
                  style={{ ...td, ...mono, color: !p.floatingPnl ? undefined : Number(p.floatingPnl) >= 0 ? "green" : "crimson" }}
                >
                  {p.floatingPnl ?? "—"}
                </td>
                <td style={{ ...td, fontSize: 11, color: "#999" }}>{p.openedAt}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={`up to ${p.volume}`}
                    value={partialVolume[p.id] ?? ""}
                    onChange={(e) => setPartialVolume((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    style={{ width: 70, fontSize: 12, marginRight: 4 }}
                    title="Leave blank to close the full volume"
                  />
                  <button type="button" disabled={closingId === p.id} onClick={() => closePosition(p)}>
                    {closingId === p.id ? "Closing..." : "Close"}
                  </button>
                  {closeErrors[p.id] ? (
                    <div style={{ color: "crimson", fontSize: 11 }}>{closeErrors[p.id]}</div>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
