import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { checkRateLimit } from "@/lib/rate-limit";
import { bridgeReportKey, expiryState } from "@/lib/bridge-licenses";

// Platform API bridge config (A.1.2, owner decisions 2026-11-03; C:\vyx\handoff\platform-api-bridge-config-plan.md):
// how a QoreBridge proves itself on a GET. The same per-license key as its status reports
// (/api/internal/bridge-status, lib/bridge-licenses.ts bridgeReportKey), but a GET has no body, so the signed string is
// the request itself plus a timestamp:
//
//   x-bridge-signature = hex HMAC-SHA256(reportKey,
//     "GET\n<path>\n<x-bridge-time>\n<x-bridge-nonce>\n<licenseId>\n<x-bridge-machine>\n<x-bridge-build>")
//
// x-bridge-nonce: 32 random hex characters per request, so two requests in the same second differ and a replay is
// recognised by its nonce.
//
// Refused (403, with a short reason code once the signature is proven) unless, in this order:
//   clock      x-bridge-time within BRIDGE_CLOCK_SKEW_S of the platform's clock (a captured request dies quickly)
//   signature  the HMAC above, constant time
//   replay     that nonce not seen before for this license (Redis, kept for the whole window)
//   license    a registered bridge license (ClientBuild app=bridge), ACTIVE, not expired, issued with "hedge"
//   machine    x-bridge-machine = the full machine hash the license was issued for (a license issued before
//              2026-11-03 has none and is refused: re-issue it)
//   build      the bridge exe's own build is not REVOKED (the manifest's kill switch, app/api/client/manifest :28-35)
//   broker     the request came in on the license's own broker host: middleware's x-broker-id (set from the host,
//              never from the client) must equal the license's broker (lib/account-auth.ts getAccountSession pattern)
// The broker is ALWAYS the license's; nothing in the request names one.

export const BRIDGE_CLOCK_SKEW_S = 120;
const HEX64 = /^[0-9a-f]{64}$/;

export type BridgeAuthReason = "headers" | "clock" | "signature" | "replay" | "rate" | "license" | "machine" | "build" | "broker";
export type BridgeAuth = { ok: true; licenseId: string; brokerId: string } | { ok: false; status: 403 | 429; reason: BridgeAuthReason };

/** The string a bridge signs for a GET (exported for the test vector shared with qorebridge). */
export function bridgeSignedString(path: string, time: string, nonce: string, licenseId: string, machine: string, build: string): string {
  return `GET\n${path}\n${time}\n${nonce}\n${licenseId}\n${machine}\n${build}`;
}

export function bridgeGetSignature(licenseId: string, signed: string): string | null {
  const key = bridgeReportKey(licenseId);
  return key ? createHmac("sha256", key).update(signed).digest("hex") : null;
}

/** The license's issue facts from its BRIDGE_LICENSE_ISSUED audit row (the license file itself stays on the bridge). */
async function licenseFacts(licenseId: string): Promise<{ expiresAt: number | null; features: string[] }> {
  const row = await prisma.auditLog.findFirst({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: licenseId }, select: { newValue: true } });
  const v = row?.newValue as { expiresAt?: unknown; features?: unknown } | null;
  const t = typeof v?.expiresAt === "string" ? Date.parse(v.expiresAt) : NaN;
  return { expiresAt: Number.isFinite(t) ? t : null, features: Array.isArray(v?.features) ? v.features.filter((f): f is string => typeof f === "string") : [] };
}

export async function verifyBridgeGet(headers: Headers, path: string, now = Date.now()): Promise<BridgeAuth> {
  const deny = (reason: BridgeAuthReason, status: 403 | 429 = 403): BridgeAuth => ({ ok: false, status, reason });
  const licenseId = (headers.get("x-bridge-license") ?? "").trim();
  const time = (headers.get("x-bridge-time") ?? "").trim();
  const nonce = (headers.get("x-bridge-nonce") ?? "").trim().toLowerCase();
  const machine = (headers.get("x-bridge-machine") ?? "").trim().toLowerCase();
  const build = (headers.get("x-bridge-build") ?? "").trim();
  const signature = (headers.get("x-bridge-signature") ?? "").trim().toLowerCase();
  if (!licenseId || licenseId.length > 128 || !/^\d{1,12}$/.test(time) || !/^[0-9a-f]{32}$/.test(nonce) || !HEX64.test(machine) || !build || build.length > 128 || !HEX64.test(signature)) {
    return deny("headers");
  }
  if (Math.abs(now / 1000 - Number(time)) > BRIDGE_CLOCK_SKEW_S) return deny("clock");
  const want = bridgeGetSignature(licenseId, bridgeSignedString(path, time, nonce, licenseId, machine, build));
  if (!want || !timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(signature, "hex"))) return deny("signature");
  // each nonce is good once: kept a little longer than the window a request could be accepted in
  const fresh = await getRedis().set(`bridge-get-nonce:${licenseId}:${nonce}`, "1", "EX", BRIDGE_CLOCK_SKEW_S * 2 + 10, "NX");
  if (fresh !== "OK") return deny("replay");
  if (!(await checkRateLimit(`bridge-config:${licenseId}`, 30, 60)).allowed) return deny("rate", 429);

  // Postgres, not the Redis registry: the machine hash is only there, and every kill-switch write lands there first
  const license = await prisma.clientBuild.findUnique({ where: { buildId: licenseId }, select: { app: true, status: true, brokerId: true, machineId: true } });
  if (!license || license.app !== "bridge" || license.status !== "ACTIVE") return deny("license");
  const facts = await licenseFacts(licenseId);
  if (expiryState(facts.expiresAt, now) !== "ok" && expiryState(facts.expiresAt, now) !== "expiring") return deny("license");
  if (!facts.features.includes("hedge")) return deny("license");
  if (!license.machineId || license.machineId !== machine) return deny("machine");
  if (build !== "dev") {
    const exe = await prisma.clientBuild.findUnique({ where: { buildId: build }, select: { app: true, status: true } });
    if (exe?.app === "bridge" && exe.status === "REVOKED") return deny("build");
  }
  const requestBroker = headers.get("x-broker-id");
  if (!requestBroker || requestBroker !== license.brokerId) return deny("broker");
  return { ok: true, licenseId, brokerId: license.brokerId };
}
