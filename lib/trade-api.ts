// Thin fetch wrapper for the /api/trade/* routes used by the WebTrader
// client component. Every call relies on the httpOnly session cookie for
// auth — no tokens handled in JS.

// The trader's own system clock, used nowhere near auth but relied on by
// components/webtrader's client-side candle bucketing (lib/market-
// simulator.ts's applyBidAsk) to decide when a new candle starts. A
// skewed local clock silently misaligned live candles against the real,
// server-seeded history the moment the two met -- reported live as
// candles looking "torn." Every response carries a standard HTTP `Date`
// header for free; recalibrating from it on every single API call (this
// app polls every ~2s) keeps the correction current without a dedicated
// endpoint or a background timer of its own.
let serverTimeOffsetMs = 0;
export function serverNow(): number {
  return Date.now() + serverTimeOffsetMs;
}
function recalibrateFromDateHeader(header: string | null | undefined) {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isFinite(serverMs)) serverTimeOffsetMs = serverMs - Date.now();
}
function recalibrateFromResponse(response: Response) {
  recalibrateFromDateHeader(response.headers.get("date"));
}

// A bundled desktop shell's own fetch()/WebSocket can't carry the
// broker's httpOnly session cookie across the local-content/real-host
// origin boundary -- window.vyxDesktop.apiCall (desktop-tauri's Rust
// api_request command, a persistent cookie-jar-backed reqwest::Client)
// is the transport instead, when present. Every /api/trade/* route is
// unchanged either way -- this is a transport swap, not a protocol one.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const desktop = typeof window !== "undefined" ? window.vyxDesktop : undefined;
  if (desktop?.apiCall) {
    const parsedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const { status, body, date } = await desktop.apiCall(path, init?.method ?? "GET", parsedBody);
    recalibrateFromDateHeader(date);
    if (status < 200 || status >= 300) {
      throw new Error((body as { error?: string } | null)?.error ?? `request to ${path} failed (${status})`);
    }
    return body as T;
  }

  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  recalibrateFromResponse(response);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `request to ${path} failed (${response.status})`);
  }
  return body as T;
}

// btoa() only accepts a binary string, not raw bytes -- chunked to avoid
// blowing the call stack on String.fromCharCode(...bytes) for a
// multi-megabyte KYC document image.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Same as call(), minus the forced JSON content-type -- a FormData body
// needs the browser to set its own multipart boundary, which an
// explicit Content-Type header would override and break. The desktop
// path can't hand a browser FormData/File object to Rust at all, so it
// re-encodes each part as a plain JSON-safe field first -- see
// window.vyxDesktop.apiCallMultipart's own doc comment.
async function callForm<T>(path: string, body: FormData): Promise<T> {
  const desktop = typeof window !== "undefined" ? window.vyxDesktop : undefined;
  if (desktop?.apiCallMultipart) {
    const fields: Array<
      | { name: string; value: string }
      | { name: string; file: { filename: string; mime: string; dataBase64: string } }
    > = [];
    for (const [name, value] of body.entries()) {
      if (value instanceof File) {
        const dataBase64 = arrayBufferToBase64(await value.arrayBuffer());
        fields.push({ name, file: { filename: value.name, mime: value.type || "application/octet-stream", dataBase64 } });
      } else {
        fields.push({ name, value });
      }
    }
    const { status, body: responseBody } = await desktop.apiCallMultipart(path, fields);
    if (status < 200 || status >= 300) {
      throw new Error((responseBody as { error?: string } | null)?.error ?? `request to ${path} failed (${status})`);
    }
    return responseBody as T;
  }

  const response = await fetch(path, { method: "POST", body });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(responseBody?.error ?? `request to ${path} failed (${response.status})`);
  }
  return responseBody as T;
}

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

export type ApiLivePrice = { symbol: string; bid: string; ask: string; updatedAt: string };

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

export type ApiBrokerBranding = { brokerName: string; brokerLogoUrl: string; supportEmail: string | null };

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
  login: (accountNumber: string, password: string, accountType?: "LIVE" | "DEMO") =>
    call<{ accountId: string; accountNumber: string; accountType: string } | { requiresTwoFactor: true; pendingToken: string }>(
      "/api/trade/login",
      { method: "POST", body: JSON.stringify({ accountNumber, password, accountType }) }
    ),
  verifyTwoFactor: (pendingToken: string, code: string) =>
    call<{ accountId: string; accountNumber: string; accountType: string }>("/api/trade/login/verify-2fa", {
      method: "POST",
      body: JSON.stringify({ pendingToken, code }),
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
};
