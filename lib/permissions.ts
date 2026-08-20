import "server-only";
import { prisma } from "@/lib/prisma";
import type { AdminSessionPayload } from "@/lib/auth";
import type { Permission } from "@/lib/permission-labels";

export { PERMISSIONS, PERMISSION_LABELS, type Permission } from "@/lib/permission-labels";

// Fresh DB read on every call, deliberately not baked into the session
// JWT -- admin sessions have no server-side revocation (see
// lib/auth.ts's getAdminSession()), but a Broker Admin revoking a
// delegated permission needs to take effect immediately, not after the
// affected Manager's 7-day token happens to expire. Also catches a
// since-DISABLED admin whose JWT is still technically valid -- a free
// strengthening since this query already runs.
export async function hasPermission(session: AdminSessionPayload | null, permission: Permission): Promise<boolean> {
  if (!session) return false;
  if (session.role === "BROKER_ADMIN") return true; // implicit, not delegated
  if (session.role !== "MANAGER") return false;
  const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { status: true, extraPermissions: true } });
  return !!admin && admin.status === "ACTIVE" && admin.extraPermissions.includes(permission);
}

// One-line replacement for every route's existing
// `!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId`
// gate: true when the caller should be REJECTED.
export async function forbidUnlessBrokerAdminOrPermission(session: AdminSessionPayload | null, permission: Permission): Promise<boolean> {
  if (!session || !session.brokerId) return true;
  if (session.role === "BROKER_ADMIN") return false;
  return !(await hasPermission(session, permission));
}

export type PermissionContext = {
  forbidUnless: (permission: Permission) => boolean; // true = should be rejected
};

// Several routes (funds-requests, risk, kyc-requests, admins, ...) check
// more than one permission per request -- e.g. risk/route.ts's PATCH
// checks EMERGENCY_CONTROLS and RISK_SETTINGS independently depending on
// which fields the body touches. Calling forbidUnlessBrokerAdminOrPermission
// per-check meant a fresh Manager account did a separate
// prisma.adminUser.findUnique for each one, all identical, all in the
// same request -- a real, measured contributor to the multi-second
// per-click delay Manager-role admins were seeing. This fetches the
// account once (still nothing for BROKER_ADMIN, which never needed the
// query) and answers every subsequent check from that one result.
export async function getPermissionContext(session: AdminSessionPayload | null): Promise<PermissionContext> {
  if (!session || !session.brokerId) {
    return { forbidUnless: () => true };
  }
  if (session.role === "BROKER_ADMIN") {
    return { forbidUnless: () => false };
  }
  if (session.role !== "MANAGER") {
    return { forbidUnless: () => true };
  }
  const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { status: true, extraPermissions: true } });
  const granted = new Set(admin && admin.status === "ACTIVE" ? admin.extraPermissions : []);
  return { forbidUnless: (permission) => !granted.has(permission) };
}

