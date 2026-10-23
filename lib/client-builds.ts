import "server-only";
import { createHash, createSign, createPrivateKey } from "crypto";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

// Native-client build registry + tenant binding (2026-09-15, security audit item 4/7).
//
// Every broker build of the Avalonia terminal / backoffice carries a buildId (brand.json, hash-pinned
// into the assembly, sent as X-Client-Build on every request). This module:
//   * keeps the registry of known builds in Redis (client_build:<buildId> -> {brokerId, app, version,
//     status, createdAt, revokedAt}) -- registered by publish-*.ps1 through /api/admin/client-builds,
//     revoked there by a super admin (the kill switch). Every publish / revoke is written to Postgres
//     ("ClientBuild") FIRST, then Redis (2026-10-23): Redis stays the one-GET hot path, Postgres is what
//     a Redis that lost its keys is rebuilt from (restoreClientBuildRegistry, instrumentation.ts);
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

// The Postgres row <-> the Redis record (same fields; dates as ISO strings in Redis).
type ClientBuildRow = { buildId: string; brokerId: string; brokerSubdomain: string; app: string; version: string; status: string; createdAt: Date; revokedAt: Date | null; note: string };
function rowToRecord(r: ClientBuildRow): ClientBuild {
  return { buildId: r.buildId, brokerId: r.brokerId, brokerSubdomain: r.brokerSubdomain, app: r.app as ClientBuild["app"], version: r.version, status: r.status as ClientBuild["status"], createdAt: r.createdAt.toISOString(), revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, note: r.note };
}
function recordToRow(b: ClientBuild): ClientBuildRow {
  return { buildId: b.buildId, brokerId: b.brokerId, brokerSubdomain: b.brokerSubdomain, app: b.app, version: b.version, status: b.status, createdAt: new Date(b.createdAt), revokedAt: b.revokedAt ? new Date(b.revokedAt) : null, note: b.note ?? "" };
}

async function writeRedis(rec: ClientBuild): Promise<void> {
  const r = getRedis();
  await r.set(KEY(rec.buildId), JSON.stringify(rec));
  await r.sadd(INDEX, rec.buildId);
}

export async function registerClientBuild(b: Omit<ClientBuild, "createdAt" | "revokedAt" | "status">): Promise<ClientBuild> {
  const rec: ClientBuild = { ...b, status: "ACTIVE", createdAt: new Date().toISOString(), revokedAt: null };
  await prisma.clientBuild.create({ data: recordToRow(rec) }); // durable first: a Redis failure cannot lose a publish
  await writeRedis(rec);
  return rec;
}

/// The kill switch (and its undo). Postgres first, then Redis; a build only Redis knows (registered before the durable
/// copy existed and not yet backfilled) is written to Postgres here too.
export async function setClientBuildStatus(buildId: string, status: "ACTIVE" | "REVOKED", note?: string): Promise<ClientBuild | null> {
  const cur = (await getClientBuild(buildId)) ?? (await prisma.clientBuild.findUnique({ where: { buildId } }).then((r) => (r ? rowToRecord(r) : null)));
  if (!cur) return null;
  const rec: ClientBuild = { ...cur, status, revokedAt: status === "REVOKED" ? new Date().toISOString() : null, note: note ?? cur.note };
  const row = recordToRow(rec);
  await prisma.clientBuild.upsert({ where: { buildId }, create: row, update: { status: row.status, revokedAt: row.revokedAt, note: row.note } });
  await writeRedis(rec);
  return rec;
}

/// Startup (instrumentation.ts): a Redis that has NO registry keys (flushed, replaced, failed over) is rebuilt from
/// Postgres, so native clients are not all refused as BUILD_UNKNOWN. One SCARD when Redis is healthy; Postgres is read
/// only when the index is empty. Returns the number of builds restored (0 = nothing to do).
export async function restoreClientBuildRegistry(): Promise<number> {
  if ((await getRedis().scard(INDEX)) > 0) return 0;
  const rows = await prisma.clientBuild.findMany();
  for (const r of rows) await writeRedis(rowToRecord(r));
  if (rows.length) console.warn(`[client-builds] Redis had no build registry: restored ${rows.length} build(s) from Postgres`);
  return rows.length;
}

/// One-time (scripts/client-builds-registry.ts backfill): every build only Redis knows gets its Postgres row. Never
/// overwrites a row Postgres already has. Returns the number of rows written.
export async function backfillClientBuildsToPostgres(): Promise<number> {
  let written = 0;
  for (const b of await listClientBuilds()) {
    const r = await prisma.clientBuild.createMany({ data: [recordToRow(b)], skipDuplicates: true });
    written += r.count;
  }
  return written;
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

/// Start the registry GET for this request's build now (null when there is nothing to look up), for checkClientBuild.
export function prefetchClientBuild(h: Headers): Promise<ClientBuild | null> | null {
  if (h.get("x-client-platform") !== "DESKTOP_NATIVE") return null;
  const buildId = (h.get("x-client-build") ?? "").trim();
  if (!buildId || buildId === "dev" || buildId.startsWith("dev-")) return null;
  const p = getClientBuild(buildId);
  p.catch(() => {}); // awaited later (or dropped when there is no session); never an unhandled rejection
  return p;
}

export type ClientBuildVerdict = { ok: true; buildId: string | null } | { ok: false; reason: "missing" | "unknown" | "revoked" | "wrong-tenant"; buildId: string };

/// The check every authenticated request and both logins run. Cheap: one Redis GET, only for
/// native clients (browser requests return ok immediately).
/// `prefetched` (latency fix 1, 2026-09-26): the registry GET already started by prefetchClientBuild, so a session
/// getter pays one Redis round trip (session + build in parallel) instead of two in a row.
export async function checkClientBuild(brokerId: string | null, brokerSubdomain: string | null, prefetched?: Promise<ClientBuild | null> | null): Promise<ClientBuildVerdict> {
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
  const b = await (prefetched ?? getClientBuild(buildId));
  if (!b) return { ok: false, reason: "unknown", buildId };
  if (b.status !== "ACTIVE") return { ok: false, reason: "revoked", buildId };
  if (brokerId && b.brokerId !== brokerId) return { ok: false, reason: "wrong-tenant", buildId };
  return { ok: true, buildId };
}

export function clientBuildErrorMessage(v: Exclude<ClientBuildVerdict, { ok: true }>): string {
  switch (v.reason) {
    case "revoked":
      return "BUILD_RETIRED: this installation has been retired. Install the latest version.";
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
