import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import SecurityManager from "@/components/admin/SecurityManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN-only guard is identical to what
// this page checked itself, so it's not redundant to remove (unlike
// app/manage/(shell)/settings/page.tsx, which kept its own stricter
// check -- see that commit). SecurityManager now fetches its own state
// from /api/admin/two-factor/status.
export const metadata: Metadata = { title: "Security - Super Admin" };

export default function SuperAdminSecurityPage() {
  return (
    <main className="mx-auto max-w-[720px]">
      <PageHeader
        title="Security"
        description="This login is the only way in to platform-wide control -- every broker's tenants, billing, and admin accounts. Two-factor authentication is strongly recommended."
      />
      <SecurityManager />
    </main>
  );
}
