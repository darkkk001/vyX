import "server-only";
import { Prisma } from "@prisma/client";

// Phase 1 trust pack §3 -- pure validation/limit logic extracted out of
// app/api/trade/alerts/route.ts so it's directly unit-testable (that
// route itself calls next/headers-backed session/cookie functions that
// only work inside a real Next.js request, same reason every other pure
// check in this app -- lib/risk.ts, lib/margin.ts -- lives outside its
// route file too).

export const MAX_ACTIVE_ALERTS_PER_ACCOUNT = 50;
export const ALERT_CONDITIONS = ["ABOVE", "BELOW", "CROSSES"] as const;
export type AlertConditionInput = (typeof ALERT_CONDITIONS)[number];

export type ValidatedAlertInput = {
  symbol: string;
  condition: AlertConditionInput;
  price: Prisma.Decimal;
  expiresAt: Date | null;
};

// `ok` is a literal boolean discriminant (not just an `error: string |
// null` field) so TypeScript actually narrows the union on it -- a
// caller can check `if (!result.ok)` and have `.error` available, or
// after that check, `.value` with no cast.
export type ValidateAlertResult = { ok: false; error: string } | { ok: true; value: ValidatedAlertInput };

export function validateAlertInput(body: unknown): ValidateAlertResult {
  const b = body as Record<string, unknown> | null;
  const symbol = typeof b?.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
  const condition = ALERT_CONDITIONS.includes(b?.condition as AlertConditionInput) ? (b!.condition as AlertConditionInput) : null;
  const priceRaw = b?.price != null ? String(b.price) : null;
  const expiresAtRaw = typeof b?.expiresAt === "string" ? b.expiresAt : null;

  if (!symbol || !condition || !priceRaw) {
    return { ok: false, error: "symbol, condition, and price are required" };
  }

  let price: Prisma.Decimal;
  try {
    price = new Prisma.Decimal(priceRaw);
  } catch {
    return { ok: false, error: "invalid price" };
  }
  if (price.lte(0)) {
    return { ok: false, error: "price must be positive" };
  }

  let expiresAt: Date | null = null;
  if (expiresAtRaw) {
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: "invalid expiresAt" };
    }
    expiresAt = parsed;
  }

  return { ok: true, value: { symbol, condition, price, expiresAt } };
}

// The brief's own stated limit -- checked against ACTIVE alerts only, so
// an account with a long history of old triggered/cancelled ones never
// gets blocked from setting new ones. Takes the count as a plain number
// (the caller already ran the actual COUNT query, same "count query at
// the call site, pure comparison here" split as lib/risk.ts's own
// checkMaxOpenPositions) rather than a Prisma client, so this stays a
// pure function.
export function checkActiveAlertLimit(currentActiveCount: number): string | null {
  if (currentActiveCount >= MAX_ACTIVE_ALERTS_PER_ACCOUNT) {
    return `you can have at most ${MAX_ACTIVE_ALERTS_PER_ACCOUNT} active alerts`;
  }
  return null;
}
