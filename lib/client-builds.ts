import "server-only";
import { createHash, createSign, createPrivateKey } from "crypto";
import { getRedis } from "@/lib/redis";
import { headers } from "next/headers";

// Native-client build registry + tenant binding (2026-09-15, security audit item 4/7).
//
// Every broker build of the Avalonia terminal / backoffice carries a buildId (brand.json, hash-pinned
// into the assembly, sent as X-Client-Build on every request). This module:
//   * keeps the registry of known builds in Redis (client_build:<buildId> -> {brokerId, app, version,
//     status, createdAt, revokedAt}) -- registered by publish-*.ps1 through /api/admin/client-builds,
//     revoked there by a super admin (the kill switch);
//   * answers the signed client manifest (/api/client/manifest) the app verifies at start with the
//     public key compiled into it (ECDSA P-256, IEEE P1363 signature), binding the build to ONE
//     tenant host so a copied build cannot be pointed at another server;
//   * assertClientBuild() -- called by the session getters and both logins: a native client (the
//     X-Client-Platform: DESKTOP_NATIVE header every ApiClient request carries) must present a
//     registered, ACTIVE buildId that belongs to the request's broker. Browsers never send the
//     platform header and are unaffected. Debug builds send "dev"; allowed only for the tenants in
//     CLIENT_BUILD_DEV_TENANTS (subdomains, comma-separated) so QA keeps working.

export type ClientBuild = {
  buildId: string;
  brokerId: string;
  brokerSubdomain: string;
  app: "terminal" | "backoffice";
  version: string;
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
  revokedAt: string | null;
  note: string;
};

const KEY = (id: string) => `client_build:${id}`;
const INDEX = "client_builds:index";

export async function getClientBuild(buildId: string): Promise<ClientBuild | null> {
  const raw = await getRedis().get(KEY(buildId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientBuild;
  } catch {
    return null;
  }
}

export async function registerClientBuild(b: Omit<ClientBuild, "createdAt" | "revokedAt" | "status">): Promise<ClientBuild> {
  const rec: ClientBuild = { ...b, status: "ACTIVE", createdAt: new Date().toISOString(), revokedAt: null };
  const r = getRedis();
  await r.set(KEY(b.buildId), JSON.stringify(rec));
  await r.sadd(INDEX, b.buildId);
  return rec;
}

export async function setClientBuildStatus(buildId: string, status: "ACTIVE" | "REVOKED", note?: string): Promise<ClientBuild | null> {
  const cur = await getClientBuild(buildId);
  if (!cur) return null;
  const rec: ClientBuild = { ...cur, status, revokedAt: status === "REVOKED" ? new Date().toISOString() : null, note: note ?? cur.note };
  await getRedis().set(KEY(buildId), JSON.stringify(rec));
  return rec;
}

export async function listClientBuilds(): Promise<ClientBuild[]> {
  const ids = await getRedis().smembers(INDEX);
  const out: ClientBuild[] = [];
  for (const id of ids) {
    const b = await getClientBuild(id);
    if (b) out.push(b);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export type ClientBuildVerdict = { ok: true; buildId: string | null } | { ok: false; reason: "missing" | "unknown" | "revoked" | "wrong-tenant"; buildId: string };

/// The check every authenticated request and both logins run. Cheap: one Redis GET, only for
/// native clients (browser requests return ok immediately).
export async function checkClientBuild(brokerId: string | null, brokerSubdomain: string | null): Promise<ClientBuildVerdict> {
  const h = await headers();
  const platform = h.get("x-client-platform");
  const buildId = (h.get("x-client-build") ?? "").trim();
  if (platform !== "DESKTOP_NATIVE") return { ok: true, buildId: null };
  // CLIENT_BUILD_ENFORCE=1 makes an identity mandatory; until then (the roll-out window while the
  // installed 1.0.31 terminal / 1.0.0 backoffice carry none) a header-less native client is allowed and logged
  if (!buildId) {
    if (process.env.CLIENT_BUILD_ENFORCE === "1") return { ok: false, reason: "missing", buildId };
    console.warn("[client-builds] native client without X-Client-Build (grace mode)", { brokerSubdomain });
    return { ok: true, buildId: null };
  }
  if (buildId === "dev" || buildId.startsWith("dev-")) {
    const allowed = (process.env.CLIENT_BUILD_DEV_TENANTS ?? "zzzqa").split(",").map((s) => s.trim()).filter(Boolean);
    return brokerSubdomain && allowed.includes(brokerSubdomain) ? { ok: true, buildId } : { ok: false, reason: "wrong-tenant", buildId };
  }
  const b = await getClientBuild(buildId);
  if (!b) return { ok: false, reason: "unknown", buildId };
  if (b.status !== "ACTIVE") return { ok: false, reason: "revoked", buildId };
  if (brokerId && b.brokerId !== brokerId) return { ok: false, reason: "wrong-tenant", buildId };
  return { ok: true, buildId };
}

export function clientBuildErrorMessage(v: Exclude<ClientBuildVerdict, { ok: true }>): string {
  switch (v.reason) {
    case "revoked":
      return "BUILD_RETIRED: this installation has been retired by your broker. Install the latest version.";
    case "wrong-tenant":
      return "BUILD_WRONG_TENANT: this installation is not issued for this broker.";
    case "unknown":
      return "BUILD_UNKNOWN: this installation is not registered. Install an official build.";
    default:
      return "BUILD_MISSING: this installation carries no build identity. Install an official build.";
  }
}

// ---- signed manifest ----
export type ClientManifest = {
  slug: string;
  apiHost: string;
  app: string;
  buildId: string;
  status: "ACTIVE" | "REVOKED" | "UNKNOWN";
  minVersion: string;
  iat: number;
  exp: number;
};

/// {manifest (base64 of the JSON), signature (base64, ECDSA P-256 / SHA-256, IEEE P1363 r||s)}.
/// The private key is CLIENT_MANIFEST_PRIVATE_KEY (PKCS#8 PEM); the matching public key is compiled
/// into the apps (Vyx.Shared ClientManifestKeys).
export function signManifest(m: ClientManifest): { manifest: string; signature: string; keyId: string } {
  const pem = process.env.CLIENT_MANIFEST_PRIVATE_KEY;
  if (!pem) throw new Error("CLIENT_MANIFEST_PRIVATE_KEY is not set");
  const json = Buffer.from(JSON.stringify(m), "utf8");
  const signer = createSign("SHA256");
  signer.update(json);
  const sig = signer.sign({ key: createPrivateKey(pem.replace(/\\n/g, "\n")), dsaEncoding: "ieee-p1363" });
  const keyId = createHash("sha256").update(pem).digest("hex").slice(0, 8);
  return { manifest: json.toString("base64"), signature: sig.toString("base64"), keyId };
}
