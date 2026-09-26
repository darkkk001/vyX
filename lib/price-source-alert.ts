import "server-only";
import { prisma } from "@/lib/prisma";

// Owner decision (2026-09-26): the web NEVER falls back to Neon's LivePrice when the engine's live-price read fails
// (that table has been frozen since 2026-09-14, when the feed's writes moved VPS-local). A failed read means "no
// price": every close, SL / TP, stop-out and pending trigger refuses to act on it -- and the broker's staff is told,
// here, instead of the platform going quietly blind.
//
// One staff notification (type PRICE_SOURCE_DOWN, no account) per ACTIVE broker, at most once per 5 minutes platform-
// wide (checked in the database, so every serverless instance agrees), plus an in-process 60 s throttle so an outage
// does not turn every request into a notification query. Never throws: an alert failing must not break the caller.

const ALERT_EVERY_MS = 5 * 60_000;
const LOCAL_THROTTLE_MS = 60_000;
let lastLocalAttempt = 0;

export const PRICE_SOURCE_DOWN = "PRICE_SOURCE_DOWN";

export async function reportPriceSourceDown(context: { where: string; symbol?: string; reason: string }): Promise<void> {
  console.error("[price-source] live price read FAILED: refusing to act on a price (no Neon fallback)", context);
  const now = Date.now();
  if (now - lastLocalAttempt < LOCAL_THROTTLE_MS) return;
  lastLocalAttempt = now;
  try {
    const recent = await prisma.notification.findFirst({
      where: { type: PRICE_SOURCE_DOWN, createdAt: { gt: new Date(now - ALERT_EVERY_MS) } },
      select: { id: true },
    });
    if (recent) return;
    const brokers = await prisma.broker.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    const body =
      `Live prices could not be read from the price engine (${context.reason}). Until they are back, no close, stop loss, ` +
      `take profit, stop-out or pending order is executed on a price. Check the engine and the feed (FEED screen).`;
    await prisma.notification.createMany({
      data: brokers.map((b) => ({ brokerId: b.id, type: PRICE_SOURCE_DOWN, title: "Live prices unavailable", body, entityType: "PriceSource", entityId: context.where })),
    });
  } catch (err) {
    console.error("[price-source] could not record the alert", err);
  }
}

/** Test hook: forget the in-process throttle. */
export function resetPriceSourceAlertThrottle(): void {
  lastLocalAttempt = 0;
}
