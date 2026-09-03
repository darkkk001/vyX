"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { useAdminEventStream, ADMIN_STREAM_RECONNECTED, type AdminEvent } from "@/lib/admin-realtime";
import { useLiveTicks } from "@/lib/price-stream";

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
  contractSize: string;
  side: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  currentPrice: string | null;
  floatingPnl: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  isManualOrigin: boolean;
  mirrored: boolean;
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

type PositionsData = { rows: PositionRow[]; accounts: AccountOption[]; symbols: SymbolOption[]; groups: GroupOption[]; ibOptions: IbOption[] };

// Exposure monitor: filters, sorting, per-symbol Client Floating P&L, an
// "open a position" modal, a per-row "modify SL/TP" modal, and the open
// positions table with a per-row Close action (full or partial volume).
// Filtering is entirely client-side (same pattern AccountsManager.tsx's
// own search box uses) -- the exposure aggregate and the broker-wide
// total both recompute from whichever subset the filters leave, via
// useMemo, so they always stay in sync with what's on screen. Self-fetches
// everything from the already-existing /api/manage/positions route
// (extended with a GET returning the same shape page.tsx's Server
// Component used to compute) instead of receiving it all as
// server-rendered props.
export default function PositionsManager() {
  const [data, setData] = useState<PositionsData | null>(null);
  const rawRows = data?.rows ?? [];
  const accounts = data?.accounts ?? [];
  const symbols = data?.symbols ?? [];
  const groups = data?.groups ?? [];
  const ibOptions = data?.ibOptions ?? [];

  function reload() {
    return fetch("/api/manage/positions")
      .then((r) => r.json())
      .then(setData);
  }

  // Realtime-sync fix -- this used to be a 5s poll-everything interval
  // specifically to keep currentPrice/floatingPnl (computed server-side
  // per request) tracking the live feed between mutations. Replaced by
  // useLiveTicks below: positions load once, then floating P/L is
  // recomputed client-side on every coalesced price tick, the same math
  // (and the same 20Hz/symbol coalescing) as WebTrader.tsx's own
  // positionPnl. The row LIST itself (opens/closes/modifies) still needs
  // a real refetch -- that's the admin-event-stream reaction below, now
  // the only thing that reloads this page's own data.
  useEffect(() => {
    reload().catch(() => setData({ rows: [], accounts: [], symbols: [], groups: [], ibOptions: [] }));
  }, []);

  // Instant reaction to a fill/close/modify from anywhere (another
  // dealer's action, the trader's own, or an auto-liquidation).
  useAdminEventStream((event: AdminEvent) => {
    if (
      event.type === ADMIN_STREAM_RECONNECTED ||
      event.type === "OrderFilled" ||
      event.type === "PositionClosed" ||
      event.type === "PositionsClosed" ||
      event.type === "PositionModified"
    ) {
      reload().catch(() => {});
    }
  });

  // Recomputes currentPrice/floatingPnl per position on every coalesced
  // tick -- same close-price convention and P/L formula as WebTrader.tsx's
  // own positionPnl (BUY closes at bid, SELL at ask; diff * contractSize *
  // volume), not a Decimal-precision recompute, since this is a live
  // display value, not a source of truth for anything booked to the
  // ledger. A symbol with no tick yet (feed just connected, or this
  // session never got one) keeps showing the server's own value from the
  // last /api/manage/positions fetch -- never blanks out.
  const liveTicks = useLiveTicks();
  const positionRows = useMemo(() => {
    return rawRows.map((p) => {
      const tick = liveTicks[p.symbolName];
      if (!tick) return p;
      const closePrice = p.side === "BUY" ? tick.bid : tick.ask;
      const openPrice = Number(p.openPrice);
      const diff = p.side === "BUY" ? closePrice - openPrice : openPrice - closePrice;
      const floatingPnl = diff * Number(p.contractSize) * Number(p.volume);
      return { ...p, currentPrice: closePrice.toFixed(p.digits), floatingPnl: floatingPnl.toFixed(2) };
    });
  }, [rawRows, liveTicks]);

  // "As of <time>" + live indicator -- ticks the display once a second so
  // the indicator can actually notice the feed going stale, independent
  // of whether a new tick (which would re-render anyway) has arrived.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const symbolsHeld = useMemo(() => new Set(rawRows.map((p) => p.symbolName)), [rawRows]);
  const mostRecentTickAt = useMemo(() => {
    let latest = 0;
    for (const symbol of symbolsHeld) {
      const at = liveTicks[symbol]?.at ?? 0;
      if (at > latest) latest = at;
    }
    return latest;
  }, [liveTicks, symbolsHeld]);
  const priceFeedIsLive = mostRecentTickAt > 0 && nowTick - mostRecentTickAt < 10_000;

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
      // Volume-weighted notional (price * volume) per side, kept separate
      // from a single blended sum -- a dealer judging hedge risk on a
      // mixed book needs "what did the net-long/net-short side actually
      // pay", not a side-blind average across buys and sells entered at
      // completely different price clusters, which would produce a
      // number that means nothing.
      buyNotional: number;
      sellNotional: number;
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
        buyNotional: 0,
        sellNotional: 0,
        currentPrice: p.currentPrice,
        floatingPnl: 0,
      };
      entry.count += 1;
      const volume = Number(p.volume);
      const openPrice = Number(p.openPrice);
      if (p.side === "BUY") {
        entry.buyVolume += volume;
        entry.buyNotional += volume * openPrice;
      } else {
        entry.sellVolume += volume;
        entry.sellNotional += volume * openPrice;
      }
      if (p.floatingPnl != null) entry.floatingPnl += Number(p.floatingPnl);
      bySymbol.set(p.symbolName, entry);
    }
    const rows = [...bySymbol.values()].map((e) => {
      const netExposureNum = e.buyVolume - e.sellVolume;
      const buyAvg = e.buyVolume > 0 ? e.buyNotional / e.buyVolume : null;
      const sellAvg = e.sellVolume > 0 ? e.sellNotional / e.sellVolume : null;
      // Net-side-aware: the average entry price of whichever side is
      // actually driving the net exposure a dealer would need to hedge --
      // a flat book (net exposure exactly 0) has no single "net side", so
      // there's nothing meaningful to show.
      const netAvgPrice = netExposureNum > 0 ? buyAvg : netExposureNum < 0 ? sellAvg : null;
      return {
        symbol: e.symbol,
        count: e.count,
        digits: e.digits,
        buyVolume: e.buyVolume.toFixed(2),
        sellVolume: e.sellVolume.toFixed(2),
        netExposure: netExposureNum.toFixed(2),
        netExposureNum,
        netAvgPrice,
        currentPrice: e.currentPrice,
        floatingPnl: e.floatingPnl,
      };
    });
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
  const [openPrice, setOpenPrice] = useState("");
  const [openSl, setOpenSl] = useState("");
  const [openTp, setOpenTp] = useState("");
  const [openReason, setOpenReason] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  function launchOpenModal() {
    setAccountId(accounts[0]?.id ?? "");
    setSymbolId(symbols[0]?.id ?? "");
    setSide("BUY");
    setVolume("0.01");
    setOpenPrice("");
    setOpenSl("");
    setOpenTp("");
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
      body: JSON.stringify({
        accountId,
        symbolId,
        side,
        volume,
        price: openPrice.trim() || undefined,
        slPrice: openSl.trim() || undefined,
        tpPrice: openTp.trim() || undefined,
        note: openReason.trim(),
      }),
    });
    setOpening(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setOpenError(body.error ?? "failed to open position");
      return;
    }
    setOpenModalOpen(false);
    reload().catch(() => {});
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
    reload().catch(() => {});
  }

  // --- Close action, per row ---
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeErrors, setCloseErrors] = useState<Record<string, string>>({});
  const [partialVolume, setPartialVolume] = useState<Record<string, string>>({});
  const [closeConfirm, setCloseConfirm] = useState<PositionRow | null>(null);

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
    setCloseConfirm(null);
    reload().catch(() => {});
  }

  // --- Reverse / Void / Delete, per row -- VYX-POSITION-TOOLS-V0.
  // Every one of these three can come back 202 {pending, requestId}
  // instead of 200 -- a MANAGER's call only ever files a
  // PositionActionRequest (see lib/position-actions.ts's
  // positionActionNeedsApproval); the position itself hasn't changed
  // yet, so this only closes the modal with a "submitted for approval"
  // toast and refreshes the pending-approvals panel, not the position
  // list. A BROKER_ADMIN's call executes immediately (200), same as
  // before -- reload() as usual.
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reverseVoidErrors, setReverseVoidErrors] = useState<Record<string, string>>({});
  const [reverseConfirm, setReverseConfirm] = useState<PositionRow | null>(null);
  const [reverseMode, setReverseMode] = useState<"IN_PLACE" | "CLOSE_REOPEN">("IN_PLACE");
  const [voidConfirm, setVoidConfirm] = useState<PositionRow | null>(null);
  const [pendingSubmittedToast, setPendingSubmittedToast] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingSubmittedToast) return;
    const t = setTimeout(() => setPendingSubmittedToast(null), 4000);
    return () => clearTimeout(t);
  }, [pendingSubmittedToast]);

  async function reversePosition(row: PositionRow) {
    setReversingId(row.id);
    setReverseVoidErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/positions/${row.id}/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: reverseMode }),
    });
    setReversingId(null);
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) {
      setReverseConfirm(null);
      setPendingSubmittedToast("Reverse submitted for approval");
      reloadPendingActions().catch(() => {});
      return;
    }
    if (!response.ok) {
      setReverseVoidErrors((prev) => ({ ...prev, [row.id]: body.error ?? "reverse failed" }));
      return;
    }
    setReverseConfirm(null);
    reload().catch(() => {});
  }

  async function voidPosition(row: PositionRow) {
    setVoidingId(row.id);
    setReverseVoidErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/positions/${row.id}/void`, { method: "POST" });
    setVoidingId(null);
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) {
      setVoidConfirm(null);
      setPendingSubmittedToast("Void submitted for approval");
      reloadPendingActions().catch(() => {});
      return;
    }
    if (!response.ok) {
      setReverseVoidErrors((prev) => ({ ...prev, [row.id]: body.error ?? "void failed" }));
      return;
    }
    setVoidConfirm(null);
    reload().catch(() => {});
  }

  // Delete lives on the Deals page (/manage/deals), not here -- it's only
  // ever eligible on an already-CLOSED/VOIDED position (see
  // lib/position-actions.ts's executeDelete), and this page only ever
  // shows OPEN ones.

  // --- Pending approvals (MANAGER-filed requests a different admin must
  // review) -- kept in-page rather than a separate route so the whole
  // request -> approve loop is testable from one screen.
  type PendingAction = {
    id: string;
    actionType: "REVERSE_IN_PLACE" | "REVERSE_CLOSE_REOPEN" | "VOID" | "DELETE";
    status: "PENDING" | "APPROVED" | "REJECTED";
    reason: string | null;
    createdAt: string;
    requestedByName: string;
    position: { symbolName: string; side: "BUY" | "SELL"; volume: string; accountNumber: string; accountFullName: string };
  };
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [pendingActionErrors, setPendingActionErrors] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  function reloadPendingActions() {
    return fetch("/api/manage/position-action-requests")
      .then((r) => (r.ok ? r.json() : []))
      .then(setPendingActions);
  }
  useEffect(() => {
    reloadPendingActions().catch(() => {});
  }, []);

  const ACTION_TYPE_LABELS: Record<PendingAction["actionType"], string> = {
    REVERSE_IN_PLACE: "Reverse (in-place flip)",
    REVERSE_CLOSE_REOPEN: "Reverse (close & reopen)",
    VOID: "Void",
    DELETE: "Delete",
  };

  async function reviewPendingAction(id: string, decision: "approve" | "reject") {
    setReviewingId(id);
    setPendingActionErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/position-action-requests/${id}/${decision}`, { method: "POST" });
    setReviewingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setPendingActionErrors((prev) => ({ ...prev, [id]: body.error ?? `${decision} failed` }));
      return;
    }
    reloadPendingActions().catch(() => {});
    reload().catch(() => {});
  }

  // --- Bulk close, one account at a time -- only enabled once the
  // Account filter above picks one specific account (closing "all
  // accounts currently in view" is not what this button does). Shares
  // lib/bulk-close.ts's one-transaction, one-price-snapshot-per-symbol
  // core with the trader terminal's own Close all/profitable/losing.
  const [bulkCloseConfirm, setBulkCloseConfirm] = useState(false);
  const [bulkClosing, setBulkClosing] = useState(false);
  const [bulkCloseError, setBulkCloseError] = useState<string | null>(null);
  const bulkCloseAccount = accountFilter !== "ALL" ? accounts.find((a) => a.id === accountFilter) : null;

  async function submitBulkClose() {
    if (!bulkCloseAccount) return;
    setBulkClosing(true);
    setBulkCloseError(null);
    const response = await fetch("/api/manage/positions/close-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: bulkCloseAccount.id, scope: "ALL" }),
    });
    setBulkClosing(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setBulkCloseError(body.error ?? "close failed");
      return;
    }
    setBulkCloseConfirm(false);
    reload().catch(() => {});
  }

  if (data === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--text-3)]">
          {positionRows.length} open position{positionRows.length === 1 ? "" : "s"} across this broker.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-3)]" title="Floating P/L and current price update live from the price-tick feed; the position list itself updates on fill/close/modify events">
          <span className={`inline-block h-2 w-2 rounded-full ${priceFeedIsLive ? "bg-[var(--buy)]" : "bg-[var(--text-3)]"}`} />
          {priceFeedIsLive
            ? `Live prices — as of ${new Date(mostRecentTickAt).toLocaleTimeString()}`
            : mostRecentTickAt > 0
              ? `Price feed stale — last tick ${new Date(mostRecentTickAt).toLocaleTimeString()}`
              : "Price feed connecting…"}
        </div>
      </div>

      {pendingSubmittedToast ? (
        <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-3 py-2 text-sm text-[var(--accent)]">
          {pendingSubmittedToast} -- a different admin needs to review it below before it takes effect.
        </div>
      ) : null}

      {pendingActions.length > 0 ? (
        <Card title={`Pending approvals (${pendingActions.length})`}>
          <div className="flex flex-col gap-2">
            {pendingActions.map((req) => (
              <div key={req.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-2.5">
                <div className="text-sm">
                  <Badge tone="warning">{ACTION_TYPE_LABELS[req.actionType]}</Badge>{" "}
                  <span className="text-[var(--text-1)]">
                    {req.position.accountNumber} — {req.position.symbolName} {req.position.side} {req.position.volume}
                  </span>
                  <span className="block text-xs text-[var(--text-3)] mt-0.5">
                    Requested by {req.requestedByName} · {new Date(req.createdAt).toLocaleString()}
                    {req.reason ? ` · "${req.reason}"` : ""}
                  </span>
                  {pendingActionErrors[req.id] ? <span className="block text-xs text-[var(--sell)] mt-0.5">{pendingActionErrors[req.id]}</span> : null}
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" disabled={reviewingId === req.id} onClick={() => reviewPendingAction(req.id, "reject")}>
                    Reject
                  </Button>
                  <Button size="sm" variant="success" disabled={reviewingId === req.id} onClick={() => reviewPendingAction(req.id, "approve")}>
                    {reviewingId === req.id ? "Working..." : "Approve"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

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
            <TableHeaderCell align="right" title="Volume-weighted average open price of the side driving net exposure (net-side-aware VWAP) -- helps judge hedge levels.">
              Avg open price (net)
            </TableHeaderCell>
            <TableHeaderCell align="right">Client floating P&L</TableHeaderCell>
            <TableHeaderCell align="right">Current price</TableHeaderCell>
          </TableHead>
          <TableBody>
            {exposureRows.length === 0 ? (
              <TableEmptyState colSpan={8}>No open positions match the current filters.</TableEmptyState>
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
                  <TableCell align="right" mono>
                    {e.netAvgPrice != null ? e.netAvgPrice.toFixed(e.digits) : "—"}
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

      <Table
        title="Open positions"
        description="Reflects the filters above"
        action={
          <div className="flex items-center gap-2">
            {bulkCloseAccount ? (
              <Button variant="danger" onClick={() => setBulkCloseConfirm(true)}>
                Close all for {bulkCloseAccount.accountNumber}
              </Button>
            ) : null}
            <Button variant="primary" onClick={launchOpenModal}>+ New manual position</Button>
          </div>
        }
      >
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
                  <ActionMenu
                    items={[
                      { label: "Modify SL/TP", onClick: () => openModifyModal(p) },
                      { label: "Close position", onClick: () => setCloseConfirm(p) },
                      {
                        label: "Reverse",
                        onClick: () => { setReverseMode("IN_PLACE"); setReverseConfirm(p); },
                        title: "Flip the position's side in place, or close & reopen opposite at market",
                      },
                      {
                        label: "Void",
                        onClick: () => setVoidConfirm(p),
                        tone: "danger" as const,
                        title: "Cancel this position as if it never produced a P/L -- balance restored, hidden from the trader's statement",
                      },
                    ]}
                  />
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
          <FormField label="Price (blank = current market price)">
            <Input
              type="text"
              inputMode="decimal"
              mono
              value={openPrice}
              onChange={(e) => setOpenPrice(e.target.value)}
              placeholder="e.g. 2415.30 — leave blank to fill at CMP"
            />
          </FormField>
          <FormField label="Stop loss (optional)">
            <Input type="text" inputMode="decimal" mono value={openSl} onChange={(e) => setOpenSl(e.target.value)} />
          </FormField>
          <FormField label="Take profit (optional)">
            <Input type="text" inputMode="decimal" mono value={openTp} onChange={(e) => setOpenTp(e.target.value)} />
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

      <Modal open={bulkCloseConfirm} onClose={() => setBulkCloseConfirm(false)} title="Confirm bulk close">
        {bulkCloseAccount ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Closes every open position for {bulkCloseAccount.accountNumber} ({bulkCloseAccount.fullName}) in one
              transaction, at one live-price snapshot per symbol. This cannot be undone.
            </p>
            {bulkCloseError ? <div className="text-xs text-[var(--sell)]">{bulkCloseError}</div> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setBulkCloseConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={bulkClosing} onClick={submitBulkClose}>
                {bulkClosing ? "Closing..." : "Close all"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>

      <Modal open={closeConfirm !== null} onClose={() => setCloseConfirm(null)} title="Confirm close position">
        {closeConfirm ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Closes {closeConfirm.accountNumber}&apos;s {closeConfirm.symbolName} {closeConfirm.side} at the current live price.
            </p>
            <FormField label={`Volume (leave blank to close the full ${closeConfirm.volume})`}>
              <Input
                type="text"
                inputMode="decimal"
                placeholder={`up to ${closeConfirm.volume}`}
                value={partialVolume[closeConfirm.id] ?? ""}
                onChange={(e) => setPartialVolume((prev) => ({ ...prev, [closeConfirm.id]: e.target.value }))}
                mono
              />
            </FormField>
            {closeErrors[closeConfirm.id] ? <div className="text-xs text-[var(--sell)]">{closeErrors[closeConfirm.id]}</div> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setCloseConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={closingId === closeConfirm.id} onClick={() => closePosition(closeConfirm)}>
                {closingId === closeConfirm.id ? "Closing..." : "Confirm close"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>

      <Modal open={reverseConfirm !== null} onClose={() => setReverseConfirm(null)} title="Confirm reverse position">
        {reverseConfirm ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 cursor-pointer rounded-lg border border-[var(--border)] p-2.5 has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-bg)]">
                <input type="radio" name="reverseMode" className="mt-0.5" checked={reverseMode === "IN_PLACE"} onChange={() => setReverseMode("IN_PLACE")} />
                <span className="text-sm">
                  <span className="font-medium text-[var(--text-1)]">Flip in place</span>
                  <span className="block text-xs text-[var(--text-2)] mt-0.5">
                    Same position, same entry price ({reverseConfirm.openPrice}) -- side flips {reverseConfirm.side} →{" "}
                    {reverseConfirm.side === "BUY" ? "SELL" : "BUY"}, floating P/L sign flips with it. No close, no new position, no realized P/L
                    event, no Transaction. Margin recalculates live for the new side.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer rounded-lg border border-[var(--border)] p-2.5 has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-bg)]">
                <input type="radio" name="reverseMode" className="mt-0.5" checked={reverseMode === "CLOSE_REOPEN"} onChange={() => setReverseMode("CLOSE_REOPEN")} />
                <span className="text-sm">
                  <span className="font-medium text-[var(--text-1)]">Close &amp; reopen opposite @ market</span>
                  <span className="block text-xs text-[var(--text-2)] mt-0.5">
                    Closes {reverseConfirm.symbolName} {reverseConfirm.side} at the current live price (realizing its P&amp;L, booked to the
                    ledger), then immediately opens a new {reverseConfirm.side === "BUY" ? "SELL" : "BUY"} position for the same volume at that
                    price.
                  </span>
                </span>
              </label>
            </div>
            {reverseConfirm.mirrored ? (
              <div className="rounded-lg border border-[var(--warn)]/30 bg-[var(--warn-bg)] px-2.5 py-2 text-xs text-[var(--warn)]">
                {reverseConfirm.accountNumber} is in a mirrored group -- this account&apos;s mirror target won&apos;t follow this correction
                automatically.
              </div>
            ) : null}
            {reverseVoidErrors[reverseConfirm.id] ? <div className="text-xs text-[var(--sell)]">{reverseVoidErrors[reverseConfirm.id]}</div> : null}
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
              Cancels {voidConfirm.accountNumber}&apos;s {voidConfirm.symbolName} {voidConfirm.side} position as if it never produced a P/L --
              balance is restored to its pre-open state (any commission/swap already booked against it is reversed with a ledger entry), the
              position is marked VOIDED. Visible to admins on the Deals page; hidden from the trader&apos;s own statement -- Delete (full
              removal) is available there too, once it&apos;s no longer open.
            </p>
            {reverseVoidErrors[voidConfirm.id] ? <div className="text-xs text-[var(--sell)]">{reverseVoidErrors[voidConfirm.id]}</div> : null}
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
