import "server-only";
import { getRedis } from "@/lib/redis";

// The CONNECTED badge (owner 2026-10-23, qorebridge repo docs/connected-badge-design.md). The broker's bridge reports
// in every 15 s (POST /api/internal/bridge-status); the last report lives in Redis for 60 s. The backoffice reads one
// of three plain states. Liveness only: no prices, orders or credentials; nothing is written to the database.

export type BridgeBadge = "CONNECTED" | "DEGRADED" | "NOT_CONNECTED";
export const BRIDGE_BADGE_TEXT: Record<BridgeBadge, string> = {
  CONNECTED: "Connected",
  DEGRADED: "Degraded",
  NOT_CONNECTED: "Not connected",
};
/** A report older than this counts as no report (three missed reports). */
export const BRIDGE_REPORT_FRESH_MS = 45_000;

export type BridgeReport = {
  licenseId: string;
  receivedAt: number;
  lpsReady: number;
  lpsTotal: number;
  intake: "ok" | "degraded" | "down" | "off";
  feed: "ok" | "degraded" | "off";
  /** The license's expiry (ms), when known: within 30 days the badge is Degraded with the date. */
  licenseExpiresAt?: number | null;
};

const EXPIRY_WARNING_MS = 30 * 86_400_000;
const expiring = (r: BridgeReport, now: number) => r.licenseExpiresAt != null && r.licenseExpiresAt - now <= EXPIRY_WARNING_MS;

const REPORT = (brokerId: string) => `bridge-status:${brokerId}`;
const SINCE = (brokerId: string) => `bridge-status-since:${brokerId}`;

/** The badge for a report (or none). */
export function badgeFor(r: BridgeReport | null, now: number): BridgeBadge {
  if (!r || now - r.receivedAt > BRIDGE_REPORT_FRESH_MS) return "NOT_CONNECTED";
  if (r.lpsTotal > 0 && r.lpsReady === r.lpsTotal && r.intake === "ok" && r.feed !== "degraded" && !expiring(r, now)) return "CONNECTED";
  // reporting, but an LP is down, the intake is unhealthy, or there is no hedging lane at all
  return "DEGRADED";
}

export async function readBridgeReport(brokerId: string): Promise<BridgeReport | null> {
  const raw = await getRedis().get(REPORT(brokerId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BridgeReport;
  } catch {
    return null;
  }
}

/** Stores a report; returns the badge before and after (the caller announces a change). */
export async function storeBridgeReport(brokerId: string, r: BridgeReport): Promise<{ before: BridgeBadge; after: BridgeBadge }> {
  const now = r.receivedAt;
  const before = badgeFor(await readBridgeReport(brokerId), now);
  await getRedis().set(REPORT(brokerId), JSON.stringify(r), "EX", 60);
  const after = badgeFor(r, now);
  if (before !== after) await getRedis().set(SINCE(brokerId), JSON.stringify({ badge: after, since: now }), "EX", 30 * 86_400);
  return { before, after };
}

/** The badge now, with when it last changed. A bridge that stopped reporting turns NOT_CONNECTED here, at read time. */
export async function bridgeStatus(
  brokerId: string,
  now = Date.now()
): Promise<{ badge: BridgeBadge; text: string; since: string | null; lastReportAt: string | null; licenseExpiresAt: string | null }> {
  const r = await readBridgeReport(brokerId);
  const badge = badgeFor(r, now);
  const redis = getRedis();
  let since: number | null = null;
  try {
    const s = JSON.parse((await redis.get(SINCE(brokerId))) ?? "null") as { badge: BridgeBadge; since: number } | null;
    if (s && s.badge === badge) since = s.since;
  } catch {
    since = null;
  }
  if (since === null) {
    // the badge changed without a report saying so (reports stopped): it changed when the last report went stale
    since = badge === "NOT_CONNECTED" && r ? r.receivedAt + BRIDGE_REPORT_FRESH_MS : now;
    await redis.set(SINCE(brokerId), JSON.stringify({ badge, since }), "EX", 30 * 86_400);
  }
  // owner 2026-10-23: 30 days before expiry the badge says so, in plain words
  const text = badge === "DEGRADED" && r && expiring(r, now) ? `License expires on ${new Date(r.licenseExpiresAt!).toISOString().slice(0, 10)}` : BRIDGE_BADGE_TEXT[badge];
  return {
    badge,
    text,
    since: new Date(since).toISOString(),
    lastReportAt: r ? new Date(r.receivedAt).toISOString() : null,
    licenseExpiresAt: r?.licenseExpiresAt != null ? new Date(r.licenseExpiresAt).toISOString() : null,
  };
}
