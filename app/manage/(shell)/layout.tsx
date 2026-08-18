import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { AdminShell, type AdminNavItem } from "@/components/admin/AdminShell";

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

  const navItems: AdminNavItem[] = [
    { href: "/manage/symbols", label: "Symbols" },
    { href: "/manage/positions", label: "Positions" },
    { href: "/manage/accounts", label: "Accounts" },
    { href: "/manage/groups", label: "Groups" },
  ];
  if (session!.role === "BROKER_ADMIN") {
    navItems.push(
      { href: "/manage/funds", label: "Funds" },
      { href: "/manage/kyc", label: "KYC" },
      { href: "/manage/ib", label: "IB" },
      { href: "/manage/team", label: "Team" }
    );
  }

  return (
    <AdminShell title="VyXTrader Manager" navItems={navItems} userLabel={session!.role}>
      {children}
    </AdminShell>
  );
}
