import type { Order } from "@prisma/client";

// Per-order execution capture (Batch D, owner 2026-10-21): what the backoffice execution detail shows for an order. The
// columns are on Order (prisma/schema.prisma); this module derives the request side (who asked, from where, on what) and
// shapes the detail. Orders written before the capture carry nulls and the detail simply leaves those fields out.

type HeaderBag = { get(name: string): string | null };

export type RequestMeta = { requestedAt: Date; clientIp: string | null; platform: string };

/// The caller's IP. Only the headers Vercel's edge sets from the connecting peer (x-real-ip, x-vercel-forwarded-for) are
/// trusted: they overwrite whatever the client sent, x-forwarded-for's first hop does not (lib/demo.ts clientIpOf).
export function clientIp(h: HeaderBag): string | null {
  const raw = (h.get("x-real-ip") ?? h.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  if (!raw) return null;
  return /^[0-9a-f:.]{2,45}$/i.test(raw) ? raw : null;
}

/// "Windows terminal 1.0.93" | "Windows backoffice 1.0.89" | "Mobile" | "WebTrader" | "API" (+ the caller's product token).
/// The native apps send no User-Agent: they identify by X-Client-Platform and their build id
/// ("<slug>-terminal-1.0.93-<hash>"). The mobile app sends X-Client-Platform: MOBILE and no version yet.
export function platformOf(h: HeaderBag): string {
  const platform = h.get("x-client-platform");
  const build = (h.get("x-client-build") ?? "").trim();
  if (platform === "DESKTOP_NATIVE") {
    const m = /-(terminal|backoffice)-(\d+\.\d+\.\d+)(?:-|$)/.exec(build);
    if (m) return `Windows ${m[1]} ${m[2]}`;
    return build.startsWith("dev") ? "Windows terminal (dev build)" : "Windows terminal";
  }
  if (platform === "MOBILE") {
    const v = (h.get("x-client-version") ?? "").trim();
    return /^\d+(\.\d+){0,3}$/.test(v) ? `Mobile ${v}` : "Mobile";
  }
  if (platform === "API") {
    const product = (h.get("user-agent") ?? "").trim().split(/\s+/)[0] ?? "";
    return product ? `API (${product.slice(0, 60)})` : "API";
  }
  return "WebTrader";
}

/// The request side of an order, read once at the top of the route (requestedAt = when the request arrived).
export function requestMeta(h: HeaderBag, requestedAt: Date = new Date()): RequestMeta {
  return { requestedAt, clientIp: clientIp(h), platform: platformOf(h) };
}

/// A staff-made order (backoffice): the staff member's IP and app, never the client's.
export function staffRequestMeta(h: HeaderBag, requestedAt: Date = new Date()): RequestMeta {
  const p = platformOf(h);
  return { requestedAt, clientIp: clientIp(h), platform: p.startsWith("Windows backoffice") ? p : "Backoffice" };
}

export type ExecutionMode = "AUTO" | "DEALER";
/// The book an order is routed to: the account group's book, or LP for a coverage hedge sent to the liquidity provider.
export type Routing = "A_BOOK" | "B_BOOK" | "LP";

type ExecOrder = Pick<Order, "requestedAt" | "executedAt" | "clientIp" | "platform" | "routing" | "executionMode" | "requestedPrice" | "filledPrice" | "status" | "rejectionReason" | "ticket" | "type" | "source">;

/// The execution detail of one order for the backoffice (GET /api/manage/deals `openExecution` / `closeExecution`). A
/// field the server does not have is left OUT (never null, never a placeholder), so the client shows a row only when the
/// field is present. Prices are strings at the symbol's digits; latencyMs = executedAt - requestedAt.
export function executionDetail(o: ExecOrder, digits: number) {
  const out: Record<string, string | number> = { orderTicket: o.ticket, orderType: o.type, status: o.status };
  if (o.source) out.source = o.source;
  if (o.requestedAt) out.requestedAt = o.requestedAt.toISOString();
  if (o.executedAt) out.executedAt = o.executedAt.toISOString();
  if (o.requestedAt && o.executedAt) out.latencyMs = Math.max(0, o.executedAt.getTime() - o.requestedAt.getTime());
  if (o.requestedPrice) out.requestedPrice = o.requestedPrice.toFixed(digits);
  if (o.filledPrice) out.filledPrice = o.filledPrice.toFixed(digits);
  if (o.clientIp) out.clientIp = o.clientIp;
  if (o.platform) out.platform = o.platform;
  if (o.routing) out.routing = o.routing;
  if (o.executionMode) out.executionMode = o.executionMode;
  if (o.rejectionReason) out.rejectReason = o.rejectionReason;
  return out;
}
