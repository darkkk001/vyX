import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextAdminShell } from "@/components/admin/NextAdminShell";
import type { AdminNavGroup } from "@/components/admin/AdminShell";
import { TopbarSearch } from "@/components/admin/TopbarSearch";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { initialsFrom } from "@/lib/format";

// Everything under app/manage/(shell)/* requires a signed-in MANAGER/
// BROKER_ADMIN session -- route group (invisible in the URL) so
// app/manage/login stays a sibling, never wrapped in this shell
// regardless of session state (fixes a real bug: an authenticated
// session previously made the parent layout wrap /manage/login in the
// sidebar too, rendering the shell AND the login form at once).
export default async function ManageShellLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const [broker, admin, unreadNotifications] = await Promise.all([
    prisma.broker.findUnique({ where: { id: session!.brokerId! }, select: { name: true, primaryColor: true, logoUrl: true } }),
    prisma.adminUser.findUnique({ where: { id: session!.adminId }, select: { email: true } }),
    prisma.notification.count({ where: { brokerId: session!.brokerId!, readAt: null } }),
  ]);

  const isBrokerAdmin = session!.role === "BROKER_ADMIN";

  const navGroups: AdminNavGroup[] = [
    {
      label: "Overview",
      items: [
        { href: "/manage/dashboard", label: "Dashboard" },
        { href: "/manage/notifications", label: "Notifications", ...(unreadNotifications > 0 ? { badge: unreadNotifications } : {}) },
      ],
    },
    {
      label: "Clients",
      items: [
        { href: "/manage/accounts", label: "Trading Accounts" },
        { href: "/manage/leads", label: "Leads" },
        ...(isBrokerAdmin ? [{ href: "/manage/kyc", label: "KYC review" }] : []),
      ],
    },
    ...(isBrokerAdmin
      ? [
          {
            label: "Finance",
            items: [
              { href: "/manage/funds", label: "Deposits & withdrawals" },
              { href: "/manage/transfers", label: "Internal transfers" },
              { href: "/manage/wallets", label: "Wallets" },
              { href: "/manage/ib", label: "IB & affiliates" },
            ],
          } satisfies AdminNavGroup,
        ]
      : [{ label: "Finance", items: [{ href: "/manage/wallets", label: "Wallets" }] } satisfies AdminNavGroup]),
    {
      label: "Trading",
      items: [
        { href: "/manage/positions", label: "Live Exposure" },
        { href: "/manage/dealing", label: "Dealing queue" },
        { href: "/manage/feed-health", label: "Feed health" },
        { href: "/manage/deals", label: "Deals" },
        { href: "/manage/symbols", label: "Symbols" },
        { href: "/manage/groups", label: "Client groups" },
        { href: "/manage/margin", label: "Margin monitoring" },
        ...(isBrokerAdmin ? [{ href: "/manage/risk", label: "Risk rules" }, { href: "/manage/emergency", label: "Emergency controls" }] : []),
      ],
    },
    ...(isBrokerAdmin
      ? [
          {
            label: "Liquidity",
            items: [
              { href: "/manage/liquidity", label: "LPs" },
              { href: "/manage/liquidity-routing", label: "Routing" },
            ],
          } satisfies AdminNavGroup,
        ]
      : []),
    {
      label: "Organization",
      items: [
        { href: "/manage/reports", label: "Reports" },
        ...(isBrokerAdmin ? [{ href: "/manage/team", label: "Staff & roles" }] : []),
        { href: "/manage/audit", label: "Audit log" },
        ...(isBrokerAdmin ? [{ href: "/manage/settings", label: "System settings" }] : []),
      ],
    },
  ];

  return (
    <NextAdminShell
      title={broker?.name ?? "Backoffice"}
      logoUrl={broker?.logoUrl}
      pageTitle="Backoffice"
      navGroups={navGroups}
      topbarSearch={<TopbarSearch placeholder="Search clients, transactions…" />}
      topbarRight={
        <>
          {/* No repeated broker name/initials pill here -- the sidebar's
              own logoUrl/title (above) already shows the broker's
              branding at top-left; this side is the signed-in admin. */}
          <div className="flex items-center gap-2">
            <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-3)] text-[11px] font-semibold text-[var(--text-2)]">
              {initialsFrom(admin?.email ?? session!.role)}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-semibold text-[var(--text-1)]">{admin?.email ?? session!.role}</span>
              <span className="text-[10px] text-[var(--text-3)]">
                {session!.role === "BROKER_ADMIN" ? "Broker Admin" : "Manager"}
              </span>
            </div>
            <LogoutButton loginHref="/manage/login">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-3)] hover:text-[var(--sell)]">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </LogoutButton>
          </div>
        </>
      }
    >
      {children}
    </NextAdminShell>
  );
}
