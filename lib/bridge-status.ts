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
  /** Phase 2.1 #4: the v2 status-console fields (qorebridge docs/bridge-status-report.md), null / absent from a v1 bridge. */
  detail?: BridgeDetail | null;
};

// ---- v2: the status console (qorebridge repo docs/bridge-status-report.md, branch feat/bridge-status-console) ----

export const LANE_STATES = ["ready", "connecting", "reconciling", "disconnected", "logging_out", "maintenance", "market_closed", "halted", "auth_halted", "stopped"] as const;
export type LaneState = (typeof LANE_STATES)[number];
export const HOLD_REASONS = ["market_closed", "lp_reconnecting", "no_lp_up", "db_error", "lane_stopped", "license_suspended"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export const LICENSE_STATES = ["active", "grace", "suspended", "stopped", "holding"] as const;
export type BridgeLicenseState = (typeof LICENSE_STATES)[number];

export type BridgeLane = {
  id: string;
  /** "unknown" for a state this platform does not know yet (a newer bridge): shown as such, never dropped. */
  state: LaneState | "unknown";
  inFlight: number;
  /** Kept for completeness; a netting / FIX 4.4 LP always reports 0, so the console does not show it. */
  openPositions: number;
  delivered: number;
  completedSinceStart: number;
  logonRejects: number;
  maintenanceRefusals: number;
};
export type BridgeDetail = {
  v: number;
  health: "ok" | "degraded" | "down";
  hedging: boolean;
  /** graceUntil in ms (the bridge sends Unix seconds). */
  license: { state: BridgeLicenseState | "unknown"; reason: string | null; graceUntil: number | null };
  lanes: BridgeLane[];
  held: { total: number; byReason: Record<HoldReason, number> };
};

const MAX_LANES = 32;
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000_000) : 0);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The v2 fields of a report body, or null when the bridge sent none (v1: no `v`) or they are not the documented shape. A reader ignores keys it
 *  does not know; counts are whole and never negative; strings are bounded. A v1 body (only the badge keys) is null: the badge never depends on this. */
export function parseBridgeDetail(body: unknown): BridgeDetail | null {
  if (!isObj(body) || typeof body.v !== "number" || !Number.isInteger(body.v) || body.v < 2) return null;
  const health = body.health === "ok" || body.health === "degraded" || body.health === "down" ? body.health : null;
  if (!health || !isObj(body.license) || !Array.isArray(body.lanes) || !isObj(body.held)) return null;
  const lic = body.license;
  const licState = (LICENSE_STATES as readonly string[]).includes(lic.state as string) ? (lic.state as BridgeLicenseState) : "unknown";
  const graceUntil = licState === "grace" && typeof lic.graceUntil === "number" && Number.isFinite(lic.graceUntil) && lic.graceUntil > 0 ? Math.floor(lic.graceUntil) * 1000 : null;
  const reason = typeof lic.reason === "string" && lic.reason.trim() !== "" ? lic.reason.trim().slice(0, 200) : null;
  const lanes: BridgeLane[] = [];
  for (const l of body.lanes.slice(0, MAX_LANES)) {
    if (!isObj(l) || typeof l.id !== "string" || l.id.trim() === "") continue;
    lanes.push({
      id: l.id.trim().slice(0, 64),
      state: (LANE_STATES as readonly string[]).includes(l.state as string) ? (l.state as LaneState) : "unknown",
      inFlight: count(l.inFlight),
      openPositions: count(l.openPositions),
      delivered: count(l.delivered),
      completedSinceStart: count(l.completedSinceStart),
      logonRejects: count(l.logonRejects),
      maintenanceRefusals: count(l.maintenanceRefusals),
    });
  }
  const by = isObj(body.held.byReason) ? body.held.byReason : {};
  const byReason = Object.fromEntries(HOLD_REASONS.map((k) => [k, count(by[k])])) as Record<HoldReason, number>;
  return { v: body.v, health, hedging: body.hedging === true, license: { state: licState, reason, graceUntil }, lanes, held: { total: count(body.held.total), byReason } };
}

/** The console as the backoffice shows it: the v2 detail of a FRESH report with each lane's LP name (the web's; the bridge sends only the id), or
 *  null when the bridge reports no v2 fields (an older bridge) or has stopped reporting. */
export type BridgeConsole = Omit<BridgeDetail, "lanes"> & { lanes: (BridgeLane & { name: string | null })[]; reportedAt: string };
export async function bridgeConsole(
  brokerId: string,
  lpNames: (ids: string[]) => Promise<Map<string, string>>,
  now = Date.now()
): Promise<BridgeConsole | null> {
  const r = await readBridgeReport(brokerId);
  if (!r?.detail || now - r.receivedAt > BRIDGE_REPORT_FRESH_MS) return null;
  const names = r.detail.lanes.length > 0 ? await lpNames(r.detail.lanes.map((l) => l.id)) : new Map<string, string>();
  return { ...r.detail, lanes: r.detail.lanes.map((l) => ({ ...l, name: names.get(l.id) ?? null })), reportedAt: new Date(r.receivedAt).toISOString() };
}

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
