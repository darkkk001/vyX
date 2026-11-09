import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { getClientBuild, isBridgeLicense, registerClientBuild, signJson, writeBridgeLicenseStatus } from "@/lib/client-builds";
import { publishBridgeLicenseChanged } from "@/lib/nats";

// QoreBridge licenses (owner 2026-10-23, qorebridge repo docs/license-design.md). A license is a signed file a bridge
// must have to start: this broker, this server (machine id hash), the features (hedge / feed), an expiry. It is
// registered in the build registry (app "bridge", buildId = licenseId), so Super Admin's existing kill switch revokes
// it; the bridge checks /api/client/manifest?app=bridge every few minutes and stops hedging on REVOKED.

export const BRIDGE_FEATURES = ["hedge", "feed"] as const;
export type BridgeFeature = (typeof BRIDGE_FEATURES)[number];

export type BridgeLicensePayload = {
  kind: "qorebridge-license";
  licenseId: string;
  brokerId: string;
  brokerSlug: string;
  machineId: string;
  features: BridgeFeature[];
  issuedAt: number;
  expiresAt: number;
  manifestHost: string;
  reportKey: string;
};

/** The key a license signs its status reports with (CONNECTED badge): derived, never stored. Null when the platform
 *  has no BRIDGE_REPORT_SECRET. */
export function bridgeReportKey(licenseId: string): Buffer | null {
  const secret = process.env.BRIDGE_REPORT_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`bridge-report:${licenseId}`).digest();
}

/** A report's signature (hex HMAC-SHA256 of the raw body) against the license's key, constant time. */
export function bridgeReportSignatureOk(licenseId: string, body: string, signatureHex: string | null): boolean {
  const key = bridgeReportKey(licenseId);
  if (!key || !signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const want = createHmac("sha256", key).update(body).digest();
  return timingSafeEqual(want, Buffer.from(signatureHex, "hex"));
}

/** Days before expiry the platform starts warning (badge Degraded, a dealer FEED entry, Super Admin card). */
export const BRIDGE_LICENSE_WARNING_DAYS = 30;

/** Each license's expiry (ms): the ClientBuild.expiresAt column (license enforcement 1.2), else (a row the migration's
 *  backfill could not fill) its BRIDGE_LICENSE_ISSUED audit row. The license file itself stays on the bridge. */
export async function bridgeLicenseExpiries(licenseIds: string[]): Promise<Map<string, number>> {
  if (licenseIds.length === 0) return new Map();
  const out = new Map<string, number>();
  const rows = await prisma.clientBuild.findMany({ where: { buildId: { in: licenseIds } }, select: { buildId: true, expiresAt: true } });
  for (const r of rows) if (r.expiresAt) out.set(r.buildId, r.expiresAt.getTime());
  const missing = licenseIds.filter((id) => !out.has(id));
  for (const [id, f] of await auditIssueFacts(missing)) if (f.expiresAt != null) out.set(id, f.expiresAt);
  return out;
}

/** The issue facts from the BRIDGE_LICENSE_ISSUED audit rows: the fallback for a row whose columns are empty. */
export async function auditIssueFacts(licenseIds: string[]): Promise<Map<string, { expiresAt: number | null; features: string[] }>> {
  const out = new Map<string, { expiresAt: number | null; features: string[] }>();
  if (licenseIds.length === 0) return out;
  const rows = await prisma.auditLog.findMany({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: { in: licenseIds } }, select: { entityId: true, newValue: true }, orderBy: { createdAt: "asc" } });
  for (const r of rows) {
    if (!r.entityId || out.has(r.entityId)) continue; // the first issue row, as the backfill takes it
    const v = r.newValue as { expiresAt?: unknown; features?: unknown } | null;
    const t = typeof v?.expiresAt === "string" ? Date.parse(v.expiresAt) : NaN;
    out.set(r.entityId, { expiresAt: Number.isFinite(t) ? t : null, features: Array.isArray(v?.features) ? v.features.filter((f): f is string => typeof f === "string") : [] });
  }
  return out;
}

/** "expired" | "expiring" (within BRIDGE_LICENSE_WARNING_DAYS) | "ok" | null (expiry unknown). */
export function expiryState(expiresAt: number | null | undefined, now = Date.now()): "expired" | "expiring" | "ok" | null {
  if (expiresAt == null) return null;
  if (now >= expiresAt) return "expired";
  return expiresAt - now <= BRIDGE_LICENSE_WARNING_DAYS * 86_400_000 ? "expiring" : "ok";
}

export class BridgeLicenseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Issues and registers a license; returns the file's contents ({ payload, signature }) to hand to the broker's server. */
export async function issueBridgeLicense(input: { brokerSlug: string; machineId: string; features: string[]; expiresDays: number; note?: string; adminId: string }) {
  const slug = input.brokerSlug.trim().toLowerCase();
  const broker = await prisma.broker.findUnique({ where: { subdomain: slug }, select: { id: true, subdomain: true } });
  if (!broker) throw new BridgeLicenseError("unknown broker", 404);
  const machineId = input.machineId.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(machineId)) throw new BridgeLicenseError("machineId must be the 64-character value `qorebridge.exe --machine-id` prints");
  const features = [...new Set(input.features)].filter((f): f is BridgeFeature => (BRIDGE_FEATURES as readonly string[]).includes(f));
  if (features.length === 0 || features.length !== new Set(input.features).size) throw new BridgeLicenseError("features must be one or both of: hedge, feed");
  const days = Math.floor(input.expiresDays);
  if (!Number.isFinite(days) || days < 1 || days > 730) throw new BridgeLicenseError("expiresDays must be 1 to 730");
  const reportKeyCheck = bridgeReportKey("probe");
  if (!reportKeyCheck) throw new BridgeLicenseError("BRIDGE_REPORT_SECRET is not configured", 503);

  const now = Math.floor(Date.now() / 1000);
  const licenseId = `${broker.subdomain}-bridge-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const rootDomain = (process.env.ROOT_DOMAIN ?? "vyxtrader.com").split(":")[0];
  const payload: BridgeLicensePayload = {
    kind: "qorebridge-license",
    licenseId,
    brokerId: broker.id,
    brokerSlug: broker.subdomain,
    machineId,
    features,
    issuedAt: now,
    expiresAt: now + days * 86_400,
    manifestHost: `${broker.subdomain}.${rootDomain}`,
    reportKey: bridgeReportKey(licenseId)!.toString("base64"),
  };
  let signed: { payload: string; signature: string };
  try {
    signed = signJson(payload);
  } catch {
    throw new BridgeLicenseError("license signing is not configured", 503);
  }
  // the full machine hash too: /api/bridge/config checks the machine on every fetch (the audit row keeps 8 characters)
  // license enforcement 1.2: the expiry and features as columns too (the audit row below stays the issue record)
  await registerClientBuild(
    { buildId: licenseId, brokerId: broker.id, brokerSubdomain: broker.subdomain, app: "bridge", version: "license", note: (input.note ?? "").slice(0, 200) },
    { machineId, expiresAt: new Date(payload.expiresAt * 1000), features }
  );
  await prisma.auditLog.create({
    data: {
      brokerId: broker.id,
      actorAdminId: input.adminId,
      action: "BRIDGE_LICENSE_ISSUED",
      entityType: "ClientBuild",
      entityId: licenseId,
      newValue: { licenseId, features, expiresAt: new Date(payload.expiresAt * 1000).toISOString(), machineId: `${machineId.slice(0, 8)}...` },
    },
  });
  return { licenseId, expiresAt: payload.expiresAt, file: JSON.stringify({ payload: signed.payload, signature: signed.signature }) };
}

// ---- Super Admin: suspend / resume / revoke (license enforcement 1.2, contract sections 1 and 5) ----

export type BridgeLicenseAction = "suspend" | "resume" | "revoke";
export const BRIDGE_LICENSE_REASON_MAX = 200;

const ACTION_RULES = {
  // reversible stop: no new hedges, closes of existing hedges still go out (the bridge's side)
  suspend: { from: ["ACTIVE"], to: "SUSPENDED", audit: "BRIDGE_LICENSE_SUSPENDED", reasonRequired: true },
  resume: { from: ["SUSPENDED"], to: "ACTIVE", audit: "BRIDGE_LICENSE_RESUMED", reasonRequired: false },
  // permanent: a REVOKED bridge license never goes back to ACTIVE (only a new license)
  revoke: { from: ["ACTIVE", "SUSPENDED"], to: "REVOKED", audit: "BRIDGE_LICENSE_REVOKED", reasonRequired: true },
} as const;

/**
 * Applies a Super Admin action to a bridge license: the status change (guarded, Postgres then Redis), an AuditLog row
 * (actor = the admin, with the reason; the dealer FEED shows it for that broker), and the NATS nudge
 * bridge.license.<brokerId>. `adminId` null = the build registry's shared secret (no admin session).
 */
export async function changeBridgeLicenseStatus(input: { licenseId: string; action: BridgeLicenseAction; reason?: string; adminId: string | null }) {
  const rule = ACTION_RULES[input.action];
  if (!rule) throw new BridgeLicenseError("action must be suspend, resume or revoke");
  const reason = (input.reason ?? "").trim();
  if (rule.reasonRequired && !reason) throw new BridgeLicenseError("a reason is required");
  if (reason.length > BRIDGE_LICENSE_REASON_MAX) throw new BridgeLicenseError(`the reason must be at most ${BRIDGE_LICENSE_REASON_MAX} characters`);

  let pg = await prisma.clientBuild.findUnique({ where: { buildId: input.licenseId }, select: { app: true, version: true, status: true } });
  if (!pg) {
    // a license only the Redis registry knows: give it its durable row first, so the guarded write below applies
    const rec = await getClientBuild(input.licenseId);
    if (!rec || !isBridgeLicense(rec)) throw new BridgeLicenseError("unknown bridge license", 404);
    await prisma.clientBuild.createMany({
      data: [{ buildId: rec.buildId, brokerId: rec.brokerId, brokerSubdomain: rec.brokerSubdomain, app: rec.app, version: rec.version, status: rec.status, createdAt: new Date(rec.createdAt), revokedAt: rec.revokedAt ? new Date(rec.revokedAt) : null, note: rec.note ?? "" }],
      skipDuplicates: true,
    });
    pg = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: input.licenseId }, select: { app: true, version: true, status: true } });
  }
  if (!isBridgeLicense(pg)) throw new BridgeLicenseError("unknown bridge license", 404);
  const before = pg.status;

  const now = new Date();
  const data =
    input.action === "suspend"
      ? { status: "SUSPENDED" as const, suspendReason: reason, suspendedAt: now, suspendedBy: input.adminId }
      : input.action === "resume"
        ? { status: "ACTIVE" as const, suspendReason: null, suspendedAt: null, suspendedBy: null }
        : { status: "REVOKED" as const, revokedAt: now, revokedBy: input.adminId, revokeReason: reason };
  const row = await writeBridgeLicenseStatus(input.licenseId, [...rule.from], data);
  if (!row) {
    const cur = (await prisma.clientBuild.findUnique({ where: { buildId: input.licenseId }, select: { status: true } }))?.status ?? before;
    const why =
      cur === "REVOKED"
        ? "this license is revoked: a revoked license cannot be changed, issue a new one"
        : input.action === "resume"
          ? "only a suspended license can be resumed"
          : `the license is already ${cur.toLowerCase()}`;
    throw new BridgeLicenseError(why, 409);
  }
  await prisma.auditLog.create({
    data: {
      brokerId: row.brokerId,
      actorAdminId: input.adminId,
      action: rule.audit,
      entityType: "ClientBuild",
      entityId: row.buildId,
      oldValue: { status: before },
      newValue: { licenseId: row.buildId, status: rule.to, reason },
    },
  });
  // loss-tolerant: the 15 s status report carries the same verdict
  try {
    await publishBridgeLicenseChanged(row.brokerId, row.buildId, rule.to);
  } catch {
    // never fails the admin action
  }
  return row;
}
