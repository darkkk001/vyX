import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { registerClientBuild, signJson } from "@/lib/client-builds";

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

/** Each license's expiry (ms), from its BRIDGE_LICENSE_ISSUED audit row (the license file itself stays on the bridge). */
export async function bridgeLicenseExpiries(licenseIds: string[]): Promise<Map<string, number>> {
  if (licenseIds.length === 0) return new Map();
  const rows = await prisma.auditLog.findMany({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: { in: licenseIds } }, select: { entityId: true, newValue: true } });
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = r.newValue as { expiresAt?: unknown } | null;
    const t = typeof v?.expiresAt === "string" ? Date.parse(v.expiresAt) : NaN;
    if (r.entityId && Number.isFinite(t)) out.set(r.entityId, t);
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
  await registerClientBuild({ buildId: licenseId, brokerId: broker.id, brokerSubdomain: broker.subdomain, app: "bridge", version: "license", note: (input.note ?? "").slice(0, 200) });
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
