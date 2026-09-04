import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import AuditLogTable from "./AuditLogTable";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx already redirects unauthenticated/wrong-role
// sessions before this page renders at all, and AuditLogTable now
// fetches its own data from /api/admin/audit (which does its own, real
// auth check) instead of being rendered inline here.
export const metadata: Metadata = { title: "Audit log - Super Admin" };

export default function SuperAdminAuditPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Audit log" description="Every platform-level and cross-tenant action, fully logged" />
      <AuditLogTable />
    </main>
  );
}
