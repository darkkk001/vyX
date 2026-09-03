import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import FeedHealthManager from "./FeedHealthManager";

// No auth check or internal-service probe here anymore -- app/manage/
// (shell)/layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to
// what this page checked itself. FeedHealthManager now self-fetches from
// a new /api/manage/feed-health GET running the same two probes.
export const metadata: Metadata = { title: "Feed health — Backoffice" };

export default function ManagerFeedHealthPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader
        title="Feed health"
        description="Tick-pipeline latency and health, end to end. Not deployed publicly yet -- see the Tick Pipeline Audit -- so this shows real numbers only against a local dev stack."
      />
      <FeedHealthManager />
    </main>
  );
}
