"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

type AccountHeader = {
  fullName: string;
  accountNumber: string;
  email: string;
  accountType: string;
  status: string;
  groupName: string | null;
  kycStatus: string | null;
};

type TimelineRow = { kind: string; tone: "success" | "danger" | "warning" | "neutral" | "info" | "accent"; summary: string; timeLabel: string };

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
        description={`${account.email} · ${account.accountType} · ${account.status} · Group: ${account.groupName ?? "ungrouped"} · KYC: ${account.kycStatus ?? "none"}`}
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
              <TableRow key={i}>
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
