import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import HealthManager from "./HealthManager";

// No auth check or Prisma probe here anymore -- app/(super-admin)/
// (shell)/layout.tsx's own SUPER_ADMIN guard is identical to what this
// page checked itself. HealthManager now self-fetches from a new
// /api/admin/health GET running the same live DB timing probe.
export const metadata: Metadata = { title: "Platform health - Super Admin" };

export default function PlatformHealthPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Platform health" description="Service status across the platform" />
      <HealthManager />
    </main>
  );
}
