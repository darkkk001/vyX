import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { listClientBuilds } from "@/lib/client-builds";
import { bridgeLicenseExpiries, BridgeLicenseError, expiryState, issueBridgeLicense } from "@/lib/bridge-licenses";

// QoreBridge licenses, Super Admin only (owner 2026-10-23).
//   GET                                            -> every bridge license (newest first); revoke / reinstate with
//                                                     PATCH /api/admin/client-builds { buildId: licenseId, status }
//   POST { brokerSlug, machineId, features, expiresDays?, note? } -> issues one: { licenseId, expiresAt, file }
//        `file` is the qorebridge.license contents (signed; contains no secret that opens anything but the bridge's
//        own status reports). machineId = what `qorebridge.exe --machine-id` prints on the broker's server.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const all = (await listClientBuilds()).filter((b) => b.app === "bridge");
  const expiries = await bridgeLicenseExpiries(all.map((b) => b.buildId));
  return NextResponse.json(
    all.map((b) => {
      const at = expiries.get(b.buildId) ?? null;
      return { ...b, expiresAt: at != null ? new Date(at).toISOString() : null, expiry: expiryState(at) };
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
