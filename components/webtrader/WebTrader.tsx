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
  type Candle,
  type Timeframe,
} from "@/lib/market-simulator";
import { tradeApi, type AccountInfo, type ApiPosition, type ApiOrder, type ApiFundsRequest, type ApiKycStatus } from "@/lib/trade-api";
import KLineChartPanel, { type KLineChartHandle, type ChartLine } from "./KLineChartPanel";
import DesktopTitleBar from "./DesktopTitleBar";
import SessionClock from "./SessionClock";
import NewsPanel from "./NewsPanel";
import ChartCell from "./ChartCell";
import { computeChartLines } from "@/lib/chart-lines";

declare global {
  interface Window {
    // Exposed by the Tauri desktop shell's init script
    // (desktop-tauri/src-tauri/src/main.rs) only when running inside that
    // shell — absent in a normal browser tab.
    vyxDesktop?: {
      isDesktop: true;
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
      rememberBroker: (hostname: string) => void;
      forgetBroker: () => void;
    };
  }
}

const TF_LABELS: { key: Timeframe; label: string }[] = [
  { key: "M1", label: "1m" },
  { key: "M5", label: "5m" },
  { key: "M30", label: "30m" },
  { key: "H1", label: "1H" },
  { key: "H4", label: "4H" },
  { key: "D1", label: "D" },
  { key: "W1", label: "W" },
  { key: "MN1", label: "M" },
  { key: "Y1", label: "Y" },
];

type BottomTab = "positions" | "net" | "orders" | "history" | "analytics" | "logs";
type LogEntry = { id: number; time: string; message: string };
type OrderMode = "market" | "pending";
type PendingType = "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop";
type Toast = { id: number; message: string };
type Alert = { id: number; symbol: string; condition: "above" | "below"; price: number; triggered: boolean; time?: string };

let idCounter = 1;
function nextId() {
  return idCounter++;
}

function isValidSlTpForSide(side: "BUY" | "SELL", sl: number | null, tp: number | null, currentPrice: number): string | null {
  if (sl != null && !isNaN(sl)) {
    if (side === "BUY" && sl >= currentPrice) return "Stop loss must be below the current price for a Buy";
    if (side === "SELL" && sl <= currentPrice) return "Stop loss must be above the current price for a Sell";
  }
  if (tp != null && !isNaN(tp)) {
    if (side === "BUY" && tp <= currentPrice) return "Take profit must be above the current price for a Buy";
    if (side === "SELL" && tp >= currentPrice) return "Take profit must be below the current price for a Sell";
  }
  return null;
}

function isValidPendingPrice(type: PendingType, price: number, currentPrice: number) {
  if (type === "buy_limit") return price < currentPrice;
  if (type === "sell_limit") return price > currentPrice;
  if (type === "buy_stop") return price > currentPrice;
  return price < currentPrice; // sell_stop
}
function pendingPriceRuleText(type: PendingType) {
  if (type === "buy_limit") return "Buy limit must be below the current price";
  if (type === "sell_limit") return "Sell limit must be above the current price";
  if (type === "buy_stop") return "Buy stop must be above the current price";
  return "Sell stop must be below the current price";
}

export default function WebTrader({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string }) {
  const router = useRouter();

  const [market, setMarket] = useState<Record<string, MarketState>>(() => createInitialMarket());
  const [watchlistOrder, setWatchlistOrder] = useState<string[]>(SYMBOL_DEFS.map((s) => s.name));
  const [dragSymbol, setDragSymbol] = useState<string | null>(null);
  const [watchlistFilter, setWatchlistFilter] = useState("");
  const [columnPrefs, setColumnPrefs] = useState({ signal: true, change: true, spread: false, high: false, low: false });
  const [wlMenuOpen, setWlMenuOpen] = useState(false);

  const [activeSymbol, setActiveSymbol] = useState("XAUUSD");
  const [currentTf, setCurrentTf] = useState<Timeframe>("H1");

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<ApiPosition[]>([]);
  const [pendingOrders, setPendingOrders] = useState<ApiOrder[]>([]);
  const [history, setHistory] = useState<ApiPosition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const trailingDistances = useRef<Record<string, number>>({});

  const [orderMode, setOrderMode] = useState<OrderMode>("market");
  const [pendingType, setPendingType] = useState<PendingType>("buy_limit");
  const [pendingPrice, setPendingPrice] = useState("");
  const [volume, setVolume] = useState(0.01);
  const [riskPct, setRiskPct] = useState("");
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [pendingMarketSide, setPendingMarketSide] = useState<"BUY" | "SELL" | null>(null);
  const [oneClick, setOneClick] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);

  // ---------- resizable panel layout ----------
  const [orderPanelWidth, setOrderPanelWidth] = useState(260);
  const [watchlistWidth, setWatchlistWidth] = useState(210);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(190);
  const resizeStateRef = useRef<{ kind: "order" | "watchlist" | "bottom"; startPos: number; startSize: number } | null>(null);

  const startResize = useCallback((kind: "order" | "watchlist" | "bottom") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startSize = kind === "order" ? orderPanelWidth : kind === "watchlist" ? watchlistWidth : bottomPanelHeight;
    resizeStateRef.current = { kind, startPos: kind === "bottom" ? e.clientY : e.clientX, startSize };
  }, [orderPanelWidth, watchlistWidth, bottomPanelHeight]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const rs = resizeStateRef.current;
      if (!rs) return;
      if (rs.kind === "bottom") {
        const delta = rs.startPos - e.clientY;
        setBottomPanelHeight(Math.min(500, Math.max(120, rs.startSize + delta)));
      } else if (rs.kind === "order") {
        const delta = e.clientX - rs.startPos;
        setOrderPanelWidth(Math.min(420, Math.max(200, rs.startSize + delta)));
      } else {
        const delta = rs.startPos - e.clientX;
        setWatchlistWidth(Math.min(420, Math.max(160, rs.startSize + delta)));
      }
    }
    function onUp() {
      resizeStateRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const [activeBottomTab, setActiveBottomTab] = useState<BottomTab>("positions");
  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const [histSymbol, setHistSymbol] = useState("");
  const [histPeriod, setHistPeriod] = useState("all");

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertHistory, setAlertHistory] = useState<Alert[]>([]);
  const [alertsModalOpen, setAlertsModalOpen] = useState(false);
  const [alertsTab, setAlertsTab] = useState<"active" | "history">("active");

  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [chartLayout, setChartLayout] = useState<"single" | "grid">("single");
  const [gridCells, setGridCells] = useState<{ symbol: string; tf: Timeframe }[]>([
    { symbol: "XAUUSD", tf: "H1" },
    { symbol: "EURUSD", tf: "H1" },
    { symbol: "BTCUSD", tf: "H1" },
    { symbol: "GBPUSD", tf: "H1" },
  ]);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [actionsSearch, setActionsSearch] = useState("");
  // Read once client-side (useEffect, not render) — window.vyxDesktop
  // doesn't exist during SSR, and JSX reading it directly there would
  // throw "window is not defined".
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  useEffect(() => setIsDesktopApp(!!window.vyxDesktop?.isDesktop), []);

  // "default" = the newer palette, "classic" = the original WebTrader
  // colors — same components/markup either way, see the
  // .wt-root[data-theme="default"] override in webtrader.css. Persisted
  // per-browser/per-install since it's a personal preference, not
  // account data.
  const [theme, setTheme] = useState<"classic" | "default">("default");
  useEffect(() => {
    const saved = localStorage.getItem("vyx-theme");
    if (saved === "classic" || saved === "default") setTheme(saved);
  }, []);
  function changeTheme(next: "classic" | "default") {
    setTheme(next);
    localStorage.setItem("vyx-theme", next);
  }

  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportRows, setReportRows] = useState<ApiPosition[] | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [fundsModalOpen, setFundsModalOpen] = useState(false);
  const [fundsTab, setFundsTab] = useState<"deposit" | "withdraw">("deposit");
  const [fundsAmount, setFundsAmount] = useState("");
  const [fundsSubmitting, setFundsSubmitting] = useState(false);
  const [fundsHistory, setFundsHistory] = useState<ApiFundsRequest[]>([]);

  const [symbolInfoOpen, setSymbolInfoOpen] = useState(false);
  const [shareData, setShareData] = useState<null | {
    symbolLabel: string; pnl: number; pnlPct: number; entryLabel: string; currentLabel: string; rrLabel: string; rrTitle: string;
  }>(null);

  const [sltpEdit, setSltpEdit] = useState<null | { posId: string | null; netSymbol: string | null; sl: string; tp: string }>(null);

  const [quickOrder, setQuickOrder] = useState<null | { symbol: string }>(null);
  const [quickOrderVolume, setQuickOrderVolume] = useState("0.01");
  const [quickOrderRisk, setQuickOrderRisk] = useState("");
  const [quickOrderSl, setQuickOrderSl] = useState("");
  const [quickOrderTp, setQuickOrderTp] = useState("");
  const [quickOrderComment, setQuickOrderComment] = useState("");

  const [genericModal, setGenericModal] = useState<null | {
    title: string; message: string; showInput: boolean; defaultValue?: string; okLabel: string;
    onConfirm: (value: string | null) => void;
  }>(null);
  const [genericModalValue, setGenericModalValue] = useState("");

  const [wlContextMenu, setWlContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [chartContextMenu, setChartContextMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const chartRef = useRef<KLineChartHandle>(null);
  const [maActive, setMaActive] = useState(false);

  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpConfirm, setCpConfirm] = useState("");
  const [cpError, setCpError] = useState<string | null>(null);
  const [cpSubmitting, setCpSubmitting] = useState(false);

  const [kycModalOpen, setKycModalOpen] = useState(false);
  const [kycStatus, setKycStatus] = useState<ApiKycStatus>(null);
  const [kycDocumentType, setKycDocumentType] = useState("passport");
  const [kycFront, setKycFront] = useState<File | null>(null);
  const [kycBack, setKycBack] = useState<File | null>(null);
  const [kycError, setKycError] = useState<string | null>(null);
  const [kycSubmitting, setKycSubmitting] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const closingIds = useRef<Set<string>>(new Set());
  const fillingIds = useRef<Set<string>>(new Set());

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const appendLog = useCallback((message: string) => {
    const now = new Date();
    // Explicit HH:MM:SS rather than toLocaleTimeString() — locale defaults
    // vary (some omit seconds), and execution time down to the second is
    // the whole point of a trade log.
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => n.toString().padStart(2, "0")).join(":");
    setLogs((prev) => [{ id: nextId(), time, message }, ...prev].slice(0, 200));
  }, []);

  const equityHistoryRef = useRef<number[]>([]);
  const sparklineRef = useRef<HTMLCanvasElement>(null);

  // `important: true` also fires a native OS notification when running
  // inside the desktop app (see desktop/preload.js) — for background events
  // a trader wouldn't otherwise see while the window isn't focused (alerts,
  // SL/TP hits). Plain user-triggered actions (clicking Buy, closing a
  // position) skip that: the trader is already looking at the screen.
  const pushToast = useCallback((message: string, important = false) => {
    const id = nextId();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2200);
    appendLog(message);
    if (important && typeof window !== "undefined" && window.vyxDesktop?.isDesktop && "Notification" in window) {
      try {
        new Notification("VyXTrader", { body: message });
      } catch {
        // ignore — notification permission or platform quirk, toast already shown
      }
    }
  }, [appendLog]);

  const askPrompt = useCallback((message: string, defaultValue: string, onSubmit: (value: string) => void) => {
    setGenericModalValue(defaultValue);
    setGenericModal({ title: "Enter value", message, showInput: true, defaultValue, okLabel: "Save", onConfirm: (v) => { if (v !== null) onSubmit(v); } });
  }, []);

  // ---------- data loading ----------
  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await tradeApi.me());
    } catch {
      router.push("/trade/login");
    }
  }, [router]);
  const refreshPositions = useCallback(async () => setPositions(await tradeApi.positions().catch(() => [])), []);
  const refreshOrders = useCallback(async () => setPendingOrders(await tradeApi.orders().catch(() => [])), []);
  const refreshHistory = useCallback(async () => {
    setHistory(await tradeApi.history({ from: histFrom, to: histTo, symbol: histSymbol }).catch(() => []));
  }, [histFrom, histTo, histSymbol]);
  const refreshFundsHistory = useCallback(async () => setFundsHistory(await tradeApi.fundsHistory().catch(() => [])), []);
  const refreshKycStatus = useCallback(async () => setKycStatus(await tradeApi.kycStatus().catch(() => null)), []);

  // "Switch account" — log out, then either back to the root-domain server
  // picker (desktop, so a different broker can be picked) or this broker's
  // own login page (plain web tab).
  async function handleLogout() {
    try {
      await tradeApi.logout();
    } catch {
      // session cookie clears server-side regardless; proceed to navigate away
    }
    if (window.vyxDesktop?.isDesktop) {
      window.vyxDesktop.forgetBroker();
      const parts = window.location.hostname.split(".");
      const root = parts.length > 2 ? parts.slice(1).join(".") : window.location.hostname;
      window.location.href = `https://${root}/launch`;
    } else {
      window.location.href = "/trade/login";
    }
  }

  async function generateReport() {
    setReportLoading(true);
    try {
      setReportRows(await tradeApi.history({ from: reportFrom, to: reportTo }));
    } catch {
      pushToast("Failed to generate report");
    } finally {
      setReportLoading(false);
    }
  }

  function exportReportCsv() {
    if (!reportRows || reportRows.length === 0) return;
    const header = ["Symbol", "Side", "Volume", "Open Price", "Close Price", "Swap", "Commission", "P&L", "Opened At", "Closed At"];
    const lines = reportRows.map((p) =>
      [
        p.symbol.name, p.side, p.volume, p.openPrice, p.closePrice ?? "",
        p.swap, p.commission, p.realizedPnl ?? "", p.openedAt, p.closedAt ?? "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vyxtrader-statement${reportFrom ? `-${reportFrom}` : ""}${reportTo ? `-${reportTo}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleChangePassword(event: React.FormEvent) {
    event.preventDefault();
    setCpError(null);
    if (cpNew.length < 8) { setCpError("New password must be at least 8 characters"); return; }
    if (cpNew !== cpConfirm) { setCpError("New passwords don't match"); return; }
    setCpSubmitting(true);
    try {
      await tradeApi.changePassword(cpCurrent, cpNew);
      pushToast("Password changed");
      setChangePasswordOpen(false);
      setCpCurrent(""); setCpNew(""); setCpConfirm("");
    } catch (err) {
      setCpError(err instanceof Error ? err.message : "failed to change password");
    } finally {
      setCpSubmitting(false);
    }
  }

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
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  // A successful account load means this session is valid on this broker's
  // subdomain — remember it (desktop only) so next launch skips the server
  // picker and comes straight back here instead. Skipped when the launcher's
  // "Remember me" checkbox was unchecked (?remember=0 on the /trade redirect
  // from /api/trade/login-redirect); defaults to remembering when arriving
  // any other way (e.g. logging in directly on a broker-specific build).
  useEffect(() => {
    const remember = new URLSearchParams(window.location.search).get("remember");
    if (account && window.vyxDesktop?.isDesktop && remember !== "0") {
      window.vyxDesktop.rememberBroker(window.location.hostname);
    }
  }, [account]);

  // ---------- price tick ----------
  const liveTicksRef = useRef<Record<string, { bid: number; ask: number }>>({});
  useEffect(() => {
    const interval = setInterval(() => setMarket((prev) => tickMarket(prev, liveTicksRef.current)), 1500);
    return () => clearInterval(interval);
  }, []);

  // Polls the MT5 EA bridge feed (see /api/internal/price-feed) so real
  // ticks blend into the tick loop above without restarting its interval.
  // Doubles as the connection-status signal (see DesktopTitleBar / topbar
  // indicator) — a thrown fetch means the server itself is unreachable,
  // which is distinct from (and rarer than) an individual symbol just
  // having no live tick from the EA.
  const [connected, setConnected] = useState(true);
  const [pingMs, setPingMs] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let wasConnected = true;
    async function poll() {
      const startedAt = performance.now();
      try {
        const rows = await tradeApi.prices();
        if (cancelled) return;
        setPingMs(Math.round(performance.now() - startedAt));
        const next: Record<string, { bid: number; ask: number }> = {};
        const now = Date.now();
        for (const row of rows) {
          // Ignore stale rows (EA/terminal offline) so the chart falls back
          // to simulation instead of freezing on the last real tick.
          if (now - new Date(row.updatedAt).getTime() > 15000) continue;
          next[row.symbol] = { bid: parseFloat(row.bid), ask: parseFloat(row.ask) };
        }
        liveTicksRef.current = next;
        if (!wasConnected) { appendLog("Connection restored"); wasConnected = true; }
        setConnected(true);
      } catch {
        // feed unreachable — keep simulating, nothing to surface to the trader
        if (wasConnected) { appendLog("Connection lost"); wasConnected = false; }
        setConnected(false);
        setPingMs(null);
      }
    }
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [appendLog]);

  // Pushed ticks from the API Gateway's price-tick WebSocket
  // (services/api-gateway/src/ws.ts, fed by NATS from the Rust Market
  // Data Core — see docs/market-data.md §2). Updates the same
  // liveTicksRef the poll above writes, so tickMarket needs no changes;
  // this just makes ticks land sooner than the 2s poll interval. The poll
  // stays running as the connection-status signal and as a fallback if
  // the socket can't connect (e.g. NEXT_PUBLIC_GATEWAY_WS_URL unset in an
  // environment that hasn't been cut over to the Gateway yet) — this
  // effect fails silently rather than surfacing its own error state.
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://127.0.0.1:8080";
      socket = new WebSocket(`${base}/v1/prices/stream`);
      socket.onmessage = (event) => {
        try {
          const tick = JSON.parse(event.data) as { symbol: string; bid: number; ask: number };
          liveTicksRef.current = {
            ...liveTicksRef.current,
            [tick.symbol]: { bid: tick.bid, ask: tick.ask },
          };
        } catch {
          // malformed frame — ignore, next tick will correct the picture
        }
      };
      socket.onclose = () => {
        if (!cancelled) reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  // Seeds real OHLC history (see /api/trade/candles) for a symbol+timeframe,
  // replacing the synthetic seed. A symbol with no feed history yet (empty
  // response) just keeps simulating — no real data to show, nothing to
  // seed. Shared by the single-chart focus effect below and the
  // multi-chart grid (each cell seeds its own symbol+tf independently).
  const seedRealCandles = useCallback(async (symbol: string, tf: Timeframe) => {
    try {
      const rows = await tradeApi.candles(symbol, tf);
      if (rows.length === 0) return;
      const lastBucket = new Date(rows[rows.length - 1].bucketStart).getTime();
      setMarket((prev) => {
        const ms = prev[symbol];
        if (!ms) return prev;
        return {
          ...prev,
          [symbol]: {
            ...ms,
            candles: {
              ...ms.candles,
              [tf]: rows.map((r) => ({
                o: parseFloat(r.open),
                h: parseFloat(r.high),
                l: parseFloat(r.low),
                c: parseFloat(r.close),
                t: new Date(r.bucketStart).getTime(),
              })),
            },
            lastCandleStart: { ...ms.lastCandleStart, [tf]: lastBucket },
          },
        };
      });
    } catch {
      // no real history yet — keep the synthetic seed
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => { if (!cancelled) await seedRealCandles(activeSymbol, currentTf); })();
    return () => { cancelled = true; };
  }, [activeSymbol, currentTf, seedRealCandles]);

  // Multi-chart grid: each cell seeds its own symbol+timeframe the same way
  // the focused chart does above, independently.
  useEffect(() => {
    if (chartLayout !== "grid") return;
    let cancelled = false;
    (async () => {
      for (const cell of gridCells) {
        if (cancelled) return;
        await seedRealCandles(cell.symbol, cell.tf);
      }
    })();
    return () => { cancelled = true; };
  }, [chartLayout, gridCells, seedRealCandles]);

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
  const pnlAtPrice = useCallback(
    (symbolName: string, side: "BUY" | "SELL", entry: number, vol: number, targetPrice: number): number => {
      const m = market[symbolName];
      if (!m) return 0;
      const diff = side === "BUY" ? targetPrice - entry : entry - targetPrice;
      return diff * m.def.contractSize * vol;
    },
    [market]
  );

  const floatingPnl = useMemo(() => positions.reduce((s, p) => s + positionPnl(p), 0), [positions, positionPnl]);
  const usedMargin = useMemo(() => {
    if (!account) return 0;
    return positions.reduce((sum, p) => {
      const m = market[p.symbol.name];
      if (!m) return sum;
      return sum + (m.def.contractSize * parseFloat(p.volume) * m.bid) / account.leverage;
    }, 0);
  }, [positions, market, account]);
  const equity = account ? parseFloat(account.balance) + floatingPnl : 0;
  const freeMargin = equity - usedMargin;
  const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : Infinity;

  const wlGridTemplate = useMemo(() => {
    const widths = ["1fr"]; // symbol
    if (columnPrefs.signal) widths.push("0.4fr");
    widths.push("0.95fr"); // price
    if (columnPrefs.change) widths.push("0.75fr");
    if (columnPrefs.spread) widths.push("0.7fr");
    if (columnPrefs.high) widths.push("0.8fr");
    if (columnPrefs.low) widths.push("0.8fr");
    return `18px ${widths.join(" ")} 20px`;
  }, [columnPrefs]);

  // equity sparkline
  useEffect(() => {
    if (!account) return;
    const hist = equityHistoryRef.current;
    hist.push(equity);
    if (hist.length > 40) hist.shift();
    const canvas = sparklineRef.current;
    if (!canvas || hist.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...hist), max = Math.max(...hist);
    const range = max - min || 1;
    const step = w / (hist.length - 1);
    const up = hist[hist.length - 1] >= hist[0];
    ctx.strokeStyle = up ? "#16C784" : "#EA3943";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 3) - 1.5;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [equity, account]);

  // margin call banner
  const marginCall = positions.length > 0 && isFinite(marginLevel) && marginLevel < 100;
  const marginCallNotifiedRef = useRef(false);
  useEffect(() => {
    if (marginCall && !marginCallNotifiedRef.current) {
      marginCallNotifiedRef.current = true;
      pushToast("Margin call — your margin level is below 100%", true);
    } else if (!marginCall) {
      marginCallNotifiedRef.current = false;
    }
  }, [marginCall, pushToast]);

  function selectSymbol(name: string) {
    if (name === activeSymbol) return;
    setActiveSymbol(name);
    setPendingMarketSide(null);
  }

  // ---------- auto-close / auto-fill / alerts / trailing stops ----------
  useEffect(() => {
    setAlerts((prev) => {
      let changed = false;
      const next = prev.map((a) => {
        if (a.triggered) return a;
        const m = market[a.symbol];
        if (!m || !m.live) return a;
        const hit = a.condition === "above" ? m.bid >= a.price : m.bid <= a.price;
        if (hit) {
          changed = true;
          pushToast(`Alert triggered — ${a.symbol} reached ${fmt(a.price, m.def.digits)}`, true);
          setAlertHistory((h) => [{ ...a, triggered: true, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...h]);
          return { ...a, triggered: true };
        }
        return a;
      });
      return changed ? next.filter((a) => !a.triggered) : prev;
    });

    positions.forEach((p) => {
      if (closingIds.current.has(p.id)) return;
      const m = market[p.symbol.name];
      if (!m || !m.live) return;
      const price = p.side === "BUY" ? m.bid : m.ask;
      const sl = p.slPrice != null ? parseFloat(p.slPrice) : null;
      const tp = p.tpPrice != null ? parseFloat(p.tpPrice) : null;
      let hitType: "S/L" | "T/P" | null = null;
      if (sl != null) { if (p.side === "BUY" ? price <= sl : price >= sl) hitType = "S/L"; }
      if (!hitType && tp != null) { if (p.side === "BUY" ? price >= tp : price <= tp) hitType = "T/P"; }
      if (hitType) {
        closingIds.current.add(p.id);
        tradeApi.closePosition(p.id, price)
          .then((res) => {
            const pnl = (res as { transaction: { amount: string } }).transaction.amount;
            pushToast(`${p.symbol.name} closed — ${hitType} hit — ${parseFloat(pnl) >= 0 ? "+" : ""}${parseFloat(pnl).toFixed(2)} USD`, true);
            return Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
          })
          .catch(() => {})
          .finally(() => closingIds.current.delete(p.id));
      } else if (trailingDistances.current[p.id]) {
        const dist = trailingDistances.current[p.id];
        const digits = p.symbol.digits;
        let newSl: number | null = null;
        if (p.side === "BUY") {
          const candidate = +(price - dist).toFixed(digits);
          if (sl == null || candidate > sl) newSl = candidate;
        } else {
          const candidate = +(price + dist).toFixed(digits);
          if (sl == null || candidate < sl) newSl = candidate;
        }
        if (newSl != null) {
          tradeApi.editPositionSlTp(p.id, { currentPrice: price, slPrice: newSl }).then(refreshPositions).catch(() => {});
        }
      }
    });

    pendingOrders.forEach((o) => {
      if (fillingIds.current.has(o.id)) return;
      const m = market[o.symbol.name];
      if (!m || !m.live || !o.requestedPrice) return;
      const trigger = parseFloat(o.requestedPrice);
      const price = o.side === "BUY" ? m.ask : m.bid;
      let shouldFill = false;
      if (o.type === "LIMIT") shouldFill = o.side === "BUY" ? price <= trigger : price >= trigger;
      if (o.type === "STOP") shouldFill = o.side === "BUY" ? price >= trigger : price <= trigger;
      if (shouldFill) {
        fillingIds.current.add(o.id);
        tradeApi.fillOrder(o.id, price)
          .then(() => {
            pushToast(`${o.symbol.name} pending order triggered — ${o.side} ${o.volume}`, true);
            return Promise.all([refreshOrders(), refreshPositions()]);
          })
          .catch(() => {})
          .finally(() => fillingIds.current.delete(o.id));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  // ---------- order ticket ----------
  const m = market[activeSymbol];

  function updateRiskVolume(riskPctValue: string, slValue: string) {
    const rp = parseFloat(riskPctValue);
    const sl = parseFloat(slValue);
    if (!account || isNaN(rp) || rp <= 0 || isNaN(sl)) return;
    const riskAmount = parseFloat(account.balance) * (rp / 100);
    const slDistance = Math.abs(m.bid - sl);
    const valuePerLot = slDistance * m.def.contractSize;
    if (valuePerLot <= 0) return;
    const vol = Math.max(0.01, +(riskAmount / valuePerLot).toFixed(2));
    setVolume(vol);
  }

  function buildSlTpPreview(symbolName: string, vol: number, currentPrice: number, sl: number, tp: number): string[] {
    const lines: string[] = [];
    const mm = market[symbolName];
    if (!isNaN(sl) && sl !== currentPrice) {
      const side = sl < currentPrice ? "BUY" : "SELL";
      const pnl = pnlAtPrice(symbolName, side, currentPrice, vol, sl);
      lines.push(`S/L (if hit): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    }
    if (!isNaN(tp) && tp !== currentPrice) {
      const side = tp > currentPrice ? "BUY" : "SELL";
      const pnl = pnlAtPrice(symbolName, side, currentPrice, vol, tp);
      lines.push(`T/P (if hit): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    }
    void mm;
    return lines;
  }
  const ticketSl = parseFloat(slInput);
  const ticketTp = parseFloat(tpInput);
  const ticketHintLines = buildSlTpPreview(activeSymbol, volume, m.bid, ticketSl, ticketTp);
  const buyDisabled = !m.live || (!isNaN(ticketSl) && ticketSl >= m.bid) || (!isNaN(ticketTp) && ticketTp <= m.bid);
  const sellDisabled = !m.live || (!isNaN(ticketSl) && ticketSl <= m.bid) || (!isNaN(ticketTp) && ticketTp >= m.bid);

  async function placeOrder(side: "BUY" | "SELL") {
    if (!m.live) { pushToast("No live feed for this symbol"); return; }
    const sl = slInput === "" ? null : parseFloat(slInput);
    const tp = tpInput === "" ? null : parseFloat(tpInput);
    const refPrice = side === "BUY" ? m.ask : m.bid;
    const error = isValidSlTpForSide(side, sl, tp, refPrice);
    if (error) { pushToast(error); return; }
    try {
      await tradeApi.placeOrder({
        symbol: activeSymbol, side, type: "MARKET", volume, price: refPrice,
        slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID(),
      });
      pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${volume} lots of ${activeSymbol} @ ${fmt(refPrice, m.def.digits)}`);
      await Promise.all([refreshPositions(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed");
    }
  }

  function confirmAndPlace(side: "BUY" | "SELL") {
    if (oneClick) { placeOrder(side); return; }
    setPendingMarketSide((prev) => (prev === side ? null : side));
  }

  async function placePendingOrder() {
    if (!m.live) { pushToast("No live feed for this symbol"); return; }
    const price = parseFloat(pendingPrice);
    if (isNaN(price)) { pushToast("Enter a valid entry price"); return; }
    if (!isValidPendingPrice(pendingType, price, m.bid)) { pushToast(pendingPriceRuleText(pendingType)); return; }
    const side = pendingType.startsWith("buy") ? "BUY" : "SELL";
    const type = pendingType.endsWith("limit") ? "LIMIT" : "STOP";
    const sl = slInput === "" ? null : parseFloat(slInput);
    const tp = tpInput === "" ? null : parseFloat(tpInput);
    try {
      await tradeApi.placeOrder({
        symbol: activeSymbol, side, type, volume, price, slPrice: sl, tpPrice: tp,
        idempotencyKey: crypto.randomUUID(),
      });
      pushToast(`Pending ${pendingType.replace("_", " ")} placed for ${activeSymbol}`);
      await refreshOrders();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed");
    }
  }

  async function oneClickTrade(symbolName: string, side: "BUY" | "SELL") {
    const mm = market[symbolName];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const ocPrice = side === "BUY" ? mm.ask : mm.bid;
    try {
      await tradeApi.placeOrder({
        symbol: symbolName, side, type: "MARKET", volume,
        price: ocPrice, idempotencyKey: crypto.randomUUID(),
      });
      pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${volume} lots of ${symbolName} @ ${fmt(ocPrice, mm.def.digits)} — one-click`);
      await Promise.all([refreshPositions(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed");
    }
  }

  // ---------- positions ----------
  async function closePositionFull(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    const mm = market[p.symbol.name];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const price = p.side === "BUY" ? mm.bid : mm.ask;
    try {
      const res = await tradeApi.closePosition(id, price);
      const pnl = parseFloat((res as { transaction: { amount: string } }).transaction.amount);
      pushToast(`Closed ${p.symbol.name} — ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`);
      await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to close position");
    }
  }

  function openPartialClose(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    askPrompt(`Close how many lots out of ${parseFloat(p.volume).toFixed(2)}?`, (parseFloat(p.volume) / 2).toFixed(2), async (amountStr) => {
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0 || amount >= parseFloat(p.volume)) {
        pushToast("Enter a value less than the full position size");
        return;
      }
      const mm = market[p.symbol.name];
      if (!mm.live) { pushToast("No live feed for this symbol"); return; }
      const price = p.side === "BUY" ? mm.bid : mm.ask;
      try {
        const res = await tradeApi.closePosition(id, price, amount);
        const pnl = parseFloat((res as { transaction: { amount: string } }).transaction.amount);
        pushToast(`Closed ${amount} lots of ${p.symbol.name} — ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`);
        await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "failed to partially close");
      }
    });
  }

  function openTrailingStop(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    askPrompt(`Trailing stop distance (price units) for ${p.symbol.name}:`, "5.00", (distStr) => {
      const dist = parseFloat(distStr);
      if (isNaN(dist) || dist <= 0) { pushToast("Enter a valid distance"); return; }
      trailingDistances.current[id] = dist;
      pushToast(`Trailing stop of ${dist} set on ${p.symbol.name} — SL follows price automatically`);
    });
  }

  async function reversePosition(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    const mm = market[p.symbol.name];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const closePrice = p.side === "BUY" ? mm.bid : mm.ask;
    const newSide = p.side === "BUY" ? "SELL" : "BUY";
    try {
      await tradeApi.closePosition(id, closePrice);
      await tradeApi.placeOrder({
        symbol: p.symbol.name, side: newSide, type: "MARKET", volume: parseFloat(p.volume),
        price: newSide === "BUY" ? mm.ask : mm.bid, idempotencyKey: crypto.randomUUID(),
      });
      pushToast(`${p.symbol.name} reversed to ${newSide}`);
      await Promise.all([refreshPositions(), refreshHistory(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to reverse");
    }
  }

  function editComment(id: string) {
    askPrompt("Comment for this position:", comments[id] ?? "", (val) => {
      setComments((prev) => ({ ...prev, [id]: val.trim() }));
    });
  }

  function openShareForPosition(id: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    const mm = market[p.symbol.name];
    const pnl = positionPnl(p);
    const pnlPct = account ? (pnl / parseFloat(account.balance)) * 100 : 0;
    const sl = p.slPrice ? parseFloat(p.slPrice) : null;
    const tp = p.tpPrice ? parseFloat(p.tpPrice) : null;
    const rr = sl && tp ? Math.abs((tp - parseFloat(p.openPrice)) / (parseFloat(p.openPrice) - sl)).toFixed(1) : "—";
    setShareData({
      symbolLabel: p.symbol.name, pnl, pnlPct,
      entryLabel: fmt(parseFloat(p.openPrice), p.symbol.digits), currentLabel: fmt(mm.bid, p.symbol.digits),
      rrLabel: rr === "—" ? "—" : `1 : ${rr}`, rrTitle: "RR",
    });
  }

  function openShareForNet(symbolName: string) {
    const symPositions = positions.filter((p) => p.symbol.name === symbolName);
    if (symPositions.length === 0) return;
    const mm = market[symbolName];
    let buyLots = 0, sellLots = 0, totalPnl = 0, weightedEntry = 0;
    symPositions.forEach((p) => {
      const vol = parseFloat(p.volume);
      if (p.side === "BUY") buyLots += vol; else sellLots += vol;
      totalPnl += positionPnl(p);
      weightedEntry += parseFloat(p.openPrice) * vol;
    });
    const totalLots = buyLots + sellLots;
    const avgEntry = weightedEntry / totalLots;
    const netLots = +(buyLots - sellLots).toFixed(2);
    const netSide = netLots > 0 ? "Buy" : netLots < 0 ? "Sell" : "Flat";
    const pnlPct = account ? (totalPnl / parseFloat(account.balance)) * 100 : 0;
    setShareData({
      symbolLabel: `${symbolName} · net ${netSide} ${Math.abs(netLots).toFixed(2)}`,
      pnl: totalPnl, pnlPct,
      entryLabel: fmt(avgEntry, symPositions[0].symbol.digits), currentLabel: fmt(mm.bid, symPositions[0].symbol.digits),
      rrLabel: `${symPositions.length}`, rrTitle: "Positions",
    });
  }

  async function closeManyBySymbol(symbolName: string) {
    const toClose = positions.filter((p) => p.symbol.name === symbolName);
    for (const p of toClose) await closePositionFull(p.id);
  }
  async function closeManyBy(predicate: (p: ApiPosition) => boolean, label: string) {
    const toClose = positions.filter(predicate);
    if (toClose.length === 0) return;
    for (const p of toClose) await closePositionFull(p.id);
    pushToast(`${label} — ${toClose.length} position${toClose.length > 1 ? "s" : ""} closed`);
  }

  function openSltpEditForNet(symbolName: string) {
    setSltpEdit({ posId: null, netSymbol: symbolName, sl: "", tp: "" });
  }
  async function saveSltpEdit() {
    if (!sltpEdit) return;
    const sl = sltpEdit.sl === "" ? null : parseFloat(sltpEdit.sl);
    const tp = sltpEdit.tp === "" ? null : parseFloat(sltpEdit.tp);
    if (sltpEdit.netSymbol) {
      const symPositions = positions.filter((p) => p.symbol.name === sltpEdit.netSymbol);
      const mm = market[sltpEdit.netSymbol];
      if (!mm.live) { pushToast("No live feed for this symbol"); return; }
      let updated = 0, skipped = 0;
      for (const p of symPositions) {
        const testSl = sl ?? (p.slPrice ? parseFloat(p.slPrice) : null);
        const testTp = tp ?? (p.tpPrice ? parseFloat(p.tpPrice) : null);
        const error = isValidSlTpForSide(p.side, testSl, testTp, mm.bid);
        if (error) { skipped++; continue; }
        await tradeApi.editPositionSlTp(p.id, { currentPrice: mm.bid, slPrice: sl ?? undefined, tpPrice: tp ?? undefined });
        updated++;
      }
      pushToast(skipped > 0 ? `${sltpEdit.netSymbol} — updated ${updated}, skipped ${skipped}` : `${sltpEdit.netSymbol} — updated SL/TP on ${updated} positions`);
    } else if (sltpEdit.posId) {
      const p = positions.find((x) => x.id === sltpEdit.posId);
      if (p) {
        const mm = market[p.symbol.name];
        if (!mm.live) { pushToast("No live feed for this symbol"); return; }
        const error = isValidSlTpForSide(p.side, sl, tp, mm.bid);
        if (error) { pushToast(error); return; }
        try {
          await tradeApi.editPositionSlTp(p.id, { currentPrice: mm.bid, slPrice: sl, tpPrice: tp });
          pushToast(`${p.symbol.name} position updated`);
        } catch (err) {
          pushToast(err instanceof Error ? err.message : "failed to update");
        }
      }
    }
    setSltpEdit(null);
    await refreshPositions();
  }

  // ---------- inline SL/TP edit ----------
  const [inlineEditing, setInlineEditing] = useState<{ id: string; field: "sl" | "tp"; value: string } | null>(null);
  async function commitInlineEdit(id: string, field: "sl" | "tp", raw: string) {
    const p = positions.find((x) => x.id === id);
    if (!p) return;
    const trimmed = raw.trim();
    const mm = market[p.symbol.name];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const value = trimmed === "" ? null : parseFloat(trimmed);
    if (value != null && isNaN(value)) { pushToast("Enter a valid price"); return; }
    const testSl = field === "sl" ? value : p.slPrice ? parseFloat(p.slPrice) : null;
    const testTp = field === "tp" ? value : p.tpPrice ? parseFloat(p.tpPrice) : null;
    const error = isValidSlTpForSide(p.side, testSl, testTp, mm.bid);
    if (error) { pushToast(error); return; }
    try {
      await tradeApi.editPositionSlTp(id, { currentPrice: mm.bid, ...(field === "sl" ? { slPrice: value } : { tpPrice: value }) });
      pushToast(`${p.symbol.name} ${field.toUpperCase()} updated`);
      await refreshPositions();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to update");
    }
  }

  // ---------- quick order (double-click watchlist) ----------
  function openQuickOrder(symbolName: string) {
    setQuickOrder({ symbol: symbolName });
    setQuickOrderVolume(volume.toFixed(2));
    setQuickOrderRisk(""); setQuickOrderSl(""); setQuickOrderTp(""); setQuickOrderComment("");
  }
  async function submitQuickOrder(side: "BUY" | "SELL") {
    if (!quickOrder) return;
    const mm = market[quickOrder.symbol];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const vol = parseFloat(quickOrderVolume) || 0.01;
    const sl = quickOrderSl === "" ? null : parseFloat(quickOrderSl);
    const tp = quickOrderTp === "" ? null : parseFloat(quickOrderTp);
    const refPrice = side === "BUY" ? mm.ask : mm.bid;
    const error = isValidSlTpForSide(side, sl, tp, refPrice);
    if (error) { pushToast(error); return; }
    try {
      await tradeApi.placeOrder({ symbol: quickOrder.symbol, side, type: "MARKET", volume: vol, price: refPrice, slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID() });
      pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${vol} lots of ${quickOrder.symbol} @ ${fmt(refPrice, mm.def.digits)}`);
      setQuickOrder(null);
      await Promise.all([refreshPositions(), refreshAccount()]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed");
    }
  }

  // ---------- chart right-click quick pending order ----------
  async function quickPlacePendingAtPrice(type: PendingType, price: number) {
    if (!m.live) { pushToast("No live feed for this symbol"); return; }
    if (!isValidPendingPrice(type, price, m.bid)) { pushToast(pendingPriceRuleText(type)); return; }
    const side = type.startsWith("buy") ? "BUY" : "SELL";
    const orderType = type.endsWith("limit") ? "LIMIT" : "STOP";
    try {
      await tradeApi.placeOrder({ symbol: activeSymbol, side, type: orderType, volume, price, idempotencyKey: crypto.randomUUID() });
      pushToast(`Pending ${type.replace("_", " ")} placed for ${activeSymbol} @ ${fmt(price, m.def.digits)}`);
      await refreshOrders();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "order failed");
    }
  }

  // ---------- alerts ----------
  function openPriceAlert(symbolName: string) {
    const mm = market[symbolName];
    askPrompt(`Alert me when ${symbolName} reaches:`, fmt(mm.bid, mm.def.digits), (priceStr) => {
      const price = parseFloat(priceStr);
      if (isNaN(price)) { pushToast("Enter a valid price"); return; }
      setAlerts((prev) => [...prev, { id: nextId(), symbol: symbolName, condition: "above", price, triggered: false }]);
      pushToast(`Alert set — ${symbolName} @ ${fmt(price, mm.def.digits)}`);
    });
  }

  // ---------- watchlist drag reorder ----------
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

  // ---------- chart ----------
  const candles: Candle[] = m.candles[currentTf];

  const chartLines: ChartLine[] = useMemo(
    () => computeChartLines(activeSymbol, positions, pendingOrders),
    [positions, pendingOrders, activeSymbol]
  );

  function handleChartContextMenuPrice(price: number, clientX: number, clientY: number) {
    setChartContextMenu({ x: clientX, y: clientY, price });
  }

  function toggleMaIndicator() {
    setMaActive(chartRef.current?.toggleMA() ?? false);
  }

  if (loadError) {
    return <div style={{ padding: 40, color: "#EDEFF2", background: "#07090C", minHeight: "100vh" }}>{loadError}</div>;
  }

  const acctPositions = positions;
  const netBySymbol = new Map<string, { buyLots: number; sellLots: number; pnl: number; count: number; digits: number; slLabel: string; tpLabel: string }>();
  acctPositions.forEach((p) => {
    const entry = netBySymbol.get(p.symbol.name) ?? { buyLots: 0, sellLots: 0, pnl: 0, count: 0, digits: p.symbol.digits, slLabel: "", tpLabel: "" };
    const vol = parseFloat(p.volume);
    if (p.side === "BUY") entry.buyLots += vol; else entry.sellLots += vol;
    entry.pnl += positionPnl(p);
    entry.count += 1;
    netBySymbol.set(p.symbol.name, entry);
  });

  const serverName = account ? `${brokerName}-${account.accountType === "LIVE" ? "Live" : "Demo"}` : brokerName;

  return (
    <div className="wt-root" data-theme={theme}>
      <DesktopTitleBar brokerName={brokerName} server={serverName} connected={connected} />
      <div id="app">
        <div className={`margin-call-banner${marginCall ? " show" : ""}`}>
          Margin call — your margin level is below 100%. Deposit funds or close positions to avoid stop-out.
        </div>

        <div className="topbar">
          <div className="topbar-left">
            <div className="nav">
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => { setFileMenuOpen((v) => !v); setToolsMenuOpen(false); }}>File</div>
                {fileMenuOpen ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 180 }} onClick={() => setFileMenuOpen(false)}>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={handleLogout}>Switch account</div>
                    {isDesktopApp ? (
                      <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => window.vyxDesktop?.close()}>Exit</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => { setToolsMenuOpen((v) => !v); setFileMenuOpen(false); }}>Tools</div>
                {toolsMenuOpen ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 180 }}>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setToolsMenuOpen(false); setChangePasswordOpen(true); }}>Change password</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setToolsMenuOpen(false); setKycModalOpen(true); refreshKycStatus(); }}>Verify identity</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setToolsMenuOpen(false); setActiveBottomTab("logs"); }}>View logs</div>
                    <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                    <div style={{ padding: "4px 10px 2px", fontSize: 10, color: "var(--text-3)", textTransform: "uppercase" }}>Theme</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px", display: "flex", justifyContent: "space-between" }} onClick={() => changeTheme("default")}>
                      Default {theme === "default" ? <span style={{ color: "var(--buy)" }}>✓</span> : null}
                    </div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px", display: "flex", justifyContent: "space-between" }} onClick={() => changeTheme("classic")}>
                      Classic {theme === "classic" ? <span style={{ color: "var(--buy)" }}>✓</span> : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="item" onClick={() => { setReportsOpen(true); setReportRows(null); }}>Reports</div>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => { setActionsMenuOpen((v) => !v); setActionsSearch(""); }}>Quick actions ▾</div>
                {actionsMenuOpen ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 240 }}>
                    <input
                      className="wl-search mono"
                      autoFocus
                      placeholder="Jump to symbol…"
                      value={actionsSearch}
                      onChange={(e) => setActionsSearch(e.target.value)}
                      style={{ margin: 6, width: "calc(100% - 12px)" }}
                    />
                    {actionsSearch ? (
                      <div style={{ maxHeight: 160, overflowY: "auto" }}>
                        {SYMBOL_DEFS.filter((s) => s.name.toLowerCase().includes(actionsSearch.toLowerCase())).map((s) => (
                          <div
                            key={s.name}
                            className="acc-option"
                            style={{ cursor: "pointer", padding: "7px 10px" }}
                            onClick={() => { selectSymbol(s.name); setActionsMenuOpen(false); }}
                          >
                            <span className="mono">{s.name}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px", color: acctPositions.some((p) => positionPnl(p) >= 0) ? "var(--buy)" : "var(--text-3)" }}
                          onClick={() => { closeManyBy((p) => positionPnl(p) >= 0, "Closed profitable"); setActionsMenuOpen(false); }}
                        >
                          Close profitable positions
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px", color: acctPositions.some((p) => positionPnl(p) < 0) ? "var(--sell)" : "var(--text-3)" }}
                          onClick={() => { closeManyBy((p) => positionPnl(p) < 0, "Closed losing"); setActionsMenuOpen(false); }}
                        >
                          Close losing positions
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { closeManyBy(() => true, "Closed all"); setActionsMenuOpen(false); }}
                        >
                          Close all positions
                        </div>
                        <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { setOneClick((v) => !v); pushToast(!oneClick ? "One-click trading enabled" : "One-click trading disabled"); setActionsMenuOpen(false); }}
                        >
                          Toggle one-click trading
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { setActiveBottomTab("logs"); setActionsMenuOpen(false); }}
                        >
                          View logs
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => setHelpMenuOpen((v) => !v)}>Help</div>
                {helpMenuOpen ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 190 }}>
                    <div
                      className="acc-option"
                      style={{ cursor: "pointer", padding: "8px 10px" }}
                      onClick={() => { setHelpMenuOpen(false); window.open("mailto:support@vyxtrader.com", "_blank"); }}
                    >
                      Contact support
                    </div>
                    <div
                      className="acc-option"
                      style={{ cursor: "pointer", padding: "8px 10px" }}
                      onClick={() => { setHelpMenuOpen(false); pushToast("VyXTrader — B2B white-label trading platform"); }}
                    >
                      About
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <span className="broker-logo topbar-center">
            <span className="broker-logo-mark">
              {brokerLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brokerLogoUrl} alt={brokerName} />
              ) : brokerName.charAt(0).toUpperCase()}
            </span>
            <span className="broker-logo-text">{brokerName.toUpperCase()}</span>
            <span
              title={serverName}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 10,
                padding: "2px 8px", borderRadius: 4, fontSize: 10.5, fontWeight: 600,
                background: connected ? "var(--buy-bg)" : "var(--sell-bg)",
                color: connected ? "var(--buy)" : "var(--sell)",
              }}
            >
              <svg width="13" height="10" viewBox="0 0 15 12" style={{ flexShrink: 0 }}>
                {[{ h: 4, y: 8 }, { h: 6.5, y: 5.5 }, { h: 9, y: 3 }, { h: 12, y: 0 }].map((b, i) => (
                  <rect key={i} x={i * 3.9} y={b.y} width="2.6" height={b.h} rx="0.6" fill={connected ? "var(--buy)" : i === 0 ? "var(--sell)" : "#3a4150"} />
                ))}
              </svg>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </span>
          <div className="topbar-right">
            <span className="trader-name">{balanceHidden ? "••••••" : account?.fullName ?? ""}</span>
            <button className="eye-toggle-btn" onClick={() => setBalanceHidden((v) => !v)} title={balanceHidden ? "Show balance" : "Hide balance"}>
              {balanceHidden ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
            <div className="account-switcher">
              <div className={`mode-toggle${account?.accountType === "LIVE" ? " live" : ""}`} onClick={() => setAccountDropdownOpen((v) => !v)}>
                <span className="mono mode-toggle-acc-num">{account?.accountNumber ?? "..."}</span>
                <span className="mode-toggle-label">{account?.accountType ?? ""}</span>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 2 }}><path d="M6 9l6 6 6-6" /></svg>
              </div>
              {accountDropdownOpen ? (
                <div className="account-dropdown show">
                  <div className="acc-option active">
                    <div className="acc-option-top">
                      <span className="acc-option-num mono">{account?.accountNumber}</span>
                      <span className={`acc-badge ${account?.accountType === "LIVE" ? "live" : "demo"}`}>{account?.accountType}</span>
                    </div>
                    <div className="acc-option-balance mono">{balanceHidden ? "••••••" : account ? money(parseFloat(account.balance)) : ""}</div>
                  </div>
                  <div className="net-pos-detail" style={{ padding: "8px 10px" }}>
                    To trade another account, log out and sign in with its account number.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)" }}>
                    <button
                      className="wl-ctx-item"
                      style={{ background: "transparent", border: "none", textAlign: "left", width: "100%", cursor: "pointer", color: "var(--text-2)" }}
                      onClick={() => { setAccountDropdownOpen(false); setChangePasswordOpen(true); }}
                    >
                      Change password
                    </button>
                    <button
                      className="wl-ctx-item"
                      style={{ background: "transparent", border: "none", textAlign: "left", width: "100%", cursor: "pointer", color: "var(--sell)" }}
                      onClick={handleLogout}
                    >
                      Log out
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <button className="funds-btn" onClick={() => { setFundsModalOpen(true); refreshFundsHistory(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
              Funds
            </button>
            <button className="bell-btn" onClick={() => setAlertsModalOpen(true)} title="Price alerts">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
              {alerts.length > 0 ? <span className="bell-count">{alerts.length}</span> : null}
            </button>
            <div className="avatar">{account?.accountNumber?.slice(-2) ?? "—"}</div>
          </div>
        </div>

        <div className="main" style={{ gridTemplateColumns: `48px ${orderPanelWidth}px 6px 1fr 6px ${watchlistWidth}px` }}>
          {/* ---------- ICON RAIL (far left) ---------- */}
          <div className="rail">
            <button className="rail-item active" title="Trade">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18.7 8.3 13 14l-4-4-5.3 5.3" /></svg>
            </button>
            <button className="rail-item" title="Reports" onClick={() => { setReportsOpen(true); setReportRows(null); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
            </button>
            <button className="rail-item" title="Journal (logs)" onClick={() => setActiveBottomTab("logs")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
            </button>
            <button className="rail-item" title="News" onClick={() => setActiveBottomTab("positions")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><line x1="8" y1="7" x2="16" y2="7" /><line x1="8" y1="11" x2="16" y2="11" /></svg>
            </button>
            <button className="rail-item" title="Alerts" onClick={() => setAlertsModalOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
            </button>
            <div className="rail-sep" />
            <button className="rail-item rail-bottom" title="Change password" onClick={() => setChangePasswordOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </button>
          </div>

          {/* ---------- ORDER PANEL (left) ---------- */}
          <div className="order-panel">
            <div className="section-label" style={{ paddingLeft: 0 }}>Order ticket</div>

            <div className="order-type-tabs">
              <button className={`ot-tab${orderMode === "market" ? " active" : ""}`} onClick={() => setOrderMode("market")}>Market</button>
              <button className={`ot-tab${orderMode === "pending" ? " active" : ""}`} onClick={() => {
                setOrderMode("pending");
                setPendingPrice(fmt(m.bid * 0.999, m.def.digits));
              }}>Pending</button>
            </div>

            {orderMode === "pending" ? (
              <>
                <div style={{ marginBottom: 10 }}>
                  <select className="pending-select" value={pendingType} onChange={(e) => setPendingType(e.target.value as PendingType)}>
                    <option value="buy_limit">Buy limit</option>
                    <option value="sell_limit">Sell limit</option>
                    <option value="buy_stop">Buy stop</option>
                    <option value="sell_stop">Sell stop</option>
                  </select>
                </div>
                <div className="field-group">
                  <div className="field">
                    <span className="field-label">Entry price</span>
                    <input className="mono" value={pendingPrice} onChange={(e) => setPendingPrice(e.target.value)} />
                  </div>
                </div>
                {pendingPrice ? (
                  <div className="margin-note" style={{ color: isValidPendingPrice(pendingType, parseFloat(pendingPrice), m.bid) ? "var(--text-3)" : "var(--sell)" }}>
                    {isValidPendingPrice(pendingType, parseFloat(pendingPrice), m.bid)
                      ? `Current price ${fmt(m.bid, m.def.digits)}`
                      : `${pendingPriceRuleText(pendingType)} (current ${fmt(m.bid, m.def.digits)})`}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="sentiment-box">
                <div className="sentiment-prices">
                  <button className={`sentiment-price-btn sell${pendingMarketSide === "SELL" ? " selected" : ""}`} disabled={sellDisabled} onClick={() => confirmAndPlace("SELL")}>
                    <span className="sp-label">Sell</span>
                    <span className="sp-value mono">{m.live ? fmt(m.bid, m.def.digits) : "—"}</span>
                  </button>
                  <button className={`sentiment-price-btn buy${pendingMarketSide === "BUY" ? " selected" : ""}`} disabled={buyDisabled} onClick={() => confirmAndPlace("BUY")}>
                    <span className="sp-label">Buy</span>
                    <span className="sp-value mono">{m.live ? fmt(m.ask, m.def.digits) : "—"}</span>
                  </button>
                </div>
              </div>
            )}

            {orderMode === "pending" ? (
              <button className="place-pending-btn" onClick={placePendingOrder}>Place pending order</button>
            ) : null}

            <div className="field-group">
              <div className="field">
                <span className="field-label">Volume (lots)</span>
                <div className="lot-stepper">
                  <button className="stepper-btn" onClick={() => setVolume((v) => Math.max(0.01, +(v - 0.01).toFixed(2)))}>−</button>
                  <input className="mono" style={{ width: 44, textAlign: "center" }} value={volume.toFixed(2)} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setVolume(v); }} />
                  <button className="stepper-btn" onClick={() => setVolume((v) => +(v + 0.01).toFixed(2))}>+</button>
                </div>
              </div>
              <div className="field">
                <span className="field-label">Risk %</span>
                <input className="mono" placeholder="—" value={riskPct} onChange={(e) => { setRiskPct(e.target.value); updateRiskVolume(e.target.value, slInput); }} />
              </div>
              <div className="field">
                <span className="field-label">Stop loss</span>
                <span className="input-with-clear">
                  <input className="mono" placeholder="—" value={slInput} onChange={(e) => { setSlInput(e.target.value); if (riskPct) updateRiskVolume(riskPct, e.target.value); }} />
                  <button className="clear-input-btn" onClick={() => setSlInput("")}>✕</button>
                </span>
              </div>
              <div className="field">
                <span className="field-label">Take profit</span>
                <span className="input-with-clear">
                  <input className="mono" placeholder="—" value={tpInput} onChange={(e) => setTpInput(e.target.value)} />
                  <button className="clear-input-btn" onClick={() => setTpInput("")}>✕</button>
                </span>
              </div>
            </div>
            {riskPct ? <div className="margin-note">Volume auto-calculated from risk % and stop distance</div> : null}

            <div className="field-group">
              <div className="field"><span className="field-label">Leverage</span><span className="mono" style={{ fontSize: 12.5 }}>1:{account?.leverage ?? 100}</span></div>
            </div>

            <div className="margin-note">Margin required <span className="mono">{account ? fmt((volume * m.def.contractSize * m.bid) / account.leverage, 2) : "—"}</span> USD</div>
            {ticketHintLines.length > 0 ? <div className="sltp-preview" dangerouslySetInnerHTML={{ __html: ticketHintLines.join("<br>") }} /> : null}

            {orderMode === "market" && pendingMarketSide ? (
              <button className={`confirm-market-btn ${pendingMarketSide === "BUY" ? "buy" : "sell"}`} onClick={() => { placeOrder(pendingMarketSide); setPendingMarketSide(null); }}>
                Confirm {pendingMarketSide} Market Order
              </button>
            ) : null}

            <div className="occ-toggle-row">
              <span className="field-label">One-click trading</span>
              <label className="switch">
                <input type="checkbox" checked={oneClick} onChange={(e) => { setOneClick(e.target.checked); pushToast(e.target.checked ? "One-click trading enabled" : "One-click trading disabled"); if (e.target.checked) setPendingMarketSide(null); }} />
                <span className="switch-slider" />
              </label>
            </div>

            <SessionClock />
            <NewsPanel />
          </div>

          <div className="col-resizer" onMouseDown={startResize("order")} />

          {/* ---------- CENTER (chart) ---------- */}
          <div className="center">
            <div className="chart-header">
              <div className="chart-title" style={{ position: "relative" }}>
                <div className="chart-symbol" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }} onClick={() => { setSymbolDropdownOpen((v) => !v); setSymbolSearch(""); }}>
                  {activeSymbol}
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                </div>
                {symbolDropdownOpen ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 220 }}>
                    <input
                      className="wl-search mono"
                      autoFocus
                      placeholder="Search symbol..."
                      value={symbolSearch}
                      onChange={(e) => setSymbolSearch(e.target.value)}
                      style={{ margin: 6, width: "calc(100% - 12px)" }}
                    />
                    <div style={{ maxHeight: 260, overflowY: "auto" }}>
                      {SYMBOL_DEFS.filter((s) => s.name.toLowerCase().includes(symbolSearch.toLowerCase())).map((s) => (
                        <div
                          key={s.name}
                          className={`acc-option${s.name === activeSymbol ? " active" : ""}`}
                          style={{ cursor: "pointer", padding: "7px 10px" }}
                          onClick={() => { selectSymbol(s.name); setSymbolDropdownOpen(false); }}
                        >
                          <span className="mono">{s.name}</span>
                          <span className="net-pos-detail" style={{ marginLeft: 8 }}>{s.category}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {m.live ? (
                  <>
                    <div className="chart-price mono" style={{ color: m.bid >= m.prevBid ? "var(--buy)" : "var(--sell)" }}>{fmt(m.bid, m.def.digits)}</div>
                    <div className="chart-change mono" style={{ background: m.bid >= m.dayOpen ? "var(--buy-bg)" : "var(--sell-bg)", color: m.bid >= m.dayOpen ? "var(--buy)" : "var(--sell)" }}>
                      {(((m.bid - m.dayOpen) / m.dayOpen) * 100 >= 0 ? "+" : "") + (((m.bid - m.dayOpen) / m.dayOpen) * 100).toFixed(2)}%
                    </div>
                    <div className="chart-spread mono">Spread {fmt(m.ask - m.bid, m.def.digits)}</div>
                  </>
                ) : (
                  <div className="chart-price mono" style={{ color: "var(--text-3)", fontSize: 12 }}>No live feed</div>
                )}
                <button className="symbol-info-btn" onClick={() => setSymbolInfoOpen(true)} title="Symbol specifications">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                </button>
              </div>
              {chartLayout === "single" ? (
                <div className="timeframes">
                  {TF_LABELS.map((tf) => (
                    <button key={tf.key} className={`tf-btn${currentTf === tf.key ? " active" : ""}`} onClick={() => setCurrentTf(tf.key)}>{tf.label}</button>
                  ))}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 3, background: "var(--bg-2)", padding: 3, borderRadius: 8, marginLeft: 8 }}>
                <button
                  title="Single chart"
                  onClick={() => setChartLayout("single")}
                  style={{ width: 26, height: 24, borderRadius: 5, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: chartLayout === "single" ? "var(--bg-4)" : "transparent", color: chartLayout === "single" ? "var(--text-1)" : "var(--text-3)" }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1" /></svg>
                </button>
                <button
                  title="2x2 grid"
                  onClick={() => setChartLayout("grid")}
                  style={{ width: 26, height: 24, borderRadius: 5, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: chartLayout === "grid" ? "var(--bg-4)" : "transparent", color: chartLayout === "grid" ? "var(--text-1)" : "var(--text-3)" }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg>
                </button>
              </div>
            </div>
            <div className="chart-area">
              {chartLayout === "single" ? (
                <>
                  <div className="drawing-toolbar">
                    <button className="draw-tool-btn" onClick={() => chartRef.current?.addOverlay("trendLine")} title="Trend line">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="20" x2="20" y2="4" /></svg>
                    </button>
                    <button className="draw-tool-btn" onClick={() => chartRef.current?.addOverlay("horizontalStraightLine")} title="Horizontal line">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12" /></svg>
                    </button>
                    <button className="draw-tool-btn" onClick={() => chartRef.current?.addOverlay("fibonacciLine")} title="Fibonacci retracement">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                    </button>
                    <button className="draw-tool-btn" onClick={() => chartRef.current?.addOverlay("rectangle")} title="Rectangle">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="1" /></svg>
                    </button>
                    <button className="draw-tool-btn" onClick={() => chartRef.current?.addOverlay("simpleAnnotation")} title="Text">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
                    </button>
                    <div className="draw-tool-sep" />
                    <button className="draw-tool-btn" onClick={() => { chartRef.current?.removeAllDrawings(); pushToast("Drawings cleared"); }} title="Clear all drawings">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                    </button>
                    <div className="draw-tool-sep" />
                    <button className={`draw-tool-btn${maActive ? " active" : ""}`} onClick={toggleMaIndicator} title="Moving average">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17c3-8 5-8 8 0s5 8 8 0" /></svg>
                    </button>
                  </div>
                  <KLineChartPanel
                    ref={chartRef}
                    candles={candles}
                    digits={m.def.digits}
                    lines={chartLines}
                    onContextMenuPrice={handleChartContextMenuPrice}
                  />
                  {!m.live ? (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>No live feed for {activeSymbol}</span>
                    </div>
                  ) : null}
                  {chartContextMenu ? (
                    <div className="wl-context-menu show" style={{ left: chartContextMenu.x, top: chartContextMenu.y }}>
                      <div className="wl-ctx-title">@ {fmt(chartContextMenu.price, m.def.digits)} — {chartContextMenu.price < m.bid ? "below" : "above"} market</div>
                      {(chartContextMenu.price < m.bid
                        ? [{ type: "buy_limit" as PendingType, label: "Buy limit here" }, { type: "sell_stop" as PendingType, label: "Sell stop here" }]
                        : [{ type: "sell_limit" as PendingType, label: "Sell limit here" }, { type: "buy_stop" as PendingType, label: "Buy stop here" }]
                      ).map((it) => (
                        <div key={it.type} className="wl-ctx-item" onClick={() => { quickPlacePendingAtPrice(it.type, chartContextMenu.price); setChartContextMenu(null); }}>
                          <span>{it.label}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 1, background: "var(--border)", height: "100%", overflow: "hidden" }}>
                  {gridCells.map((cell, i) => (
                    <ChartCell
                      key={i}
                      symbol={cell.symbol}
                      tf={cell.tf}
                      m={market[cell.symbol]}
                      positions={positions}
                      pendingOrders={pendingOrders}
                      focused={cell.symbol === activeSymbol && cell.tf === currentTf}
                      onFocus={() => { selectSymbol(cell.symbol); setCurrentTf(cell.tf); }}
                      onSymbolChange={(sym) => setGridCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, symbol: sym } : c)))}
                      onTfChange={(tf) => setGridCells((prev) => prev.map((c, idx) => (idx === i ? { ...c, tf } : c)))}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="row-resizer" onMouseDown={startResize("bottom")} />

            <div className="bottom-panel" style={{ height: bottomPanelHeight }}>
              <div className="tabs-row">
                <div className="tabs">
                  <div className={`tab${activeBottomTab === "positions" ? " active" : ""}`} onClick={() => setActiveBottomTab("positions")}>Positions ({acctPositions.length})</div>
                  <div className={`tab${activeBottomTab === "net" ? " active" : ""}`} onClick={() => setActiveBottomTab("net")}>Net positions ({netBySymbol.size})</div>
                  <div className={`tab${activeBottomTab === "orders" ? " active" : ""}`} onClick={() => setActiveBottomTab("orders")}>Orders ({pendingOrders.length})</div>
                  <div className={`tab${activeBottomTab === "history" ? " active" : ""}`} onClick={() => setActiveBottomTab("history")}>History</div>
                  <div className={`tab${activeBottomTab === "analytics" ? " active" : ""}`} onClick={() => setActiveBottomTab("analytics")}>Analytics</div>
                  <div className={`tab${activeBottomTab === "logs" ? " active" : ""}`} onClick={() => setActiveBottomTab("logs")}>Logs</div>
                </div>
                {activeBottomTab === "positions" ? (
                  <div className="bulk-actions">
                    <button className="bulk-btn profit" disabled={!acctPositions.some((p) => positionPnl(p) >= 0)} onClick={() => closeManyBy((p) => positionPnl(p) >= 0, "Closed profitable")}>Close profit</button>
                    <button className="bulk-btn loss" disabled={!acctPositions.some((p) => positionPnl(p) < 0)} onClick={() => closeManyBy((p) => positionPnl(p) < 0, "Closed losing")}>Close loss</button>
                    <button className="bulk-btn all" disabled={acctPositions.length === 0} onClick={() => closeManyBy(() => true, "Closed all")}>Close all</button>
                  </div>
                ) : null}
              </div>

              {activeBottomTab === "positions" ? (
                <div className="panel-body">
                  <div className="pos-table-header">
                    <span>ID</span><span>Symbol</span><span>Type</span><span>Lots</span><span>Price</span><span>Opened</span><span>S/L</span><span>T/P</span><span>Comment</span><span>Swap</span><span>Commission</span><span>Profit</span><span></span>
                  </div>
                  {acctPositions.length === 0 ? (
                    <div className="empty-state">No open positions — place a trade to see it here</div>
                  ) : (
                    acctPositions.map((p) => {
                      const pnl = positionPnl(p);
                      const isSlEditing = inlineEditing?.id === p.id && inlineEditing.field === "sl";
                      const isTpEditing = inlineEditing?.id === p.id && inlineEditing.field === "tp";
                      return (
                        <div className="position-row" key={p.id}>
                          <span className="pos-cell mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{p.id.slice(-8)}</span>
                          <span className="pos-cell pos-symbol">{p.symbol.name}</span>
                          <span className="pos-cell"><span className={`pos-side ${p.side.toLowerCase()}`}>{p.side === "BUY" ? "Buy" : "Sell"}</span></span>
                          <span className="pos-cell mono">{parseFloat(p.volume).toFixed(2)}</span>
                          <span className="pos-cell mono">{fmt(parseFloat(p.openPrice), p.symbol.digits)}</span>
                          <span className="pos-cell" style={{ color: "var(--text-3)", fontSize: 11 }}>{new Date(p.openedAt).toLocaleDateString([], { month: "short", day: "numeric" })} {new Date(p.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="pos-cell sltp-pill" onClick={() => !isSlEditing && setInlineEditing({ id: p.id, field: "sl", value: p.slPrice ?? "" })}>
                            {isSlEditing ? (
                              <input autoFocus className="inline-edit-input mono" defaultValue={p.slPrice ? fmt(parseFloat(p.slPrice), p.symbol.digits) : ""}
                                onBlur={(e) => { commitInlineEdit(p.id, "sl", e.target.value); setInlineEditing(null); }}
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setInlineEditing(null); }} />
                            ) : <span className="mono">{p.slPrice ? fmt(parseFloat(p.slPrice), p.symbol.digits) : "—"}</span>}
                          </span>
                          <span className="pos-cell sltp-pill" onClick={() => !isTpEditing && setInlineEditing({ id: p.id, field: "tp", value: p.tpPrice ?? "" })}>
                            {isTpEditing ? (
                              <input autoFocus className="inline-edit-input mono" defaultValue={p.tpPrice ? fmt(parseFloat(p.tpPrice), p.symbol.digits) : ""}
                                onBlur={(e) => { commitInlineEdit(p.id, "tp", e.target.value); setInlineEditing(null); }}
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setInlineEditing(null); }} />
                            ) : <span className="mono">{p.tpPrice ? fmt(parseFloat(p.tpPrice), p.symbol.digits) : "—"}</span>}
                          </span>
                          <span className="pos-cell pos-comment" onClick={() => editComment(p.id)}>{comments[p.id] || "—"}</span>
                          <span className="pos-cell pos-swap mono">{parseFloat(p.swap) >= 0 ? "+" : ""}{parseFloat(p.swap).toFixed(2)}</span>
                          <span className="pos-cell pos-commission mono">{parseFloat(p.commission).toFixed(2)}</span>
                          <span className={`pos-cell pos-pnl mono ${pnl >= 0 ? "pos" : "neg"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</span>
                          <span className="pos-cell pos-actions">
                            <button className="icon-btn" title="Partial close" onClick={() => openPartialClose(p.id)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
                            </button>
                            <button className="icon-btn" title="Trailing stop" onClick={() => openTrailingStop(p.id)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
                            </button>
                            <button className="icon-btn" title="Reverse" onClick={() => reversePosition(p.id)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                            </button>
                            <button className="icon-btn" title="Share" onClick={() => openShareForPosition(p.id)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" /></svg>
                            </button>
                            <button className="icon-btn" title="Close" onClick={() => closePositionFull(p.id)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}

              {activeBottomTab === "net" ? (
                <div className="panel-body">
                  {netBySymbol.size === 0 ? (
                    <div className="empty-state">No open positions — place a trade to see it here</div>
                  ) : (
                    Array.from(netBySymbol.entries()).map(([symbolName, g]) => {
                      const netLots = +(g.buyLots - g.sellLots).toFixed(2);
                      const netSide = netLots > 0 ? "buy" : netLots < 0 ? "sell" : "flat";
                      return (
                        <div className="simple-row" key={symbolName}>
                          <div className="simple-left">
                            <span className="pos-symbol">{symbolName}</span>
                            <span className={`pos-side ${netSide === "sell" ? "sell" : "buy"}`} style={netSide === "flat" ? { background: "var(--bg-3)", color: "var(--text-3)" } : undefined}>
                              {netSide === "flat" ? "FLAT" : netSide.toUpperCase()} {Math.abs(netLots).toFixed(2)}
                            </span>
                            <span className="net-pos-detail">{g.count} position{g.count > 1 ? "s" : ""} · B {g.buyLots.toFixed(2)} / S {g.sellLots.toFixed(2)}</span>
                            <span className="sltp-pill" onClick={() => openSltpEditForNet(symbolName)}>Edit SL/TP</span>
                          </div>
                          <div className="simple-right">
                            <span className={`pos-pnl mono ${g.pnl >= 0 ? "pos" : "neg"}`}>{g.pnl >= 0 ? "+" : ""}{g.pnl.toFixed(2)}</span>
                            <button className="icon-btn" title="Share" onClick={() => openShareForNet(symbolName)}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /></svg>
                            </button>
                            <button className="icon-btn" title={`Close all in ${symbolName}`} onClick={() => closeManyBySymbol(symbolName)}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}

              {activeBottomTab === "orders" ? (
                <div className="panel-body">
                  {pendingOrders.length === 0 ? <div className="empty-state">No pending orders</div> : pendingOrders.map((o) => (
                    <div className="simple-row" key={o.id}>
                      <div className="simple-left">
                        <span className="pos-symbol">{o.symbol.name}</span>
                        <span className={`pos-side ${o.side === "BUY" ? "buy" : "sell"}`}>{o.type} {o.side} {parseFloat(o.volume).toFixed(2)}</span>
                        <span className="net-pos-detail mono">@ {o.requestedPrice ? fmt(parseFloat(o.requestedPrice), o.symbol.digits) : "—"}</span>
                      </div>
                      <div className="simple-right">
                        <button className="icon-btn" title="Cancel order" onClick={() => tradeApi.cancelOrder(o.id).then(refreshOrders)}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {activeBottomTab === "history" ? (
                <div className="panel-body">
                  <div className="history-toolbar">
                    <select className="history-period-select" value={histPeriod} onChange={(e) => setHistPeriod(e.target.value)}>
                      <option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All history</option><option value="custom">Custom range</option>
                    </select>
                    <select className="history-period-select" value={histSymbol} onChange={(e) => setHistSymbol(e.target.value)}>
                      <option value="">All symbols</option>
                      {SYMBOL_DEFS.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                    <div className="history-summary">
                      {history.length > 0 ? <>{history.length} trades · Total <span className={history.reduce((s, h) => s + (h.realizedPnl ? parseFloat(h.realizedPnl) : 0), 0) >= 0 ? "pos" : "neg"}>{money(history.reduce((s, h) => s + (h.realizedPnl ? parseFloat(h.realizedPnl) : 0), 0))}</span></> : null}
                    </div>
                  </div>
                  {histPeriod === "custom" ? (
                    <div className="history-custom-range">
                      <input type="date" className="mono" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
                      <span style={{ color: "var(--text-3)", fontSize: 11 }}>to</span>
                      <input type="date" className="mono" value={histTo} onChange={(e) => setHistTo(e.target.value)} />
                    </div>
                  ) : null}
                  {history.length === 0 ? <div className="empty-state">No closed trades yet</div> : history.map((h) => (
                    <div className="simple-row" key={h.id}>
                      <div className="simple-left">
                        <span className="pos-symbol">{h.symbol.name}</span>
                        <span className={`pos-side ${h.side.toLowerCase()}`}>{h.side} {parseFloat(h.volume).toFixed(2)}</span>
                        <span className="net-pos-detail mono">{fmt(parseFloat(h.openPrice), h.symbol.digits)} → {h.closePrice ? fmt(parseFloat(h.closePrice), h.symbol.digits) : "—"}</span>
                        <span className="net-pos-detail">{h.closedAt ? new Date(h.closedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                      </div>
                      <div className="simple-right">
                        <span className={`pos-pnl mono ${(h.realizedPnl ? parseFloat(h.realizedPnl) : 0) >= 0 ? "pos" : "neg"}`}>{money(h.realizedPnl ? parseFloat(h.realizedPnl) : 0)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {activeBottomTab === "analytics" ? (
                <div className="panel-body">
                  <AnalyticsGrid trades={history} />
                </div>
              ) : null}

              {activeBottomTab === "logs" ? (
                <div className="panel-body">
                  {logs.length === 0 ? (
                    <div className="net-pos-detail" style={{ padding: "12px 4px" }}>No events yet.</div>
                  ) : (
                    logs.map((l) => (
                      <div key={l.id} className="mono" style={{ display: "flex", gap: 10, padding: "5px 4px", fontSize: 11, borderBottom: "1px solid var(--border)", color: "var(--text-2)" }}>
                        <span style={{ color: "var(--text-3)", flexShrink: 0 }}>{l.time}</span>
                        <span>{l.message}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="col-resizer" onMouseDown={startResize("watchlist")} />

          {/* ---------- WATCHLIST (right) ---------- */}
          <div className="watchlist" onContextMenu={(e) => { e.preventDefault(); setWlMenuOpen(true); setWlContextMenu({ x: e.clientX, y: e.clientY }); }}>
            <div className="section-label">Watchlist</div>
            <input className="wl-search mono" placeholder="Search symbol..." value={watchlistFilter} onChange={(e) => setWatchlistFilter(e.target.value)} />
            <div className="wl-header" style={{ gridTemplateColumns: wlGridTemplate }}>
              <span></span><span>Symbol</span>
              {columnPrefs.signal ? <span>Signal</span> : null}
              <span>Price</span>
              {columnPrefs.change ? <span>Chg%</span> : null}
              {columnPrefs.spread ? <span>Spread</span> : null}
              {columnPrefs.high ? <span>Day H</span> : null}
              {columnPrefs.low ? <span>Day L</span> : null}
              <span></span>
            </div>
            <div>
              {watchlistOrder.filter((name) => name.toLowerCase().includes(watchlistFilter.toLowerCase())).map((name) => {
                const row = market[name];
                const changePct = ((row.bid - row.dayOpen) / row.dayOpen) * 100;
                const flash = row.bid > row.prevBid ? "up" : row.bid < row.prevBid ? "down" : "";
                return (
                  <div key={name} className={`wl-item${name === activeSymbol ? " active" : ""}`} style={{ gridTemplateColumns: wlGridTemplate }} onClick={() => selectSymbol(name)} onDoubleClick={() => openQuickOrder(name)} {...attachDragHandlers(name)}>
                    <span className="wl-drag-handle">⋮⋮</span>
                    <span className="wl-cell wl-symbol">{name}</span>
                    {columnPrefs.signal ? <span className={`wl-cell wl-signal ${row.live && row.bid >= row.dayOpen ? "wl-pos" : "wl-neg"}`}>{row.live ? (row.bid >= row.dayOpen ? "▲" : "▼") : "—"}</span> : null}
                    <span className="wl-cell wl-price-cell">
                      {row.live ? (
                        <span className={`wl-price mono ${flash}`}>{fmt(row.bid, row.def.digits)}</span>
                      ) : (
                        <span className="wl-price mono" style={{ color: "var(--text-3)", fontSize: 10.5 }}>No feed</span>
                      )}
                      {oneClick ? (
                        <span className="wl-occ-buttons" style={{ display: "flex" }}>
                          <button className="wl-occ-btn buy" disabled={!row.live} onClick={(e) => { e.stopPropagation(); oneClickTrade(name, "BUY"); }}>B</button>
                          <button className="wl-occ-btn sell" disabled={!row.live} onClick={(e) => { e.stopPropagation(); oneClickTrade(name, "SELL"); }}>S</button>
                        </span>
                      ) : null}
                    </span>
                    {columnPrefs.change ? <span className={`wl-cell mono ${changePct >= 0 ? "wl-pos" : "wl-neg"}`}>{row.live ? (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%" : "—"}</span> : null}
                    {columnPrefs.spread ? <span className="wl-cell mono">{row.live ? fmt(row.ask - row.bid, row.def.digits) : "—"}</span> : null}
                    {columnPrefs.high ? <span className="wl-cell mono">{row.live ? fmt(row.high, row.def.digits) : "—"}</span> : null}
                    {columnPrefs.low ? <span className="wl-cell mono">{row.live ? fmt(row.low, row.def.digits) : "—"}</span> : null}
                    <button className={`wl-alert-btn${alerts.some((a) => a.symbol === name) ? " active" : ""}`} onClick={(e) => { e.stopPropagation(); openPriceAlert(name); }} title="Set price alert">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
            {wlMenuOpen && wlContextMenu ? (
              <div className="wl-context-menu show" style={{ left: wlContextMenu.x, top: wlContextMenu.y }} onMouseLeave={() => setWlMenuOpen(false)}>
                <div className="wl-ctx-title">Show columns</div>
                {(["signal", "change", "spread", "high", "low"] as const).map((key) => (
                  <div key={key} className="wl-ctx-item" onClick={() => setColumnPrefs((prev) => ({ ...prev, [key]: !prev[key] }))}>
                    <span className="wl-ctx-check">{columnPrefs[key] ? "✓" : ""}</span>
                    <span style={{ textTransform: "capitalize" }}>{key === "change" ? "Change %" : key === "high" ? "Daily high" : key === "low" ? "Daily low" : key}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="wl-hint">Right-click for more columns</div>
          </div>
        </div>

        <div className="statusbar">
          <div className="statusbar-left">
            <div className="status-item">
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--buy)" : "var(--sell)" }} />
              <span className="status-value" style={{ fontSize: 11 }}>{connected ? "Connected" : "Disconnected"} · {serverName}</span>
            </div>
            <div className="status-item"><span className="status-label">Ping</span><span className="status-value mono">{pingMs != null ? `${pingMs}ms` : "—"}</span></div>
            <div className="status-item"><span className="status-label">Balance</span><span className="status-value mono">{balanceHidden ? "••••••" : account ? fmt(parseFloat(account.balance), 2) : "—"}</span></div>
            <div className="status-item">
              <span className="status-label">Equity</span><span className="status-value mono">{balanceHidden ? "••••••" : fmt(equity, 2)}</span>
              <canvas ref={sparklineRef} width={70} height={20} className="equity-spark" />
            </div>
          </div>
          <div className="status-item statusbar-center"><span className="status-label">Open P/L</span><span className="status-value mono" style={{ color: floatingPnl === 0 ? "var(--text-1)" : floatingPnl >= 0 ? "var(--buy)" : "var(--sell)" }}>{balanceHidden ? "••••" : (floatingPnl >= 0 ? "+" : "") + floatingPnl.toFixed(2)}</span></div>
          <div className="statusbar-right">
            <div className="status-item"><span className="status-label">Margin level</span><span className="status-value mono" style={{ color: !isFinite(marginLevel) ? "var(--text-1)" : marginLevel < 100 ? "var(--sell)" : marginLevel < 200 ? "#FAC775" : "var(--buy)" }}>{balanceHidden ? "••••" : isFinite(marginLevel) ? marginLevel.toFixed(0) + "%" : "—"}</span></div>
            <div className="status-item"><span className="status-label">Free margin</span><span className="status-value mono">{balanceHidden ? "••••••" : fmt(freeMargin, 2)}</span></div>
          </div>
        </div>
      </div>

      {/* ---------- Quick order modal ---------- */}
      {quickOrder ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setQuickOrder(null); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setQuickOrder(null)}>✕</button>
            <div className="generic-modal-card">
              <div className="quick-order-header"><span>{quickOrder.symbol}</span><span className="mono">{market[quickOrder.symbol].live ? fmt(market[quickOrder.symbol].bid, market[quickOrder.symbol].def.digits) : "No live feed"}</span></div>
              <div className="field-group">
                <div className="field"><span className="field-label">Volume</span><input className="mono" style={{ width: 70 }} value={quickOrderVolume} onChange={(e) => setQuickOrderVolume(e.target.value)} /></div>
                <div className="field"><span className="field-label">Risk %</span><input className="mono" style={{ width: 70 }} placeholder="—" value={quickOrderRisk} onChange={(e) => setQuickOrderRisk(e.target.value)} /></div>
                <div className="field"><span className="field-label">Stop loss</span><input className="mono" placeholder="—" value={quickOrderSl} onChange={(e) => setQuickOrderSl(e.target.value)} /></div>
                <div className="field"><span className="field-label">Take profit</span><input className="mono" placeholder="—" value={quickOrderTp} onChange={(e) => setQuickOrderTp(e.target.value)} /></div>
                <div className="field"><span className="field-label">Comment</span><input className="mono" style={{ width: 110 }} placeholder="Optional" value={quickOrderComment} onChange={(e) => setQuickOrderComment(e.target.value)} /></div>
              </div>
              <div className="oc-row" style={{ marginBottom: 0 }}>
                <button className="buysell-btn buy" disabled={!market[quickOrder.symbol].live} onClick={() => submitQuickOrder("BUY")}>Buy</button>
                <button className="buysell-btn sell" disabled={!market[quickOrder.symbol].live} onClick={() => submitQuickOrder("SELL")}>Sell</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Share card modal ---------- */}
      {shareData ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setShareData(null); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setShareData(null)}>✕</button>
            <div className={`share-card${shareData.pnl < 0 ? " sell-mode" : ""}`}>
              <div className="share-header">
                <div className="share-logo">vy<span>X</span></div>
                <div className="share-symbol-tag">{shareData.symbolLabel}</div>
              </div>
              <div className="share-pnl-block">
                <div className="share-pnl-label">Unrealized PnL</div>
                <div className="share-pnl-value" style={{ color: shareData.pnl >= 0 ? "var(--buy)" : "var(--sell)" }}>{(shareData.pnl >= 0 ? "+" : "") + shareData.pnl.toFixed(2)}</div>
                <div className="share-pnl-pct" style={{ color: shareData.pnl >= 0 ? "var(--buy)" : "var(--sell)" }}>{(shareData.pnlPct >= 0 ? "+" : "") + shareData.pnlPct.toFixed(2)}%</div>
              </div>
              <div className="share-grid">
                <div className="share-stat"><div className="share-stat-label">Entry</div><div className="share-stat-value">{shareData.entryLabel}</div></div>
                <div className="share-stat"><div className="share-stat-label">Current</div><div className="share-stat-value">{shareData.currentLabel}</div></div>
                <div className="share-stat"><div className="share-stat-label">{shareData.rrTitle}</div><div className="share-stat-value">{shareData.rrLabel}</div></div>
                <div className="share-stat"><div className="share-stat-label">Leverage</div><div className="share-stat-value">1:{account?.leverage ?? 100}</div></div>
              </div>
              <div className="share-footer">Trade with vyX</div>
            </div>
            <div className="modal-actions">
              <button className="modal-btn secondary" onClick={() => pushToast("Image saved to downloads")}>Save image</button>
              <button className="modal-btn primary" onClick={() => pushToast("Share sheet opened")}>Share</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- SL/TP edit modal ---------- */}
      {sltpEdit ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setSltpEdit(null); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setSltpEdit(null)}>✕</button>
            <div className="sltp-edit-card">
              <div className="sltp-edit-header">
                <span>{sltpEdit.netSymbol ?? positions.find((p) => p.id === sltpEdit.posId)?.symbol.name}</span>
                <span className="sltp-edit-side">{sltpEdit.netSymbol ? `All ${positions.filter((p) => p.symbol.name === sltpEdit.netSymbol).length} positions` : `${positions.find((p) => p.id === sltpEdit.posId)?.side} ${positions.find((p) => p.id === sltpEdit.posId)?.volume}`}</span>
              </div>
              <div className="field-group">
                <div className="field"><span className="field-label">Stop loss</span><span className="input-with-clear"><input className="mono" placeholder="—" value={sltpEdit.sl} onChange={(e) => setSltpEdit({ ...sltpEdit, sl: e.target.value })} /><button className="clear-input-btn" onClick={() => setSltpEdit({ ...sltpEdit, sl: "" })}>✕</button></span></div>
                <div className="field"><span className="field-label">Take profit</span><span className="input-with-clear"><input className="mono" placeholder="—" value={sltpEdit.tp} onChange={(e) => setSltpEdit({ ...sltpEdit, tp: e.target.value })} /><button className="clear-input-btn" onClick={() => setSltpEdit({ ...sltpEdit, tp: "" })}>✕</button></span></div>
              </div>
              <button className="modal-btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={saveSltpEdit}>Update position</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Generic confirm/prompt modal ---------- */}
      {genericModal ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) { genericModal.onConfirm(null); setGenericModal(null); } }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => { genericModal.onConfirm(null); setGenericModal(null); }}>✕</button>
            <div className="generic-modal-card">
              <div className="generic-modal-title">{genericModal.title}</div>
              <div className="generic-modal-message">{genericModal.message}</div>
              {genericModal.showInput ? (
                <input className="generic-modal-input mono" autoFocus value={genericModalValue} onChange={(e) => setGenericModalValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { genericModal.onConfirm(genericModalValue); setGenericModal(null); } }} />
              ) : null}
              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button className="modal-btn secondary" onClick={() => { genericModal.onConfirm(null); setGenericModal(null); }}>Cancel</button>
                <button className="modal-btn primary" onClick={() => { genericModal.onConfirm(genericModal.showInput ? genericModalValue : ""); setGenericModal(null); }}>{genericModal.okLabel}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Change password modal ---------- */}
      {changePasswordOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setChangePasswordOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setChangePasswordOpen(false)}>✕</button>
            <form className="generic-modal-card" onSubmit={handleChangePassword}>
              <div className="generic-modal-title">Change password</div>
              <input
                className="generic-modal-input mono"
                type="password"
                placeholder="Current password"
                autoFocus
                value={cpCurrent}
                onChange={(e) => setCpCurrent(e.target.value)}
                required
                style={{ marginBottom: 8 }}
              />
              <input
                className="generic-modal-input mono"
                type="password"
                placeholder="New password (min. 8 characters)"
                value={cpNew}
                onChange={(e) => setCpNew(e.target.value)}
                required
                style={{ marginBottom: 8 }}
              />
              <input
                className="generic-modal-input mono"
                type="password"
                placeholder="Confirm new password"
                value={cpConfirm}
                onChange={(e) => setCpConfirm(e.target.value)}
                required
              />
              {cpError ? <p style={{ color: "var(--sell)", fontSize: 12, margin: "8px 0 0" }}>{cpError}</p> : null}
              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button type="button" className="modal-btn secondary" onClick={() => setChangePasswordOpen(false)}>Cancel</button>
                <button type="submit" className="modal-btn primary" disabled={cpSubmitting}>{cpSubmitting ? "Saving…" : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ---------- Verify identity (KYC) modal ---------- */}
      {kycModalOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setKycModalOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setKycModalOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 320 }}>
              <div className="generic-modal-title">Verify identity</div>
              {kycStatus && kycStatus.status !== "REJECTED" ? (
                <>
                  <p style={{ fontSize: 13, margin: "8px 0" }}>
                    Status:{" "}
                    <strong style={{ color: kycStatus.status === "APPROVED" ? "var(--buy)" : undefined }}>
                      {kycStatus.status}
                    </strong>
                  </p>
                  <p style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {kycStatus.status === "PENDING"
                      ? "Your documents are under review."
                      : "Your identity is verified."}
                  </p>
                  <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button type="button" className="modal-btn secondary" onClick={() => setKycModalOpen(false)}>Close</button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setKycError(null);
                    if (!kycFront || !kycBack) {
                      setKycError("Both document sides are required");
                      return;
                    }
                    setKycSubmitting(true);
                    try {
                      await tradeApi.submitKyc(kycDocumentType, kycFront, kycBack);
                      pushToast("Identity documents submitted — pending review");
                      setKycFront(null);
                      setKycBack(null);
                      await refreshKycStatus();
                    } catch (err) {
                      setKycError(err instanceof Error ? err.message : "failed to submit documents");
                    } finally {
                      setKycSubmitting(false);
                    }
                  }}
                >
                  {kycStatus?.status === "REJECTED" ? (
                    <p style={{ fontSize: 12, color: "var(--sell)", margin: "0 0 8px" }}>
                      Previous submission rejected{kycStatus.rejectionReason ? `: ${kycStatus.rejectionReason}` : "."} Please
                      resubmit.
                    </p>
                  ) : null}
                  <select
                    className="generic-modal-input mono"
                    value={kycDocumentType}
                    onChange={(e) => setKycDocumentType(e.target.value)}
                    style={{ marginBottom: 8, width: "100%" }}
                  >
                    <option value="passport">Passport</option>
                    <option value="national_id">National ID</option>
                    <option value="drivers_license">Driver&apos;s license</option>
                  </select>
                  <div className="field-group" style={{ marginBottom: 8 }}>
                    <div className="field-label" style={{ fontSize: 11, marginBottom: 4 }}>Document front</div>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      onChange={(e) => setKycFront(e.target.files?.[0] ?? null)}
                      required
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 8 }}>
                    <div className="field-label" style={{ fontSize: 11, marginBottom: 4 }}>Document back</div>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      onChange={(e) => setKycBack(e.target.files?.[0] ?? null)}
                      required
                    />
                  </div>
                  {kycError ? <p style={{ color: "var(--sell)", fontSize: 12, margin: "8px 0 0" }}>{kycError}</p> : null}
                  <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button type="button" className="modal-btn secondary" onClick={() => setKycModalOpen(false)}>Cancel</button>
                    <button type="submit" className="modal-btn primary" disabled={kycSubmitting}>
                      {kycSubmitting ? "Submitting…" : "Submit"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Reports (account statement) modal ---------- */}
      {reportsOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setReportsOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setReportsOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 460 }}>
              <div className="generic-modal-title">Account statement</div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>From</label>
                  <input type="date" className="mono" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} style={{ width: "100%" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: "var(--text-3)", display: "block", marginBottom: 3 }}>To</label>
                  <input type="date" className="mono" value={reportTo} onChange={(e) => setReportTo(e.target.value)} style={{ width: "100%" }} />
                </div>
                <button className="modal-btn primary" onClick={generateReport} disabled={reportLoading}>{reportLoading ? "…" : "Generate"}</button>
              </div>

              {reportRows ? (
                (() => {
                  const closed = reportRows.filter((p) => p.status === "CLOSED");
                  const pnls = closed.map((p) => parseFloat(p.realizedPnl ?? "0"));
                  const netPnl = pnls.reduce((a, b) => a + b, 0);
                  const wins = pnls.filter((v) => v > 0).length;
                  const losses = pnls.filter((v) => v < 0).length;
                  const winRate = closed.length ? ((wins / closed.length) * 100).toFixed(1) : "0.0";
                  return (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
                        {[
                          { label: "Trades", value: String(closed.length) },
                          { label: "Win rate", value: `${winRate}%` },
                          { label: "Wins / Losses", value: `${wins} / ${losses}` },
                          { label: "Net P&L", value: money(netPnl), color: netPnl >= 0 ? "var(--buy)" : "var(--sell)" },
                        ].map((s) => (
                          <div key={s.label} style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
                            <div className="net-pos-detail" style={{ marginBottom: 3 }}>{s.label}</div>
                            <div className="mono" style={{ color: s.color }}>{s.value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                        {closed.length === 0 ? (
                          <div className="empty-state">No closed trades in this range</div>
                        ) : (
                          closed.map((p) => (
                            <div key={p.id} className="simple-row" style={{ padding: "6px 10px" }}>
                              <div className="simple-left">
                                <span className="pos-symbol">{p.symbol.name}</span>
                                <span className="net-pos-detail mono">{p.side} {parseFloat(p.volume).toFixed(2)} @ {p.openPrice} → {p.closePrice ?? "—"}</span>
                              </div>
                              <div className="simple-right mono" style={{ color: parseFloat(p.realizedPnl ?? "0") >= 0 ? "var(--buy)" : "var(--sell)" }}>
                                {money(parseFloat(p.realizedPnl ?? "0"))}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="modal-actions" style={{ marginTop: 16 }}>
                        <button className="modal-btn secondary" onClick={() => setReportsOpen(false)}>Close</button>
                        <button className="modal-btn primary" onClick={exportReportCsv} disabled={closed.length === 0}>Export CSV</button>
                      </div>
                    </>
                  );
                })()
              ) : (
                <div className="net-pos-detail" style={{ padding: "8px 0" }}>Pick a date range and click Generate.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Alerts modal ---------- */}
      {alertsModalOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setAlertsModalOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setAlertsModalOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 300 }}>
              <div className="funds-tabs">
                <button className={`funds-tab${alertsTab === "active" ? " active" : ""}`} onClick={() => setAlertsTab("active")}>Active</button>
                <button className={`funds-tab${alertsTab === "history" ? " active" : ""}`} onClick={() => setAlertsTab("history")}>History</button>
              </div>
              <div style={{ maxHeight: 280, overflowY: "auto" }}>
                {alertsTab === "active" ? (
                  alerts.length === 0 ? <div className="empty-state">No alerts — get notified instantly about price movements</div> : alerts.map((a) => (
                    <div className="simple-row" key={a.id}>
                      <div className="simple-left"><span className="pos-symbol">{a.symbol}</span><span className="net-pos-detail mono">@ {fmt(a.price, market[a.symbol].def.digits)}</span></div>
                      <div className="simple-right"><button className="icon-btn" onClick={() => setAlerts((prev) => prev.filter((x) => x.id !== a.id))}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button></div>
                    </div>
                  ))
                ) : (
                  alertHistory.length === 0 ? <div className="empty-state">No triggered alerts yet</div> : alertHistory.slice(0, 30).map((h) => (
                    <div className="simple-row" key={h.id}>
                      <div className="simple-left"><span className="pos-symbol">{h.symbol}</span><span className="net-pos-detail mono">@ {fmt(h.price, market[h.symbol].def.digits)}</span></div>
                      <div className="simple-right"><span className="net-pos-detail">{h.time}</span></div>
                    </div>
                  ))
                )}
              </div>
              <button className="confirm-market-btn buy" style={{ display: "block", marginTop: 12 }} onClick={() => openPriceAlert(activeSymbol)}>+ New alert</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Symbol info modal ---------- */}
      {symbolInfoOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setSymbolInfoOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setSymbolInfoOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 280 }}>
              <div className="quick-order-header"><span>{activeSymbol}</span></div>
              <div className="si-row"><span>Contract size</span><span className="mono">{m.def.contractSize}</span></div>
              <div className="si-row"><span>Digits</span><span className="mono">{m.def.digits}</span></div>
              <div className="si-row"><span>Min lot</span><span className="mono">0.01</span></div>
              <div className="si-row"><span>Max lot</span><span className="mono">100</span></div>
              <div className="si-row"><span>Swap long</span><span className="mono">-1.20</span></div>
              <div className="si-row"><span>Swap short</span><span className="mono">+0.35</span></div>
              <div className="si-row"><span>Trading hours</span><span className="mono">24/5</span></div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Funds modal ---------- */}
      {fundsModalOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setFundsModalOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setFundsModalOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 300 }}>
              <div className="funds-tabs">
                <button className={`funds-tab${fundsTab === "deposit" ? " active" : ""}`} onClick={() => setFundsTab("deposit")}>Deposit</button>
                <button className={`funds-tab${fundsTab === "withdraw" ? " active" : ""}`} onClick={() => setFundsTab("withdraw")}>Withdraw</button>
              </div>
              <div className="section-label" style={{ paddingLeft: 0 }}>{fundsTab === "deposit" ? "Payment method" : "Withdraw to"}</div>
              <div className="method-row">
                <button className="method-btn active">Bank transfer</button>
                <button className="method-btn">Card</button>
                {fundsTab === "deposit" ? <button className="method-btn">Crypto</button> : null}
              </div>
              <div className="field-group" style={{ marginTop: 10 }}>
                <div className="field"><span className="field-label">Amount (USD)</span><input className="mono" placeholder="0.00" style={{ width: 100 }} value={fundsAmount} onChange={(e) => setFundsAmount(e.target.value)} /></div>
              </div>
              {fundsTab === "withdraw" ? <div className="margin-note">Available: {account ? money(parseFloat(account.balance)) : "—"}</div> : null}
              <button
                className={`confirm-market-btn ${fundsTab === "deposit" ? "buy" : "sell"}`}
                style={{ display: "block", marginTop: 12 }}
                disabled={fundsSubmitting}
                onClick={async () => {
                  const amount = parseFloat(fundsAmount);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    pushToast("Enter a valid amount");
                    return;
                  }
                  setFundsSubmitting(true);
                  try {
                    await tradeApi.submitFundsRequest({
                      type: fundsTab === "deposit" ? "DEPOSIT" : "WITHDRAWAL",
                      amount,
                    });
                    setFundsAmount("");
                    pushToast(
                      fundsTab === "deposit"
                        ? "Deposit request submitted — pending review"
                        : "Withdrawal request submitted — pending review"
                    );
                    await refreshFundsHistory();
                  } catch (err) {
                    pushToast(err instanceof Error ? err.message : "failed to submit request");
                  } finally {
                    setFundsSubmitting(false);
                  }
                }}
              >
                {fundsSubmitting ? "Submitting..." : fundsTab === "deposit" ? "Deposit funds" : "Request withdrawal"}
              </button>

              {fundsHistory.length > 0 ? (
                <>
                  <div className="section-label" style={{ paddingLeft: 0, marginTop: 14 }}>Recent requests</div>
                  <div style={{ maxHeight: 140, overflowY: "auto" }}>
                    {fundsHistory.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 12,
                          padding: "4px 0",
                          borderBottom: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        <span>{r.type === "DEPOSIT" ? "Deposit" : "Withdrawal"}</span>
                        <span className="mono">{money(parseFloat(r.amount))}</span>
                        <span
                          style={{
                            color: r.status === "COMPLETED" ? "var(--buy)" : r.status === "REJECTED" ? "var(--sell)" : undefined,
                          }}
                        >
                          {r.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="toast" style={{ opacity: toasts.length > 0 ? 1 : 0 }}>{toasts[toasts.length - 1]?.message ?? ""}</div>
    </div>
  );
}

function AnalyticsGrid({ trades }: { trades: ApiPosition[] }) {
  const pnls = trades.map((t) => (t.realizedPnl ? parseFloat(t.realizedPnl) : 0));
  if (pnls.length === 0) {
    return <div className="empty-state" style={{ gridColumn: "1/-1" }}>No closed trades yet — analytics will appear after you close some trades</div>;
  }
  const wins = pnls.filter((p) => p >= 0);
  const losses = pnls.filter((p) => p < 0);
  const winRate = (wins.length / pnls.length) * 100;
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? "∞" : "—") : (grossProfit / grossLoss).toFixed(2);
  const best = Math.max(...pnls);
  const worst = Math.min(...pnls);
  const avgTrade = totalPnl / pnls.length;

  const metrics: [string, string, string][] = [
    ["Total trades", String(pnls.length), "var(--text-1)"],
    ["Win rate", winRate.toFixed(1) + "%", winRate >= 50 ? "var(--buy)" : "var(--sell)"],
    ["Total P/L", (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2), totalPnl >= 0 ? "var(--buy)" : "var(--sell)"],
    ["Profit factor", profitFactor, "var(--text-1)"],
    ["Best trade", "+" + best.toFixed(2), "var(--buy)"],
    ["Worst trade", worst.toFixed(2), "var(--sell)"],
    ["Avg trade", (avgTrade >= 0 ? "+" : "") + avgTrade.toFixed(2), avgTrade >= 0 ? "var(--buy)" : "var(--sell)"],
    ["Wins / Losses", `${wins.length} / ${losses.length}`, "var(--text-1)"],
  ];

  return (
    <div className="analytics-grid">
      {metrics.map(([label, value, color]) => (
        <div className="metric-card" key={label}>
          <div className="metric-label">{label}</div>
          <div className="metric-value mono" style={{ color }}>{value}</div>
        </div>
      ))}
    </div>
  );
}
