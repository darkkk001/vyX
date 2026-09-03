import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextAdminShell } from "@/components/admin/NextAdminShell";
import type { AdminNavGroup } from "@/components/admin/AdminShell";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { initialsFrom } from "@/lib/format";

// Mirrors app/manage/(shell)/layout.tsx's shape and reasoning: route
// group so app/(super-admin)/login stays a sibling, never wrapped in
// this shell regardless of session state.
export default async function SuperAdminShellLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    redirect("/login");
  }

  const [admin, unreadNotifications] = await Promise.all([
    prisma.adminUser.findUnique({ where: { id: session!.adminId }, select: { email: true } }),
    prisma.notification.count({ where: { type: "ADMIN_PASSWORD_RESET_REQUESTED", readAt: null } }),
  ]);

  const navGroups: AdminNavGroup[] = [
    {
      label: "Tenants",
      items: [
        { href: "/brokers", label: "All brokers" },
        { href: "/trials", label: "Trials pending" },
      ],
    },
    { label: "Billing", items: [{ href: "/billing", label: "Plans & billing" }] },
    {
      label: "Platform",
      items: [
        { href: "/health", label: "Platform health" },
        { href: "/audit", label: "Audit log" },
        { href: "/security", label: "Security" },
        { href: "/notifications", label: "Notifications", ...(unreadNotifications > 0 ? { badge: unreadNotifications } : {}) },
      ],
    },
  ];

  return (
    <NextAdminShell
      title="vyX Super Admin"
      enableRealtime={false}
      planeTag="PLATFORM CONTROL PLANE"
      pageTitle="Super Admin"
      navGroups={navGroups}
      bottomNavGroup={{ items: [{ href: "/admins", label: "Admins" }] }}
      topbarRight={
        <div className="flex items-center gap-2">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[var(--accent)]/35 bg-[var(--accent-bg)] text-[11px] font-semibold text-[var(--accent)]">
            {initialsFrom(admin?.email ?? "SUPER_ADMIN")}
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold text-[var(--text-1)]">{admin?.email ?? "Super Admin"}</span>
            <span className="text-[10px] text-[var(--text-3)]">Platform Owner</span>
          </div>
          <LogoutButton loginHref="/login">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-3)] hover:text-[var(--sell)]">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </LogoutButton>
        </div>
      }
    >
      {children}
    </NextAdminShell>
  );
}
