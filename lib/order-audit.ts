import type { Prisma } from "@prisma/client";

function asPlainObject(v: Prisma.JsonValue | null): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Broker feedback items 14+15 -- every order-lifecycle AuditLog row must
// let a broker answer "what order was this, whose account, what side/
// size" straight from the log, without cross-referencing anything else.
// Order.id doubles as "order number" here -- there's no separate
// sequential field on Order (see prisma/schema.prisma), and no other part
// of the app has ever invented one (positions display their own "ID" the
// same way, via `.slice(-8)`), so reusing the id is the only consistent
// choice. Spread into every order/position AuditLog's oldValue/newValue
// alongside whatever fields are specific to that event.
export function orderAuditFields(
  order: { id: string; side: string; type: string; volume: Prisma.Decimal | string },
  symbol: string,
  accountNumber: string
) {
  return {
    orderNumber: order.id,
    accountNumber,
    symbol,
    side: order.side,
    type: order.type,
    lots: order.volume.toString(),
  };
}

// Broker feedback items 14+15's trader-visible half -- the "Logs" tab
// (components/webtrader/WebTrader.tsx) previously only showed ephemeral,
// session-local messages (connection status, toasts from this browser
// tab) that vanish on reload. This turns the same persisted AuditLog rows
// the backoffice audit page reads into one human-readable line each, so a
// trader (or support looking at their screen) can see real prices for
// their own order history after a reload, not just "connection restored."
// Returns null for an action this Logs tab has no sensible line for yet
// (defensive -- new order-lifecycle actions should be added here as they
// appear, but a missing one should just be silently skipped, not crash).
export function describeOrderAuditEvent(action: string, oldValue: Prisma.JsonValue | null, newValue: Prisma.JsonValue | null): string | null {
  const before = asPlainObject(oldValue);
  const after = asPlainObject(newValue);
  const orderNumber = (after.orderNumber ?? before.orderNumber) as string | undefined;
  const symbol = (after.symbol ?? before.symbol) as string | undefined;
  const side = (after.side ?? before.side) as string | undefined;
  const lots = (after.lots ?? before.lots) as string | undefined;
  const tag = orderNumber ? `#${orderNumber.slice(-8)}` : "";
  const desc = symbol && side && lots ? `${symbol} ${side} ${lots} ${tag}`.trim() : tag;

  switch (action) {
    case "ORDER_PLACED": {
      const parts = [`Order placed: ${desc}`];
      if (after.requestedPrice) parts.push(`@ ${after.requestedPrice}`);
      if (after.slPrice) parts.push(`SL ${after.slPrice}`);
      if (after.tpPrice) parts.push(`TP ${after.tpPrice}`);
      return parts.join(" ");
    }
    case "ORDER_MODIFIED": {
      const changes: string[] = [];
      for (const key of ["requestedPrice", "slPrice", "tpPrice"]) {
        if (key in after) changes.push(`${key} ${before[key] ?? "—"} → ${after[key]}`);
      }
      return `Order modified: ${desc}${changes.length ? " — " + changes.join(", ") : ""}`;
    }
    case "TRADER_CANCELLED_DEALING_ORDER":
    case "TRADER_CANCELLED_PENDING_ORDER":
      return `Order cancelled: ${desc}`;
    case "DEALING_ORDER_REJECTED":
    case "DEALING_ORDER_AUTO_REJECTED":
      return `Order rejected: ${desc}${after.reason ? ` — ${after.reason}` : ""}`;
    case "DEALING_ORDER_REQUOTED":
      return `Dealer requoted ${desc} @ ${after.requotedPrice}`;
    case "DEALING_ORDER_REQUOTE_ACCEPTED":
      return `Requote accepted: ${desc} filled @ ${after.filledPrice}`;
    case "DEALING_ORDER_REQUOTE_REJECTED":
      return `Requote rejected: ${desc}`;
    case "DEALING_ORDER_ACCEPTED":
    case "DEALING_ORDER_AUTO_ACCEPTED":
    case "ORDER_FILLED":
      return `Order filled: ${desc} @ ${after.filledPrice}`;
    case "ORDER_TRIGGERED_AND_FILLED":
      return `Pending order triggered: ${desc} @ ${after.filledPrice} (requested ${before.requestedPrice ?? "—"})`;
    case "PENDING_ORDER_QUEUED_FOR_DEALING":
      return `Order queued for dealer review: ${desc} (triggered @ ${after.triggerPrice})`;
    default:
      return null;
  }
}
