"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
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
  slPrice: string | null;
  tpPrice: string | null;
  isManualOrigin: boolean;
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
// "open a position" modal, a per-row "modify SL/TP" modal, and the open
// positions table with a per-row Close action (full or partial volume).
// Filtering is entirely client-side (same pattern AccountsManager.tsx's
// own search box uses) -- the exposure aggregate and the broker-wide
// total both recompute from whichever subset the filters leave, via
// useMemo, so they always stay in sync with what's on screen.
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

  // --- Open position modal ---
  const [openModalOpen, setOpenModalOpen] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [symbolId, setSymbolId] = useState(symbols[0]?.id ?? "");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [volume, setVolume] = useState("0.01");
  const [openReason, setOpenReason] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  function launchOpenModal() {
    setAccountId(accounts[0]?.id ?? "");
    setSymbolId(symbols[0]?.id ?? "");
    setSide("BUY");
    setVolume("0.01");
    setOpenReason("");
    setOpenError(null);
    setOpenModalOpen(true);
  }

  async function openPosition() {
    if (!openReason.trim()) {
      setOpenError("Reason is required for the audit trail");
      return;
    }
    setOpening(true);
    setOpenError(null);
    const response = await fetch("/api/manage/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, symbolId, side, volume, note: openReason.trim() }),
    });
    setOpening(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setOpenError(body.error ?? "failed to open position");
      return;
    }
    setOpenModalOpen(false);
    router.refresh();
  }

  // --- Modify SL/TP modal ---
  const [modifyTarget, setModifyTarget] = useState<PositionRow | null>(null);
  const [modSl, setModSl] = useState("");
  const [modTp, setModTp] = useState("");
  const [modReason, setModReason] = useState("");
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [modifying, setModifying] = useState(false);

  function openModifyModal(row: PositionRow) {
    setModifyTarget(row);
    setModSl(row.slPrice ?? "");
    setModTp(row.tpPrice ?? "");
    setModReason("");
    setModifyError(null);
  }

  async function submitModify() {
    if (!modifyTarget) return;
    if (!modReason.trim()) {
      setModifyError("Reason is required for the audit trail");
      return;
    }
    setModifying(true);
    setModifyError(null);
    const response = await fetch(`/api/manage/positions/${modifyTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slPrice: modSl.trim() === "" ? null : modSl.trim(),
        tpPrice: modTp.trim() === "" ? null : modTp.trim(),
        reason: modReason.trim(),
      }),
    });
    setModifying(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setModifyError(body.error ?? "modify failed");
      return;
    }
    setModifyTarget(null);
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

  // --- Reverse / Void, per row ---
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reverseVoidErrors, setReverseVoidErrors] = useState<Record<string, string>>({});
  const [reverseConfirm, setReverseConfirm] = useState<PositionRow | null>(null);
  const [voidConfirm, setVoidConfirm] = useState<PositionRow | null>(null);

  async function reversePosition(row: PositionRow) {
    setReversingId(row.id);
    setReverseVoidErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/positions/${row.id}/reverse`, { method: "POST" });
    setReversingId(null);
    setReverseConfirm(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setReverseVoidErrors((prev) => ({ ...prev, [row.id]: body.error ?? "reverse failed" }));
      return;
    }
    router.refresh();
  }

  async function voidPosition(row: PositionRow) {
    setVoidingId(row.id);
    setReverseVoidErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/positions/${row.id}/void`, { method: "POST" });
    setVoidingId(null);
    setVoidConfirm(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setReverseVoidErrors((prev) => ({ ...prev, [row.id]: body.error ?? "void failed" }));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Filters">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-3)]">Symbol</label>
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
            <label className="text-xs font-medium text-[var(--text-3)]">Account</label>
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
            <label className="text-xs font-medium text-[var(--text-3)]">Group</label>
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
            <label className="text-xs font-medium text-[var(--text-3)]">IB</label>
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
            <label className="text-xs font-medium text-[var(--text-3)]">Side</label>
            <Select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as SideFilter)} className="w-28">
              <option value="ALL">All</option>
              <option value="BUY">Long (BUY)</option>
              <option value="SELL">Short (SELL)</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-3)]">P&L</label>
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
              <label className="text-xs font-medium text-[var(--text-3)]">Sort by</label>
              <Select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} className="w-32">
                <option value="symbol">Symbol</option>
                <option value="exposure">Exposure</option>
                <option value="risk">Risk</option>
              </Select>
            </div>
            <div className="text-right">
              <p className="text-xs text-[var(--text-3)]">Total floating P&L</p>
              <p className={`font-mono text-lg font-semibold ${totalFloatingPnl >= 0 ? "text-[var(--buy)]" : "text-[var(--sell)]"}`}>
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
                    className={e.netExposureNum === 0 ? "" : e.netExposureNum > 0 ? "text-[var(--buy)]" : "text-[var(--sell)]"}
                  >
                    {e.netExposureNum > 0 ? "+" : ""}
                    {e.netExposure}
                  </TableCell>
                  <TableCell align="right" mono className={e.floatingPnl >= 0 ? "text-[var(--buy)]" : "text-[var(--sell)]"}>
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

      <Table title="Open positions" description="Reflects the filters above" action={<Button variant="primary" onClick={launchOpenModal}>+ New manual position</Button>}>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell>Side</TableHeaderCell>
          <TableHeaderCell align="right">Volume</TableHeaderCell>
          <TableHeaderCell align="right">Open price</TableHeaderCell>
          <TableHeaderCell align="right">Current price</TableHeaderCell>
          <TableHeaderCell align="right">S/L</TableHeaderCell>
          <TableHeaderCell align="right">T/P</TableHeaderCell>
          <TableHeaderCell align="right">Floating P&L</TableHeaderCell>
          <TableHeaderCell>Opened</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {filteredPositions.length === 0 ? (
            <TableEmptyState colSpan={11}>No open positions match the current filters.</TableEmptyState>
          ) : (
            filteredPositions.map((p) => (
              <TableRow key={p.id}>
                <TableCell primary>
                  {p.accountNumber}
                  <div className="text-xs font-normal text-[var(--text-3)]">{p.accountFullName}</div>
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
                <TableCell align="right" mono className="text-[var(--text-3)]">
                  {p.slPrice ?? "—"}
                </TableCell>
                <TableCell align="right" mono className="text-[var(--text-3)]">
                  {p.tpPrice ?? "—"}
                </TableCell>
                <TableCell
                  align="right"
                  mono
                  className={!p.floatingPnl ? "" : Number(p.floatingPnl) >= 0 ? "text-[var(--buy)]" : "text-[var(--sell)]"}
                >
                  {p.floatingPnl ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{p.openedAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      title="Modify SL/TP"
                      onClick={() => openModifyModal(p)}
                      className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-3)] text-[var(--text-2)] hover:text-[var(--text-1)]"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
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
                    <Button size="sm" variant="ghost" disabled={reversingId === p.id} onClick={() => setReverseConfirm(p)} title="Close and immediately open the opposite side at the current price">
                      Reverse
                    </Button>
                    {p.isManualOrigin ? (
                      <Button size="sm" variant="ghost" disabled={voidingId === p.id} onClick={() => setVoidConfirm(p)} title="Erase this manually-opened position -- no Transaction, not a real trade">
                        Void
                      </Button>
                    ) : null}
                  </div>
                  {closeErrors[p.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{closeErrors[p.id]}</div> : null}
                  {reverseVoidErrors[p.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{reverseVoidErrors[p.id]}</div> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={openModalOpen} onClose={() => setOpenModalOpen(false)} title="New manual position">
        <div className="flex flex-col gap-3">
          <FormField label="Client account">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.fullName}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Symbol">
            <Select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} required>
              {symbols.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Side">
            <Select value={side} onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </Select>
          </FormField>
          <FormField label="Volume (lots)">
            <Input type="text" inputMode="decimal" mono value={volume} onChange={(e) => setVolume(e.target.value)} />
          </FormField>
          <FormField label="Reason (required, logged in audit trail)">
            <textarea
              rows={2}
              value={openReason}
              onChange={(e) => setOpenReason(e.target.value)}
              placeholder="e.g. Phone order — client unable to access platform"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none"
            />
          </FormField>
          {openError ? <p className="text-sm text-[var(--sell)]">{openError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setOpenModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={opening || !accountId || !symbolId} onClick={openPosition}>
              {opening ? "Opening..." : "Open position"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal
        open={modifyTarget !== null}
        onClose={() => setModifyTarget(null)}
        title={modifyTarget ? `Modify position — ${modifyTarget.symbolName} — ${modifyTarget.accountNumber}` : ""}
      >
        <div className="flex flex-col gap-3">
          <FormField label="Stop loss">
            <Input type="text" inputMode="decimal" mono placeholder="—" value={modSl} onChange={(e) => setModSl(e.target.value)} />
          </FormField>
          <FormField label="Take profit">
            <Input type="text" inputMode="decimal" mono placeholder="—" value={modTp} onChange={(e) => setModTp(e.target.value)} />
          </FormField>
          <FormField label="Reason (required, logged in audit trail)">
            <textarea
              rows={2}
              value={modReason}
              onChange={(e) => setModReason(e.target.value)}
              placeholder="e.g. Client requested SL adjustment via support"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none"
            />
          </FormField>
          {modifyError ? <p className="text-sm text-[var(--sell)]">{modifyError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setModifyTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={modifying} onClick={submitModify}>
              {modifying ? "Saving..." : "Save changes"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal open={reverseConfirm !== null} onClose={() => setReverseConfirm(null)} title="Confirm reverse position">
        {reverseConfirm ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Closes {reverseConfirm.accountNumber}&apos;s {reverseConfirm.symbolName} {reverseConfirm.side} at the current live price (realizing
              its P&amp;L), then immediately opens a new {reverseConfirm.side === "BUY" ? "SELL" : "BUY"} position for the same volume at that
              price.
            </p>
            <ModalActions>
              <Button variant="ghost" onClick={() => setReverseConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={reversingId === reverseConfirm.id} onClick={() => reversePosition(reverseConfirm)}>
                {reversingId === reverseConfirm.id ? "Reversing..." : "Confirm reverse"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>

      <Modal open={voidConfirm !== null} onClose={() => setVoidConfirm(null)} title="Confirm void position">
        {voidConfirm ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Erases {voidConfirm.accountNumber}&apos;s manually-opened {voidConfirm.symbolName} {voidConfirm.side} position -- it never moved any
              balance, so nothing is booked. Use this only to correct a mistaken manual entry, not to close a real trade.
            </p>
            <ModalActions>
              <Button variant="ghost" onClick={() => setVoidConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={voidingId === voidConfirm.id} onClick={() => voidPosition(voidConfirm)}>
                {voidingId === voidConfirm.id ? "Voiding..." : "Confirm void"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
