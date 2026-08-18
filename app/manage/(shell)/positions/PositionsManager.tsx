"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

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
    <div className="flex flex-col gap-6">
      <Card title="Exposure by symbol">
        <Table>
          <TableHead>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell align="right">Positions</TableHeaderCell>
            <TableHeaderCell align="right">Buy volume</TableHeaderCell>
            <TableHeaderCell align="right">Sell volume</TableHeaderCell>
            <TableHeaderCell align="right">Net exposure</TableHeaderCell>
            <TableHeaderCell align="right">Current price</TableHeaderCell>
          </TableHead>
          <TableBody>
            {exposureRows.length === 0 ? (
              <TableEmptyState colSpan={6}>No open positions.</TableEmptyState>
            ) : (
              exposureRows.map((e) => (
                <TableRow key={e.symbol}>
                  <TableCell mono>{e.symbol}</TableCell>
                  <TableCell align="right">{e.count}</TableCell>
                  <TableCell align="right" mono>
                    {e.buyVolume}
                  </TableCell>
                  <TableCell align="right" mono>
                    {e.sellVolume}
                  </TableCell>
                  <TableCell
                    align="right"
                    mono
                    className={Number(e.netExposure) === 0 ? "" : Number(e.netExposure) > 0 ? "text-emerald-600" : "text-rose-600"}
                  >
                    {Number(e.netExposure) > 0 ? "+" : ""}
                    {e.netExposure}
                  </TableCell>
                  <TableCell align="right" mono>
                    {e.currentPrice ?? "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card title="Open a position">
        <form onSubmit={openPosition} className="flex flex-wrap items-center gap-2">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required className="w-56">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} — {a.fullName}
              </option>
            ))}
          </Select>
          <Select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} required className="w-32">
            {symbols.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")} className="w-24">
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </Select>
          <Input
            type="text"
            inputMode="decimal"
            mono
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            placeholder="Volume"
            className="w-20"
            required
          />
          <Button type="submit" variant="primary" disabled={opening || !accountId || !symbolId}>
            {opening ? "Opening..." : "Open position"}
          </Button>
          {openError ? <span className="text-sm text-rose-600">{openError}</span> : null}
        </form>
      </Card>

      <Card title="Open positions">
        <Table>
          <TableHead>
            <TableHeaderCell>Account</TableHeaderCell>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell>Side</TableHeaderCell>
            <TableHeaderCell align="right">Volume</TableHeaderCell>
            <TableHeaderCell align="right">Open price</TableHeaderCell>
            <TableHeaderCell align="right">Current price</TableHeaderCell>
            <TableHeaderCell align="right">Floating P&L</TableHeaderCell>
            <TableHeaderCell>Opened</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            {positionRows.length === 0 ? (
              <TableEmptyState colSpan={9}>No open positions.</TableEmptyState>
            ) : (
              positionRows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {p.accountNumber}
                    <div className="text-xs text-slate-400">{p.accountFullName}</div>
                  </TableCell>
                  <TableCell mono>{p.symbolName}</TableCell>
                  <TableCell>
                    <Badge tone={p.side === "BUY" ? "success" : "danger"}>{p.side}</Badge>
                  </TableCell>
                  <TableCell align="right" mono>
                    {p.volume}
                  </TableCell>
                  <TableCell align="right" mono>
                    {p.openPrice}
                  </TableCell>
                  <TableCell align="right" mono>
                    {p.currentPrice ?? "—"}
                  </TableCell>
                  <TableCell
                    align="right"
                    mono
                    className={!p.floatingPnl ? "" : Number(p.floatingPnl) >= 0 ? "text-emerald-600" : "text-rose-600"}
                  >
                    {p.floatingPnl ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-slate-400">{p.openedAt}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder={`up to ${p.volume}`}
                        value={partialVolume[p.id] ?? ""}
                        onChange={(e) => setPartialVolume((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        className="w-20 text-xs"
                        title="Leave blank to close the full volume"
                      />
                      <Button size="sm" variant="danger" disabled={closingId === p.id} onClick={() => closePosition(p)}>
                        {closingId === p.id ? "Closing..." : "Close"}
                      </Button>
                    </div>
                    {closeErrors[p.id] ? <div className="mt-1 text-xs text-rose-600">{closeErrors[p.id]}</div> : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
