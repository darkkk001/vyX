"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type PositionRow = {
  id: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  groupId: string | null;
  groupName: string | null;
  ibAccountId: string | null;
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
export type GroupOption = { id: string; name: string };
export type IbOption = { id: string; accountNumber: string; fullName: string };

type SideFilter = "ALL" | "BUY" | "SELL";
type PlFilter = "ALL" | "PROFIT" | "LOSS";
type SortMode = "symbol" | "exposure" | "risk";

const NO_GROUP = "__none__";
const NO_IB = "__none__";

// Exposure monitor: filters, sorting, per-symbol Client Floating P&L, an
// "open a position" form, and the open positions table with a per-row
// Close action (full or partial volume). Filtering is entirely
// client-side (same pattern AccountsManager.tsx's own search box uses)
// -- the exposure aggregate and the broker-wide total both recompute
// from whichever subset the filters leave, via useMemo, so they always
// stay in sync with what's on screen.
export default function PositionsManager({
  positionRows,
  accounts,
  symbols,
  groups,
  ibOptions,
}: {
  positionRows: PositionRow[];
  accounts: AccountOption[];
  symbols: SymbolOption[];
  groups: GroupOption[];
  ibOptions: IbOption[];
}) {
  const router = useRouter();

  // --- Filters ---
  const [symbolFilter, setSymbolFilter] = useState("ALL");
  const [accountFilter, setAccountFilter] = useState("ALL");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [ibFilter, setIbFilter] = useState("ALL");
  const [sideFilter, setSideFilter] = useState<SideFilter>("ALL");
  const [plFilter, setPlFilter] = useState<PlFilter>("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("symbol");

  // Only accounts that actually have an open position -- filtering
  // positions by an account with none would always show nothing.
  const accountsWithPositions = useMemo(() => {
    const ids = new Set(positionRows.map((p) => p.accountId));
    return accounts.filter((a) => ids.has(a.id));
  }, [positionRows, accounts]);

  const filteredPositions = useMemo(() => {
    return positionRows.filter((p) => {
      if (symbolFilter !== "ALL" && p.symbolName !== symbolFilter) return false;
      if (accountFilter !== "ALL" && p.accountId !== accountFilter) return false;
      if (groupFilter !== "ALL") {
        if (groupFilter === NO_GROUP ? p.groupId !== null : p.groupId !== groupFilter) return false;
      }
      if (ibFilter !== "ALL") {
        if (ibFilter === NO_IB ? p.ibAccountId !== null : p.ibAccountId !== ibFilter) return false;
      }
      if (sideFilter !== "ALL" && p.side !== sideFilter) return false;
      if (plFilter !== "ALL") {
        const pnl = p.floatingPnl != null ? Number(p.floatingPnl) : null;
        if (pnl == null) return false;
        if (plFilter === "PROFIT" && pnl <= 0) return false;
        if (plFilter === "LOSS" && pnl >= 0) return false;
      }
      return true;
    });
  }, [positionRows, symbolFilter, accountFilter, groupFilter, ibFilter, sideFilter, plFilter]);

  const exposureRows = useMemo(() => {
    type Acc = {
      symbol: string;
      digits: number;
      count: number;
      buyVolume: number;
      sellVolume: number;
      currentPrice: string | null;
      floatingPnl: number;
    };
    const bySymbol = new Map<string, Acc>();
    for (const p of filteredPositions) {
      const entry = bySymbol.get(p.symbolName) ?? {
        symbol: p.symbolName,
        digits: p.digits,
        count: 0,
        buyVolume: 0,
        sellVolume: 0,
        currentPrice: p.currentPrice,
        floatingPnl: 0,
      };
      entry.count += 1;
      const volume = Number(p.volume);
      if (p.side === "BUY") entry.buyVolume += volume;
      else entry.sellVolume += volume;
      if (p.floatingPnl != null) entry.floatingPnl += Number(p.floatingPnl);
      bySymbol.set(p.symbolName, entry);
    }
    const rows = [...bySymbol.values()].map((e) => ({
      symbol: e.symbol,
      count: e.count,
      buyVolume: e.buyVolume.toFixed(2),
      sellVolume: e.sellVolume.toFixed(2),
      netExposure: (e.buyVolume - e.sellVolume).toFixed(2),
      netExposureNum: e.buyVolume - e.sellVolume,
      currentPrice: e.currentPrice,
      floatingPnl: e.floatingPnl,
    }));
    if (sortMode === "exposure") {
      rows.sort((a, b) => Math.abs(b.netExposureNum) - Math.abs(a.netExposureNum));
    } else if (sortMode === "risk") {
      // Highest risk to the broker = symbols where clients are currently
      // winning the most (positive client P&L = money owed if closed now).
      rows.sort((a, b) => b.floatingPnl - a.floatingPnl);
    } else {
      rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
    return rows;
  }, [filteredPositions, sortMode]);

  const totalFloatingPnl = useMemo(
    () => filteredPositions.reduce((sum, p) => sum + (p.floatingPnl != null ? Number(p.floatingPnl) : 0), 0),
    [filteredPositions]
  );

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
      <Card title="Filters">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">Symbol</label>
            <Select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} className="w-32">
              <option value="ALL">All</option>
              {symbols.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">Account</label>
            <Select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} className="w-44">
              <option value="ALL">All</option>
              {accountsWithPositions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.fullName}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">Group</label>
            <Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="w-36">
              <option value="ALL">All</option>
              <option value={NO_GROUP}>— ungrouped —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">IB</label>
            <Select value={ibFilter} onChange={(e) => setIbFilter(e.target.value)} className="w-44">
              <option value="ALL">All</option>
              <option value={NO_IB}>— no IB —</option>
              {ibOptions.map((ib) => (
                <option key={ib.id} value={ib.id}>
                  {ib.accountNumber} — {ib.fullName}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">Side</label>
            <Select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as SideFilter)} className="w-28">
              <option value="ALL">All</option>
              <option value="BUY">Long (BUY)</option>
              <option value="SELL">Short (SELL)</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">P&L</label>
            <Select value={plFilter} onChange={(e) => setPlFilter(e.target.value as PlFilter)} className="w-28">
              <option value="ALL">All</option>
              <option value="PROFIT">Profit</option>
              <option value="LOSS">Loss</option>
            </Select>
          </div>
          {symbolFilter !== "ALL" ||
          accountFilter !== "ALL" ||
          groupFilter !== "ALL" ||
          ibFilter !== "ALL" ||
          sideFilter !== "ALL" ||
          plFilter !== "ALL" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSymbolFilter("ALL");
                setAccountFilter("ALL");
                setGroupFilter("ALL");
                setIbFilter("ALL");
                setSideFilter("ALL");
                setPlFilter("ALL");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </Card>

      <Card
        title="Exposure by symbol"
        description={`${filteredPositions.length} position${filteredPositions.length === 1 ? "" : "s"} in view`}
        action={
          <div className="flex items-center gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-500">Sort by</label>
              <Select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} className="w-32">
                <option value="symbol">Symbol</option>
                <option value="exposure">Exposure</option>
                <option value="risk">Risk</option>
              </Select>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Total floating P&L</p>
              <p className={`font-mono text-lg font-semibold ${totalFloatingPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {totalFloatingPnl.toFixed(2)}
              </p>
            </div>
          </div>
        }
      >
        <Table>
          <TableHead>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell align="right">Positions</TableHeaderCell>
            <TableHeaderCell align="right">Buy volume</TableHeaderCell>
            <TableHeaderCell align="right">Sell volume</TableHeaderCell>
            <TableHeaderCell align="right">Net exposure</TableHeaderCell>
            <TableHeaderCell align="right">Client floating P&L</TableHeaderCell>
            <TableHeaderCell align="right">Current price</TableHeaderCell>
          </TableHead>
          <TableBody>
            {exposureRows.length === 0 ? (
              <TableEmptyState colSpan={7}>No open positions match the current filters.</TableEmptyState>
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
                    className={e.netExposureNum === 0 ? "" : e.netExposureNum > 0 ? "text-emerald-600" : "text-rose-600"}
                  >
                    {e.netExposureNum > 0 ? "+" : ""}
                    {e.netExposure}
                  </TableCell>
                  <TableCell align="right" mono className={e.floatingPnl >= 0 ? "text-emerald-600" : "text-rose-600"}>
                    {e.floatingPnl.toFixed(2)}
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

      <Card title="Open positions" description="Reflects the filters above">
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
            {filteredPositions.length === 0 ? (
              <TableEmptyState colSpan={9}>No open positions match the current filters.</TableEmptyState>
            ) : (
              filteredPositions.map((p) => (
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
