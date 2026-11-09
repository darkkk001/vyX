import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bridgeLicenseExpiries, BridgeLicenseError, expiryState, issueBridgeLicense } from "@/lib/bridge-licenses";
import { LICENSE_ONLINE_MS, machinePrefix } from "@/lib/bridge-license-state";

// QoreBridge licenses, Super Admin only (owner 2026-10-23).
//   GET                                            -> every bridge row (licenses and exe builds, newest first), with
//                                                     status, suspend / revoke reason + who / when, expiry, features,
//                                                     online status and any machine conflict (license enforcement 1.2)
//   POST { brokerSlug, machineId, features, expiresDays?, note? } -> issues one: { licenseId, expiresAt, file }
//        `file` is the qorebridge.license contents (signed; contains no secret that opens anything but the bridge's
//        own status reports). machineId = what `qorebridge.exe --machine-id` prints on the broker's server.
// Suspend / resume / revoke: POST /api/admin/bridge-licenses/<licenseId> { action, reason }.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Postgres: every license and every status write lands there first, and the enforcement fields live only there
  const all = await prisma.clientBuild.findMany({ where: { app: "bridge" }, orderBy: { createdAt: "desc" } });
  const expiries = await bridgeLicenseExpiries(all.filter((b) => !b.expiresAt).map((b) => b.buildId));
  const adminIds = [...new Set(all.flatMap((b) => [b.suspendedBy, b.revokedBy]).filter((x): x is string => !!x))];
  const admins = adminIds.length ? await prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, email: true } }) : [];
  const email = new Map(admins.map((a) => [a.id, a.email]));
  const now = Date.now();
  return NextResponse.json(
    all.map((b) => {
      const at = b.expiresAt ? b.expiresAt.getTime() : (expiries.get(b.buildId) ?? null);
      const bound = b.machineId ?? b.boundMachineId;
      return {
        buildId: b.buildId,
        brokerId: b.brokerId,
        brokerSubdomain: b.brokerSubdomain,
        app: b.app,
        version: b.version,
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        revokedAt: b.revokedAt?.toISOString() ?? null,
        note: b.note,
        expiresAt: at != null ? new Date(at).toISOString() : null,
        expiry: expiryState(at, now),
        features: b.features,
        suspendReason: b.status === "SUSPENDED" ? b.suspendReason : null,
        suspendedAt: b.status === "SUSPENDED" ? (b.suspendedAt?.toISOString() ?? null) : null,
        suspendedBy: b.status === "SUSPENDED" && b.suspendedBy ? (email.get(b.suspendedBy) ?? b.suspendedBy) : null,
        revokeReason: b.status === "REVOKED" ? b.revokeReason : null,
        revokedBy: b.status === "REVOKED" && b.revokedBy ? (email.get(b.revokedBy) ?? b.revokedBy) : null,
        // machine hashes are shown as their first 8 characters only
        machine: bound ? { prefix: machinePrefix(bound), source: b.machineId ? "issued" : "first-report" } : null,
        online: { online: !!b.lastReportAt && now - b.lastReportAt.getTime() <= LICENSE_ONLINE_MS, lastReportAt: b.lastReportAt?.toISOString() ?? null, machine: machinePrefix(b.lastReportMachine) },
        conflict: b.conflictMachine ? { machine: machinePrefix(b.conflictMachine), at: b.conflictAt?.toISOString() ?? null } : null,
      };
    })
  );
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  try {
    const out = await issueBridgeLicense({
      brokerSlug: typeof body?.brokerSlug === "string" ? body.brokerSlug : "",
      machineId: typeof body?.machineId === "string" ? body.machineId : "",
      features: Array.isArray(body?.features) ? body.features.filter((f: unknown): f is string => typeof f === "string") : [],
      expiresDays: typeof body?.expiresDays === "number" ? body.expiresDays : 365,
      note: typeof body?.note === "string" ? body.note : "",
      adminId: session!.adminId,
    });
    return NextResponse.json(out, { status: 201 });
  } catch (e) {
    if (e instanceof BridgeLicenseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
