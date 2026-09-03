"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

type AccountHeader = {
  fullName: string;
  accountNumber: string;
  email: string;
  accountMode: string;
  accountTypeName: string | null;
  status: string;
  groupName: string | null;
  kycStatus: string | null;
};

type TimelineRow = { kind: string; tone: "success" | "danger" | "warning" | "neutral" | "info" | "accent"; summary: string; timeLabel: string; entityId?: string };

// Self-fetches from a new /api/manage/accounts/[id]/activity GET instead
// of a dynamic-route Server Component -- a bundled manager-shell desktop
// app has no real routing to give this its own URL, so it's rendered
// inline (in-memory "selected account" state, same pattern App.tsx uses
// for section switching) instead of navigating to /manage/accounts/{id}.
// backLink defaults to a real page navigation for the website (this
// component's original behavior); the shell overrides it with a local
// state reset instead.
export default function ClientActivityView({ accountId, backLink }: { accountId: string; backLink?: () => void }) {
  const [data, setData] = useState<{ account: AccountHeader; timeline: TimelineRow[] } | null | "not-found">(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/manage/accounts/${accountId}/activity`)
      .then((r) => {
        if (r.status === 404) return "not-found" as const;
        return r.json();
      })
      .then(setData)
      .catch(() => setData("not-found"));
  }, [accountId]);

  // Omni-search's "order/position/transaction ID -> that record in
  // context" destination -- ?highlight=<id> in the URL. Read via
  // window.location directly (not next/navigation's useSearchParams):
  // this component also bundles into manager-tauri's Vite shell, which
  // has no Next.js router to satisfy that hook's Suspense requirement.
  useEffect(() => {
    if (data === null || data === "not-found") return;
    const highlight = new URLSearchParams(window.location.search).get("highlight");
    if (!highlight) return;
    const el = document.getElementById(`activity-row-${highlight}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Inline style, not a Tailwind/CSS class -- this admin area has no
    // stylesheet of its own to add a one-off animation class to, and a
    // plain style + transition does the same "flash then fade" job.
    el.style.transition = "background-color 2s ease";
    el.style.backgroundColor = "var(--accent-bg)";
    const timer = setTimeout(() => { el.style.backgroundColor = ""; }, 2000);
    return () => clearTimeout(timer);
  }, [data]);

  if (data === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }
  if (data === "not-found") {
    return <p className="text-sm text-[var(--sell)]">Account not found.</p>;
  }

  const { account, timeline } = data;

  return (
    <main className="mx-auto max-w-[1000px]">
      <PageHeader
        title={`${account.fullName} — ${account.accountNumber}`}
        description={`${account.email} · ${account.accountMode} · ${account.status} · Group: ${account.groupName ?? "ungrouped"} · KYC: ${account.kycStatus ?? "none"}`}
        action={account.accountTypeName ? <Badge tone="accent">{account.accountTypeName}</Badge> : null}
      />
      <p className="mb-4">
        {backLink ? (
          <button type="button" onClick={backLink} className="text-sm text-[var(--accent)] hover:underline">
            ← Back to Accounts
          </button>
        ) : (
          // Plain <a> deliberately, not next/link's <Link>: this component must
          // also import cleanly into manager-shell's Vite bundle, which has no next/link.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a href="/manage/accounts" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to Accounts
          </a>
        )}
      </p>
      <Table title="Activity" description="Most recent 50 of each type, merged and sorted by time.">
        <TableHead>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Details</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {timeline.length === 0 ? (
            <TableEmptyState colSpan={3}>No activity yet.</TableEmptyState>
          ) : (
            timeline.map((row, i) => (
              <TableRow key={i} id={row.entityId ? `activity-row-${row.entityId}` : undefined}>
                <TableCell>
                  <Badge tone={row.tone}>{row.kind}</Badge>
                </TableCell>
                <TableCell className="text-sm">{row.summary}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.timeLabel}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
