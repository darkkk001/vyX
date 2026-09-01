"use client";

import { useEffect, useMemo, useState } from "react";
import { SYMBOL_DEFS, fmt, type MarketState, type SymbolDef } from "@/lib/market-simulator";
import { tradeApi, type ApiPosition } from "@/lib/trade-api";
import {
  registerHotkeys,
  hotkeyToLabel,
  eventToBinding,
  findConflict,
  type HotkeyBinding,
} from "@/lib/hotkeys";

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
  // uses this to show it permanently, MT4/5-style, rather than behind a
  // rail icon. `open` is ignored when true; the confirm-enable dialog
  // still overlays normally either way.
  embedded?: boolean;
  // WebTrader's own real, broker-enabled symbol universe (allSymbols) --
  // this panel's own symbol dropdown used to read the hardcoded
  // SYMBOL_DEFS bootstrap directly, capping it at 10.
  symbols: SymbolDef[];
  market: Record<string, MarketState>;
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
  const slValidity = useMemo(() => {
    if (!m || !m.live || config.sl === "") return null;
    const sl = parseFloat(config.sl);
    if (isNaN(sl)) return null;
    const ref = m.bid; // BUY reference is ask, SELL is bid; SL side depends on which hotkey fires, so validate against both and report the worse case
    const validForBuy = sl < m.ask;
    const validForSell = sl > m.bid;
    return { validForBuy, validForSell };
  }, [m, config.sl]);
  const tpValidity = useMemo(() => {
    if (!m || !m.live || config.tp === "") return null;
    const tp = parseFloat(config.tp);
    if (isNaN(tp)) return null;
    const validForBuy = tp > m.ask;
    const validForSell = tp < m.bid;
    return { validForBuy, validForSell };
  }, [m, config.tp]);

  async function smartExecute(side: "BUY" | "SELL") {
    if (!m || !m.live) { pushToast("No live feed for this symbol"); return; }
    const sl = config.sl === "" ? null : parseFloat(config.sl);
    const tp = config.tp === "" ? null : parseFloat(config.tp);
    if (sl != null && ((side === "BUY" && sl >= m.ask) || (side === "SELL" && sl <= m.bid))) {
      pushToast(`Invalid Stop Loss — SL must be ${side === "BUY" ? "below" : "above"} the current market price`);
      return;
    }
    if (tp != null && ((side === "BUY" && tp <= m.ask) || (side === "SELL" && tp >= m.bid))) {
      pushToast(`Invalid Take Profit — TP must be ${side === "BUY" ? "above" : "below"} the current market price`);
      return;
    }
    const refPrice = side === "BUY" ? m.ask : m.bid;
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
        pushToast(`Smart Execution: ${config.symbol} order submitted — awaiting dealer approval`);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Smart Execution order failed");
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
    const reasons = failed.map((r) => (r as PromiseRejectedResult).reason?.message ?? "unknown error");
    pushToast(
      `${label} — Requested: ${matching.length}, Successful: ${matching.length - failed.length}, Failed: ${failed.length}` +
        (reasons.length ? ` (${reasons[0]}${reasons.length > 1 ? ", …" : ""})` : ""),
      failed.length === 0
    );
    await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
  }

  async function partialCloseOne(p: ApiPosition, pct: number) {
    const mm = market[p.symbol.name];
    if (!mm || !mm.live) throw new Error(`${p.symbol.name}: no live feed`);
    const price = p.side === "BUY" ? mm.bid : mm.ask;
    const amount = +(parseFloat(p.volume) * pct).toFixed(2);
    if (amount <= 0 || amount >= parseFloat(p.volume)) throw new Error(`${p.symbol.name}: invalid partial volume`);
    await tradeApi.closePosition(p.id, price, amount, "stm_bulk");
  }

  async function breakEvenOne(p: ApiPosition, offset: number) {
    const mm = market[p.symbol.name];
    if (!mm || !mm.live) throw new Error(`${p.symbol.name}: no live feed`);
    const currentPrice = p.side === "BUY" ? mm.bid : mm.ask;
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
    const price = p.side === "BUY" ? mm.bid : mm.ask;
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
  const card = (
    <div className="generic-modal-card" style={{ width: embedded ? "100%" : 420 }}>
          <div className="generic-modal-title">Smart Trade Manager</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Symbol</label>
              <select className="mono" style={{ width: "100%" }} value={config.symbol} onChange={(e) => setConfig((c) => ({ ...c, symbol: e.target.value }))}>
                {symbols.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Order type</label>
              <select className="mono" style={{ width: "100%" }} value={config.orderType} onChange={(e) => setConfig((c) => ({ ...c, orderType: e.target.value as OrderType }))}>
                <option value="MARKET">Market</option>
                <option value="LIMIT">Limit</option>
                <option value="STOP">Stop</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Lot size</label>
              <input className="mono" style={{ width: "100%" }} type="number" step="0.01" min="0.01" value={config.lot}
                onChange={(e) => setConfig((c) => ({ ...c, lot: parseFloat(e.target.value) || 0.01 }))} />
            </div>
            <div />
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>
                Stop Loss {slValidity ? (
                  <span style={{ color: slValidity.validForBuy || slValidity.validForSell ? "var(--buy)" : "var(--sell)" }}>
                    {slValidity.validForBuy && slValidity.validForSell ? "VALID" : slValidity.validForBuy ? "valid for BUY only" : slValidity.validForSell ? "valid for SELL only" : "INVALID"}
                  </span>
                ) : null}
              </label>
              <input
                className="mono"
                style={{ width: "100%", boxShadow: config.sl !== "" && slValidity && !slValidity.validForBuy && !slValidity.validForSell ? "inset 0 0 0 1.5px var(--sell)" : undefined }}
                type="number" step="any" value={config.sl}
                onChange={(e) => setConfig((c) => ({ ...c, sl: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>
                Take Profit {tpValidity ? (
                  <span style={{ color: tpValidity.validForBuy || tpValidity.validForSell ? "var(--buy)" : "var(--sell)" }}>
                    {tpValidity.validForBuy && tpValidity.validForSell ? "VALID" : tpValidity.validForBuy ? "valid for BUY only" : tpValidity.validForSell ? "valid for SELL only" : "INVALID"}
                  </span>
                ) : null}
              </label>
              <input
                className="mono"
                style={{ width: "100%", boxShadow: config.tp !== "" && tpValidity && !tpValidity.validForBuy && !tpValidity.validForSell ? "inset 0 0 0 1.5px var(--sell)" : undefined }}
                type="number" step="any" value={config.tp}
                onChange={(e) => setConfig((c) => ({ ...c, tp: e.target.value }))}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Buy hotkey</label>
              <button className="modal-btn" style={{ width: "100%" }} onClick={() => setCapturingHotkey("buy")}>
                {capturingHotkey === "buy" ? "Press a key…" : hotkeyToLabel(config.buyHotkey)}
              </button>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Sell hotkey</label>
              <button className="modal-btn" style={{ width: "100%" }} onClick={() => setCapturingHotkey("sell")}>
                {capturingHotkey === "sell" ? "Press a key…" : hotkeyToLabel(config.sellHotkey)}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginBottom: 12 }}>
            <span style={{ fontWeight: 600 }}>Smart Execution</span>
            <button
              className={`modal-btn${config.smartExecution ? " primary" : ""}`}
              onClick={() => { if (config.smartExecution) setConfig((c) => ({ ...c, smartExecution: false })); else setConfirmEnable(true); }}
            >
              {config.smartExecution ? "ON" : "OFF"}
            </button>
          </div>

          <div className="generic-modal-title" style={{ fontSize: 13, marginBottom: 8 }}>Position actions</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Scope</label>
              <select className="mono" style={{ width: "100%" }} value={closeScope} onChange={(e) => setCloseScope(e.target.value as CloseScope)}>
                <option value="ALL_SYMBOLS">All symbols</option>
                <option value="CURRENT_SYMBOL">Current symbol ({activeSymbol})</option>
                <option value="SELECTED">Selected ({selectedPositionIds.size})</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>Direction</label>
              <select className="mono" style={{ width: "100%" }} value={closeDirection} onChange={(e) => setCloseDirection(e.target.value as DirectionFilter)}>
                <option value="ALL">All</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </div>
          </div>

          {/* flexWrap: wrap on all three rows below -- this card used to
              only ever render at a fixed 420px (the non-embedded modal
              width); embedded mode can now be as narrow as 160px (the
              Watchlist column's own resize floor), and none of these rows
              have any give at that width. Without wrapping, the row just
              overflowed the card and (since nothing between here and
              .watchlist had min-width: 0 to actually clip it) rendered
              past the Watchlist column and over the chart. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-3)", width: 90 }}>Break-even</span>
              <input className="mono" style={{ width: 70 }} type="number" step="any" value={beOffset} onChange={(e) => setBeOffset(e.target.value)} title="Offset from entry price" />
              <button className="modal-btn" disabled={busy} onClick={breakEven}>Apply</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-3)", width: 90 }}>Partial close</span>
              <button className="modal-btn" disabled={busy} onClick={() => partialClosePct(0.25)}>25%</button>
              <button className="modal-btn" disabled={busy} onClick={() => partialClosePct(0.5)}>50%</button>
              <button className="modal-btn" disabled={busy} onClick={() => partialClosePct(0.75)}>75%</button>
              <input className="mono" style={{ width: 50 }} type="number" min="1" max="99" value={customPct} onChange={(e) => setCustomPct(e.target.value)} />
              <button className="modal-btn" disabled={busy} onClick={partialCloseCustom}>%</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button className="modal-btn" disabled={busy} onClick={closeProfitable} style={{ flex: 1, minWidth: 90 }}>Close profitable</button>
              <button className="modal-btn" disabled={busy} onClick={closeLosing} style={{ flex: 1, minWidth: 80 }}>Close losing</button>
              <button className="modal-btn" disabled={busy} onClick={closeAll} style={{ flex: 1, minWidth: 70 }}>Close all</button>
            </div>
          </div>
        </div>
  );

  return (
    <>
      {embedded ? card : (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={onClose}>✕</button>
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
                Smart Execution allows assigned hotkeys to immediately place or manage trades using your saved trading parameters. Make sure your hotkeys and order settings are correct before enabling this feature.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="modal-btn" onClick={() => setConfirmEnable(false)}>Cancel</button>
                <button className="modal-btn primary" onClick={() => { setConfig((c) => ({ ...c, smartExecution: true })); setConfirmEnable(false); }}>I Understand & Enable</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
