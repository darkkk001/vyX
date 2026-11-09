import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { BridgeLicenseError, changeBridgeLicenseStatus, type BridgeLicenseAction } from "@/lib/bridge-licenses";

// POST /api/admin/bridge-licenses/<licenseId> { action: "suspend" | "resume" | "revoke", reason }, Super Admin only
// (license enforcement 1.2, C:\vyx\handoff\license-enforcement-contract.md sections 1 and 5).
//   suspend  ACTIVE -> SUSPENDED, reversible. reason REQUIRED (max 200): the bridge holds new hedges, closes still go out
//   resume   SUSPENDED -> ACTIVE (reason optional)
//   revoke   ACTIVE | SUSPENDED -> REVOKED, permanent (reason REQUIRED): only a new license brings the bridge back
// Each writes an AuditLog row (actor = this admin, the reason), shows in that broker's dealer FEED, and nudges the bridge
// (bridge.license.<brokerId>). 409 when the license is not in a state the action applies to.
export async function POST(request: NextRequest, { params }: { params: Promise<{ licenseId: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { licenseId } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action === "suspend" || body?.action === "resume" || body?.action === "revoke" ? (body.action as BridgeLicenseAction) : null;
  if (!action) return NextResponse.json({ error: "action must be suspend, resume or revoke" }, { status: 400 });
  if (body?.reason !== undefined && typeof body.reason !== "string") return NextResponse.json({ error: "reason must be text" }, { status: 400 });
  try {
    const row = await changeBridgeLicenseStatus({ licenseId, action, reason: body?.reason ?? "", adminId: session!.adminId });
    return NextResponse.json({ licenseId: row.buildId, status: row.status });
  } catch (e) {
    if (e instanceof BridgeLicenseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
