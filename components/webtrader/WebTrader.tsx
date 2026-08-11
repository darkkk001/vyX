"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SYMBOL_DEFS,
  createInitialMarket,
  tickMarket,
  fmt,
  money,
  type MarketState,
} from "@/lib/market-simulator";
import { tradeApi, type AccountInfo, type ApiPosition, type ApiOrder } from "@/lib/trade-api";

type Toast = { id: number; message: string; kind?: "warn" | "buy" | "sell" };
type Alert = { id: number; symbol: string; condition: "above" | "below"; price: number; triggered: boolean };
type Timeframe = "M1" | "M5" | "H1";

const ALL_COLUMNS = [
  { key: "bid", label: "Bid" },
  { key: "ask", label: "Ask" },
  { key: "spread", label: "Spread" },
  { key: "change", label: "Chg %" },
  { key: "high", label: "High" },
  { key: "low", label: "Low" },
] as const;

let idCounter = 1;
function nextId() {
  return idCounter++;
}

export default function WebTrader() {
  const router = useRouter();

  const [market, setMarket] = useState<Record<string, MarketState>>(() => createInitialMarket());
  const [watchlistOrder, setWatchlistOrder] = useState<string[]>(SYMBOL_DEFS.map((s) => s.name));
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(["bid", "ask", "spread", "change"])
  );
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [dragSymbol, setDragSymbol] = useState<string | null>(null);

  const [selectedSymbol, setSelectedSymbol] = useState("EURUSD");
  const [selectedTf, setSelectedTf] = useState<Timeframe>("M1");
  const [selectedOrderType, setSelectedOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");

  const [volume, setVolume] = useState("0.10");
  const [ticketPrice, setTicketPrice] = useState("");
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<ApiPosition[]>([]);
  const [pendingOrders, setPendingOrders] = useState<ApiOrder[]>([]);
  const [history, setHistory] = useState<ApiPosition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertCondition, setAlertCondition] = useState<"above" | "below">("above");
  const [alertPrice, setAlertPrice] = useState("");

  const [privacyMode, setPrivacyMode] = useState(false);
  const [netPositionsView, setNetPositionsView] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<"positions" | "pending" | "history" | "analytics">(
    "positions"
  );

  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const [histSymbol, setHistSymbol] = useState("");

  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnTab, setTxnTab] = useState<"deposit" | "withdraw">("deposit");
  const [txnAmount, setTxnAmount] = useState("");

  const [toasts, setToasts] = useState<Toast[]>([]);
  const closingIds = useRef<Set<string>>(new Set());
  const fillingIds = useRef<Set<string>>(new Set());

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pushToast = useCallback((message: string, kind?: Toast["kind"]) => {
    const id = nextId();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await tradeApi.me());
    } catch {
      router.push("/trade/login");
    }
  }, [router]);

  const refreshPositions = useCallback(async () => {
    setPositions(await tradeApi.positions().catch(() => []));
  }, []);
  const refreshOrders = useCallback(async () => {
    setPendingOrders(await tradeApi.orders().catch(() => []));
  }, []);
  const refreshHistory = useCallback(async () => {
    setHistory(await tradeApi.history({ from: histFrom, to: histTo, symbol: histSymbol }).catch(() => []));
  }, [histFrom, histTo, histSymbol]);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([refreshAccount(), refreshPositions(), refreshOrders()]);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "failed to load account data");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // ---- price simulation tick + auto-close / auto-fill / alerts ----
  useEffect(() => {
    const interval = setInterval(() => {
      setMarket((prev) => tickMarket(prev));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Alerts
    setAlerts((prev) => {
      let changed = false;
      const next = prev.map((a) => {
        if (a.triggered) return a;
        const m = market[a.symbol];
        if (!m) return a;
        const hit = a.condition === "above" ? m.bid >= a.price : m.bid <= a.price;
        if (hit) {
          changed = true;
          pushToast(`Alert: ${a.symbol} is ${a.condition} ${fmt(a.price, m.def.digits)}`, "warn");
          return { ...a, triggered: true };
        }
        return a;
      });
      return changed ? next : prev;
    });

    // Auto-close positions on SL/TP hit
    positions.forEach((p) => {
      if (closingIds.current.has(p.id)) return;
      const m = market[p.symbol.name];
      if (!m) return;
      const price = p.side === "BUY" ? m.bid : m.ask;
      const sl = p.slPrice != null ? parseFloat(p.slPrice) : null;
      const tp = p.tpPrice != null ? parseFloat(p.tpPrice) : null;
      let hitReason: "sl" | "tp" | null = null;
      if (sl != null) {
        if (p.side === "BUY" ? price <= sl : price >= sl) hitReason = "sl";
      }
      if (!hitReason && tp != null) {
        if (p.side === "BUY" ? price >= tp : price <= tp) hitReason = "tp";
      }
      if (hitReason) {
        closingIds.current.add(p.id);
        tradeApi
          .closePosition(p.id, price)
          .then(() => {
            pushToast(
              `${hitReason === "sl" ? "Stop Loss" : "Take Profit"} hit on ${p.symbol.name}`,
              hitReason === "sl" ? "sell" : "buy"
            );
            return Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
          })
          .catch(() => {})
          .finally(() => closingIds.current.delete(p.id));
      }
    });

    // Auto-fill pending LIMIT/STOP orders
    pendingOrders.forEach((o) => {
      if (fillingIds.current.has(o.id)) return;
      const m = market[o.symbol.name];
      if (!m || !o.requestedPrice) return;
      const trigger = parseFloat(o.requestedPrice);
      const price = o.side === "BUY" ? m.ask : m.bid;
      let shouldFill = false;
      if (o.type === "LIMIT") shouldFill = o.side === "BUY" ? price <= trigger : price >= trigger;
      if (o.type === "STOP") shouldFill = o.side === "BUY" ? price >= trigger : price <= trigger;
      if (shouldFill) {
        fillingIds.current.add(o.id);
        tradeApi
          .fillOrder(o.id, price)
          .then(() => {
            pushToast(`Pending order filled: ${o.side} ${o.symbol.name}`, o.side === "BUY" ? "buy" : "sell");
            return Promise.all([refreshOrders(), refreshPositions()]);
          })
          .catch(() => {})
          .finally(() => fillingIds.current.delete(o.id));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  // ---- helpers ----
  const priv = (s: string) => (privacyMode ? "••••••" : s);

  const positionPnl = useCallback(
    (p: ApiPosition): number => {
      const m = market[p.symbol.name];
      if (!m) return 0;
      const closePrice = p.side === "BUY" ? m.bid : m.ask;
      const diff = p.side === "BUY" ? closePrice - parseFloat(p.openPrice) : parseFloat(p.openPrice) - closePrice;
      return diff * m.def.contractSize * parseFloat(p.volume);
    },
    [market]
  );
  const floatingPnl = useMemo(
    () => positions.reduce((sum, p) => sum + positionPnl(p), 0),
    [positions, positionPnl]
  );
  const usedMargin = useMemo(() => {
    if (!account) return 0;
    return positions.reduce((sum, p) => {
      const m = market[p.symbol.name];
      if (!m) return sum;
      return sum + (m.def.contractSize * parseFloat(p.volume) * m.bid) / account.leverage;
    }, 0);
  }, [positions, market, account]);
  const equity = account ? parseFloat(account.balance) + parseFloat(account.credit) + floatingPnl : 0;
  const freeMargin = equity - usedMargin;
  const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : Infinity;

  function selectSymbol(name: string) {
    setSelectedSymbol(name);
    setSlInput("");
    setTpInput("");
    setFieldErrors({});
  }

  function clearFieldErrors() {
    setFieldErrors({});
  }

  function validateOrder(side: "BUY" | "SELL") {
    const errors: Record<string, string> = {};
    const m = market[selectedSymbol];
    const vol = parseFloat(volume);
    if (!(vol > 0)) errors.volume = "Volume must be > 0";
    else if (vol < 0.01 || vol > 100) errors.volume = "Range 0.01–100";

    let refPrice = side === "BUY" ? m.ask : m.bid;
    if (selectedOrderType !== "MARKET") {
      const p = parseFloat(ticketPrice);
      if (!(p > 0)) errors.price = "Enter a price";
      else refPrice = p;
    }

    if (slInput !== "") {
      const sl = parseFloat(slInput);
      if (side === "BUY" && sl >= refPrice) errors.sl = "SL must be below price";
      if (side === "SELL" && sl <= refPrice) errors.sl = "SL must be above price";
    }
    if (tpInput !== "") {
      const tp = parseFloat(tpInput);
      if (side === "BUY" && tp <= refPrice) errors.tp = "TP must be above price";
      if (side === "SELL" && tp >= refPrice) errors.tp = "TP must be below price";
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return null;
    return {
      volume: vol,
      refPrice,
      sl: slInput === "" ? null : parseFloat(slInput),
      tp: tpInput === "" ? null : parseFloat(tpInput),
    };
  }

  async function submitOrder(side: "BUY" | "SELL") {
    const result = validateOrder(side);
    if (!result) return;
    try {
      await tradeApi.placeOrder({
        symbol: selectedSymbol,
        side,
        type: selectedOrderType,
        volume: result.volume,
        price: result.refPrice,
        slPrice: result.sl,
        tpPrice: result.tp,
        idempotencyKey: crypto.randomUUID(),
      });
      pushToast(
        selectedOrderType === "MARKET"
          ? `${side} ${result.volume} ${selectedSymbol} @ ${fmt(result.refPrice, market[selectedSymbol].def.digits)}`
          : `${selectedOrderType} ${side} order placed for ${selectedSymbol}`,
        side === "BUY" ? "buy" : "sell"
      );
      clearFieldErrors();
      await Promise.all([refreshPositions(), refreshOrders(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed", "warn");
    }
  }

  async function closePositionManually(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    const m = market[p.symbol.name];
    const price = p.side === "BUY" ? m.bid : m.ask;
    try {
      await tradeApi.closePosition(id, price);
      await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to close position", "warn");
    }
  }

  async function cancelPendingOrder(id: string) {
    try {
      await tradeApi.cancelOrder(id);
      await refreshOrders();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to cancel order", "warn");
    }
  }

  async function editPositionField(position: ApiPosition, field: "sl" | "tp", raw: string) {
    const m = market[position.symbol.name];
    const ref = position.side === "BUY" ? m.bid : m.ask;
    const value = raw === "" ? null : parseFloat(raw);
    if (value != null) {
      if (field === "sl") {
        if ((position.side === "BUY" && value >= ref) || (position.side === "SELL" && value <= ref)) {
          pushToast(`Invalid SL for ${position.side} position`, "warn");
          return;
        }
      } else {
        if ((position.side === "BUY" && value <= ref) || (position.side === "SELL" && value >= ref)) {
          pushToast(`Invalid TP for ${position.side} position`, "warn");
          return;
        }
      }
    }
    try {
      await tradeApi.editPositionSlTp(position.id, {
        currentPrice: ref,
        ...(field === "sl" ? { slPrice: value } : { tpPrice: value }),
      });
      await refreshPositions();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to update", "warn");
    }
  }

  function addAlert() {
    const price = parseFloat(alertPrice);
    if (!(price > 0)) return;
    setAlerts((prev) => [...prev, { id: nextId(), symbol: selectedSymbol, condition: alertCondition, price, triggered: false }]);
    setAlertPrice("");
  }

  function attachDragHandlers(name: string) {
    return {
      draggable: true,
      onDragStart: () => setDragSymbol(name),
      onDragEnd: () => setDragSymbol(null),
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: () => {
        if (!dragSymbol || dragSymbol === name) return;
        setWatchlistOrder((prev) => {
          const next = [...prev];
          const from = next.indexOf(dragSymbol);
          const to = next.indexOf(name);
          next.splice(from, 1);
          next.splice(to, 0, dragSymbol);
          return next;
        });
      },
    };
  }

  // ---- chart drawing ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const m = market[selectedSymbol];
    const candles = m.candles[selectedTf];
    if (!candles.length) return;

    const padLeft = 8, padRight = 56, padTop = 10, padBottom = 20;
    const plotW = w - padLeft - padRight, plotH = h - padTop - padBottom;
    const visible = candles.slice(-Math.floor(plotW / 8));
    let min = Infinity, max = -Infinity;
    visible.forEach((c) => { min = Math.min(min, c.l); max = Math.max(max, c.h); });
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;

    const y = (price: number) => padTop + (1 - (price - min) / (max - min)) * plotH;
    const candleW = plotW / visible.length;

    ctx.strokeStyle = "#1b2233";
    ctx.fillStyle = "#5c6788";
    ctx.font = "10px monospace";
    ctx.lineWidth = 1;
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const price = min + ((max - min) * i) / steps;
      const yy = y(price);
      ctx.beginPath();
      ctx.moveTo(padLeft, yy);
      ctx.lineTo(w - padRight, yy);
      ctx.stroke();
      ctx.fillText(fmt(price, m.def.digits), w - padRight + 6, yy + 3);
    }

    visible.forEach((c, i) => {
      const cx = padLeft + i * candleW + candleW / 2;
      const up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? "#16c78d" : "#f0526a";
      ctx.beginPath();
      ctx.moveTo(cx, y(c.h));
      ctx.lineTo(cx, y(c.l));
      ctx.stroke();
      const bodyTop = y(Math.max(c.o, c.c));
      const bodyBottom = y(Math.min(c.o, c.c));
      const bw = Math.max(candleW * 0.6, 2);
      ctx.fillRect(cx - bw / 2, bodyTop, bw, Math.max(bodyBottom - bodyTop, 1));
    });

    const lastY = y(m.bid);
    ctx.strokeStyle = "#2f7dfb";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, lastY);
    ctx.lineTo(w - padRight, lastY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#2f7dfb";
    ctx.fillRect(w - padRight, lastY - 8, padRight - 4, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(fmt(m.bid, m.def.digits), w - padRight + 4, lastY + 3);
  }, [market, selectedSymbol, selectedTf]);

  if (loadError) {
    return (
      <div style={{ padding: 40, color: "#e8ecf4", background: "#0b0e14", minHeight: "100vh" }}>
        <p>{loadError}</p>
      </div>
    );
  }

  const m = market[selectedSymbol];

  return (
    <div className="wt-root">
      <div id="app">
        {isFinite(marginLevel) && positions.length > 0 && marginLevel < 100 ? (
          <div className={`show${marginLevel < 50 ? " stopout" : ""}`} id="margin-banner">
            {marginLevel < 50
              ? `STOP OUT LEVEL — margin level ${marginLevel.toFixed(0)}% — positions may be force-closed`
              : `MARGIN CALL — margin level ${marginLevel.toFixed(0)}% — add funds or reduce exposure`}
          </div>
        ) : null}

        <div id="topbar">
          <div id="brand">
            <span className="dot" />
            <span>VyXTrader</span>
          </div>
          <div id="account-switcher">
            <span className="muted num">{account?.accountNumber ?? "..."}</span>
            <span className="muted">{account?.accountType}</span>
          </div>
          <div id="balances">
            <div className="balance-item"><span className="label">Balance</span><span className="value num">{account ? priv(money(parseFloat(account.balance))) : "..."}</span></div>
            <div className="balance-item"><span className="label">Equity</span><span className="value num">{account ? priv(money(equity)) : "..."}</span></div>
            <div className="balance-item"><span className="label">Margin</span><span className="value num">{account ? priv(money(usedMargin)) : "..."}</span></div>
            <div className="balance-item"><span className="label">Free Margin</span><span className="value num">{account ? priv(money(freeMargin)) : "..."}</span></div>
            <div className="balance-item"><span className="label">Margin Level</span><span className="value num">{isFinite(marginLevel) ? priv(marginLevel.toFixed(0) + "%") : "—"}</span></div>
            <button className="icon-btn" onClick={() => setPrivacyMode((v) => !v)} title="Hide balances">{privacyMode ? "\u{1F648}" : "\u{1F441}"}</button>
          </div>
          <div id="topbar-actions">
            <button onClick={() => { setTxnTab("deposit"); setTxnModalOpen(true); }}>Deposit</button>
            <button onClick={() => { setTxnTab("withdraw"); setTxnModalOpen(true); }}>Withdraw</button>
          </div>
        </div>

        <div id="main">
          <div id="watchlist-panel">
            <div className="panel-head">
              <span>Watchlist</span>
              <button className="icon-btn" onClick={() => setColumnsMenuOpen((v) => !v)}>{"⚙"}</button>
            </div>
            <div id="watchlist-body">
              <table id="watchlist-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    {ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)).map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {watchlistOrder.map((name) => {
                    const row = market[name];
                    const spreadVal = row.ask - row.bid;
                    const changePct = ((row.bid - row.dayOpen) / row.dayOpen) * 100;
                    const values: Record<string, string> = {
                      bid: fmt(row.bid, row.def.digits),
                      ask: fmt(row.ask, row.def.digits),
                      spread: fmt(spreadVal, row.def.digits),
                      change: (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%",
                      high: fmt(row.high, row.def.digits),
                      low: fmt(row.low, row.def.digits),
                    };
                    return (
                      <tr
                        key={name}
                        className={`row${name === selectedSymbol ? " selected" : ""}`}
                        onClick={() => selectSymbol(name)}
                        {...attachDragHandlers(name)}
                      >
                        <td className="sym">{name}</td>
                        {ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)).map((c) => (
                          <td key={c.key} className="num">{values[c.key]}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {columnsMenuOpen ? (
                <div id="columns-menu">
                  {ALL_COLUMNS.map((c) => (
                    <label key={c.key}>
                      <input
                        type="checkbox"
                        checked={visibleColumns.has(c.key)}
                        onChange={(e) => {
                          setVisibleColumns((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.key);
                            else next.delete(c.key);
                            return next;
                          });
                        }}
                      />{" "}
                      {c.label}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div id="chart-panel">
            <div id="chart-head">
              <span id="chart-symbol">{selectedSymbol}</span>
              <span id="chart-price" className={`num ${m.bid >= m.prevBid ? "buy-color" : "sell-color"}`}>{fmt(m.bid, m.def.digits)}</span>
              <div className="tf-group">
                {(["M1", "M5", "H1"] as const).map((tf) => (
                  <button key={tf} className={`tf-btn${tf === selectedTf ? " active" : ""}`} onClick={() => setSelectedTf(tf)}>{tf}</button>
                ))}
              </div>
            </div>
            <div id="chart-canvas-wrap">
              <canvas id="chart-canvas" ref={canvasRef} />
            </div>
            <div id="symbol-info">
              <span>Category: <b>{m.def.category}</b></span>
              <span>Digits: <b>{m.def.digits}</b></span>
              <span>Contract size: <b>{m.def.contractSize}</b></span>
              <span>Spread: <b>{fmt(m.ask - m.bid, m.def.digits)}</b></span>
              <span>Session high: <b>{fmt(m.high, m.def.digits)}</b></span>
              <span>Session low: <b>{fmt(m.low, m.def.digits)}</b></span>
            </div>
          </div>

          <div id="right-col">
            <div id="ticket">
              <h3>New Order</h3>
              <div className="price-row">
                <div className="price-box sell-box" onClick={() => submitOrder("SELL")}>
                  <div className="lbl">Sell</div>
                  <div className="val num sell-color">{fmt(m.bid, m.def.digits)}</div>
                </div>
                <div className="price-box buy-box" onClick={() => submitOrder("BUY")}>
                  <div className="lbl">Buy</div>
                  <div className="val num buy-color">{fmt(m.ask, m.def.digits)}</div>
                </div>
              </div>

              <div className="order-type-tabs">
                {(["MARKET", "LIMIT", "STOP"] as const).map((t) => (
                  <button
                    key={t}
                    className={selectedOrderType === t ? "active" : ""}
                    onClick={() => {
                      setSelectedOrderType(t);
                      if (t !== "MARKET") setTicketPrice(fmt(m.bid, m.def.digits));
                    }}
                  >
                    {t === "MARKET" ? "Market" : t === "LIMIT" ? "Limit" : "Stop"}
                  </button>
                ))}
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Volume (lots)</label>
                  <input
                    type="number"
                    value={volume}
                    step="0.01"
                    min="0.01"
                    className={fieldErrors.volume ? "invalid" : ""}
                    onChange={(e) => setVolume(e.target.value)}
                  />
                  <small className="err">{fieldErrors.volume}</small>
                </div>
                {selectedOrderType !== "MARKET" ? (
                  <div className="field">
                    <label>Price</label>
                    <input
                      type="number"
                      value={ticketPrice}
                      step="0.00001"
                      className={fieldErrors.price ? "invalid" : ""}
                      onChange={(e) => setTicketPrice(e.target.value)}
                    />
                    <small className="err">{fieldErrors.price}</small>
                  </div>
                ) : null}
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Stop Loss</label>
                  <input
                    type="number"
                    value={slInput}
                    step="0.00001"
                    placeholder="off"
                    className={fieldErrors.sl ? "invalid" : ""}
                    onChange={(e) => setSlInput(e.target.value)}
                  />
                  <small className="err">{fieldErrors.sl}</small>
                </div>
                <div className="field">
                  <label>Take Profit</label>
                  <input
                    type="number"
                    value={tpInput}
                    step="0.00001"
                    placeholder="off"
                    className={fieldErrors.tp ? "invalid" : ""}
                    onChange={(e) => setTpInput(e.target.value)}
                  />
                  <small className="err">{fieldErrors.tp}</small>
                </div>
              </div>

              <div className="submit-row">
                <button className="sell-btn" onClick={() => submitOrder("SELL")}>Sell</button>
                <button className="buy-btn" onClick={() => submitOrder("BUY")}>Buy</button>
              </div>
            </div>

            <div id="alerts-panel">
              <h3>Price Alerts</h3>
              <div>
                {alerts.length === 0 ? (
                  <div className="muted">No alerts set.</div>
                ) : (
                  alerts.map((a) => (
                    <div key={a.id} className={`alert-row${a.triggered ? " triggered" : ""}`}>
                      <span className="grow">{a.symbol} {a.condition} {fmt(a.price, market[a.symbol]?.def.digits ?? 5)}</span>
                      {a.triggered ? "🔔" : null}
                      <button className="icon-btn" onClick={() => setAlerts((prev) => prev.filter((x) => x.id !== a.id))}>{"✕"}</button>
                    </div>
                  ))
                )}
              </div>
              <div id="alert-form">
                <select value={alertCondition} onChange={(e) => setAlertCondition(e.target.value as "above" | "below")}>
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                </select>
                <input type="number" step="0.00001" placeholder="price" value={alertPrice} onChange={(e) => setAlertPrice(e.target.value)} />
                <button onClick={addAlert}>Add</button>
              </div>
            </div>
          </div>

          <div id="bottom-panel">
            <div id="bottom-tabs">
              <button className={activeBottomTab === "positions" ? "active" : ""} onClick={() => setActiveBottomTab("positions")}>Positions</button>
              <button className={activeBottomTab === "pending" ? "active" : ""} onClick={() => setActiveBottomTab("pending")}>Pending Orders</button>
              <button className={activeBottomTab === "history" ? "active" : ""} onClick={() => setActiveBottomTab("history")}>Trade History</button>
              <button className={activeBottomTab === "analytics" ? "active" : ""} onClick={() => setActiveBottomTab("analytics")}>Analytics</button>
            </div>

            <div id="bottom-body">
              {activeBottomTab === "positions" ? (
                <div className="tab-pane active">
                  <div className="bottom-toolbar">
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="checkbox" checked={netPositionsView} onChange={(e) => setNetPositionsView(e.target.checked)} /> Net positions
                    </label>
                    <span className="muted" style={{ marginLeft: "auto" }}>Floating P/L: {money(floatingPnl)}</span>
                  </div>
                  <PositionsTable
                    positions={positions}
                    market={market}
                    netView={netPositionsView}
                    positionPnl={positionPnl}
                    onEdit={editPositionField}
                    onClose={closePositionManually}
                  />
                </div>
              ) : null}

              {activeBottomTab === "pending" ? (
                <div className="tab-pane active">
                  <PendingTable orders={pendingOrders} onCancel={cancelPendingOrder} />
                </div>
              ) : null}

              {activeBottomTab === "history" ? (
                <div className="tab-pane active">
                  <div className="bottom-toolbar">
                    <label>From <input type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} style={{ width: 140, display: "inline-block" }} /></label>
                    <label>To <input type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} style={{ width: 140, display: "inline-block" }} /></label>
                    <label>Symbol
                      <select value={histSymbol} onChange={(e) => setHistSymbol(e.target.value)} style={{ width: 120, display: "inline-block" }}>
                        <option value="">All</option>
                        {SYMBOL_DEFS.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                    </label>
                  </div>
                  <HistoryTable trades={history} />
                </div>
              ) : null}

              {activeBottomTab === "analytics" ? (
                <div className="tab-pane active">
                  <AnalyticsPanel trades={history} />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {txnModalOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setTxnModalOpen(false); }}>
          <div className="modal modal-wrap">
            <button className="icon-btn modal-close" onClick={() => setTxnModalOpen(false)}>{"✕"}</button>
            <h2>{txnTab === "deposit" ? "Deposit" : "Withdraw"}</h2>
            <div className="modal-tabs">
              <button className={txnTab === "deposit" ? "active" : ""} onClick={() => setTxnTab("deposit")}>Deposit</button>
              <button className={txnTab === "withdraw" ? "active" : ""} onClick={() => setTxnTab("withdraw")}>Withdraw</button>
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Amount (USD)</label>
              <input type="number" min="1" step="1" placeholder="100" value={txnAmount} onChange={(e) => setTxnAmount(e.target.value)} />
            </div>
            <button
              className="primary"
              style={{ width: "100%", padding: 10 }}
              onClick={() => {
                setTxnModalOpen(false);
                setTxnAmount("");
                pushToast("Deposit/withdraw requests go through the backoffice review flow (Phase 3) — not yet available.", "warn");
              }}
            >
              Submit
            </button>
          </div>
        </div>
      ) : null}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind ? " " + t.kind : ""}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}

function PositionsTable({
  positions,
  market,
  netView,
  positionPnl,
  onEdit,
  onClose,
}: {
  positions: ApiPosition[];
  market: Record<string, MarketState>;
  netView: boolean;
  positionPnl: (p: ApiPosition) => number;
  onEdit: (p: ApiPosition, field: "sl" | "tp", raw: string) => void;
  onClose: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; field: "sl" | "tp"; value: string } | null>(null);

  if (positions.length === 0) return <div className="empty-state">No open positions.</div>;

  if (netView) {
    const bySymbol = new Map<string, { net: number; pnl: number }>();
    positions.forEach((p) => {
      const entry = bySymbol.get(p.symbol.name) ?? { net: 0, pnl: 0 };
      entry.net += p.side === "BUY" ? parseFloat(p.volume) : -parseFloat(p.volume);
      entry.pnl += positionPnl(p);
      bySymbol.set(p.symbol.name, entry);
    });
    return (
      <table>
        <thead><tr><th>Symbol</th><th>Direction</th><th>Net Volume</th><th>P/L</th></tr></thead>
        <tbody>
          {Array.from(bySymbol.entries()).map(([name, r]) => (
            <tr key={name}>
              <td className="sym">{name}</td>
              <td className={r.net >= 0 ? "buy-color" : "sell-color"}>{r.net >= 0 ? "NET BUY" : "NET SELL"}</td>
              <td className="num">{Math.abs(r.net).toFixed(2)}</td>
              <td className={`num ${r.pnl >= 0 ? "buy-color" : "sell-color"}`}>{money(r.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <table>
      <thead><tr><th>Symbol</th><th>Side</th><th>Vol</th><th>Open</th><th>Current</th><th>SL</th><th>TP</th><th>P/L</th><th></th></tr></thead>
      <tbody>
        {positions.map((p) => {
          const m = market[p.symbol.name];
          const pnl = positionPnl(p);
          return (
            <tr key={p.id}>
              <td className="sym">{p.symbol.name}</td>
              <td className={p.side === "BUY" ? "buy-color" : "sell-color"}>{p.side}</td>
              <td className="num">{parseFloat(p.volume).toFixed(2)}</td>
              <td className="num">{fmt(parseFloat(p.openPrice), p.symbol.digits)}</td>
              <td className="num">{m ? fmt(m.bid, p.symbol.digits) : "—"}</td>
              {(["sl", "tp"] as const).map((field) => {
                const raw = field === "sl" ? p.slPrice : p.tpPrice;
                const isEditing = editing?.id === p.id && editing.field === field;
                return (
                  <td
                    key={field}
                    className="editable-cell num"
                    onClick={() => !isEditing && setEditing({ id: p.id, field, value: raw ?? "" })}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        type="number"
                        step="0.00001"
                        defaultValue={raw ?? ""}
                        onBlur={(e) => {
                          onEdit(p, field, e.target.value);
                          setEditing(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      raw != null ? fmt(parseFloat(raw), p.symbol.digits) : "—"
                    )}
                  </td>
                );
              })}
              <td className={`num ${pnl >= 0 ? "buy-color" : "sell-color"}`}>{money(pnl)}</td>
              <td><button className="ghost" onClick={() => onClose(p.id)}>Close</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PendingTable({ orders, onCancel }: { orders: ApiOrder[]; onCancel: (id: string) => void }) {
  if (orders.length === 0) return <div className="empty-state">No pending orders.</div>;
  return (
    <table>
      <thead><tr><th>Symbol</th><th>Type</th><th>Side</th><th>Vol</th><th>Price</th><th>SL</th><th>TP</th><th></th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td className="sym">{o.symbol.name}</td>
            <td>{o.type}</td>
            <td className={o.side === "BUY" ? "buy-color" : "sell-color"}>{o.side}</td>
            <td className="num">{parseFloat(o.volume).toFixed(2)}</td>
            <td className="num">{o.requestedPrice ? fmt(parseFloat(o.requestedPrice), o.symbol.digits) : "—"}</td>
            <td className="num">{o.slPrice ? fmt(parseFloat(o.slPrice), o.symbol.digits) : "—"}</td>
            <td className="num">{o.tpPrice ? fmt(parseFloat(o.tpPrice), o.symbol.digits) : "—"}</td>
            <td><button className="ghost" onClick={() => onCancel(o.id)}>Cancel</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTable({ trades }: { trades: ApiPosition[] }) {
  if (trades.length === 0) return <div className="empty-state">No trades in range.</div>;
  return (
    <table>
      <thead><tr><th>Symbol</th><th>Side</th><th>Vol</th><th>Open</th><th>Close</th><th>Closed</th><th>P/L</th></tr></thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            <td className="sym">{t.symbol.name}</td>
            <td className={t.side === "BUY" ? "buy-color" : "sell-color"}>{t.side}</td>
            <td className="num">{parseFloat(t.volume).toFixed(2)}</td>
            <td className="num">{fmt(parseFloat(t.openPrice), t.symbol.digits)}</td>
            <td className="num">{t.closePrice ? fmt(parseFloat(t.closePrice), t.symbol.digits) : "—"}</td>
            <td className="muted">{t.closedAt ? new Date(t.closedAt).toLocaleString() : "—"}</td>
            <td className={`num ${(t.realizedPnl ? parseFloat(t.realizedPnl) : 0) >= 0 ? "buy-color" : "sell-color"}`}>
              {money(t.realizedPnl ? parseFloat(t.realizedPnl) : 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnalyticsPanel({ trades }: { trades: ApiPosition[] }) {
  const pnls = trades.map((t) => (t.realizedPnl ? parseFloat(t.realizedPnl) : 0));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const winRate = pnls.length ? (wins.length / pnls.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const cards: [string, string][] = [
    ["Total Trades", String(pnls.length)],
    ["Win Rate", winRate.toFixed(1) + "%"],
    ["Total P/L", money(totalPnl)],
    ["Avg Win", money(avgWin)],
    ["Avg Loss", money(avgLoss)],
    ["Profit Factor", isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"],
  ];

  return (
    <div className="stat-cards">
      {cards.map(([label, value]) => (
        <div className="stat-card" key={label}>
          <div className="label">{label}</div>
          <div className="value">{value}</div>
        </div>
      ))}
    </div>
  );
}
