import { PageHeader } from "@/components/ui/PageHeader";
import WalletsManager from "./WalletsManager";

// A view of each account's existing balance/credit -- not a separate
// multi-currency wallet system, which would need a Client entity above
// Account this schema deliberately doesn't have (see Account's own
// schema comment). Confirmed with the user.
//
// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. WalletsManager now fetches its own data
// from the already-existing /api/manage/accounts route.
export default function ManagerWalletsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Wallets" description="Balance and credit per account." />
      <WalletsManager />
    </main>
  );
}
