// Thin fetch wrapper for the /api/trade/* routes used by the WebTrader
// client component. Every call relies on the httpOnly session cookie for
// auth — no tokens handled in JS.

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `request to ${path} failed (${response.status})`);
  }
  return body as T;
}

// Same as call(), minus the forced JSON content-type -- a FormData body
// needs the browser to set its own multipart boundary, which an
// explicit Content-Type header would override and break.
async function callForm<T>(path: string, body: FormData): Promise<T> {
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
  symbol: { name: string; digits: number };
};

export type ApiFundsRequest = {
  id: string;
  type: "DEPOSIT" | "WITHDRAWAL";
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

export const tradeApi = {
  me: () => call<AccountInfo>("/api/trade/me"),
  prices: () => call<ApiLivePrice[]>("/api/trade/prices"),
  candles: (symbol: string, tf: ApiCandleTimeframe) =>
    call<ApiCandle[]>(`/api/trade/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`),
  positions: () => call<ApiPosition[]>("/api/trade/positions"),
  orders: () => call<ApiOrder[]>("/api/trade/orders"),
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
  }) =>
    // No `position` key when dealing mode queued the order for manual
    // dealer review instead of auto-filling -- see
    // app/api/trade/orders/route.ts's dealingModeAt branch.
    call<{ order: { id: string }; position?: { id: string } }>("/api/trade/orders", { method: "POST", body: JSON.stringify(body) }),
  cancelOrder: (id: string) => call(`/api/trade/orders/${id}`, { method: "DELETE" }),
  fillOrder: (id: string, price: number) =>
    call(`/api/trade/orders/${id}/fill`, { method: "POST", body: JSON.stringify({ price }) }),
  editPositionSlTp: (
    id: string,
    body: { currentPrice: number; slPrice?: number | null; tpPrice?: number | null }
  ) => call(`/api/trade/positions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  closePosition: (id: string, closePrice: number, volume?: number) =>
    call(`/api/trade/positions/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ closePrice, ...(volume != null ? { volume } : {}) }),
    }),
  fundsHistory: () => call<ApiFundsRequest[]>("/api/trade/funds-requests"),
  submitFundsRequest: (body: { type: "DEPOSIT" | "WITHDRAWAL"; amount: number; note?: string }) =>
    call<ApiFundsRequest>("/api/trade/funds-requests", { method: "POST", body: JSON.stringify(body) }),
  kycStatus: () => call<ApiKycStatus>("/api/trade/kyc"),
  submitKyc: (documentType: string, front: File, back: File) => {
    const form = new FormData();
    form.set("documentType", documentType);
    form.set("front", front);
    form.set("back", back);
    return callForm<{ status: string; documentType: string }>("/api/trade/kyc", form);
  },
  login: (accountNumber: string, password: string) =>
    call("/api/trade/login", { method: "POST", body: JSON.stringify({ accountNumber, password }) }),
  logout: () => call("/api/trade/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call("/api/trade/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
};
