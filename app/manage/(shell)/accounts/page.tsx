import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import AccountsManager from "./AccountsManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. AccountsManager now self-fetches from the
// already-existing /api/manage/accounts GET (extended with
// maxDailyLoss/country/kycStatus), /api/manage/groups GET, and
// /api/manage/shell-info (extended with canManageFinance) instead of
// receiving all three as server-rendered props.
export const metadata: Metadata = { title: "Trading Accounts - Backoffice" };

export default function ManagerAccountsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Trading Accounts" />
      <AccountsManager />
    </main>
  );
}
