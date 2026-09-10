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

// {route, required, granted} diagnostic for a route about to 403 --
// `route` is caller-supplied (the route.ts's own file path/name, since
// there's no framework-given way to ask "what route handler is this")
// so a 403 in logs says exactly which permission was missing on which
// endpoint, instead of a bare "forbidden" a developer has to go
// spelunking for. `granted` distinguishes the three real cases: a
// BROKER_ADMIN's implicit all-access, a MANAGER's actual extraPermissions
// list (however small), and "no session at all" (getAdminSession()
// already logs its own reason for that one in lib/auth.ts -- this adds
// the route-level context on top).
function logForbidden(route: string | undefined, required: Permission, session: AdminSessionPayload | null, granted: "ALL (BROKER_ADMIN)" | Permission[] | "NONE (no session)") {
  console.error("[permissions] forbidUnless: rejecting", {
    route: route ?? "(unspecified, pass routeName to getPermissionContext to identify it)",
    required,
    role: session?.role ?? null,
    adminId: session?.adminId ?? null,
    granted,
  });
}

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
export async function getPermissionContext(session: AdminSessionPayload | null, routeName?: string): Promise<PermissionContext> {
  if (!session || !session.brokerId) {
    // getAdminSession() already logged WHY session is null (no cookie,
    // expired Redis entry, or an x-broker-id/tenant mismatch) -- see
    // lib/auth.ts. This case is the one most likely to be misread as "my
    // permissions are wrong" when it's actually "you're not authenticated
    // for this request at all" -- logged here too so the route context
    // (which auth.ts doesn't have) is visible in the same place a caller
    // would go looking for "why did this 403."
    return { forbidUnless: (permission) => { logForbidden(routeName, permission, session, "NONE (no session)"); return true; } };
  }
  if (session.role === "BROKER_ADMIN") {
    return { forbidUnless: () => false };
  }
  if (session.role !== "MANAGER") {
    return { forbidUnless: (permission) => { logForbidden(routeName, permission, session, "NONE (no session)"); return true; } };
  }
  const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { status: true, extraPermissions: true } });
  const grantedList = admin && admin.status === "ACTIVE" ? admin.extraPermissions : [];
  const granted = new Set(grantedList);
  return {
    forbidUnless: (permission) => {
      const denied = !granted.has(permission);
      if (denied) logForbidden(routeName, permission, session, grantedList as Permission[]);
      return denied;
    },
  };
}

