import "server-only";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// Owner decision (2026-09-26): the web NEVER falls back to Neon's LivePrice when the engine's live-price read fails
// (that table has been frozen since 2026-09-14, when the feed's writes moved VPS-local). A failed read means "no
// price": every close, SL / TP, stop-out and pending trigger refuses to act on it -- and the broker's staff is told,
// here, instead of the platform going quietly blind.
//
// Owner decision (2026-10-05): alert on REAL outages only. A read is already retried once (lib/market-data-client.ts);
// a failure that is still there is only alerted after ~20 s of CONTINUOUS failure (no successful read since the first
// failure, tracked in Redis so every serverless instance agrees). One outage = one "Live prices unavailable" and, on
// the first successful read after it, one "Live prices back" with its duration. The staff wording never names our
// infrastructure (engine, timeouts, HTTP codes, the feed): the technical reason stays in the server log and in the
// ops-only Redis record. One notification per ACTIVE broker, as before. Never throws: an alert failing must not break
// the caller.

export const PRICE_SOURCE_DOWN = "PRICE_SOURCE_DOWN";
export const PRICE_SOURCE_BACK = "PRICE_SOURCE_BACK";
export const OUTAGE_ALERT_AFTER_MS = 20_000;
const SUCCESS_RECORD_EVERY_MS = 1_000;

const K_FIRST_FAIL = "price-source:first-fail"; // ms of the first failure of the current run of failures
const K_LAST_OK = "price-source:last-ok"; // ms of the last successful read
const K_OUTAGE = "price-source:outage"; // JSON {startedAt, alertedAt, reason}: an alerted outage still open

let lastSuccessRecorded = 0;
let failedSinceLastRecordedSuccess = false;

function hhmmUtc(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "<1 min", "1 min", "12 min", "2 h 5 min". */
export function outageDurationText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function unavailableText(startedAt: number): { title: string; body: string } {
  return { title: "Live prices unavailable", body: `Live prices unavailable since ${hhmmUtc(startedAt)}.` };
}

export function backText(backAt: number, durationMs: number): { title: string; body: string } {
  return { title: "Live prices back", body: `Live prices back at ${hhmmUtc(backAt)} (${outageDurationText(durationMs)}).` };
}

async function notifyAllBrokers(type: string, text: { title: string; body: string }): Promise<void> {
  const brokers = await prisma.broker.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (brokers.length === 0) return;
  await prisma.notification.createMany({
    data: brokers.map((b) => ({ brokerId: b.id, type, title: text.title, body: text.body, entityType: "PriceSource", entityId: "outage" })),
  });
}

/** A price read failed even after its one retry. Alerts once the failures have lasted OUTAGE_ALERT_AFTER_MS. */
export async function reportPriceSourceDown(context: { where: string; symbol?: string; reason: string }, now: number = Date.now()): Promise<void> {
  console.error("[price-source] live price read FAILED: refusing to act on a price (no Neon fallback)", context);
  failedSinceLastRecordedSuccess = true;
  try {
    const redis = getRedis();
    const [firstRaw, lastOkRaw] = await redis.mget(K_FIRST_FAIL, K_LAST_OK);
    const first = firstRaw ? Number(firstRaw) : NaN;
    const lastOk = lastOkRaw ? Number(lastOkRaw) : 0;
    // a new run of failures: none recorded yet, or a successful read since the recorded first failure
    if (!Number.isFinite(first) || lastOk > first) {
      await redis.set(K_FIRST_FAIL, String(now), "EX", 3600);
      return;
    }
    if (now - first < OUTAGE_ALERT_AFTER_MS) return;
    // continuous failure for 20 s+: exactly one alert per outage, whichever instance gets here first
    const record = JSON.stringify({ startedAt: first, alertedAt: now, reason: context.reason, where: context.where });
    const won = await redis.set(K_OUTAGE, record, "EX", 7 * 24 * 3600, "NX");
    if (won !== "OK") return;
    console.error("[price-source] OUTAGE alerted (staff notified)", { startedAt: new Date(first).toISOString(), reason: context.reason });
    await notifyAllBrokers(PRICE_SOURCE_DOWN, unavailableText(first));
  } catch (err) {
    console.error("[price-source] could not record the failure / alert", err);
  }
}

/** A price read succeeded: ends a run of failures, and closes an alerted outage with one "back" notification. Cheap:
 *  at most one Redis round trip per second per instance, unless this instance just saw a failure. */
export async function reportPriceSourceOk(now: number = Date.now()): Promise<void> {
  if (!failedSinceLastRecordedSuccess && now - lastSuccessRecorded < SUCCESS_RECORD_EVERY_MS) return;
  lastSuccessRecorded = now;
  failedSinceLastRecordedSuccess = false;
  try {
    const redis = getRedis();
    const res = await redis.multi().set(K_LAST_OK, String(now), "EX", 3600).getdel(K_OUTAGE).exec();
    const outageRaw = res?.[1]?.[1] as string | null | undefined;
    if (!outageRaw) return;
    let startedAt = now;
    try { startedAt = Number((JSON.parse(outageRaw) as { startedAt?: number }).startedAt) || now; } catch { /* keep now */ }
    const duration = Math.max(0, now - startedAt);
    console.error("[price-source] outage OVER (staff notified)", { startedAt: new Date(startedAt).toISOString(), durationMs: duration });
    await redis.set("price-source:last-outage", JSON.stringify({ startedAt, endedAt: now, durationMs: duration }), "EX", 30 * 24 * 3600);
    await notifyAllBrokers(PRICE_SOURCE_BACK, backText(now, duration));
  } catch (err) {
    console.error("[price-source] could not record the successful read", err);
  }
}

/** Test hook: forget the in-process state. */
export function resetPriceSourceAlertThrottle(): void {
  lastSuccessRecorded = 0;
  failedSinceLastRecordedSuccess = false;
}
