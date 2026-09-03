import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import AdminsManager from "./AdminsManager";

// No auth check or Prisma query here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN guard is identical to what this
// page checked itself. AdminsManager now self-fetches the admin list and
// broker options from the already-existing /api/admin/admins and
// /api/admin/brokers GETs instead of both being server-rendered props.
export const metadata: Metadata = { title: "Admins — Super Admin" };

export default function AdminsPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Admins" description="Broker-scoped admin accounts across every tenant" />
      <AdminsManager />
    </main>
  );
}
