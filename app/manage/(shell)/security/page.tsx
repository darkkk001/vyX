import { PageHeader } from "@/components/ui/PageHeader";
import ManagerSecurityManager from "./ManagerSecurityManager";

// No auth check or Prisma query here -- app/manage/(shell)/layout.tsx's
// own MANAGER/BROKER_ADMIN guard already covers every role that can reach
// this page. Self-service only (this admin's own sessions), same as the
// Super Admin equivalent (app/(super-admin)/(shell)/security).
export default function ManagerSecurityPage() {
  return (
    <main className="mx-auto max-w-[720px]">
      <PageHeader title="Security" description="Devices currently signed in to your admin account." />
      <ManagerSecurityManager />
    </main>
  );
}
