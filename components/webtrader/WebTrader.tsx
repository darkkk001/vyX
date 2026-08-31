"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SYMBOL_DEFS,
  createInitialMarket,
  tickMarket,
  feedStatusFor,
  bucketStartMs,
  resolveDayOpenFromD1,
  fmt,
  money,
  type MarketState,
  type Candle,
  type Timeframe,
  type FeedStatus,
} from "@/lib/market-simulator";
import { tradeApi, serverNow, ApiError, type AccountInfo, type ApiPosition, type ApiOrder, type ApiFundsRequest, type ApiKycStatus, type ApiLinkedAccount, type ApiSession } from "@/lib/trade-api";
import { isTickDebug } from "@/lib/tick-debug";
import KLineChartPanel, { type KLineChartHandle, type ChartLine } from "./KLineChartPanel";
import DesktopTitleBar from "./DesktopTitleBar";
import SessionClock from "./SessionClock";
import NewsPanel from "./NewsPanel";
import ChartCell from "./ChartCell";
import SmartTradeManager from "./SmartTradeManager";
import { computeChartLines } from "@/lib/chart-lines";

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

type BottomTab = "positions" | "net" | "orders" | "allOrders" | "history" | "analytics" | "logs";
type LogEntry = { id: number; time: string; message: string };
type OrderMode = "market" | "pending";
type PendingType = "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop";
type Toast = { id: number; message: string; retry?: () => void };
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

// Layout/watchlist personalization (docs/webtrader-stm-architecture-
// review.md §3 item 10) -- same "one new localStorage key, same pattern
// as vyx-theme" the doc describes, covering the pieces that weren't
// already covered by vyx-stm-config (SmartTradeManager.tsx) or vyx-theme:
// watchlist symbol order, which watchlist columns are shown, and the
// three resizable panel dimensions. Read once via a lazy useState
// initializer (runs before first paint, so there's no flash of the
// default layout); a stale/corrupt value just falls back to the default
// below rather than throwing.
const LAYOUT_STORAGE_KEY = "vyx-webtrader-layout";
type StoredLayout = {
  watchlistOrder?: string[];
  columnPrefs?: { signal: boolean; change: boolean; spread: boolean; high: boolean; low: boolean };
  orderPanelWidth?: number;
  watchlistWidth?: number;
  bottomPanelHeight?: number;
};
function loadStoredLayout(): StoredLayout {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredLayout) : {};
  } catch {
    return {};
  }
}

// fix/realtime-sync §6 -- every dropdown/context menu in this file used
// to only ever close via its own explicit "close" click (an option, a
// second click on the trigger); clicking anywhere else on the page, or
// pressing Escape, or the window losing focus, left it sitting open
// indefinitely. `containerRef` scopes "outside" to whatever DOM node
// wraps both the trigger and the menu itself, so clicking the trigger
// again (already toggling `active` off through its own onClick) doesn't
// double-fire a close through this listener too. Route-change dismissal
// (mentioned in the originating spec) doesn't apply to this component --
// WebTrader IS the route for as long as any of these menus could be
// open; there's no client-side navigation away from /trade that would
// leave one dangling.
function useDismiss(active: boolean, onClose: () => void, containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // capture: true so this still sees the click even if some inner
    // handler further down calls stopPropagation (the watchlist's own
    // context-menu trigger already does, for its right-click).
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [active, onClose, containerRef]);
}

export default function WebTrader({
  brokerName,
  brokerLogoUrl,
  supportEmail,
  onSessionExpired,
}: {
  brokerName: string;
  brokerLogoUrl: string;
  // Null = broker hasn't set one -- the Help menu hides "Contact support"
  // entirely rather than leaking the platform's own address (see
  // Broker.supportEmail's schema comment).
  supportEmail: string | null;
  // Called when a session refresh (me()) comes back unauthenticated.
  // Defaults to the website's own behavior (redirect to the Next.js login
  // route) -- the bundled desktop shell has no such route and passes its
  // own handler that shows its local login screen instead.
  onSessionExpired?: () => void;
}) {

  const [market, setMarket] = useState<Record<string, MarketState>>(() => createInitialMarket());
  const [storedLayout] = useState<StoredLayout>(() => loadStoredLayout());
  const [watchlistOrder, setWatchlistOrder] = useState<string[]>(() => {
    const saved = storedLayout.watchlistOrder;
    // A saved order from before a symbol was added/removed from
    // SYMBOL_DEFS would silently drop or duplicate rows -- only trust it
    // when it's exactly the same set of symbols as today's default.
    const defaultNames = SYMBOL_DEFS.map((s) => s.name);
    if (saved && saved.length === defaultNames.length && defaultNames.every((n) => saved.includes(n))) {
      return saved;
    }
    return defaultNames;
  });
  const [dragSymbol, setDragSymbol] = useState<string | null>(null);
  const [watchlistFilter, setWatchlistFilter] = useState("");
  const [columnPrefs, setColumnPrefs] = useState(
    storedLayout.columnPrefs ?? { signal: true, change: true, spread: false, high: false, low: false }
  );
  const [wlMenuOpen, setWlMenuOpen] = useState(false);
  const wlContextMenuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(wlMenuOpen, () => setWlMenuOpen(false), wlContextMenuRef);

  const [activeSymbol, setActiveSymbol] = useState("XAUUSD");
  const [currentTf, setCurrentTf] = useState<Timeframe>("H1");

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<ApiPosition[]>([]);
  // "Selected" scope for Smart Trade Manager's bulk actions (break-even,
  // partial close, close) -- otherwise unused outside SmartTradeManager.tsx.
  const [selectedPositionIds, setSelectedPositionIds] = useState<Set<string>>(new Set());
  // Now doubles as the embedded Smart Trade Manager panel's expand/
  // collapse state (below the Watchlist) -- defaults open since it's
  // meant to be visible there, not hidden behind the rail icon anymore.
  const [stmOpen, setStmOpen] = useState(true);
  const [pendingOrders, setPendingOrders] = useState<ApiOrder[]>([]);
  const [allOrders, setAllOrders] = useState<ApiOrder[]>([]);
  const [history, setHistory] = useState<ApiPosition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const trailingDistances = useRef<Record<string, number>>({});

  const [orderMode, setOrderMode] = useState<OrderMode>("market");
  const [pendingType, setPendingType] = useState<PendingType>("buy_limit");
  const [pendingPrice, setPendingPrice] = useState("");
  const [volume, setVolume] = useState(0.01);
  // The lot-size field's own text, decoupled from `volume` while the
  // field is focused -- reported live: value={volume.toFixed(2)}
  // reformatted the displayed text on every keystroke (React re-render
  // after each onChange), which meant typing a second digit landed
  // against an already-snapped-back "0.01" instead of what was just
  // typed, making manual entry effectively unusable (only +/- worked).
  // Synced from `volume` only while NOT focused (the effect below), so
  // the +/- buttons and risk-%-driven auto-volume still update the
  // display live, but typing is never fought mid-edit.
  const [volumeInput, setVolumeInput] = useState(volume.toFixed(2));
  const volumeInputFocusedRef = useRef(false);
  useEffect(() => {
    if (!volumeInputFocusedRef.current) setVolumeInput(volume.toFixed(2));
  }, [volume]);
  const [riskPct, setRiskPct] = useState("");
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [pendingMarketSide, setPendingMarketSide] = useState<"BUY" | "SELL" | null>(null);
  const [oneClick, setOneClick] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);

  // ---------- resizable panel layout ----------
  // fix/realtime-sync §5's bounds (order panel 260-420, watchlist
  // 220-420) are clamped again here, not just in onMove's drag handler
  // below -- a layout saved to localStorage before this fix (old bounds
  // were 200-420 / 160-420) could otherwise load a narrower-than-allowed
  // panel that only got corrected the next time the user happened to
  // drag it.
  const [orderPanelWidth, setOrderPanelWidth] = useState(() => Math.min(420, Math.max(260, storedLayout.orderPanelWidth ?? 260)));
  const [watchlistWidth, setWatchlistWidth] = useState(() => Math.min(420, Math.max(220, storedLayout.watchlistWidth ?? 220)));
  const [bottomPanelHeight, setBottomPanelHeight] = useState(storedLayout.bottomPanelHeight ?? 190);
  const resizeStateRef = useRef<{ kind: "order" | "watchlist" | "bottom"; startPos: number; startSize: number } | null>(null);
  // Bounds the bottom-panel drag against the ACTUAL space available in
  // .center right now, instead of a flat 500px ceiling that ignores
  // viewport size -- .chart-area's own CSS min-height: 180px means the
  // chart never shrinks past that, so a fixed 500px cap on a short
  // window (or one with the browser's dev tools docked) let the two
  // together exceed .center's real height and visually overlap. Reported
  // live: dragging the panel up merged it into the chart.
  const centerRef = useRef<HTMLDivElement>(null);
  // .chart-area's own CSS floor -- keep in sync with that rule
  // (webtrader.css's .chart-area min-height) so the two can never fight
  // over the same pixels.
  const CHART_MIN_HEIGHT = 180;
  const RESIZER_HEIGHT = 6;
  // Below this, treat the measurement as "layout hasn't settled yet" (the
  // very first effect tick after mount, before the chart/header have
  // painted) rather than a real constraint -- returning null lets callers
  // skip clamping instead of shrinking the panel to its 120px floor on
  // every page load, which is exactly what happened without this guard:
  // a too-early clientHeight read (0 or near it) made every fresh load
  // look like "dragging is disabled," since the panel was pinned at its
  // minimum before the user ever touched the resizer.
  const PLAUSIBLE_MIN_CENTER_HEIGHT = 300;
  const maxBottomPanelHeight = useCallback((): number | null => {
    const available = centerRef.current?.clientHeight;
    if (available == null || available < PLAUSIBLE_MIN_CENTER_HEIGHT) return null;
    return Math.max(120, available - CHART_MIN_HEIGHT - RESIZER_HEIGHT);
  }, []);

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
        const requested = Math.max(120, rs.startSize + delta);
        const max = maxBottomPanelHeight();
        setBottomPanelHeight(Math.min(500, max ?? requested, requested));
      } else if (rs.kind === "order") {
        // Order ticket now sits on the right (see .main's layout below) --
        // its resizer is on its LEFT edge, so dragging left is what grows
        // it now, the mirror of when it sat on the left with the resizer
        // on its right edge.
        const delta = rs.startPos - e.clientX;
        // fix/realtime-sync §5's explicit bounds (260-420, was 200-420) --
        // .center's own min-width: 0 already keeps the chart column from
        // ever overlapping regardless of these numbers (that's a CSS Grid
        // property, not a JS clamp concern), but a panel too narrow to
        // read is still a real usability floor worth raising to match.
        setOrderPanelWidth(Math.min(420, Math.max(260, rs.startSize + delta)));
      } else {
        // Watchlist now sits on the left, resizer on its RIGHT edge --
        // dragging right grows it now.
        const delta = e.clientX - rs.startPos;
        // fix/realtime-sync §5's explicit bounds (220-420, was 160-420).
        setWatchlistWidth(Math.min(420, Math.max(220, rs.startSize + delta)));
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
  }, [maxBottomPanelHeight]);

  // Catches the case the drag handler alone can't: a bottomPanelHeight
  // restored from a previous, larger window (loadStoredLayout) or a
  // browser window shrunk (dev tools docked, resized smaller) after the
  // panel was already sized -- without this, .center's overflow: hidden
  // just clips/overlaps the two instead of the panel ever getting a
  // chance to shrink back down.
  useEffect(() => {
    function clamp() {
      const max = maxBottomPanelHeight();
      if (max == null) return; // layout not settled yet -- nothing to correct against
      setBottomPanelHeight((h) => Math.min(h, max));
    }
    // Skips the immediate mount-time call on purpose: right after mount,
    // .center hasn't painted its real content (chart header, market data)
    // yet, so PLAUSIBLE_MIN_CENTER_HEIGHT's guard would just no-op here
    // anyway -- a real, already-too-large stored value gets caught by the
    // very next actual window resize, and by the drag handler's own clamp
    // the moment the user touches the resizer.
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [maxBottomPanelHeight]);

  // Persists everything loadStoredLayout reads back on next visit. Fires
  // on every resize-drag tick too (not just drag-end) -- three numbers
  // plus a small array/object is cheap enough that debouncing isn't worth
  // the added complexity here.
  useEffect(() => {
    try {
      const layout: StoredLayout = { watchlistOrder, columnPrefs, orderPanelWidth, watchlistWidth, bottomPanelHeight };
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // localStorage unavailable (private mode, quota) -- layout just
      // won't persist across reloads, nothing else depends on this.
    }
  }, [watchlistOrder, columnPrefs, orderPanelWidth, watchlistWidth, bottomPanelHeight]);

  const [activeBottomTab, setActiveBottomTab] = useState<BottomTab>("positions");
  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const [histSymbol, setHistSymbol] = useState("");
  const [histPeriod, setHistPeriod] = useState("all");
  // The preset dropdown (Today/7d/30d/All/Custom) used to only control
  // whether the manual date inputs showed -- picking "Today" or "Last 7
  // days" never actually touched histFrom/histTo, so refreshHistory's own
  // query (below) stayed unfiltered no matter which preset was selected;
  // only "Custom range" ever did anything. This derives the actual dates
  // for every non-custom preset so the dropdown does what it says.
  function selectHistPeriod(period: string) {
    setHistPeriod(period);
    if (period === "custom") return;
    if (period === "all") {
      setHistFrom("");
      setHistTo("");
      return;
    }
    const days = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 0;
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    setHistFrom(from.toISOString().slice(0, 10));
    setHistTo(today.toISOString().slice(0, 10));
  }

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertHistory, setAlertHistory] = useState<Alert[]>([]);
  const [alertsModalOpen, setAlertsModalOpen] = useState(false);
  const [alertsTab, setAlertsTab] = useState<"active" | "history">("active");

  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const accountSwitcherRef = useRef<HTMLDivElement | null>(null);
  useDismiss(accountDropdownOpen, () => setAccountDropdownOpen(false), accountSwitcherRef);
  const [linkedAccounts, setLinkedAccounts] = useState<ApiLinkedAccount[] | null>(null);
  const [switchTarget, setSwitchTarget] = useState<ApiLinkedAccount | null>(null);
  const [switchPassword, setSwitchPassword] = useState("");
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // Set only if the target account has 2FA enabled -- see
  // submitAccountSwitch's requiresTwoFactor branch.
  const [switchPendingToken, setSwitchPendingToken] = useState<string | null>(null);
  const [switchTwoFactorCode, setSwitchTwoFactorCode] = useState("");
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const symbolDropdownRef = useRef<HTMLDivElement | null>(null);
  useDismiss(symbolDropdownOpen, () => setSymbolDropdownOpen(false), symbolDropdownRef);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [chartLayout, setChartLayout] = useState<"single" | "grid">("single");
  const [gridCells, setGridCells] = useState<{ symbol: string; tf: Timeframe }[]>([
    { symbol: "XAUUSD", tf: "H1" },
    { symbol: "EURUSD", tf: "H1" },
    { symbol: "BTCUSD", tf: "H1" },
    { symbol: "GBPUSD", tf: "H1" },
  ]);
  // fix/realtime-sync §6 -- one shared slot instead of 4 independent
  // booleans, so opening any one of these always closes whichever other
  // one was open (previously only File<->Tools did this, pairwise, by
  // each one's onClick manually clearing the other -- Actions/Help never
  // closed File or Tools, or each other).
  type TopMenuId = "file" | "tools" | "actions" | "help";
  const [topMenuOpen, setTopMenuOpen] = useState<TopMenuId | null>(null);
  const topMenuContainerRef = useRef<HTMLDivElement | null>(null);
  useDismiss(topMenuOpen !== null, () => setTopMenuOpen(null), topMenuContainerRef);
  const [actionsSearch, setActionsSearch] = useState("");
  // Read once client-side (useEffect, not render) — window.vyxDesktop
  // doesn't exist during SSR, and JSX reading it directly there would
  // throw "window is not defined".
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  useEffect(() => setIsDesktopApp(!!window.vyxDesktop?.isDesktop), []);

  // Mobile layout (docs/webtrader-stm-architecture-review.md §3 item 9):
  // below this width the side-by-side rail/order-panel/chart/watchlist
  // grid can't fit, so .main switches to single-column and only one
  // section shows at a time -- see webtrader.css's ".main.mobile" rules
  // and the bottom nav bar this state drives, right below the chart area
  // in the JSX. 860px (not a device-specific breakpoint) is where the
  // order ticket's two-column lot/SL/TP fields realistically stop being
  // comfortably tappable side-by-side with anything else visible.
  const [isMobileView, setIsMobileView] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chart" | "trade" | "positions" | "watchlist">("chart");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    setIsMobileView(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobileView(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
  // "MARKET" keeps the original two-button (Buy/Sell) ticket; any
  // PendingType instead shows a single directional button + a Price
  // field, same shape as the chart right-click pending-order flow
  // (quickPlacePendingAtPrice) -- side is implied by the chosen type,
  // matching MT4/5's own single order-type dropdown convention.
  const [quickOrderType, setQuickOrderType] = useState<"MARKET" | PendingType>("MARKET");
  const [quickOrderPrice, setQuickOrderPrice] = useState("");

  const [genericModal, setGenericModal] = useState<null | {
    title: string; message: string; showInput: boolean; defaultValue?: string; okLabel: string;
    onConfirm: (value: string | null) => void;
  }>(null);
  const [genericModalValue, setGenericModalValue] = useState("");

  // `symbol` is set only when right-clicking a specific row (vs. empty
  // watchlist space) -- gates the "Symbol specification" item below,
  // which needs to know which symbol to show.
  const [wlContextMenu, setWlContextMenu] = useState<{ x: number; y: number; symbol?: string } | null>(null);
  const [chartContextMenu, setChartContextMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  // fix/realtime-sync §6 -- consolidated onto the same useDismiss every
  // other menu in this file now uses (was its own bespoke mousedown/
  // Escape effect, added for the same originally-reported "right-click
  // the chart, nothing dismisses it" bug -- see this file's useDismiss
  // for why a ref beats the old `.closest(".wl-context-menu")` check:
  // this also now gets window-blur dismissal for free, and pan/zoom via
  // KLineChartPanel's onPanOrZoom prop above).
  const chartContextMenuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(chartContextMenu !== null, () => setChartContextMenu(null), chartContextMenuRef);
  const chartRef = useRef<KLineChartHandle>(null);
  const [maActive, setMaActive] = useState(false);

  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpConfirm, setCpConfirm] = useState("");
  const [cpError, setCpError] = useState<string | null>(null);
  const [cpSubmitting, setCpSubmitting] = useState(false);

  // ---------- Security panel: 2FA + active sessions ----------
  const [securityModalOpen, setSecurityModalOpen] = useState(false);
  const [tfaSetupData, setTfaSetupData] = useState<{ secret: string; qrCodeDataUri: string } | null>(null);
  const [tfaConfirmCode, setTfaConfirmCode] = useState("");
  const [tfaDisablePassword, setTfaDisablePassword] = useState("");
  const [tfaBusy, setTfaBusy] = useState(false);
  const [tfaError, setTfaError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ApiSession[] | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

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
  const pushToast = useCallback((message: string, important = false, retry?: () => void) => {
    const id = nextId();
    setToasts((prev) => [...prev, { id, message, retry }]);
    // Retry toasts stay up long enough to actually click -- the plain
    // confirmation toasts don't need it.
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), retry ? 6000 : 2200);
    appendLog(message);
    if (important && typeof window !== "undefined" && window.vyxDesktop?.isDesktop && "Notification" in window) {
      try {
        new Notification(brokerName, { body: message });
      } catch {
        // ignore — notification permission or platform quirk, toast already shown
      }
    }
  }, [appendLog, brokerName]);

  // Phase 0 money-risk patch (docs/ROADMAP.md) -- the server now rejects
  // a MARKET order whose fill price moved past the client's tolerance, or
  // whose feed went stale between click and processing, instead of
  // silently filling at whatever the client asked (see lib/risk.ts's
  // checkPriceFreshness/checkSlippage). Both are routine, expected
  // rejections under a fast-moving market, not errors -- worth a
  // one-click retry against the now-current price rather than making the
  // trader re-open the ticket and re-enter everything.
  const handleOrderError = useCallback((err: unknown, retry?: () => void) => {
    if (err instanceof ApiError && (err.message === "PRICE_STALE" || err.message === "SLIPPAGE_EXCEEDED")) {
      const reason = err.message === "PRICE_STALE" ? "Feed went stale — order not placed" : "Price moved — order not placed";
      pushToast(reason, false, retry);
      return;
    }
    if (err instanceof ApiError && err.message === "INSUFFICIENT_MARGIN") {
      const info = err.body as { required?: string; available?: string } | null;
      pushToast(
        info?.required && info?.available
          ? `Insufficient margin — required $${info.required}, available $${info.available}`
          : "Insufficient margin — order not placed"
      );
      return;
    }
    pushToast(err instanceof Error ? err.message : "order failed");
  }, [pushToast]);

  const askPrompt = useCallback((message: string, defaultValue: string, onSubmit: (value: string) => void) => {
    setGenericModalValue(defaultValue);
    setGenericModal({ title: "Enter value", message, showInput: true, defaultValue, okLabel: "Save", onConfirm: (v) => { if (v !== null) onSubmit(v); } });
  }, []);

  // ---------- data loading ----------
  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await tradeApi.me());
    } catch (err) {
      // Only a real 401 means the session actually expired -- this used to
      // force a logout on *any* failed request (a network blip, a 500, a
      // desktop-bridge hiccup mid-poll), kicking a trader with an open
      // position back to the login screen over a transient error that had
      // nothing to do with their session. Every other error just logs and
      // leaves the last-known account state on screen; the next poll tries
      // again.
      if (err instanceof ApiError && err.status === 401) {
        if (onSessionExpired) onSessionExpired();
        else window.location.href = "/trade/login";
      } else {
        console.error("refreshAccount failed", err);
      }
    }
  }, [onSessionExpired]);
  const refreshPositions = useCallback(async () => setPositions(await tradeApi.positions().catch(() => [])), []);
  // Fetches both the Pending Orders view and the full-lifecycle Orders
  // view (docs/webtrader-stm-architecture-review.md §4.5) together --
  // every existing call site already treats "refreshOrders" as "an order
  // mutation just happened," which is exactly the signal both tabs need,
  // so this piggybacks allOrders onto the same calls rather than needing
  // its own call site added everywhere refreshOrders() already is.
  const refreshOrders = useCallback(async () => {
    const [pending, all] = await Promise.all([
      tradeApi.orders().catch(() => []),
      tradeApi.allOrders().catch(() => []),
    ]);
    setPendingOrders(pending);
    setAllOrders(all);
  }, []);

  // A dealer requoted one of this account's orders (see
  // app/api/manage/dealing-queue/[id]/route.ts) -- respond with accept
  // (fills at the requoted price) or reject (cancels, no position).
  const respondToRequote = useCallback(
    async (order: ApiOrder, accept: boolean) => {
      try {
        await tradeApi.requoteResponse(order.id, accept);
        pushToast(
          accept ? `${order.symbol.name} requote accepted — position opened` : `${order.symbol.name} requote rejected`,
          true
        );
        await Promise.all([refreshOrders(), refreshPositions(), refreshAccount()]);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "requote response failed");
      }
    },
    [pushToast, refreshOrders, refreshPositions, refreshAccount]
  );
  const refreshHistory = useCallback(async () => {
    setHistory(await tradeApi.history({ from: histFrom, to: histTo, symbol: histSymbol }).catch(() => []));
  }, [histFrom, histTo, histSymbol]);
  const refreshFundsHistory = useCallback(async () => setFundsHistory(await tradeApi.fundsHistory().catch(() => [])), []);
  const refreshKycStatus = useCallback(async () => setKycStatus(await tradeApi.kycStatus().catch(() => null)), []);

  // Unifies closed trades with deposits/withdrawals/adjustments into one
  // chronological feed for the History tab -- same convention MT4/MT5's
  // own "Account History" tab uses (balance operations interleaved with
  // trades, not off in a separate screen). Reported live as "deposit/
  // withdrawal doesn't show in History like every trade does." A funds
  // row has no symbol/lots/open-close price, so those columns render as
  // "—"; its amount takes the same Profit column a trade's realizedPnl
  // does, since both are "how this row changed the balance."
  type HistoryRow =
    | { kind: "trade"; date: number; trade: ApiPosition }
    | { kind: "funds"; date: number; funds: ApiFundsRequest };
  const historyRows: HistoryRow[] = useMemo(() => {
    const tradeRows: HistoryRow[] = history.map((h) => ({ kind: "trade", date: new Date(h.closedAt ?? h.openedAt).getTime(), trade: h }));
    const fundsRows: HistoryRow[] = fundsHistory
      .filter((f) => f.status === "COMPLETED")
      .map((f) => ({ kind: "funds", date: new Date(f.createdAt).getTime(), funds: f }));
    return [...tradeRows, ...fundsRows].sort((a, b) => b.date - a.date);
  }, [history, fundsHistory]);

  // "Switch account"/"Logout" — log out, then show the login screen again.
  // Desktop (bundled shell): the document is local content with no
  // meaningful URL of its own to navigate to -- onSessionExpired flips
  // App.tsx's loggedIn state back to false, which re-renders the
  // already-embedded TradeLoginForm in place. This used to navigate to
  // the real website's root-domain server picker (https://.../launch), a
  // leftover from when the desktop app was still a remote WebView
  // wrapper rather than a bundled shell -- that took the trader out of
  // the app entirely and into a real browser-facing website page inside
  // the WebView, which is what "Switch account redirects to the website"
  // was actually seeing.
  async function handleLogout() {
    try {
      await tradeApi.logout();
    } catch {
      // session cookie clears server-side regardless; proceed either way
    }
    if (window.vyxDesktop?.isDesktop) {
      window.vyxDesktop.stopLiveStreams?.();
      window.vyxDesktop.forgetBroker?.();
      window.vyxDesktop.forgetSession?.();
      onSessionExpired?.();
    } else {
      window.location.href = "/trade/login";
    }
  }

  // Account Selector (docs/webtrader-stm-architecture-review.md §4.2):
  // fetched fresh each time the dropdown opens rather than kept live,
  // since it's just a switch target list, not something that needs to
  // track balance changes in real time.
  useEffect(() => {
    if (!accountDropdownOpen) return;
    tradeApi.linkedAccounts().then(setLinkedAccounts).catch(() => setLinkedAccounts([]));
  }, [accountDropdownOpen]);

  // Switching is a real re-login (matches MT4/5 behavior) — same
  // POST /api/trade/login the login page itself uses, just pre-filled with
  // the target account number. On success the session cookie now points at
  // a different account, so every piece of client state (positions,
  // orders, watchlist prefs tied to the old account, etc.) needs a full
  // reload rather than a partial refetch.
  async function submitAccountSwitch(event: React.FormEvent) {
    event.preventDefault();
    if (!switchTarget) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const result = await tradeApi.login(switchTarget.accountNumber, switchPassword);
      if ("requiresTwoFactor" in result) {
        setSwitchPendingToken(result.pendingToken);
        setSwitching(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setSwitching(false);
      setSwitchError(err instanceof Error ? err.message : "switch failed");
    }
  }

  async function submitSwitchTwoFactor(event: React.FormEvent) {
    event.preventDefault();
    if (!switchPendingToken) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await tradeApi.verifyTwoFactor(switchPendingToken, switchTwoFactorCode);
      window.location.reload();
    } catch (err) {
      setSwitching(false);
      setSwitchError(err instanceof Error ? err.message : "verification failed");
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
    const brokerSlug = brokerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "statement";
    a.download = `${brokerSlug}-statement${reportFrom ? `-${reportFrom}` : ""}${reportTo ? `-${reportTo}` : ""}.csv`;
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
  // Previously only fetched when the Funds modal opened -- the bottom-
  // panel History tab now shows deposits/withdrawals/adjustments
  // alongside closed trades (see historyRows below), so it needs to be
  // loaded up front like trade history already is, not gated behind a
  // modal the trader might never open.
  useEffect(() => { refreshFundsHistory(); }, [refreshFundsHistory]);

  async function openSecurityModal() {
    setTopMenuOpen(null);
    setSecurityModalOpen(true);
    setTfaSetupData(null);
    setTfaConfirmCode("");
    setTfaDisablePassword("");
    setTfaError(null);
    setSessions(null);
    setSessions(await tradeApi.sessions().catch(() => []));
  }

  async function startTwoFactorSetup() {
    setTfaBusy(true);
    setTfaError(null);
    try {
      const { secret, qrCodeDataUri } = await tradeApi.setupTwoFactor();
      setTfaSetupData({ secret, qrCodeDataUri });
    } catch (err) {
      setTfaError(err instanceof Error ? err.message : "failed to start 2FA setup");
    } finally {
      setTfaBusy(false);
    }
  }

  async function confirmTwoFactorSetup(event: React.FormEvent) {
    event.preventDefault();
    setTfaBusy(true);
    setTfaError(null);
    try {
      await tradeApi.confirmTwoFactor(tfaConfirmCode);
      await refreshAccount();
      setTfaSetupData(null);
      setTfaConfirmCode("");
      pushToast("Two-factor authentication enabled");
    } catch (err) {
      setTfaError(err instanceof Error ? err.message : "invalid code");
    } finally {
      setTfaBusy(false);
    }
  }

  async function disableTwoFactorSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTfaBusy(true);
    setTfaError(null);
    try {
      await tradeApi.disableTwoFactor(tfaDisablePassword);
      await refreshAccount();
      setTfaDisablePassword("");
      pushToast("Two-factor authentication disabled");
    } catch (err) {
      setTfaError(err instanceof Error ? err.message : "failed to disable 2FA");
    } finally {
      setTfaBusy(false);
    }
  }

  // Revoking the current session (the same device this panel is open in)
  // deletes the underlying Redis session immediately -- the cookie itself
  // is still sitting in the browser but now points at nothing, so the
  // next request would 401 anyway. Logging out explicitly here (instead
  // of waiting for that to surface incidentally) gives a clean redirect
  // rather than a confusing stuck screen.
  async function revokeSessionRow(s: ApiSession) {
    setRevokingSessionId(s.sessionId);
    try {
      await tradeApi.revokeSession(s.sessionId);
      if (s.current) {
        handleLogout();
        return;
      }
      setSessions((prev) => prev?.filter((x) => x.sessionId !== s.sessionId) ?? null);
      pushToast("Session revoked");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to revoke session");
    } finally {
      setRevokingSessionId(null);
    }
  }

  // A successful account load means this session is valid on this broker's
  // subdomain — remember it (desktop only) so next launch skips the server
  // picker and comes straight back here instead. Skipped when the launcher's
  // "Remember me" checkbox was unchecked (?remember=0 on the /trade redirect
  // from /api/trade/login-redirect); defaults to remembering when arriving
  // any other way (e.g. logging in directly on a broker-specific build).
  useEffect(() => {
    const remember = new URLSearchParams(window.location.search).get("remember");
    if (account && window.vyxDesktop?.isDesktop && remember !== "0") {
      window.vyxDesktop.rememberBroker?.(window.vyxDesktop.brokerHost ?? window.location.hostname);
    }
  }, [account]);

  // ---------- price tick ----------
  // fix/realtime-sync §2 -- bounds feedStatusFor's "connecting" state to a
  // real window instead of the mount timestamp drifting with re-renders;
  // serverNow() (not Date.now()) so the 30s grace window and every
  // lastTickAt comparison it's measured against share one clock.
  const sessionStartedAtRef = useRef(serverNow());
  const liveTicksRef = useRef<Record<string, { bid: number; ask: number; at: number }>>({});
  // Coalesces both push-tick sources below (the browser WebSocket and the
  // desktop native relay) to at most 20 updates/s per symbol -- the
  // Contabo audit's ask, once ticks started arriving in real time (EA
  // direct mode, sub-second cadence) instead of the old 1s timer, a fast
  // symbol could push liveTicksRef (and therefore a re-render) far more
  // often than is useful for a human-readable chart.
  const lastTickAcceptedAtRef = useRef<Record<string, number>>({});
  const MAX_TICK_HZ_PER_SYMBOL = 20;
  function acceptCoalescedTick(symbol: string, bid: number, ask: number) {
    const now = performance.now();
    const last = lastTickAcceptedAtRef.current[symbol] ?? 0;
    if (now - last < 1000 / MAX_TICK_HZ_PER_SYMBOL) return;
    lastTickAcceptedAtRef.current[symbol] = now;
    const at = serverNow();
    liveTicksRef.current = { ...liveTicksRef.current, [symbol]: { bid, ask, at } };
    // TEMP DIAGNOSTIC -- round 4 investigation, remove before merge.
    if (isTickDebug() && symbol === activeSymbol) {
      // eslint-disable-next-line no-console
      console.log("[DIAG acceptCoalescedTick]", { symbol, bid, at, bucketM1: bucketStartMs("M1", at) });
    }
    // hotfix/terminal-live-bugs #2 -- this used to only write liveTicksRef
    // and wait for the 1500ms interval below to notice it, which meant a
    // push tick (browser WS or desktop native relay) took up to 1.5s to
    // ever reach React state -- so the header price, the chart's last
    // candle, and the dashed last-price line all sat on a stale value for
    // up to 1.5s at a time, wide enough on fast-moving gold to look like a
    // multi-dollar gap. Applying it here means the chart's last-candle
    // effect (KLineChartPanel's `[latestBar]` useEffect -- see its own
    // comment) fires on every coalesced tick, exactly as designed, not
    // once per interval tick.
    setMarket((prev) => tickMarket(prev, liveTicksRef.current, at));
  }
  useEffect(() => {
    // Backstop only now (fix/realtime-sync §2 originally made this the
    // sole consumer of liveTicksRef; acceptCoalescedTick above now applies
    // push ticks immediately) -- still needed for symbols whose only tick
    // source is the 30s REST poll (no push feed reaching them), and to
    // keep re-evaluating `live`/staleness even when no tick has landed
    // for a symbol recently (tickMarket flips `live` false once a tick
    // ages past LIVE_MAX_AGE_MS, which needs to happen on a clock, not
    // just on receipt of a new tick).
    const tick = () => setMarket((prev) => tickMarket(prev, liveTicksRef.current, serverNow()));
    tick();
    const interval = setInterval(tick, 1500);
    return () => clearInterval(interval);
  }, []);

  // Polls /api/trade/prices + LivePrice -- was the primary tick source
  // before the Gateway WebSocket below existed, at 2s. Now that
  // NEXT_PUBLIC_GATEWAY_WS_URL is confirmed live in production (Contabo
  // audit, 2026-08-29), this is a 30s health-check/fallback only: still
  // writes ticks (so an environment where the socket never connects --
  // the var unset, or a persistent reconnect failure -- still has *some*
  // live price, just up to 30s stale instead of 2s), still doubles as the
  // connection-status signal (DesktopTitleBar / topbar indicator), and
  // still rides refreshOrders/refreshPositions along (safe to slow down
  // now that the separate trading-events WebSocket below already covers
  // the low-latency case this used to be the only thing catching --
  // dealer fills, requotes, externally-created positions).
  const [connected, setConnected] = useState(true);
  // hotfix/terminal-live-bugs #3 -- this used to be timed off this same
  // REST poll (performance.now() around the tradeApi.prices() call below)
  // and labeled "Ping" in the status bar, which measured an HTTP
  // round-trip through Vercel's edge/function stack to this DB, not
  // network latency to the Contabo gateway -- that's why it read 429ms
  // instead of the ~120-150ms a real Karachi-to-Contabo RTT should be.
  // Real value now comes from an app-level ping/pong on the price-tick
  // WebSocket itself (see the effect below and services/api-gateway/src/
  // ws.ts's registerClient) -- null/"—" whenever that socket isn't open,
  // same "never show a wrong number" rule as dayOpen's fix above.
  const [pingMs, setPingMs] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let wasConnected = true;
    async function poll() {
      try {
        const rows = await tradeApi.prices();
        if (cancelled) return;
        const next: Record<string, { bid: number; ask: number; at: number }> = {};
        const now = Date.now();
        for (const row of rows) {
          // Ignore stale rows (EA/terminal offline) so the chart falls back
          // to simulation instead of freezing on the last real tick.
          const updatedAtMs = new Date(row.updatedAt).getTime();
          if (now - updatedAtMs > 15000) continue;
          // `at` is the row's own updatedAt, not "now this poll happened to
          // resolve" -- feedStatusFor's staleness clock should reflect how
          // fresh the price actually is, not this request's own latency.
          next[row.symbol] = { bid: parseFloat(row.bid), ask: parseFloat(row.ask), at: updatedAtMs };
        }
        // Merges onto whatever the WS/desktop relay has already written
        // (fix/realtime-sync §2) instead of replacing wholesale -- this
        // poll runs every 30s now (a fallback, not the primary source, per
        // this effect's own doc comment below), so blindly overwriting
        // would occasionally stomp a fresher push-tick with an up-to-30s-
        // stale REST snapshot for the same symbol.
        for (const [symbol, tick] of Object.entries(next)) {
          const existing = liveTicksRef.current[symbol];
          if (!existing || tick.at >= existing.at) {
            liveTicksRef.current = { ...liveTicksRef.current, [symbol]: tick };
          }
        }
        if (!wasConnected) { appendLog("Connection restored"); wasConnected = true; }
        setConnected(true);
      } catch {
        // feed unreachable — keep simulating, nothing to surface to the trader
        if (wasConnected) { appendLog("Connection lost"); wasConnected = false; }
        setConnected(false);
      }
      // Rides along with the price poll rather than its own interval --
      // this is the only thing that would otherwise surface a dealer's
      // requote (order status flips PENDING -> REQUOTED server-side with
      // nothing pushing that change to the client) or any position change
      // that didn't originate from this tab (a manual position from the
      // backoffice, a dealer fill, an auto-close/stop-out) -- previously
      // refreshPositions() only ran once on mount and after this tab's own
      // trade actions, so an externally-created position could sit
      // invisible for as long as the trader didn't happen to do anything
      // else. Both already swallow their own errors, so neither affects
      // the connection-status logic above.
      if (!cancelled) { refreshOrders(); refreshPositions(); }
    }
    poll();
    const interval = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [appendLog, refreshOrders, refreshPositions]);

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
    // Desktop: a bundled shell's own browser WebSocket can't carry the
    // session cookie across the local-content/real-host origin boundary
    // (same reason lib/trade-api.ts's call() can't use fetch() there) --
    // desktop-tauri's native WS relay (main.rs's run_gateway_stream)
    // does the actual handshake instead and forwards frames as Tauri
    // events. startLiveStreams is safe to call even if a session isn't
    // captured yet (rejects, caught below); the 2s poll above still
    // covers that gap either way, same as the web fallback.
    if (typeof window !== "undefined" && window.vyxDesktop?.onPriceTick) {
      window.vyxDesktop.startLiveStreams?.().catch(() => {});
      return window.vyxDesktop.onPriceTick((payload) => {
        try {
          const tick = JSON.parse(payload) as { symbol: string; bid: string | number; ask: string | number };
          const bid = Number(tick.bid);
          const ask = Number(tick.ask);
          if (!tick.symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
          acceptCoalescedTick(tick.symbol, bid, ask);
        } catch {
          // malformed frame — ignore, next tick will correct the picture
        }
      });
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    function connect() {
      if (cancelled) return;
      const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://127.0.0.1:8080";
      socket = new WebSocket(`${base}/v1/prices/stream`);
      if (isTickDebug()) {
        // eslint-disable-next-line no-console
        console.log("[DIAG ws connecting]", `${base}/v1/prices/stream`);
      }
      socket.onopen = () => {
        if (isTickDebug()) {
          // eslint-disable-next-line no-console
          console.log("[DIAG ws open]");
        }
        // hotfix/terminal-live-bugs #3 -- app-level ping/pong over this
        // same connection, echoed by services/api-gateway/src/ws.ts's
        // registerClient. The browser's native WebSocket API never
        // exposes protocol-level ping/pong frames to JS (those are
        // handled invisibly below the API), so a real RTT to the gateway
        // has to be a plain message the two sides agree on, not something
        // the platform gives you for free.
        const sendPing = () => { try { socket?.send(JSON.stringify({ type: "ping", t: performance.now() })); } catch { /* socket not open */ } };
        sendPing();
        pingInterval = setInterval(sendPing, 5000);
      };
      socket.onmessage = (event) => {
        if (isTickDebug()) {
          // eslint-disable-next-line no-console
          console.log("[DIAG ws message]", typeof event.data === "string" ? event.data.slice(0, 200) : event.data);
        }
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.type === "pong") {
            setPingMs(Math.round(performance.now() - parsed.t));
            return;
          }
          // The Gateway relays the Rust engine's raw JSON unchanged --
          // bid/ask are strings there (Prisma.Decimal serialized), same
          // as tradeApi.prices()'s rows above, not the number the old
          // `as` type assertion claimed (a cast, not a runtime coercion
          // -- it never actually caught this). Every consumer of
          // liveTicksRef expects a real number, so this crashed the
          // whole page the moment a live tick actually arrived --
          // dormant until the WS auth fix made that path work at all.
          const tick = parsed as { symbol: string; bid: string | number; ask: string | number };
          const bid = Number(tick.bid);
          const ask = Number(tick.ask);
          if (!tick.symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
          acceptCoalescedTick(tick.symbol, bid, ask);
        } catch {
          // malformed frame — ignore, next tick will correct the picture
        }
      };
      socket.onclose = (event) => {
        if (isTickDebug()) {
          // eslint-disable-next-line no-console
          console.log("[DIAG ws close]", { code: event.code, reason: event.reason, wasClean: event.wasClean });
        }
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        setPingMs(null);
        if (!cancelled) reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = (event) => {
        if (isTickDebug()) {
          // eslint-disable-next-line no-console
          console.log("[DIAG ws error]", event);
        }
        socket?.close();
      };
    }
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      socket?.close();
    };
  }, []);

  // Pushed order/position/account events (docs/webtrader-stm-architecture-
  // review.md §4.3, sequencing item 4) -- the Gateway
  // (services/api-gateway/src/ws.ts's attachTradingEventStream) only ever
  // forwards messages already scoped to this session's account, so every
  // message received here is relevant; no client-side filtering needed.
  // A dealer filling/rejecting a dealing-queue order, or a requote landing
  // on this account, are the cases this actually shaves the up-to-2s poll
  // delay off of -- this tab's own actions already get their result
  // synchronously in the HTTP response, so this is a genuine latency win
  // only for changes another actor made. Doesn't distinguish event `type`
  // -- refreshing all three is cheap and avoids this effect needing to
  // track every event shape the backend might ever add. Same silent-
  // failure/2s-poll-fallback rule as the price-tick socket above.
  useEffect(() => {
    // Desktop: same native-relay reasoning as the price-tick effect
    // above -- startLiveStreams isn't called again here, it starts both
    // streams together, so calling it from that effect alone is enough
    // (both effects always mount together, this component owning both).
    if (typeof window !== "undefined" && window.vyxDesktop?.onTradingEvent) {
      return window.vyxDesktop.onTradingEvent(() => {
        refreshOrders();
        refreshPositions();
        refreshAccount();
      });
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://127.0.0.1:8080";
      socket = new WebSocket(`${base}/v1/trading/stream`);
      socket.onmessage = () => {
        refreshOrders();
        refreshPositions();
        refreshAccount();
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
  }, [refreshOrders, refreshPositions, refreshAccount]);

  // fix/realtime-sync §7 -- F5/Ctrl+R (Cmd+R on Mac) refetches this tab's
  // own data instead of a full page reload, which used to throw away
  // every bit of client-side state (chart drawings, grid layout, the
  // in-memory `market` simulator/tick history, watchlist scroll
  // position...) for a page that's otherwise designed to run
  // indefinitely without ever reloading. The two price/trading
  // WebSockets aren't force-reconnected here -- both already carry their
  // own reconnect-with-backoff (see those effects above) and are either
  // already alive (nothing to do) or already reconnecting on their own
  // schedule; this only needs to be the "give me fresh data now" a
  // trader pressing F5 actually wants.
  //
  // Real limitation, not something JS can work around: this only catches
  // the keyboard shortcut. A literal click on the browser's own reload
  // button/toolbar icon can't be intercepted by any web page's script --
  // that one action genuinely still does a full reload.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isRefreshShortcut = e.key === "F5" || ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R"));
      if (!isRefreshShortcut) return;
      e.preventDefault();
      refreshOrders();
      refreshPositions();
      refreshAccount();
      pushToast("Refreshed");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refreshOrders, refreshPositions, refreshAccount, pushToast]);

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
      const seededCandles: Candle[] = rows.map((r) => ({
        o: parseFloat(r.open),
        h: parseFloat(r.high),
        l: parseFloat(r.low),
        c: parseFloat(r.close),
        t: new Date(r.bucketStart).getTime(),
      }));
      // fix/realtime-sync §3's "on timeframe switch: fetch history, then
      // immediately apply the latest tick to the last bucket" -- the
      // server's own candle flush (engine/market-data) runs on its own
      // periodic cadence, so its last row can be up to that interval
      // stale relative to whatever tick has already landed in
      // liveTicksRef since it was written. Only reconciles when the
      // server's last row IS the currently-open bucket for `tf` (a fully
      // closed historical bucket has nothing live to apply) and a real
      // tick actually exists for this symbol right now.
      const live = liveTicksRef.current[symbol];
      const nowForBucket = serverNow();
      if (live && lastBucket === bucketStartMs(tf, nowForBucket)) {
        const last = seededCandles[seededCandles.length - 1];
        seededCandles[seededCandles.length - 1] = {
          o: last.o,
          h: Math.max(last.h, live.bid),
          l: Math.min(last.l, live.bid),
          c: live.bid,
          t: last.t,
        };
      }
      setMarket((prev) => {
        const ms = prev[symbol];
        if (!ms) return prev;
        return {
          ...prev,
          [symbol]: {
            ...ms,
            candles: { ...ms.candles, [tf]: seededCandles },
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

  // hotfix/terminal-live-bugs #1 follow-up -- applyBidAsk's D1-rollover
  // resync (lib/market-simulator.ts) only fixes dayOpen at the *next* UTC
  // midnight; a page loaded mid-day (the actual reported case, 07:52 UTC)
  // still compared a live price against createInitialMarket()'s launch-time
  // seed until then. This fetches D1 history independently of whatever
  // timeframe the chart itself is showing (a trader on M1 still needs
  // today's D1 open) and seeds dayOpen from the real bucket -- resolved via
  // resolveDayOpenFromD1, which only trusts a row that IS today's open
  // bucket. Deliberately never downgrades an already-known dayOpen (e.g.
  // one a live D1 rollover already set correctly this session) back to
  // unknown just because this fetch found nothing -- only ever upgrades
  // unknown -> known.
  //
  // round-2 hotfix -- this MUST also write lastCandleStart.D1 (see
  // resolveDayOpenFromD1's own comment). The first version only patched
  // dayOpen/dayOpenKnown, so applyBidAsk's D1-rollover check
  // (lastCandleStart.D1, still 0 from createInitialMarket -- nothing else
  // ever sets it unless D1 happens to be the chart's own active
  // timeframe) treated the very next live tick as "a new D1 bucket just
  // started" and immediately re-stamped dayOpen to that tick's own bid --
  // which is exactly how production kept showing "+0.00%" moments after
  // this ran.
  const seedDayOpen = useCallback(async (symbol: string) => {
    try {
      const rows = await tradeApi.candles(symbol, "D1");
      const resolved = resolveDayOpenFromD1(rows, serverNow());
      if (resolved === null) return; // no D1 bar for today yet -- leave as-is (unknown stays "—", known stays known)
      setMarket((prev) => {
        const ms = prev[symbol];
        if (!ms) return prev;
        return {
          ...prev,
          [symbol]: {
            ...ms,
            dayOpen: resolved.open,
            dayOpenKnown: true,
            lastCandleStart: { ...ms.lastCandleStart, D1: resolved.bucketStart },
          },
        };
      });
    } catch {
      // history endpoint unreachable -- leave dayOpenKnown as-is, never
      // fabricate a number to show
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => { if (!cancelled) await seedDayOpen(activeSymbol); })();
    return () => { cancelled = true; };
  }, [activeSymbol, seedDayOpen]);

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

  // A dealer requoted one of this account's orders -- prompt once per
  // order (requotedPromptedRef tracks which ids already got a popup, so
  // the 2s poll folding refreshOrders() in doesn't re-open it every
  // cycle). The row in the Orders panel below is the fallback if this
  // popup gets dismissed or missed.
  const requotedPromptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (genericModal) return;
    const requoted = pendingOrders.find((o) => o.status === "REQUOTED" && !requotedPromptedRef.current.has(o.id));
    if (!requoted) return;
    requotedPromptedRef.current.add(requoted.id);
    setGenericModal({
      title: "Dealer requoted your order",
      message: `${requoted.side} ${requoted.volume} ${requoted.symbol.name} — dealer offered ${
        requoted.requotedPrice ? fmt(parseFloat(requoted.requotedPrice), requoted.symbol.digits) : "a different price"
      } instead of ${requoted.requestedPrice ? fmt(parseFloat(requoted.requestedPrice), requoted.symbol.digits) : "market"}. Accept the new price?`,
      showInput: false,
      okLabel: "Accept new price",
      // v is null for every dismissal path (backdrop click, the X button,
      // and Cancel -- see the generic modal's own onClick handlers below),
      // not just an explicit "reject." This used to treat all of those the
      // same as clicking Cancel-as-reject and silently rejected the order,
      // contradicting this effect's own comment that the Orders panel row
      // is the fallback for a dismissed/missed popup -- a fallback that
      // never got a chance to matter because the order was already
      // rejected. Only the explicit "Accept new price" button should act;
      // everything else leaves the order REQUOTED for that row's own
      // Accept/Reject buttons to handle.
      onConfirm: (v) => { if (v !== null) respondToRequote(requoted, true); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOrders, genericModal]);

  // ---------- order ticket ----------
  const m = market[activeSymbol];
  // fix/realtime-sync §2 -- recomputed every render, which happens at
  // least every 1500ms regardless of tick content (tickMarket's own
  // setMarket call above always returns a new object), so a status
  // transition (connecting -> live -> stale -> no-feed) is reflected
  // within that same worst-case window even with zero new ticks.
  const activeFeedStatus: FeedStatus = feedStatusFor(m.lastTickAt, serverNow(), sessionStartedAtRef.current);

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
      const result = await tradeApi.placeOrder({
        symbol: activeSymbol, side, type: "MARKET", volume, price: refPrice,
        slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID(),
      });
      if (result.position) {
        pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${volume} lots of ${activeSymbol} @ ${fmt(refPrice, m.def.digits)}`);
        await Promise.all([refreshPositions(), refreshAccount()]);
      } else {
        pushToast(`${activeSymbol} order submitted — awaiting dealer approval`);
        await refreshOrders();
      }
    } catch (err) {
      handleOrderError(err, () => placeOrder(side));
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
      const result = await tradeApi.placeOrder({
        symbol: symbolName, side, type: "MARKET", volume,
        price: ocPrice, idempotencyKey: crypto.randomUUID(),
      });
      if (result.position) {
        pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${volume} lots of ${symbolName} @ ${fmt(ocPrice, mm.def.digits)} — one-click`);
        await Promise.all([refreshPositions(), refreshAccount()]);
      } else {
        pushToast(`${symbolName} order submitted — awaiting dealer approval`);
        await refreshOrders();
      }
    } catch (err) {
      handleOrderError(err, () => oneClickTrade(symbolName, side));
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
    setQuickOrderType("MARKET"); setQuickOrderPrice("");
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
      const result = await tradeApi.placeOrder({ symbol: quickOrder.symbol, side, type: "MARKET", volume: vol, price: refPrice, slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID() });
      setQuickOrder(null);
      if (result.position) {
        pushToast(`${side === "BUY" ? "Bought" : "Sold"} ${vol} lots of ${quickOrder.symbol} @ ${fmt(refPrice, mm.def.digits)}`);
        await Promise.all([refreshPositions(), refreshAccount()]);
      } else {
        pushToast(`${quickOrder.symbol} order submitted — awaiting dealer approval`);
        await refreshOrders();
      }
    } catch (err) {
      handleOrderError(err, () => submitQuickOrder(side));
    }
  }
  // Same ticket, pending-type path (Buy/Sell Limit/Stop) -- side comes
  // from the chosen type, and price is the trader's own entry rather than
  // the current bid/ask, same validation as the chart right-click flow
  // (quickPlacePendingAtPrice).
  async function submitQuickPendingOrder(type: PendingType) {
    if (!quickOrder) return;
    const mm = market[quickOrder.symbol];
    if (!mm.live) { pushToast("No live feed for this symbol"); return; }
    const price = parseFloat(quickOrderPrice);
    if (!Number.isFinite(price) || price <= 0) { pushToast("Enter a valid price"); return; }
    if (!isValidPendingPrice(type, price, mm.bid)) { pushToast(pendingPriceRuleText(type)); return; }
    const side = type.startsWith("buy") ? "BUY" : "SELL";
    const orderType = type.endsWith("limit") ? "LIMIT" : "STOP";
    const vol = parseFloat(quickOrderVolume) || 0.01;
    const sl = quickOrderSl === "" ? null : parseFloat(quickOrderSl);
    const tp = quickOrderTp === "" ? null : parseFloat(quickOrderTp);
    const error = isValidSlTpForSide(side, sl, tp, price);
    if (error) { pushToast(error); return; }
    try {
      await tradeApi.placeOrder({ symbol: quickOrder.symbol, side, type: orderType, volume: vol, price, slPrice: sl, tpPrice: tp, idempotencyKey: crypto.randomUUID() });
      setQuickOrder(null);
      pushToast(`Pending ${type.replace("_", " ")} placed for ${quickOrder.symbol} @ ${fmt(price, mm.def.digits)}`);
      await refreshOrders();
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
      // Always hardcoded "above" regardless of where the target price sat
      // relative to the market -- an alert for a price already below the
      // current bid got condition "above" (triggers on bid >= price),
      // which was already true the instant it was created, firing
      // immediately instead of waiting for the price to actually drop
      // there. Infer the direction from where the price is right now,
      // same "below market" logic the chart's own right-click menu
      // already uses to label a price (see chartContextMenu below).
      const condition: Alert["condition"] = price >= mm.bid ? "above" : "below";
      setAlerts((prev) => [...prev, { id: nextId(), symbol: symbolName, condition, price, triggered: false }]);
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
      <DesktopTitleBar brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} server={serverName} connected={connected} />
      <div id="app">
        <div className={`margin-call-banner${marginCall ? " show" : ""}`}>
          Margin call — your margin level is below 100%. Deposit funds or close positions to avoid stop-out.
        </div>

        <div className={`topbar${isDesktopApp ? " topbar-desktop" : ""}`}>
          <div className="topbar-left">
            <div className="nav" ref={topMenuContainerRef}>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => setTopMenuOpen((id) => (id === "file" ? null : "file"))}>File</div>
                {topMenuOpen === "file" ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 180 }} onClick={() => setTopMenuOpen(null)}>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={handleLogout}>Switch account</div>
                    {isDesktopApp ? (
                      <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => window.vyxDesktop?.close?.()}>Exit</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => setTopMenuOpen((id) => (id === "tools" ? null : "tools"))}>Tools</div>
                {topMenuOpen === "tools" ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 180 }}>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setTopMenuOpen(null); setChangePasswordOpen(true); }}>Change password</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={openSecurityModal}>Security</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setTopMenuOpen(null); setKycModalOpen(true); refreshKycStatus(); }}>Verify identity</div>
                    <div className="acc-option" style={{ cursor: "pointer", padding: "8px 10px" }} onClick={() => { setTopMenuOpen(null); setActiveBottomTab("logs"); }}>View logs</div>
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
                <div className="item" onClick={() => { setTopMenuOpen((id) => (id === "actions" ? null : "actions")); setActionsSearch(""); }}>Quick actions ▾</div>
                {topMenuOpen === "actions" ? (
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
                            onClick={() => { selectSymbol(s.name); setTopMenuOpen(null); }}
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
                          onClick={() => { closeManyBy((p) => positionPnl(p) >= 0, "Closed profitable"); setTopMenuOpen(null); }}
                        >
                          Close profitable positions
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px", color: acctPositions.some((p) => positionPnl(p) < 0) ? "var(--sell)" : "var(--text-3)" }}
                          onClick={() => { closeManyBy((p) => positionPnl(p) < 0, "Closed losing"); setTopMenuOpen(null); }}
                        >
                          Close losing positions
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { closeManyBy(() => true, "Closed all"); setTopMenuOpen(null); }}
                        >
                          Close all positions
                        </div>
                        <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { setOneClick((v) => !v); pushToast(!oneClick ? "One-click trading enabled" : "One-click trading disabled"); setTopMenuOpen(null); }}
                        >
                          Toggle one-click trading
                        </div>
                        <div
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { setActiveBottomTab("logs"); setTopMenuOpen(null); }}
                        >
                          View logs
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <div style={{ position: "relative" }}>
                <div className="item" onClick={() => setTopMenuOpen((id) => (id === "help" ? null : "help"))}>Help</div>
                {topMenuOpen === "help" ? (
                  <div className="account-dropdown show" style={{ top: "100%", left: 0, width: 190 }}>
                    {supportEmail ? (
                      <div
                        className="acc-option"
                        style={{ cursor: "pointer", padding: "8px 10px" }}
                        onClick={() => { setTopMenuOpen(null); window.open(`mailto:${supportEmail}`, "_blank"); }}
                      >
                        Contact support
                      </div>
                    ) : null}
                    <div
                      className="acc-option"
                      style={{ cursor: "pointer", padding: "8px 10px" }}
                      onClick={() => { setTopMenuOpen(null); pushToast(`${brokerName} — online trading platform`); }}
                    >
                      About
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {isDesktopApp ? (
            // DesktopTitleBar (the bar above this one) already shows the
            // broker's logo/name and a Live/Demo status pill -- showing
            // this same identity a second time right underneath it was
            // the literal "two headers both say Futurix Global" complaint.
            <span className="topbar-center" />
          ) : (
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
              </span>
            </span>
          )}
          <div className="topbar-right">
            <span className="trader-name">{balanceHidden ? "••••••" : account?.fullName ?? ""}</span>
            <button className="eye-toggle-btn" onClick={() => setBalanceHidden((v) => !v)} title={balanceHidden ? "Show balance" : "Hide balance"}>
              {balanceHidden ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
            <div className="account-switcher" ref={accountSwitcherRef}>
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
                  {linkedAccounts === null ? (
                    <div className="net-pos-detail" style={{ padding: "8px 10px" }}>Loading linked accounts…</div>
                  ) : linkedAccounts.length === 0 ? (
                    <div className="net-pos-detail" style={{ padding: "8px 10px" }}>
                      No other accounts linked to this email.
                    </div>
                  ) : (
                    <div style={{ borderTop: "1px solid var(--border)" }}>
                      {linkedAccounts.map((la) => (
                        <div
                          key={la.accountNumber}
                          className="acc-option"
                          style={{ cursor: "pointer", padding: "8px 10px" }}
                          onClick={() => { setSwitchTarget(la); setSwitchPassword(""); setSwitchError(null); setSwitchPendingToken(null); setSwitchTwoFactorCode(""); setAccountDropdownOpen(false); }}
                        >
                          <div className="acc-option-top">
                            <span className="acc-option-num mono">{la.accountNumber}</span>
                            <span className={`acc-badge ${la.accountType === "LIVE" ? "live" : "demo"}`}>{la.accountType}</span>
                          </div>
                          <div className="acc-option-balance mono">
                            {balanceHidden ? "••••••" : `${money(parseFloat(la.balance))} ${la.currency}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
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
              <span className="funds-btn-label">Funds</span>
            </button>
            <button className="bell-btn" onClick={() => setAlertsModalOpen(true)} title="Price alerts">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
              {alerts.length > 0 ? <span className="bell-count">{alerts.length}</span> : null}
            </button>
            <div className="avatar">{account?.accountNumber?.slice(-2) ?? "—"}</div>
          </div>
        </div>

        <div
          className={`main${isMobileView ? " mobile" : ""}`}
          style={isMobileView ? undefined : { gridTemplateColumns: `48px ${watchlistWidth}px 6px 1fr 6px ${orderPanelWidth}px` }}
        >
          {/* ---------- ICON RAIL (far left, desktop only -- replaced by
              the bottom nav bar on mobile, rendered after .main below) ---------- */}
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
            <button className={`rail-item${stmOpen ? " active" : ""}`} title="Smart Trade Manager" onClick={() => setStmOpen((v) => !v)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>
            </button>
            <div className="rail-sep" />
            <button className="rail-item rail-bottom" title="Change password" onClick={() => setChangePasswordOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </button>
          </div>

          {/* ---------- WATCHLIST (left) ---------- */}
          <div
            className={`watchlist${isMobileView ? ` mobile${mobileTab === "watchlist" ? " mobile-active" : ""}` : ""}`}
            onContextMenu={(e) => { e.preventDefault(); setWlMenuOpen(true); setWlContextMenu({ x: e.clientX, y: e.clientY }); }}
          >
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
                const changePct = row.dayOpenKnown ? ((row.bid - row.dayOpen) / row.dayOpen) * 100 : null;
                const flash = row.bid > row.prevBid ? "up" : row.bid < row.prevBid ? "down" : "";
                return (
                  <div
                    key={name}
                    className={`wl-item${name === activeSymbol ? " active" : ""}`}
                    style={{ gridTemplateColumns: wlGridTemplate }}
                    onClick={() => selectSymbol(name)}
                    onDoubleClick={() => openQuickOrder(name)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setWlMenuOpen(true); setWlContextMenu({ x: e.clientX, y: e.clientY, symbol: name }); }}
                    {...attachDragHandlers(name)}
                  >
                    <span className="wl-drag-handle">⋮⋮</span>
                    <span className="wl-cell wl-symbol">{name}</span>
                    {columnPrefs.signal ? <span className={`wl-cell wl-signal ${row.live && row.dayOpenKnown && row.bid >= row.dayOpen ? "wl-pos" : "wl-neg"}`}>{row.live && row.dayOpenKnown ? (row.bid >= row.dayOpen ? "▲" : "▼") : "—"}</span> : null}
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
                    {columnPrefs.change ? <span className={`wl-cell mono ${changePct !== null && changePct >= 0 ? "wl-pos" : "wl-neg"}`}>{row.live && changePct !== null ? (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%" : "—"}</span> : null}
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
              <div className="wl-context-menu show" ref={wlContextMenuRef} style={{ left: wlContextMenu.x, top: wlContextMenu.y }}>
                {wlContextMenu.symbol ? (
                  <>
                    <div
                      className="wl-ctx-item"
                      onClick={() => {
                        selectSymbol(wlContextMenu.symbol!);
                        setSymbolInfoOpen(true);
                        setWlMenuOpen(false);
                      }}
                    >
                      <span className="wl-ctx-check" />
                      <span>Symbol specification — {wlContextMenu.symbol}</span>
                    </div>
                    <div className="wl-ctx-title">Show columns</div>
                  </>
                ) : (
                  <div className="wl-ctx-title">Show columns</div>
                )}
                {(["signal", "change", "spread", "high", "low"] as const).map((key) => (
                  <div key={key} className="wl-ctx-item" onClick={() => setColumnPrefs((prev) => ({ ...prev, [key]: !prev[key] }))}>
                    <span className="wl-ctx-check">{columnPrefs[key] ? "✓" : ""}</span>
                    <span style={{ textTransform: "capitalize" }}>{key === "change" ? "Change %" : key === "high" ? "Daily high" : key === "low" ? "Daily low" : key}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="wl-hint">Right-click for more columns</div>

            {/* ---------- Smart Trade Manager (embedded below the
                Watchlist, MT4/5-style, instead of hidden behind the rail
                icon) -- same rail button now just toggles this section's
                collapse state. ---------- */}
            <div
              className="section-label"
              style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}
              onClick={() => setStmOpen((v) => !v)}
            >
              <span>Smart Trade Manager</span>
              <span style={{ transform: stmOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▾</span>
            </div>
            {stmOpen ? (
              <SmartTradeManager
                embedded
                open={stmOpen}
                onClose={() => setStmOpen(false)}
                market={market}
                positions={positions}
                positionPnl={positionPnl}
                activeSymbol={activeSymbol}
                selectedPositionIds={selectedPositionIds}
                pushToast={pushToast}
                refreshPositions={refreshPositions}
                refreshHistory={refreshHistory}
                refreshAccount={refreshAccount}
              />
            ) : null}
          </div>

          {isMobileView ? null : <div className="col-resizer" onMouseDown={startResize("watchlist")} />}

          {/* ---------- CENTER (chart) ---------- */}
          <div ref={centerRef} className={`center${isMobileView ? ` mobile${mobileTab === "chart" || mobileTab === "positions" ? " mobile-active" : ""}` : ""}`}>
            <div className="chart-header" style={isMobileView && mobileTab !== "chart" ? { display: "none" } : undefined}>
              <div className="chart-title" ref={symbolDropdownRef} style={{ position: "relative" }}>
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
                {activeFeedStatus === "live" || activeFeedStatus === "stale" ? (
                  <>
                    <div
                      className="chart-price mono"
                      style={{ color: activeFeedStatus === "stale" ? "var(--text-3)" : m.bid >= m.prevBid ? "var(--buy)" : "var(--sell)" }}
                    >
                      {fmt(m.bid, m.def.digits)}
                    </div>
                    {m.dayOpenKnown ? (
                      <div className="chart-change mono" style={{ background: m.bid >= m.dayOpen ? "var(--buy-bg)" : "var(--sell-bg)", color: m.bid >= m.dayOpen ? "var(--buy)" : "var(--sell)" }}>
                        {(((m.bid - m.dayOpen) / m.dayOpen) * 100 >= 0 ? "+" : "") + (((m.bid - m.dayOpen) / m.dayOpen) * 100).toFixed(2)}%
                      </div>
                    ) : (
                      // hotfix/terminal-live-bugs #1 -- no trustworthy D1
                      // open yet (mid-day mount, D1 history unavailable) --
                      // "—", never a number computed against the launch seed.
                      <div className="chart-change mono" style={{ color: "var(--text-3)" }}>—</div>
                    )}
                    <div className="chart-spread mono">Spread {fmt(m.ask - m.bid, m.def.digits)}</div>
                    {activeFeedStatus === "stale" ? <div className="chart-spread mono">Stale</div> : null}
                  </>
                ) : (
                  // "connecting" (fix/realtime-sync §2's "no red text" rule
                  // -- neutral wording/color, never styled as an error) vs
                  // "no-feed" (the genuine dead-feed case, same wording as
                  // before).
                  <div className="chart-price mono" style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {activeFeedStatus === "connecting" ? "Connecting…" : "No live feed"}
                  </div>
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
            <div className="chart-area" style={isMobileView && mobileTab !== "chart" ? { display: "none" } : undefined}>
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
                    latestBar={candles[candles.length - 1]}
                    currentPrice={m.live ? m.bid : undefined}
                    currentPriceRising={m.bid >= m.prevBid}
                    digits={m.def.digits}
                    lines={chartLines}
                    onContextMenuPrice={handleChartContextMenuPrice}
                    onPanOrZoom={() => setChartContextMenu(null)}
                  />
                  {process.env.NODE_ENV !== "production" ? (
                    // hotfix/terminal-live-bugs round 2 -- dev-only overlay
                    // to visually confirm the tick->last-bar sync live in a
                    // browser, since this can't be asserted from a unit
                    // test alone. Never rendered in a production build
                    // (this whole branch is dead-code-eliminated by
                    // Next.js's production bundler).
                    <div
                      style={{
                        position: "absolute", bottom: 8, left: 8, zIndex: 5, pointerEvents: "none",
                        background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 11, fontFamily: "monospace",
                        padding: "4px 8px", borderRadius: 4, lineHeight: 1.5,
                      }}
                    >
                      <div>tick.bid: {fmt(m.bid, m.def.digits)}</div>
                      <div>bar.close ({currentTf}): {candles.length ? fmt(candles[candles.length - 1].c, m.def.digits) : "—"}</div>
                      <div style={{ color: candles.length && candles[candles.length - 1].c !== m.bid ? "#EA3943" : "#16C784" }}>
                        Δ: {candles.length ? fmt(m.bid - candles[candles.length - 1].c, m.def.digits) : "—"}
                      </div>
                    </div>
                  ) : null}
                  {activeFeedStatus === "connecting" ? (
                    // No dark overlay, no error-toned text -- fix/
                    // realtime-sync §2's explicit "never show an error in
                    // the first 5s" rule. The chart itself already renders
                    // (seeded history + the placeholder base price), just
                    // with a quiet corner note instead of a hard block.
                    <div style={{ position: "absolute", top: 8, left: 8, fontSize: 11, color: "var(--text-3)", pointerEvents: "none" }}>Connecting…</div>
                  ) : activeFeedStatus === "no-feed" ? (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>No live feed for {activeSymbol}</span>
                    </div>
                  ) : null}
                  {chartContextMenu ? (
                    <div className="wl-context-menu show" ref={chartContextMenuRef} style={{ left: chartContextMenu.x, top: chartContextMenu.y }}>
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
                      feedStatus={feedStatusFor(market[cell.symbol].lastTickAt, serverNow(), sessionStartedAtRef.current)}
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

            {isMobileView ? null : <div className="row-resizer" onMouseDown={startResize("bottom")} />}

            <div
              className={`bottom-panel${isMobileView ? " mobile" : ""}`}
              style={isMobileView ? { display: mobileTab === "positions" ? "flex" : "none", height: "auto", flex: 1 } : { height: bottomPanelHeight }}
            >
              <div className="tabs-row">
                <div className="tabs">
                  <div className={`tab${activeBottomTab === "positions" ? " active" : ""}`} onClick={() => setActiveBottomTab("positions")}>Positions ({acctPositions.length})</div>
                  <div className={`tab${activeBottomTab === "net" ? " active" : ""}`} onClick={() => setActiveBottomTab("net")}>Net positions ({netBySymbol.size})</div>
                  <div className={`tab${activeBottomTab === "orders" ? " active" : ""}`} onClick={() => setActiveBottomTab("orders")}>Pending Orders ({pendingOrders.length})</div>
                  <div className={`tab${activeBottomTab === "allOrders" ? " active" : ""}`} onClick={() => setActiveBottomTab("allOrders")}>Orders ({allOrders.length})</div>
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
                    <span>
                      <input
                        type="checkbox"
                        title="Select all"
                        checked={acctPositions.length > 0 && acctPositions.every((p) => selectedPositionIds.has(p.id))}
                        onChange={(e) => setSelectedPositionIds(e.target.checked ? new Set(acctPositions.map((p) => p.id)) : new Set())}
                      />
                    </span>
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
                          <span className="pos-cell">
                            <input
                              type="checkbox"
                              checked={selectedPositionIds.has(p.id)}
                              onChange={(e) =>
                                setSelectedPositionIds((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(p.id); else next.delete(p.id);
                                  return next;
                                })
                              }
                            />
                          </span>
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
                        {o.status === "REQUOTED" ? (
                          <span className="net-pos-detail mono">
                            requoted to {o.requotedPrice ? fmt(parseFloat(o.requotedPrice), o.symbol.digits) : "—"}
                          </span>
                        ) : (
                          <span className="net-pos-detail mono">@ {o.requestedPrice ? fmt(parseFloat(o.requestedPrice), o.symbol.digits) : "—"}</span>
                        )}
                      </div>
                      <div className="simple-right">
                        {o.status === "REQUOTED" ? (
                          <>
                            <button className="modal-btn primary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => respondToRequote(o, true)}>
                              Accept
                            </button>
                            <button className="modal-btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => respondToRequote(o, false)}>
                              Reject
                            </button>
                          </>
                        ) : (
                          <button className="icon-btn" title="Cancel order" onClick={() => tradeApi.cancelOrder(o.id).then(refreshOrders)}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {activeBottomTab === "allOrders" ? (
                <div className="panel-body">
                  {allOrders.length === 0 ? (
                    <div className="empty-state">No orders yet</div>
                  ) : (
                    allOrders.map((o) => {
                      const statusColor =
                        o.status === "FILLED"
                          ? "var(--buy)"
                          : o.status === "REJECTED" || o.status === "CANCELLED"
                            ? "var(--sell)"
                            : "var(--text-3)";
                      const priceLabel =
                        o.status === "FILLED" && o.filledPrice
                          ? `filled @ ${fmt(parseFloat(o.filledPrice), o.symbol.digits)}`
                          : o.requestedPrice
                            ? `@ ${fmt(parseFloat(o.requestedPrice), o.symbol.digits)}`
                            : "";
                      return (
                        <div className="simple-row" key={o.id}>
                          <div className="simple-left">
                            <span className="pos-symbol">{o.symbol.name}</span>
                            <span className={`pos-side ${o.side === "BUY" ? "buy" : "sell"}`}>
                              {o.type} {o.side} {parseFloat(o.volume).toFixed(2)}
                            </span>
                            <span className="net-pos-detail mono">{priceLabel}</span>
                            {o.status === "REJECTED" && o.rejectionReason ? (
                              <span className="net-pos-detail">{o.rejectionReason}</span>
                            ) : null}
                            <span className="net-pos-detail">{new Date(o.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                          <div className="simple-right">
                            <span className="mono" style={{ color: statusColor, fontSize: 12 }}>{o.status}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}

              {activeBottomTab === "history" ? (
                <div className="panel-body">
                  <div className="history-toolbar">
                    <select className="history-period-select" value={histPeriod} onChange={(e) => selectHistPeriod(e.target.value)}>
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
                  {historyRows.length === 0 ? (
                    <div className="empty-state">No history yet</div>
                  ) : (
                    <>
                      <div className="history-table-header">
                        <span>ID</span><span>Symbol</span><span>Type</span><span>Lots</span><span>Open</span><span>Close</span><span>Opened</span><span>Closed</span><span>Swap</span><span>Commission</span><span>Profit</span>
                      </div>
                      {historyRows.map((row) => {
                        if (row.kind === "trade") {
                          const h = row.trade;
                          const pnl = h.realizedPnl ? parseFloat(h.realizedPnl) : 0;
                          return (
                            <div className="history-row" key={h.id}>
                              <span className="pos-cell mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{h.id.slice(-8)}</span>
                              <span className="pos-cell pos-symbol">{h.symbol.name}</span>
                              <span className="pos-cell"><span className={`pos-side ${h.side.toLowerCase()}`}>{h.side === "BUY" ? "Buy" : "Sell"}</span></span>
                              <span className="pos-cell mono">{parseFloat(h.volume).toFixed(2)}</span>
                              <span className="pos-cell mono">{fmt(parseFloat(h.openPrice), h.symbol.digits)}</span>
                              <span className="pos-cell mono">{h.closePrice ? fmt(parseFloat(h.closePrice), h.symbol.digits) : "—"}</span>
                              <span className="pos-cell" style={{ color: "var(--text-3)", fontSize: 11 }}>{new Date(h.openedAt).toLocaleDateString([], { month: "short", day: "numeric" })} {new Date(h.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                              <span className="pos-cell" style={{ color: "var(--text-3)", fontSize: 11 }}>{h.closedAt ? `${new Date(h.closedAt).toLocaleDateString([], { month: "short", day: "numeric" })} ${new Date(h.closedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "—"}</span>
                              <span className="pos-cell pos-swap mono">{parseFloat(h.swap) >= 0 ? "+" : ""}{parseFloat(h.swap).toFixed(2)}</span>
                              <span className="pos-cell pos-commission mono">{parseFloat(h.commission).toFixed(2)}</span>
                              <span className={`pos-cell pos-pnl mono ${pnl >= 0 ? "pos" : "neg"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</span>
                            </div>
                          );
                        }
                        const f = row.funds;
                        const amount = parseFloat(f.amount);
                        const label = f.type === "DEPOSIT" ? "Deposit" : f.type === "WITHDRAWAL" ? "Withdrawal" : "Adjustment";
                        const when = new Date(f.createdAt);
                        return (
                          <div className="history-row" key={f.id}>
                            <span className="pos-cell mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{f.id.slice(-8)}</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" title={f.note ?? undefined}>{label}</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)", fontSize: 11 }}>{when.toLocaleDateString([], { month: "short", day: "numeric" })} {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className="pos-cell" style={{ color: "var(--text-3)" }}>—</span>
                            <span className={`pos-cell pos-pnl mono ${amount >= 0 ? "pos" : "neg"}`}>{money(amount)}</span>
                          </div>
                        );
                      })}
                    </>
                  )}
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

          {isMobileView ? null : <div className="col-resizer" onMouseDown={startResize("order")} />}

          {/* ---------- ORDER PANEL (right) ---------- */}
          <div className={`order-panel${isMobileView ? ` mobile${mobileTab === "trade" ? " mobile-active" : ""}` : ""}`}>
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
                  <input
                    className="mono"
                    style={{ width: 44, textAlign: "center" }}
                    value={volumeInput}
                    onFocus={(e) => { volumeInputFocusedRef.current = true; e.target.select(); }}
                    onBlur={() => { volumeInputFocusedRef.current = false; setVolumeInput(volume.toFixed(2)); }}
                    onChange={(e) => {
                      setVolumeInput(e.target.value);
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v > 0) setVolume(v);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
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
        </div>

        {/* ---------- MOBILE BOTTOM NAV (replaces the icon rail below
            the .mobile breakpoint) ---------- */}
        {isMobileView ? (
          <div className="mobile-nav">
            <button className={`mobile-nav-item${mobileTab === "chart" ? " active" : ""}`} onClick={() => setMobileTab("chart")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18.7 8.3 13 14l-4-4-5.3 5.3" /></svg>
              <span>Chart</span>
            </button>
            <button className={`mobile-nav-item${mobileTab === "trade" ? " active" : ""}`} onClick={() => setMobileTab("trade")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20" /></svg>
              <span>Trade</span>
            </button>
            <button className={`mobile-nav-item${mobileTab === "positions" ? " active" : ""}`} onClick={() => setMobileTab("positions")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
              <span>Positions{acctPositions.length > 0 ? ` (${acctPositions.length})` : ""}</span>
            </button>
            <button className={`mobile-nav-item${mobileTab === "watchlist" ? " active" : ""}`} onClick={() => setMobileTab("watchlist")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>
              <span>Watchlist</span>
            </button>
          </div>
        ) : null}

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
                <div className="field">
                  <span className="field-label">Order type</span>
                  <select className="mono" value={quickOrderType} onChange={(e) => setQuickOrderType(e.target.value as "MARKET" | PendingType)}>
                    <option value="MARKET">Market</option>
                    <option value="buy_limit">Buy Limit</option>
                    <option value="sell_limit">Sell Limit</option>
                    <option value="buy_stop">Buy Stop</option>
                    <option value="sell_stop">Sell Stop</option>
                  </select>
                </div>
                <div className="field"><span className="field-label">Volume</span><input className="mono" style={{ width: 70 }} value={quickOrderVolume} onChange={(e) => setQuickOrderVolume(e.target.value)} /></div>
                {quickOrderType === "MARKET" ? (
                  <div className="field"><span className="field-label">Risk %</span><input className="mono" style={{ width: 70 }} placeholder="—" value={quickOrderRisk} onChange={(e) => setQuickOrderRisk(e.target.value)} /></div>
                ) : (
                  <div className="field"><span className="field-label">Price</span><input className="mono" style={{ width: 90 }} placeholder={pendingPriceRuleText(quickOrderType)} value={quickOrderPrice} onChange={(e) => setQuickOrderPrice(e.target.value)} /></div>
                )}
                <div className="field"><span className="field-label">Stop loss</span><input className="mono" placeholder="—" value={quickOrderSl} onChange={(e) => setQuickOrderSl(e.target.value)} /></div>
                <div className="field"><span className="field-label">Take profit</span><input className="mono" placeholder="—" value={quickOrderTp} onChange={(e) => setQuickOrderTp(e.target.value)} /></div>
                <div className="field"><span className="field-label">Comment</span><input className="mono" style={{ width: 110 }} placeholder="Optional" value={quickOrderComment} onChange={(e) => setQuickOrderComment(e.target.value)} /></div>
              </div>
              {quickOrderType === "MARKET" ? (
                <div className="oc-row" style={{ marginBottom: 0 }}>
                  <button className="buysell-btn buy" disabled={!market[quickOrder.symbol].live} onClick={() => submitQuickOrder("BUY")}>Buy</button>
                  <button className="buysell-btn sell" disabled={!market[quickOrder.symbol].live} onClick={() => submitQuickOrder("SELL")}>Sell</button>
                </div>
              ) : (
                <div className="oc-row" style={{ marginBottom: 0 }}>
                  <button
                    className={`buysell-btn ${quickOrderType.startsWith("buy") ? "buy" : "sell"}`}
                    disabled={!market[quickOrder.symbol].live}
                    onClick={() => submitQuickPendingOrder(quickOrderType)}
                  >
                    Place {quickOrderType.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </button>
                </div>
              )}
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
                <div className="share-logo">
                  {brokerLogoUrl ? <img src={brokerLogoUrl} alt={brokerName} className="share-logo-img" /> : brokerName}
                </div>
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
              <div className="share-footer">Trade with {brokerName}</div>
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

      {/* ---------- Security: 2FA + active sessions ---------- */}
      {securityModalOpen ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setSecurityModalOpen(false); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setSecurityModalOpen(false)}>✕</button>
            <div className="generic-modal-card" style={{ width: 420 }}>
              <div className="generic-modal-title">Security</div>

              <div style={{ marginTop: 4, marginBottom: 4, fontSize: 11, color: "var(--text-3)", textTransform: "uppercase" }}>
                Two-factor authentication
              </div>
              {account?.twoFactorEnabled ? (
                <form onSubmit={disableTwoFactorSubmit}>
                  <p style={{ fontSize: 12, color: "var(--text-3)", margin: "0 0 8px" }}>
                    Enabled. Enter your password to turn it off.
                  </p>
                  <input
                    className="generic-modal-input mono"
                    type="password"
                    placeholder="Password"
                    value={tfaDisablePassword}
                    onChange={(e) => setTfaDisablePassword(e.target.value)}
                    required
                    style={{ marginBottom: 8 }}
                  />
                  <button type="submit" className="modal-btn secondary" disabled={tfaBusy}>{tfaBusy ? "Working…" : "Disable 2FA"}</button>
                </form>
              ) : tfaSetupData ? (
                <form onSubmit={confirmTwoFactorSetup}>
                  <p style={{ fontSize: 12, color: "var(--text-3)", margin: "0 0 8px" }}>
                    Scan this with your authenticator app, or enter the key manually, then confirm with a code.
                  </p>
                  <div style={{ display: "flex", justifyContent: "center", margin: "0 0 8px" }}>
                    <img src={tfaSetupData.qrCodeDataUri} alt="2FA setup QR code" width={160} height={160} style={{ borderRadius: 6 }} />
                  </div>
                  <p className="mono" style={{ fontSize: 11, color: "var(--text-3)", wordBreak: "break-all", textAlign: "center", margin: "0 0 10px" }}>
                    {tfaSetupData.secret}
                  </p>
                  <input
                    className="generic-modal-input mono"
                    inputMode="numeric"
                    placeholder="123456"
                    maxLength={6}
                    value={tfaConfirmCode}
                    onChange={(e) => setTfaConfirmCode(e.target.value.replace(/\D/g, ""))}
                    required
                    style={{ marginBottom: 8, textAlign: "center", letterSpacing: 4 }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="modal-btn secondary" onClick={() => setTfaSetupData(null)}>Cancel</button>
                    <button type="submit" className="modal-btn primary" disabled={tfaBusy || tfaConfirmCode.length !== 6}>
                      {tfaBusy ? "Confirming…" : "Confirm"}
                    </button>
                  </div>
                </form>
              ) : (
                <div>
                  <p style={{ fontSize: 12, color: "var(--text-3)", margin: "0 0 8px" }}>
                    Not enabled. Adds a 6-digit code from an authenticator app to sign-in.
                  </p>
                  <button type="button" className="modal-btn primary" onClick={startTwoFactorSetup} disabled={tfaBusy}>
                    {tfaBusy ? "Working…" : "Enable 2FA"}
                  </button>
                </div>
              )}
              {tfaError ? <p style={{ color: "var(--sell)", fontSize: 12, margin: "8px 0 0" }}>{tfaError}</p> : null}

              <div style={{ marginTop: 20, marginBottom: 4, fontSize: 11, color: "var(--text-3)", textTransform: "uppercase" }}>
                Active sessions
              </div>
              {sessions === null ? (
                <p style={{ fontSize: 12, color: "var(--text-3)" }}>Loading…</p>
              ) : sessions.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--text-3)" }}>No other active sessions found.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {sessions.map((s) => (
                    <div
                      key={s.sessionId}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-2, transparent)" }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: "var(--text-1)" }}>
                          {s.userAgent ? s.userAgent.slice(0, 48) : "Unknown device"}
                          {s.current ? <span style={{ color: "var(--buy)", marginLeft: 6, fontSize: 11 }}>(this device)</span> : null}
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                          {s.ip ?? "unknown IP"} · {new Date(s.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="modal-btn secondary"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        disabled={revokingSessionId === s.sessionId}
                        onClick={() => revokeSessionRow(s)}
                      >
                        {revokingSessionId === s.sessionId ? "…" : s.current ? "Log out" : "Revoke"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button type="button" className="modal-btn secondary" onClick={() => setSecurityModalOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Account Selector: switch-account password confirm ---------- */}
      {switchTarget ? (
        <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) setSwitchTarget(null); }}>
          <div className="modal-wrap">
            <button className="modal-close" onClick={() => setSwitchTarget(null)}>✕</button>
            {switchPendingToken ? (
              <form className="generic-modal-card" onSubmit={submitSwitchTwoFactor}>
                <div className="generic-modal-title">Two-factor verification</div>
                <p style={{ fontSize: 12, color: "var(--text-3)", margin: "0 0 10px" }}>
                  Enter the 6-digit code for {switchTarget.accountNumber}&apos;s authenticator app.
                </p>
                <input
                  className="generic-modal-input mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  autoFocus
                  maxLength={6}
                  value={switchTwoFactorCode}
                  onChange={(e) => setSwitchTwoFactorCode(e.target.value.replace(/\D/g, ""))}
                  required
                />
                {switchError ? <p style={{ color: "var(--sell)", fontSize: 12, margin: "8px 0 0" }}>{switchError}</p> : null}
                <div className="modal-actions" style={{ marginTop: 16 }}>
                  <button type="button" className="modal-btn secondary" onClick={() => setSwitchTarget(null)}>Cancel</button>
                  <button type="submit" className="modal-btn primary" disabled={switching || switchTwoFactorCode.length !== 6}>
                    {switching ? "Verifying…" : "Verify"}
                  </button>
                </div>
              </form>
            ) : (
              <form className="generic-modal-card" onSubmit={submitAccountSwitch}>
                <div className="generic-modal-title">Switch to {switchTarget.accountNumber}</div>
                <p style={{ fontSize: 12, color: "var(--text-3)", margin: "0 0 10px" }}>
                  Confirm the password for this account — switching replaces your current session.
                </p>
                <input
                  className="generic-modal-input mono"
                  type="password"
                  placeholder="Password"
                  autoFocus
                  value={switchPassword}
                  onChange={(e) => setSwitchPassword(e.target.value)}
                  required
                />
                {switchError ? <p style={{ color: "var(--sell)", fontSize: 12, margin: "8px 0 0" }}>{switchError}</p> : null}
                <div className="modal-actions" style={{ marginTop: 16 }}>
                  <button type="button" className="modal-btn secondary" onClick={() => setSwitchTarget(null)}>Cancel</button>
                  <button type="submit" className="modal-btn primary" disabled={switching}>{switching ? "Switching…" : "Switch"}</button>
                </div>
              </form>
            )}
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
                        <span>
                          {r.type === "DEPOSIT" ? "Deposit" : r.type === "WITHDRAWAL" ? "Withdrawal" : "Adjustment"}
                          {r.type === "ADJUSTMENT" && r.note ? <span style={{ color: "var(--text-3)" }}> — {r.note}</span> : null}
                        </span>
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

      <div className={`toast${toasts[toasts.length - 1]?.retry ? " has-retry" : ""}`} style={{ opacity: toasts.length > 0 ? 1 : 0 }}>
        {toasts[toasts.length - 1]?.message ?? ""}
        {toasts[toasts.length - 1]?.retry ? (
          <button
            className="toast-retry-btn"
            onClick={() => {
              const t = toasts[toasts.length - 1];
              t?.retry?.();
              setToasts((prev) => prev.filter((x) => x.id !== t?.id));
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
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
