import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { checkRateLimit } from "@/lib/rate-limit";
import { bridgeReportKey, expiryState } from "@/lib/bridge-licenses";
import { evaluateBridgeLicense, loadBridgeLicense, trySignBridgeVerdict, type SignedVerdict } from "@/lib/bridge-license-state";

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
//   rate       30 a minute per license (429)
//   license    a registered bridge license (ClientBuild app=bridge)
//   broker     the request came in on the license's own broker host: middleware's x-broker-id (set from the host,
//              never from the client) must equal the license's broker (lib/account-auth.ts getAccountSession pattern).
//              Checked before any verdict is signed: a verdict is only ever handed out on the license's own host.
//   revoked    Super Admin revoked the license (license enforcement 1.2)                          + signed verdict
//   expired    past its expiresAt                                                                  + signed verdict
//   license    an unknown expiry, or a license not issued with "hedge"
//   machine    x-bridge-machine = the license's machine: the full hash it was issued for, or (a license issued
//              before 2026-11-03, no hash) the first machine that presented it, sticky (contract section 4)
//                                                                                                 + signed verdict
//   build      the bridge exe's own build is not REVOKED (the manifest's kill switch)                + signed verdict
// A SUSPENDED license is NOT refused here (contract 2b): the bridge keeps its LP session and needs its config at a
// restart; the route answers 200 with license: { status: "SUSPENDED", reason: "suspended" }.
// The broker is ALWAYS the license's; nothing in the request names one.

export const BRIDGE_CLOCK_SKEW_S = 120;
const HEX64 = /^[0-9a-f]{64}$/;

export type BridgeAuthReason = "headers" | "clock" | "signature" | "replay" | "rate" | "license" | "revoked" | "expired" | "machine" | "build" | "broker";
/** The top-level `license` field of an accepted config / version answer (contract 2b). */
export type BridgeLicenseField = { status: "ACTIVE" | "SUSPENDED"; reason: "" | "suspended" };
export type BridgeAuth =
  | { ok: true; licenseId: string; brokerId: string; license: BridgeLicenseField }
  // verdict: the signed license verdict, on revoked / expired / machine / build refusals only (null if signing failed)
  | { ok: false; status: 403 | 429; reason: BridgeAuthReason; verdict?: SignedVerdict | null };

/** The JSON body of a refused config / version request. */
export function bridgeAuthRefusalBody(auth: Extract<BridgeAuth, { ok: false }>) {
  return auth.verdict ? { error: "forbidden", reason: auth.reason, license: auth.verdict } : { error: "forbidden", reason: auth.reason };
}

/** The string a bridge signs for a GET (exported for the test vector shared with qorebridge). */
export function bridgeSignedString(path: string, time: string, nonce: string, licenseId: string, machine: string, build: string): string {
  return `GET\n${path}\n${time}\n${nonce}\n${licenseId}\n${machine}\n${build}`;
}

export function bridgeGetSignature(licenseId: string, signed: string): string | null {
  const key = bridgeReportKey(licenseId);
  return key ? createHmac("sha256", key).update(signed).digest("hex") : null;
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
  const license = await loadBridgeLicense(licenseId);
  if (!license) return deny("license");
  const requestBroker = headers.get("x-broker-id");
  if (!requestBroker || requestBroker !== license.brokerId) return deny("broker");
  const withVerdict = async (reason: BridgeAuthReason, v: Parameters<typeof trySignBridgeVerdict>[2]): Promise<BridgeAuth> => ({
    ok: false,
    status: 403,
    reason,
    verdict: await trySignBridgeVerdict(license.brokerSubdomain, licenseId, v, license.brokerId),
  });

  // revoked / expired first, without the machine (a dead license binds nothing)
  const base = await evaluateBridgeLicense(license, { now });
  if (base.reason === "revoked") return withVerdict("revoked", base);
  if (base.reason === "expired") return withVerdict("expired", base);
  const facts = base.facts!;
  const exp = expiryState(facts.expiresAt, now);
  if (exp !== "ok" && exp !== "expiring") return deny("license"); // no expiry known: not a proper license
  if (!facts.features.includes("hedge")) return deny("license");
  let exeRevoked = false;
  if (build !== "dev") {
    const exe = await prisma.clientBuild.findUnique({ where: { buildId: build }, select: { app: true, status: true } });
    exeRevoked = exe?.app === "bridge" && exe.status === "REVOKED";
  }
  const v = await evaluateBridgeLicense(license, { now, machine, exeRevoked });
  if (v.reason === "machine") return withVerdict("machine", v);
  if (v.reason === "revoked") return withVerdict("build", v); // the exe build: verdict REVOKED / revoked (contract 2)
  if (v.reason === "suspended") return { ok: true, licenseId, brokerId: license.brokerId, license: { status: "SUSPENDED", reason: "suspended" } };
  if (v.status !== "ACTIVE") return deny("license");
  return { ok: true, licenseId, brokerId: license.brokerId, license: { status: "ACTIVE", reason: "" } };
}
