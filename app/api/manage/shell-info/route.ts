import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole, TWO_FACTOR_SETUP_REQUIRED } from "@/lib/auth";
import { allowedBackofficeScreens } from "@/lib/backoffice-screens";
import { PERMISSIONS } from "@/lib/permissions";

// Everything app/manage/(shell)/layout.tsx's Server Component fetches to
// build the sidebar (broker name/logo, signed-in admin's email/role,
// unread notification count) -- exposed as JSON so a bundled desktop
// shell (manager-shell/, which has no Server Component of its own) can
// build the same sidebar. The website keeps using its own server-side
// fetch unchanged; this is additive, not a replacement. canManageFinance
// added for AccountsManager.tsx -- same computation
// app/manage/(shell)/accounts/page.tsx used to do server-side (BROKER_ADMIN,
// or a Manager with the delegated ACCOUNT_FINANCE permission).
//
// Phase 2 batch 4:
// - SUPPORT (the read-only support role) is admitted -- it could sign in but
//   was refused here, so the native backoffice could never open for it.
// - `screens`: the backoffice screen codes this person may open, computed from
//   role + delegated permissions by lib/backoffice-screens.ts (the same rules
//   the routes enforce); the native backoffice builds its menu from it.
// - An ENROLMENT-ONLY session (staff member without 2FA, see lib/auth.ts) gets
//   the minimal identity + `twoFactorSetupRequired: true` and no screens, so the
//   client can show its enrolment step instead of the shell.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const [broker, admin] = await Promise.all([
    prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true, primaryColor: true } }),
    prisma.adminUser.findUnique({ where: { id: session!.adminId }, select: { email: true, theme: true, extraPermissions: true, twoFactorEnabled: true } }),
  ]);
  const identity = {
    brokerName: broker?.name ?? "Backoffice",
    brokerLogoUrl: broker?.logoUrl ?? null,
    brokerPrimaryColor: broker?.primaryColor ?? null,
    adminEmail: admin?.email ?? null,
    role: session!.role,
    // Bundled shells (manager-shell) have no Server Component to read
    // this the way app/manage/layout.tsx does -- see AdminThemeSurface's
    // own usage there for why this needs to come from the DB, not a
    // hardcoded default, or a broker's own light-theme admin always
    // reopens the desktop app back in dark mode.
    theme: admin?.theme === "dark" ? "dark" : "light",
    twoFactorEnabled: admin?.twoFactorEnabled ?? false,
    // 2FA is mandatory for every backoffice staff member (owner decision 2026-09-26)
    twoFactorRequired: true,
    readOnly: session!.role === "SUPPORT",
  };

  if (session!.twoFactorSetupRequired || !admin?.twoFactorEnabled) {
    return NextResponse.json({
      ...identity,
      twoFactorSetupRequired: true,
      code: TWO_FACTOR_SETUP_REQUIRED,
      unreadNotifications: 0,
      canManageFinance: false,
      permissions: [],
      screens: [],
    });
  }

  const extraPermissions = session!.role === "MANAGER" ? admin.extraPermissions : [];
  const permissions =
    session!.role === "BROKER_ADMIN" ? [...PERMISSIONS] : extraPermissions.filter((p) => (PERMISSIONS as readonly string[]).includes(p));
  const unreadNotifications = await prisma.notification.count({ where: { brokerId, readAt: null } });

  return NextResponse.json({
    ...identity,
    twoFactorSetupRequired: false,
    unreadNotifications,
    canManageFinance: session!.role === "BROKER_ADMIN" || permissions.includes("ACCOUNT_FINANCE"),
    // the delegated permissions in force (BROKER_ADMIN: all, implicitly; SUPPORT: none)
    permissions,
    // the backoffice screen codes this person may open, in menu order
    screens: allowedBackofficeScreens(session!.role, extraPermissions),
  });
}
