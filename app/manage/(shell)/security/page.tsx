import { PageHeader } from "@/components/ui/PageHeader";
import SecurityManager from "@/components/admin/SecurityManager";

// No auth check here -- app/manage/(shell)/layout.tsx's own MANAGER/
// BROKER_ADMIN/SUPPORT guard already covers this route, and it's also
// the one route that guard redirects TO (both for SUPPORT, which has no
// other page yet, and for Broker.requireAdmin2fa's forced-setup case),
// so an additional check here would risk fighting its own redirect
// target. setupRequired is a plain search param, not session state --
// SecurityManager only uses it to decide whether to show the "your
// organization requires this" banner, never to skip real verification.
export default async function ManagerSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ setupRequired?: string }>;
}) {
  const { setupRequired } = await searchParams;

  return (
    <main className="mx-auto max-w-[720px]">
      <PageHeader title="Security" description="Two-factor authentication and devices signed in to your admin account." />
      <SecurityManager forceSetup={setupRequired === "1"} loginHref="/manage/login" />
    </main>
  );
}
