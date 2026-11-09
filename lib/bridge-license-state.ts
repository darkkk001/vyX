import "server-only";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { getClientBuild, isBridgeLicense, signManifest, type ClientManifest } from "@/lib/client-builds";
import { auditIssueFacts, expiryState } from "@/lib/bridge-licenses";

// License enforcement Phase 1.2 (2026-11-09; the binding web <-> bridge contract is
// C:\vyx\handoff\license-enforcement-contract.md). One place that decides what a bridge license is worth right now,
// for all three bridge route families (/api/client/manifest?app=bridge, /api/bridge/config[/version],
// /api/internal/bridge-status), and the one signed verdict format they all answer with.
//
// Precedence (the first that applies wins):
//   unknown    not a registered bridge license of this broker
//   revoked    Super Admin revoked the license (permanent), or the bridge exe build is REVOKED
//   expired    past the license's expiresAt
//   machine    the request names another machine than the license's (contract section 4) -> status REFUSED
//   suspended  Super Admin suspended it (reversible)
//   ACTIVE

export type LicenseVerdictStatus = "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED" | "UNKNOWN" | "REFUSED";
export type LicenseVerdictReason = "" | "suspended" | "revoked" | "expired" | "machine" | "unknown";
export type LicenseVerdict = { status: LicenseVerdictStatus; reason: LicenseVerdictReason; suspendReason?: string };
export type SignedVerdict = { manifest: string; signature: string; keyId: string };

const HEX64 = /^[0-9a-f]{64}$/;
/** A machine hash as the bridge sends it (`qorebridge.exe --machine-id`): 64 hex characters, compared lower case. */
export function normalizeMachine(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().toLowerCase();
  return HEX64.test(m) ? m : null;
}
export const machinePrefix = (m: string | null | undefined) => (m ? `${m.slice(0, 8)}...` : null);

/** Online = a signed report within this long (reports come every 15 s; the column is written at most every 30 s). */
export const LICENSE_ONLINE_MS = 90_000;
const REPORT_WRITE_EVERY_MS = 30_000;
/** One BRIDGE_LICENSE_MACHINE_CONFLICT audit row per license + machine per hour. */
const CONFLICT_AUDIT_EVERY_S = 3600;

export type BridgeLicenseRow = {
  buildId: string;
  brokerId: string;
  brokerSubdomain: string;
  app: string;
  version: string;
  status: string;
  machineId: string | null;
  boundMachineId: string | null;
  expiresAt: Date | null;
  features: string[];
  suspendReason: string | null;
};
const ROW_SELECT = { buildId: true, brokerId: true, brokerSubdomain: true, app: true, version: true, status: true, machineId: true, boundMachineId: true, expiresAt: true, features: true, suspendReason: true } as const;

/** The license row from Postgres (where every kill-switch write lands first). A license only the Redis registry knows
 *  (registered before the durable copy) is read from there, without the Postgres-only fields. Null: not a license. */
export async function loadBridgeLicense(licenseId: string): Promise<BridgeLicenseRow | null> {
  if (!licenseId || licenseId.length > 128) return null;
  const row = await prisma.clientBuild.findUnique({ where: { buildId: licenseId }, select: ROW_SELECT });
  if (row) return isBridgeLicense(row) ? row : null;
  const rec = await getClientBuild(licenseId);
  if (!rec || !isBridgeLicense(rec)) return null;
  return { buildId: rec.buildId, brokerId: rec.brokerId, brokerSubdomain: rec.brokerSubdomain, app: rec.app, version: rec.version, status: rec.status, machineId: null, boundMachineId: null, expiresAt: null, features: [], suspendReason: null };
}

/** expiresAt (ms) and features: the columns, or the BRIDGE_LICENSE_ISSUED audit row for a row the migration's
 *  backfill could not fill. */
export async function licenseIssueFacts(row: Pick<BridgeLicenseRow, "buildId" | "expiresAt" | "features">): Promise<{ expiresAt: number | null; features: string[] }> {
  let expiresAt = row.expiresAt ? row.expiresAt.getTime() : null;
  let features = row.features ?? [];
  if (expiresAt == null || features.length === 0) {
    const audit = await auditIssueFacts([row.buildId]);
    const a = audit.get(row.buildId);
    if (expiresAt == null) expiresAt = a?.expiresAt ?? null;
    if (features.length === 0) features = a?.features ?? [];
  }
  return { expiresAt, features };
}

/** The machine this license is bound to: the one it was issued for, else the first one that presented it. */
export const boundMachine = (row: Pick<BridgeLicenseRow, "machineId" | "boundMachineId">) => row.machineId ?? row.boundMachineId ?? null;

/**
 * One server per license (contract section 4). "ok" when `machine` is the license's machine. A license issued
 * without a machineId (before 2026-11-03) binds to the first machine that presents it, sticky (an audit row says so).
 * Another machine: "conflict", and the conflict is recorded (columns + one audit row per license + machine per hour).
 */
export async function checkLicenseMachine(row: BridgeLicenseRow, machine: string, now = Date.now()): Promise<"ok" | "conflict"> {
  let bound = boundMachine(row);
  if (!bound) {
    // first presenter wins; the WHERE makes two bridges racing for an unbound license bind exactly one
    const won = await prisma.clientBuild.updateMany({ where: { buildId: row.buildId, machineId: null, boundMachineId: null }, data: { boundMachineId: machine } });
    if (won.count === 1) {
      row.boundMachineId = machine;
      await prisma.auditLog.create({
        data: { brokerId: row.brokerId, action: "BRIDGE_LICENSE_MACHINE_BOUND", entityType: "ClientBuild", entityId: row.buildId, newValue: { licenseId: row.buildId, machine: machinePrefix(machine) } },
      });
      return "ok";
    }
    const fresh = await prisma.clientBuild.findUnique({ where: { buildId: row.buildId }, select: { machineId: true, boundMachineId: true } });
    // a license only the Redis registry knows has no durable row to bind: not checked, as before machine binding
    if (!fresh) return "ok";
    bound = boundMachine(fresh);
    row.boundMachineId = fresh?.boundMachineId ?? null;
  }
  if (bound === machine) return "ok";
  await recordMachineConflict(row, machine, bound, now);
  return "conflict";
}

async function recordMachineConflict(row: BridgeLicenseRow, machine: string, bound: string | null, now: number): Promise<void> {
  let first = false;
  try {
    first = (await getRedis().set(`bridge-license-conflict:${row.buildId}:${machine}`, "1", "EX", CONFLICT_AUDIT_EVERY_S, "NX")) === "OK";
  } catch {
    first = false; // Redis down: refuse anyway, just do not write the audit row
  }
  if (!first) return;
  await prisma.clientBuild.updateMany({ where: { buildId: row.buildId }, data: { conflictMachine: machine, conflictAt: new Date(now) } });
  await prisma.auditLog.create({
    data: {
      brokerId: row.brokerId,
      action: "BRIDGE_LICENSE_MACHINE_CONFLICT",
      entityType: "ClientBuild",
      entityId: row.buildId,
      newValue: { licenseId: row.buildId, machine: machinePrefix(machine), boundMachine: machinePrefix(bound) },
    },
  });
}

/** Online status: the last signed report and its machine, written at most every 30 s (a report every 15 s would
 *  otherwise be a row write every 15 s per bridge). A conditional UPDATE: no write when nothing is due. */
export async function recordLicenseReport(licenseId: string, machine: string | null, now = Date.now()): Promise<void> {
  const due = new Date(now - REPORT_WRITE_EVERY_MS);
  await prisma.clientBuild.updateMany({
    where: { buildId: licenseId, OR: [{ lastReportAt: null }, { lastReportAt: { lt: due } }, ...(machine ? [{ lastReportMachine: { not: machine } }, { lastReportMachine: null }] : [])] },
    data: { lastReportAt: new Date(now), ...(machine ? { lastReportMachine: machine } : {}) },
  });
}

/**
 * The license's verdict now. `machine` (optional: old bridges do not send it): undefined = not checked, null = sent but
 * not a valid machine hash (refused `machine`, no conflict row), a hash = checked against the bound machine.
 * `exeRevoked`: the bridge exe build it runs is REVOKED.
 */
export async function evaluateBridgeLicense(
  row: BridgeLicenseRow | null,
  opts: { brokerId?: string; machine?: string | null; exeRevoked?: boolean; now?: number } = {}
): Promise<LicenseVerdict & { facts?: { expiresAt: number | null; features: string[] } }> {
  const now = opts.now ?? Date.now();
  if (!row || (opts.brokerId && row.brokerId !== opts.brokerId)) return { status: "UNKNOWN", reason: "unknown" };
  if (row.status !== "ACTIVE" && row.status !== "SUSPENDED") return { status: "REVOKED", reason: "revoked" };
  const facts = await licenseIssueFacts(row);
  if (expiryState(facts.expiresAt, now) === "expired") return { status: "EXPIRED", reason: "expired", facts };
  if (opts.machine !== undefined) {
    if (opts.machine === null || (await checkLicenseMachine(row, opts.machine, now)) === "conflict") return { status: "REFUSED", reason: "machine", facts };
  }
  if (opts.exeRevoked) return { status: "REVOKED", reason: "revoked", facts };
  if (row.status === "SUSPENDED") return { status: "SUSPENDED", reason: "suspended", suspendReason: row.suspendReason ?? "", facts };
  return { status: "ACTIVE", reason: "", facts };
}

/** The signed verdict (contract section 2): the client manifest format, app=bridge, with the additive fields. */
export async function signBridgeVerdict(slug: string, licenseId: string, v: LicenseVerdict, brokerId?: string): Promise<SignedVerdict> {
  const rootDomain = (process.env.ROOT_DOMAIN ?? "vyxtrader.com").split(":")[0];
  const minRow = brokerId ? await prisma.brokerAppMinVersion.findUnique({ where: { brokerId_app: { brokerId, app: "bridge" } }, select: { minVersion: true } }) : null;
  const iat = Math.floor(Date.now() / 1000);
  const manifest: ClientManifest = {
    slug,
    apiHost: `${slug}.${rootDomain}`,
    app: "bridge",
    buildId: licenseId,
    status: v.status,
    reason: v.reason,
    ...(v.status === "SUSPENDED" ? { suspendReason: (v.suspendReason ?? "").slice(0, 200) } : {}),
    minVersion: minRow?.minVersion ?? "",
    iat,
    exp: iat + 24 * 3600,
  };
  return signManifest(manifest);
}

/** signBridgeVerdict, or null when signing is not configured (the refusal still goes out, with its reason). */
export async function trySignBridgeVerdict(slug: string, licenseId: string, v: LicenseVerdict, brokerId?: string): Promise<SignedVerdict | null> {
  try {
    return await signBridgeVerdict(slug, licenseId, v, brokerId);
  } catch (err) {
    console.error("bridge license verdict: signing failed", err instanceof Error ? err.message : err);
    return null;
  }
}
