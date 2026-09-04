import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import AuditLogTable from "./AuditLogTable";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx already redirects unauthenticated/wrong-role sessions
// before this page renders at all, and AuditLogTable now fetches its
// own data from /api/manage/audit (which does its own, real auth check)
// instead of receiving server-rendered rows as props -- the one path
// both the website and a bundled desktop shell (manager-shell/, which
// has no Server Component to pre-fetch anything) can share.
export const metadata: Metadata = { title: "Audit log - Backoffice" };

export default function ManagerAuditPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Audit log" description="Every sensitive action taken by broker staff, fully logged. Double-click a row to open what it changed." />
      <AuditLogTable />
    </main>
  );
}
