import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { AdminShell, type AdminNavItem } from "@/components/admin/AdminShell";

// Mirrors app/manage/(shell)/layout.tsx's shape and reasoning: route
// group so app/(super-admin)/login stays a sibling, never wrapped in
// this shell regardless of session state.
export default async function SuperAdminShellLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    redirect("/login");
  }

  const navItems: AdminNavItem[] = [
    { href: "/brokers", label: "Brokers" },
    { href: "/admins", label: "Admins" },
  ];

  return (
    <AdminShell title="VyXTrader Super Admin" navItems={navItems} userLabel={session!.role}>
      {children}
    </AdminShell>
  );
}
