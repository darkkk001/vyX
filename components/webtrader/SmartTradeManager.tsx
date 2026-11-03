"use client";

import { useEffect, useMemo, useState } from "react";
import { SYMBOL_DEFS, fmt, type MarketState, type SymbolDef } from "@/lib/market-simulator";
import { tradeApi, effectiveAsk, effectiveClose, type ApiPosition, type SpreadRule } from "@/lib/trade-api";
import {
  registerHotkeys,
  hotkeyToLabel,
  eventToBinding,
  findConflict,
  type HotkeyBinding,
} from "@/lib/hotkeys";
import { tradeActionError, TRADE_TEXT } from "@/lib/plain-error";

// Smart Trade Manager (STM): a trader configures order parameters once,
// then repeatedly fires them via keyboard hotkeys ("Smart Execution") or
// applies bulk position actions (break-even, %-based partial close, plus
// the close-profitable/losing/all actions WebTrader.tsx already has,
// re-surfaced here with BUY/SELL/selected scoping). Every action funnels
// through the exact same /api/trade/orders, /positions/[id]/close, and
// /positions/[id] (SL/TP) routes the rest of WebTrader already uses --
// this module adds no new Trading Core/Risk Engine surface, only client
// orchestration and a hotkey layer on top of what already exists.

const STORAGE_KEY = "vyx-stm-config";

// Native-terminal alignment (owner 2026-11-03): the panel uses the order ticket's label / value
// rows (.nt-row) and compact segmented controls (.stm-seg), which fit the right column at its 260 px minimum.

type OrderType = "MARKET" | "LIMIT" | "STOP";
type CloseScope = "ALL_SYMBOLS" | "CURRENT_SYMBOL" | "SELECTED";
type DirectionFilter = "ALL" | "BUY" | "SELL";

type StmConfig = {
  symbol: string;
  orderType: OrderType;
  lot: number;
  sl: string;
  tp: string;
  buyHotkey: HotkeyBinding | null;
  sellHotkey: HotkeyBinding | null;
  smartExecution: boolean;
};

const DEFAULT_CONFIG: StmConfig = {
  symbol: SYMBOL_DEFS[0]?.name ?? "XAUUSD",
  orderType: "MARKET",
  lot: 0.01,
  sl: "",
  tp: "",
  buyHotkey: { key: "1", ctrl: true, alt: false, shift: false },
  sellHotkey: { key: "2", ctrl: true, alt: false, shift: false },
  smartExecution: false,
};

function loadConfig(): StmConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    // Smart Execution always reloads OFF -- a saved "ON" state from a
    // previous session firing hotkeys the instant the page loads (before
    // the trader has looked at the panel again) is exactly the kind of
    // surprise the confirmation warning exists to prevent.
    return { ...DEFAULT_CONFIG, ...parsed, smartExecution: false };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: StmConfig) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // best-effort; STM still works for the current session without persistence
  }
}

export type BulkResult = { requested: number; successful: number; failed: number; reasons: string[] };

export default function SmartTradeManager({
  open,
  onClose,
  embedded = false,
  symbols,
  market,
  askMarkupBySymbol,
  positions,
  positionPnl,
  activeSymbol,
  selectedPositionIds,
  pushToast,
  refreshPositions,
  refreshHistory,
  refreshAccount,
}: {
  open: boolean;
  onClose: () => void;
  // Renders the panel content directly (no overlay/backdrop/close
  // button) instead of as a modal -- WebTrader.tsx's Watchlist column
  // uses this to show it permanently, always visible, rather than behind a
  // rail icon. `open` is ignored when true; the confirm-enable dialog
  // still overlays normally either way.
  embedded?: boolean;
  // WebTrader's own real, broker-enabled symbol universe (allSymbols) --
  // this panel's own symbol dropdown used to read the hardcoded
  // SYMBOL_DEFS bootstrap directly, capping it at 10.
  symbols: SymbolDef[];
  market: Record<string, MarketState>;
  // 2026-09-05 P0 fix -- this account's effective spread markup per symbol
  // (raw price units), same shape/source as WebTrader.tsx's own state.
  // See lib/trade-api.ts's ApiLivePrice/effectiveAsk comments for why this
  // is a separate value rather than baked into market[symbol].ask itself.
  askMarkupBySymbol: Record<string, SpreadRule>;
  positions: ApiPosition[];
  positionPnl: (p: ApiPosition) => number;
  activeSymbol: string;
  selectedPositionIds: Set<string>;
  pushToast: (msg: string, success?: boolean) => void;
  refreshPositions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  refreshAccount: () => Promise<void>;
}) {
  const [config, setConfig] = useState<StmConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [capturingHotkey, setCapturingHotkey] = useState<"buy" | "sell" | null>(null);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [closeScope, setCloseScope] = useState<CloseScope>("ALL_SYMBOLS");
  const [closeDirection, setCloseDirection] = useState<DirectionFilter>("ALL");
  const [customPct, setCustomPct] = useState("50");
  const [beOffset, setBeOffset] = useState("0");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConfig(loadConfig());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) saveConfig(config);
  }, [config, loaded]);

  // Capture the next real keypress as a hotkey assignment, rather than a
  // separate dropdown-of-every-key UI -- matches how every other trading
  // terminal's hotkey picker works ("press a key now").
  useEffect(() => {
    if (!capturingHotkey) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      if (e.key === "Escape") { setCapturingHotkey(null); return; }
      const binding = eventToBinding(e);
      const other = capturingHotkey === "buy" ? "Sell hotkey" : "Buy hotkey";
      const conflict = findConflict(binding, [
        { label: other, binding: capturingHotkey === "buy" ? config.sellHotkey : config.buyHotkey },
      ]);
      if (conflict) {
        pushToast(`That combination is already assigned to ${conflict}`);
        setCapturingHotkey(null);
        return;
      }
      setConfig((c) => ({ ...c, [capturingHotkey === "buy" ? "buyHotkey" : "sellHotkey"]: binding }));
      setCapturingHotkey(null);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [capturingHotkey, config.buyHotkey, config.sellHotkey, pushToast]);

  const m = market[config.symbol];

  // Mirrors lib/trading.ts's validateSlTp exactly (side-aware: SL below/
  // above reference for BUY/SELL, TP the opposite) -- this is UX-only
  // feedback, the server call below re-validates with the same rule
  // authoritatively regardless of what this shows.
  // 2026-09-05 P0 fix: the BUY-side reference used throughout this file
  // is the marked-up ask (what a BUY will actually open at), not the raw
  // feed ask -- matches placeOrder's own fix in WebTrader.tsx.
  const buyAsk = m ? effectiveAsk(askMarkupBySymbol, config.symbol, m.ask, m.bid) : 0;
  const slValidity = useMemo(() => {
    if (!m || !m.live || config.sl === "") return null;
    const sl = parseFloat(config.sl);
    if (isNaN(sl)) return null;
    // BUY reference is ask, SELL is bid; SL side depends on which hotkey fires, so validate against both and report the worse case
    const validForBuy = sl < buyAsk;
    const validForSell = sl > m.bid;
    return { validForBuy, validForSell };
  }, [m, config.sl, buyAsk]);
  const tpValidity = useMemo(() => {
    if (!m || !m.live || config.tp === "") return null;
    const tp = parseFloat(config.tp);
    if (isNaN(tp)) return null;
    const validForBuy = tp > buyAsk;
    const validForSell = tp < m.bid;
    return { validForBuy, validForSell };
  }, [m, config.tp, buyAsk]);

  async function smartExecute(side: "BUY" | "SELL") {
    if (!m || !m.live) { pushToast("No live feed for this symbol"); return; }
    const sl = config.sl === "" ? null : parseFloat(config.sl);
    const tp = config.tp === "" ? null : parseFloat(config.tp);
    const refPrice = side === "BUY" ? buyAsk : m.bid;
    if (sl != null && ((side === "BUY" && sl >= refPrice) || (side === "SELL" && sl <= m.bid))) {
      pushToast(`Invalid Stop Loss, SL must be ${side === "BUY" ? "below" : "above"} the current market price`);
      return;
    }
    if (tp != null && ((side === "BUY" && tp <= refPrice) || (side === "SELL" && tp >= m.bid))) {
      pushToast(`Invalid Take Profit, TP must be ${side === "BUY" ? "above" : "below"} the current market price`);
      return;
    }
    try {
      // A fresh idempotencyKey per call: two genuine hotkey presses are
      // two intended orders (fine), while the browser firing one keydown
      // event twice (key repeat, a stray duplicate event) reuses this
      // same call once, never producing a duplicate order server-side.
      const result = await tradeApi.placeOrder({
        symbol: config.symbol, side, type: config.orderType, volume: config.lot, price: refPrice,
        slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID(), source: "hotkey",
      });
      if (result.position) {
        pushToast(`Smart Execution: ${side === "BUY" ? "Bought" : "Sold"} ${config.lot} lots of ${config.symbol} @ ${fmt(refPrice, m.def.digits)}`, true);
        await Promise.all([refreshPositions(), refreshAccount()]);
      } else {
        pushToast(`Smart Execution: ${config.symbol} order submitted, awaiting dealer approval`);
      }
    } catch (err) {
      pushToast(tradeActionError(err));
    }
  }

  useEffect(() => {
    return registerHotkeys(
      [
        { binding: config.buyHotkey, handler: () => smartExecute("BUY") },
        { binding: config.sellHotkey, handler: () => smartExecute("SELL") },
      ],
      config.smartExecution
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.buyHotkey, config.sellHotkey, config.smartExecution, config.symbol, config.orderType, config.lot, config.sl, config.tp, m]);

  function matchesScope(p: ApiPosition, scope: CloseScope, direction: DirectionFilter): boolean {
    if (direction !== "ALL" && p.side !== direction) return false;
    if (scope === "CURRENT_SYMBOL" && p.symbol.name !== activeSymbol) return false;
    if (scope === "SELECTED" && !selectedPositionIds.has(p.id)) return false;
    return true;
  }

  async function runBulk(
    label: string,
    matching: ApiPosition[],
    action: (p: ApiPosition) => Promise<void>
  ) {
    if (matching.length === 0) { pushToast("No matching positions"); return; }
    setBusy(true);
    const results = await Promise.allSettled(matching.map(action));
    setBusy(false);
    const failed = results.filter((r) => r.status === "rejected");
    const reasons = failed.map((r) => {
      const reason = (r as PromiseRejectedResult).reason;
      return /no live feed/i.test(reason?.message ?? "") ? TRADE_TEXT.prices : tradeActionError(reason);
    });
    pushToast(
      `${label}, Requested: ${matching.length}, Successful: ${matching.length - failed.length}, Failed: ${failed.length}` +
        (reasons.length ? ` (${reasons[0]}${reasons.length > 1 ? ", …" : ""})` : ""),
      failed.length === 0
    );
    await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
  }

  async function partialCloseOne(p: ApiPosition, pct: number) {
    const mm = market[p.symbol.name];
    if (!mm || !mm.live) throw new Error(`${p.symbol.name}: no live feed`);
    const price = effectiveClose(askMarkupBySymbol, p.symbol.name, p.side, mm.ask, mm.bid); // symmetric: BUY closes at the account's bid, SELL at its ask
    const amount = +(parseFloat(p.volume) * pct).toFixed(2);
    if (amount <= 0 || amount >= parseFloat(p.volume)) throw new Error(`${p.symbol.name}: invalid partial volume`);
    await tradeApi.closePosition(p.id, price, amount, "stm_bulk");
  }

  async function breakEvenOne(p: ApiPosition, offset: number) {
    const mm = market[p.symbol.name];
    if (!mm || !mm.live) throw new Error(`${p.symbol.name}: no live feed`);
    const currentPrice = effectiveClose(askMarkupBySymbol, p.symbol.name, p.side, mm.ask, mm.bid);
    const newSl = p.side === "BUY" ? parseFloat(p.openPrice) + offset : parseFloat(p.openPrice) - offset;
    await tradeApi.editPositionSlTp(p.id, { currentPrice, slPrice: newSl });
  }

  function partialClosePct(pct: number) {
    const matching = positions.filter((p) => matchesScope(p, closeScope, closeDirection));
    runBulk(`Partial close ${Math.round(pct * 100)}%`, matching, (p) => partialCloseOne(p, pct));
  }
  function partialCloseCustom() {
    const pct = parseFloat(customPct) / 100;
    if (isNaN(pct) || pct <= 0 || pct >= 1) { pushToast("Enter a percentage between 1 and 99"); return; }
    partialClosePct(pct);
  }
  function breakEven() {
    const offset = parseFloat(beOffset) || 0;
    const matching = positions.filter((p) => matchesScope(p, closeScope, closeDirection));
    runBulk("Break-even", matching, (p) => breakEvenOne(p, offset));
  }
  async function closeOne(p: ApiPosition) {
    const mm = market[p.symbol.name];
    if (!mm || !mm.live) throw new Error(`${p.symbol.name}: no live feed`);
    const price = effectiveClose(askMarkupBySymbol, p.symbol.name, p.side, mm.ask, mm.bid); // symmetric: BUY closes at the account's bid, SELL at its ask
    await tradeApi.closePosition(p.id, price, undefined, "stm_bulk");
  }
  function closeProfitable() {
    const matching = positions.filter((p) => matchesScope(p, closeScope, closeDirection) && positionPnl(p) >= 0);
    runBulk("Close profitable", matching, closeOne);
  }
  function closeLosing() {
    const matching = positions.filter((p) => matchesScope(p, closeScope, closeDirection) && positionPnl(p) < 0);
    runBulk("Close losing", matching, closeOne);
  }
  function closeAll() {
    const matching = positions.filter((p) => matchesScope(p, closeScope, closeDirection));
    runBulk("Close", matching, closeOne);
  }

  if (!embedded && !open) return null;

  // `card` is the actual panel content -- identical whether shown as a
  // modal (rail-icon click, open/onClose) or embedded permanently below
  // the Watchlist (embedded=true, WebTrader.tsx's own toggle instead of
  // onClose). Only the chrome around it (overlay/backdrop/close button)
  // differs.
  const tag = (v: { validForBuy: boolean; validForSell: boolean } | null) =>
    v == null ? null
      : v.validForBuy && v.validForSell ? <span className="stm-tag ok">Valid</span>
      : v.validForBuy ? <span className="stm-tag buy">Buy only</span>
      : v.validForSell ? <span className="stm-tag sell">Sell only</span>
      : <span className="stm-tag err">Invalid</span>;
  const invalid = (raw: string, v: { validForBuy: boolean; validForSell: boolean } | null) => raw !== "" && v != null && !v.validForBuy && !v.validForSell;

  const card = (
    <div className={embedded ? "stm" : "generic-modal-card stm stm-modal"}>
      {embedded ? null : <div className="generic-modal-title">Smart Trade Manager</div>}
      <div className="stm-head">
        <span className="stm-sub">Hotkey orders</span>
        <button
          type="button"
          className={`stm-enable${config.smartExecution ? " on" : ""}`}
          aria-pressed={config.smartExecution}
          title={config.smartExecution ? "Smart Execution is on: the hotkeys place orders. Click to turn it off." : "Turn on Smart Execution"}
          onClick={() => { if (config.smartExecution) setConfig((c) => ({ ...c, smartExecution: false })); else setConfirmEnable(true); }}
        >
          {config.smartExecution ? "On" : "Enable"}
        </button>
      </div>

      <div className="nt-rows">
        <div className="nt-row">
          <span className="nt-row-label">Symbol</span>
          <select className="nt-select mono" aria-label="Symbol" value={config.symbol} onChange={(e) => setConfig((c) => ({ ...c, symbol: e.target.value }))}>
            {symbols.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Order type</span>
          <span className="stm-seg" role="group" aria-label="Order type">
            {(["MARKET", "LIMIT", "STOP"] as const).map((t) => (
              <button key={t} type="button" aria-pressed={config.orderType === t} className={config.orderType === t ? "active" : ""} onClick={() => setConfig((c) => ({ ...c, orderType: t }))}>{t}</button>
            ))}
          </span>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Lot size</span>
          <input className="nt-input mono" aria-label="Lot size" type="number" step="0.01" min="0.01" value={config.lot}
            onChange={(e) => setConfig((c) => ({ ...c, lot: parseFloat(e.target.value) || 0.01 }))} />
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Stop loss {tag(slValidity)}</span>
          <input className={`nt-input mono${invalid(config.sl, slValidity) ? " invalid" : ""}`} aria-label="Stop loss" placeholder="SL" type="number" step="any" value={config.sl}
            onChange={(e) => setConfig((c) => ({ ...c, sl: e.target.value }))} />
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Take profit {tag(tpValidity)}</span>
          <input className={`nt-input mono${invalid(config.tp, tpValidity) ? " invalid" : ""}`} aria-label="Take profit" placeholder="TP" type="number" step="any" value={config.tp}
            onChange={(e) => setConfig((c) => ({ ...c, tp: e.target.value }))} />
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Buy key</span>
          <button type="button" className={`stm-key buy${capturingHotkey === "buy" ? " capturing" : ""}`} onClick={() => setCapturingHotkey("buy")} title="Click, then press the key for a BUY">
            {capturingHotkey === "buy" ? "Press a key" : hotkeyToLabel(config.buyHotkey)}
          </button>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Sell key</span>
          <button type="button" className={`stm-key sell${capturingHotkey === "sell" ? " capturing" : ""}`} onClick={() => setCapturingHotkey("sell")} title="Click, then press the key for a SELL">
            {capturingHotkey === "sell" ? "Press a key" : hotkeyToLabel(config.sellHotkey)}
          </button>
        </div>
      </div>

      <div className="stm-head stm-head-sep"><span className="stm-sub">Position actions</span></div>
      <div className="nt-rows">
        <div className="nt-row">
          <span className="nt-row-label">Scope</span>
          <select className="nt-select" aria-label="Scope" value={closeScope} onChange={(e) => setCloseScope(e.target.value as CloseScope)}>
            <option value="ALL_SYMBOLS">All symbols</option>
            <option value="CURRENT_SYMBOL">{activeSymbol}</option>
            <option value="SELECTED">Selected ({selectedPositionIds.size})</option>
          </select>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Direction</span>
          <span className="stm-seg" role="group" aria-label="Direction">
            {(["ALL", "BUY", "SELL"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={closeDirection === d} className={`${d === "BUY" ? "buy" : d === "SELL" ? "sell" : ""}${closeDirection === d ? " active" : ""}`} onClick={() => setCloseDirection(d)}>{d}</button>
            ))}
          </span>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Break-even</span>
          <span className="stm-inline">
            <input className="nt-input mono stm-narrow" aria-label="Break-even offset from the entry price" placeholder="Offset" type="number" step="any" value={beOffset} onChange={(e) => setBeOffset(e.target.value)} />
            <button type="button" className="stm-btn" disabled={busy} onClick={breakEven}>Apply</button>
          </span>
        </div>
        <div className="nt-row">
          <span className="nt-row-label">Partial close</span>
          <span className="stm-inline">
            <input className="nt-input mono stm-narrow" aria-label="Percent to close" type="number" min="1" max="99" value={customPct} onChange={(e) => setCustomPct(e.target.value)} />
            <button type="button" className="stm-btn" disabled={busy} onClick={partialCloseCustom}>Close %</button>
          </span>
        </div>
        <div className="nt-row nt-row-presets">
          {[0.25, 0.5, 0.75].map((f) => (
            <button key={f} type="button" className="lot-preset" disabled={busy} onClick={() => partialClosePct(f)}>{f * 100}%</button>
          ))}
        </div>
      </div>
      <div className="stm-close-row">
        <button type="button" className="stm-btn" disabled={busy} onClick={closeProfitable}>Close profit</button>
        <button type="button" className="stm-btn" disabled={busy} onClick={closeLosing}>Close loss</button>
        <button type="button" className="stm-btn stm-btn-strong" disabled={busy} onClick={closeAll}>Close all</button>
      </div>
    </div>
  );

  return (
    <>
      {embedded ? card : (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <div className="modal-wrap">
            <button className="modal-close" aria-label="Close" onClick={onClose}>✕</button>
            {card}
          </div>
        </div>
      )}

      {confirmEnable ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setConfirmEnable(false); }}>
          <div className="modal-wrap">
            <div className="generic-modal-card" style={{ width: 380 }}>
              <div className="generic-modal-title">Enable Smart Execution?</div>
              <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 16 }}>
                The hotkeys will place and manage trades at once, with the settings above.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="modal-btn" onClick={() => setConfirmEnable(false)}>Cancel</button>
                <button className="modal-btn primary" onClick={() => { setConfig((c) => ({ ...c, smartExecution: true })); setConfirmEnable(false); }}>Enable</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
