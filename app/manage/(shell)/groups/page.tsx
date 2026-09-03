import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import GroupsManager from "./GroupsManager";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. GroupsManager now self-fetches from the
// already-existing /api/manage/groups GET (fixed to include
// forceDealingMode, which it was missing, and to return "" instead of
// null for an unset maxLotSize, matching this page's own prior mapping).
export const metadata: Metadata = { title: "Groups — Backoffice" };

export default function ManagerGroupsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Groups"
        description="Settings templates for accounts — assigning an account to a group applies the group's leverage to that account immediately. Margin-call/stop-out levels are stored here but not yet enforced by the trading engine."
      />
      <GroupsManager />
    </main>
  );
}
