// Thin fetch wrapper for the /api/trade/* routes used by the WebTrader
// client component. Every call relies on the httpOnly session cookie for
// auth — no tokens handled in JS. Transport (fetch() vs. a bundled
// desktop shell's window.vyxDesktop bridge) lives in lib/desktop-api.ts,
// shared with manager-shell/admin-shell's own API wrappers.
import { apiCall as call, apiCallForm as callForm, serverNow, ApiError } from "./desktop-api";
import type { SymbolCategory } from "./market-simulator";
import type { ChartSettings } from "./chart-settings";
export { serverNow, ApiError };

export type AccountInfo = {
  id: string;
  accountNumber: string;
  accountType: "DEMO" | "LIVE";
  currency: string;
  leverage: number;
  balance: string;
  credit: string;
  status: string;
  fullName: string;
  twoFactorEnabled: boolean;
};

export type ApiSession = {
  sessionId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
};

export type ApiPosition = {
  id: string;
  side: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  slPrice: string | null;
  tpPrice: string | null;
  closePrice: string | null;
  realizedPnl: string | null;
  swap: string;
  commission: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  symbol: { name: string; digits: number; contractSize?: string };
};

// tickAt is the real last-tick time (see LivePrice.tickAt's own schema
// comment) -- what feedStatusFor's staleness clock should read, not
// updatedAt (row-write time, bumped on every heartbeat resend regardless
// of whether the price actually changed).
export type ApiLivePrice = { symbol: string; bid: string; ask: string; updatedAt: string; tickAt: string; marketClosed: boolean };

export type ApiCandleTimeframe = "M1" | "M5" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1" | "Y1";

export type ApiCandle = {
  symbol: string;
  timeframe: ApiCandleTimeframe;
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
};

export type ApiOrder = {
  id: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP";
  volume: string;
  requestedPrice: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  status: string;
  filledPrice: string | null;
  rejectionReason: string | null;
  requotedPrice: string | null;
  createdAt: string;
  symbol: { name: string; digits: number };
};

export type ApiFundsRequest = {
  id: string;
  // ADJUSTMENT = a staff-initiated balance change (Manager backoffice's
  // "Adjust Balance"), not something the trader submitted themselves --
  // included here so it's visible at all (see the route's own comment).
  type: "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT";
  status: "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED";
  amount: string;
  note: string | null;
  createdAt: string;
};

export type ApiKycStatus = {
  status: "PENDING" | "APPROVED" | "REJECTED";
  documentType: string;
  rejectionReason: string | null;
  createdAt: string;
} | null;

export type ApiLinkedAccount = {
  accountNumber: string;
  accountType: "DEMO" | "LIVE";
  currency: string;
  balance: string;
};

export type ApiBrokerBranding = { brokerName: string; brokerLogoUrl: string; supportEmail: string | null; primaryColor: string | null };

export type ApiWatchlistSymbol = { id: string; name: string; category: SymbolCategory; digits: number; contractSize: string; stopLevel?: number };

// Phase 1 trust pack §3 -- real, server-evaluated price alerts (see
// PriceAlert's own schema comment). Replaces the old client-side-only
// mock entirely.
export type ApiAlert = {
  id: string;
  symbol: string;
  condition: "ABOVE" | "BELOW" | "CROSSES";
  price: string;
  status: "ACTIVE" | "TRIGGERED" | "EXPIRED" | "CANCELLED";
  triggeredAt: string | null;
  triggeredPrice: string | null;
  createdAt: string;
};

export const tradeApi = {
  // Public, no session needed -- see app/api/trade/broker-branding/
  // route.ts. Only meaningful for a bundled desktop shell, which has no
  // Server Component of its own to inject this the way the website does;
  // unused by the website itself (app/(broker)/trade/page.tsx already
  // gets this server-side).
  brokerBranding: () => call<ApiBrokerBranding>("/api/trade/broker-branding"),
  me: () => call<AccountInfo>("/api/trade/me"),
  prices: () => call<ApiLivePrice[]>("/api/trade/prices"),
  candles: (symbol: string, tf: ApiCandleTimeframe) =>
    call<ApiCandle[]>(`/api/trade/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`),
  positions: () => call<ApiPosition[]>("/api/trade/positions"),
  orders: () => call<ApiOrder[]>("/api/trade/orders"),
  // Full order-lifecycle view (docs/webtrader-stm-architecture-review.md
  // §4.5) -- includes FILLED/REJECTED/CANCELLED, not just what's
  // currently pending/requoted, unlike orders() above.
  allOrders: () => call<ApiOrder[]>("/api/trade/orders?status=all"),
  history: (params: { from?: string; to?: string; symbol?: string }) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.symbol) qs.set("symbol", params.symbol);
    return call<ApiPosition[]>(`/api/trade/history?${qs.toString()}`);
  },
  placeOrder: (body: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT" | "STOP";
    volume: number;
    price: number;
    slPrice?: number | null;
    tpPrice?: number | null;
    // Optional -- see lib/risk.ts's checkSlippage. Omitted by every
    // current caller, which falls back to the server's default tolerance.
    maxSlippagePips?: number;
    idempotencyKey: string;
    // Informational only (see app/api/trade/orders/route.ts) -- flags
    // this order for the STM_HOTKEY_ORDER audit trail, doesn't change
    // validation/execution.
    source?: "hotkey";
  }) =>
    // No `position` key when dealing mode queued the order for manual
    // dealer review instead of auto-filling -- see
    // app/api/trade/orders/route.ts's dealingModeAt branch.
    call<{ order: { id: string }; position?: { id: string } }>("/api/trade/orders", { method: "POST", body: JSON.stringify(body) }),
  cancelOrder: (id: string) => call(`/api/trade/orders/${id}`, { method: "DELETE" }),
  // Draggable entry-price line for a resting LIMIT/STOP order (chart
  // interaction pack). `currentPrice` is the client's own live price, same
  // reference-price pattern editPositionSlTp already uses below.
  editOrderPrice: (id: string, body: { currentPrice: number; requestedPrice: number }) =>
    call<ApiOrder>(`/api/trade/orders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  fillOrder: (id: string, price: number) =>
    call(`/api/trade/orders/${id}/fill`, { method: "POST", body: JSON.stringify({ price }) }),
  requoteResponse: (id: string, accept: boolean) =>
    call(`/api/trade/orders/${id}/requote-response`, { method: "POST", body: JSON.stringify({ accept }) }),
  editPositionSlTp: (
    id: string,
    body: { currentPrice: number; slPrice?: number | null; tpPrice?: number | null }
  ) => call(`/api/trade/positions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  // `source: "stm_bulk"` is informational only (see
  // app/api/trade/positions/[id]/close/route.ts) -- flags this close for
  // the STM_BULK_CLOSE audit trail, doesn't change validation/execution.
  closePosition: (id: string, closePrice: number, volume?: number, source?: "stm_bulk") =>
    call(`/api/trade/positions/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ closePrice, ...(volume != null ? { volume } : {}), ...(source ? { source } : {}) }),
    }),
  // One request, one server-side transaction, one price snapshot per
  // symbol -- see lib/bulk-close.ts. Replaces WebTrader.tsx's old
  // closeManyBy/closeManyBySymbol, which fired one closePosition() call
  // per position sequentially.
  closeBulk: (scope: "ALL" | "PROFIT" | "LOSS" | "SYMBOL", symbol?: string) =>
    call<{ requested: number; successful: number; failed: number; results: { positionId: string; closed: boolean; closePrice: string | null; realizedPnl: string | null; error: string | null }[] }>(
      "/api/trade/positions/close-bulk",
      { method: "POST", body: JSON.stringify({ scope, ...(symbol ? { symbol } : {}) }) }
    ),
  // Default (active only) / ?status=all (history, incl. triggered/
  // cancelled) -- same convention as orders()/allOrders().
  alerts: () => call<ApiAlert[]>("/api/trade/alerts"),
  allAlerts: () => call<ApiAlert[]>("/api/trade/alerts?status=all"),
  createAlert: (body: { symbol: string; condition: "ABOVE" | "BELOW" | "CROSSES"; price: number; expiresAt?: string }) =>
    call<ApiAlert>("/api/trade/alerts", { method: "POST", body: JSON.stringify(body) }),
  cancelAlert: (id: string) => call(`/api/trade/alerts/${id}`, { method: "DELETE" }),
  fundsHistory: () => call<ApiFundsRequest[]>("/api/trade/funds-requests"),
  submitFundsRequest: (body: { type: "DEPOSIT" | "WITHDRAWAL"; amount: number; note?: string }) =>
    call<ApiFundsRequest>("/api/trade/funds-requests", { method: "POST", body: JSON.stringify(body) }),
  kycStatus: () => call<ApiKycStatus>("/api/trade/kyc"),
  linkedAccounts: () => call<ApiLinkedAccount[]>("/api/trade/linked-accounts"),
  submitKyc: (documentType: string, front: File, back: File) => {
    const form = new FormData();
    form.set("documentType", documentType);
    form.set("front", front);
    form.set("back", back);
    return callForm<{ status: string; documentType: string }>("/api/trade/kyc", form);
  },
  // Response shape distinguishes a completed login (accountId present)
  // from a 2FA-gated one (requiresTwoFactor + pendingToken, no session
  // cookie set yet) -- see app/api/trade/login/route.ts. `accountType` is
  // optional and only meaningful from the login page's own Server
  // selector (DEMO/LIVE) -- when passed, the route rejects a mismatch
  // (e.g. a Demo account logging in against the Live "server") instead of
  // silently letting it through. The Account Selector's own call site
  // (WebTrader.tsx, switching between linked accounts) omits it entirely,
  // same as before this parameter existed.
  // `remember` (fix/realtime-sync §7) actually controls the session
  // cookie's persistence now -- see lib/account-auth.ts's
  // accountSessionCookieOptions. Defaults true (matches this form's own
  // initialRemember default) so an existing call site that never passes
  // it keeps today's always-persistent behavior.
  login: (accountNumber: string, password: string, accountType?: "LIVE" | "DEMO", remember: boolean = true) =>
    call<{ accountId: string; accountNumber: string; accountType: string } | { requiresTwoFactor: true; pendingToken: string }>(
      "/api/trade/login",
      { method: "POST", body: JSON.stringify({ accountNumber, password, accountType, remember }) }
    ),
  verifyTwoFactor: (pendingToken: string, code: string, remember: boolean = true) =>
    call<{ accountId: string; accountNumber: string; accountType: string }>("/api/trade/login/verify-2fa", {
      method: "POST",
      body: JSON.stringify({ pendingToken, code, remember }),
    }),
  logout: () => call("/api/trade/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call("/api/trade/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
  setupTwoFactor: () => call<{ secret: string; uri: string; qrCodeDataUri: string }>("/api/trade/two-factor/setup", { method: "POST" }),
  confirmTwoFactor: (code: string) =>
    call("/api/trade/two-factor/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  disableTwoFactor: (password: string) =>
    call("/api/trade/two-factor/disable", { method: "POST", body: JSON.stringify({ password }) }),
  sessions: () => call<ApiSession[]>("/api/trade/sessions"),
  revokeSession: (sessionId: string) => call(`/api/trade/sessions/${sessionId}`, { method: "DELETE" }),
  // The broker's full enabled-symbol universe (app/api/trade/symbols) --
  // replaces lib/market-simulator.ts's old hardcoded SYMBOL_DEFS as the
  // source of "what symbols exist." The watchlist itself
  // (app/api/trade/watchlist) is a separate, ordered SUBSET of this.
  symbols: () => call<{ symbols: ApiWatchlistSymbol[] }>("/api/trade/symbols"),
  // collapsedCategories -- which category headers (Forex/Metals/...) are
  // collapsed, server-persisted like the row order itself. Only the GET
  // returns it (add/hide/reset don't touch collapse state); see
  // saveWatchlistCollapsed below for writing it.
  watchlist: () => call<{ symbols: ApiWatchlistSymbol[]; collapsedCategories: SymbolCategory[] }>("/api/trade/watchlist"),
  addToWatchlist: (symbolId: string) =>
    call<{ symbols: ApiWatchlistSymbol[] }>("/api/trade/watchlist", { method: "POST", body: JSON.stringify({ symbolId }) }),
  hideFromWatchlist: (symbolId: string) => call(`/api/trade/watchlist/${symbolId}`, { method: "DELETE" }),
  resetWatchlist: () => call<{ symbols: ApiWatchlistSymbol[] }>("/api/trade/watchlist", { method: "DELETE" }),
  // Takes symbol NAMES, not ids -- see the route's own comment on why.
  reorderWatchlist: (symbolNames: string[]) =>
    call("/api/trade/watchlist/reorder", { method: "PUT", body: JSON.stringify({ symbolNames }) }),
  saveWatchlistCollapsed: (categories: SymbolCategory[]) =>
    call<{ collapsedCategories: SymbolCategory[] }>("/api/trade/watchlist/collapsed", { method: "PUT", body: JSON.stringify({ categories }) }),
  chartSettings: () => call<{ settings: ChartSettings }>("/api/trade/chart-settings"),
  saveChartSettings: (settings: ChartSettings) =>
    call<{ settings: ChartSettings }>("/api/trade/chart-settings", { method: "PUT", body: JSON.stringify(settings) }),
};
