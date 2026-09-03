"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Alert } from "@/components/ui/Alert";
import { formatDateTime } from "@/lib/format";

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  read: boolean;
  createdAt: string;
};

// Which Manager section a notification's type should jump to -- every
// type except PASSWORD_RESET_REQUESTED (handled inline below with its
// own dedicated action) previously had no click-through at all, so
// clicking e.g. a "new order awaiting confirmation" notification did
// nothing beyond what "Mark read" already did. Keys must match the
// exact `type` string each createNotification() call site uses (see
// app/api/trade/{orders,kyc,funds-requests}/route.ts,
// app/api/manage/leads/route.ts).
const SECTION_FOR_TYPE: Record<string, string> = {
  DEALING_ORDER_PENDING: "/manage/dealing",
  KYC_SUBMITTED: "/manage/kyc",
  NEW_LEAD: "/manage/leads",
  FUNDS_REQUEST: "/manage/funds",
};

// Self-fetches from the already-existing /api/manage/notifications GET
// (returns this exact shape, unmodified) instead of receiving rows as a
// server-rendered prop -- both the website and a bundled manager-shell
// desktop app (no Server Component of its own) share this one path now.
export default function NotificationsManager({
  onNavigateToSection = (section) => {
    window.location.href = section;
  },
  onMutated = () => {},
}: {
  // Same "callback with a hard-nav default" pattern as AccountsManager's
  // onOpenAccount/LogoutButton's onLoggedOut -- the website's hard nav
  // is a full page load (fine, notifications aren't clicked often); a
  // bundled shell passes its own section-switch instead.
  onNavigateToSection?: (section: string) => void;
  // Fired after markRead/markAllRead actually change something server-side
  // -- app/manage/(shell)/layout.tsx computes the sidebar's unread-count
  // badge server-side once per navigation (a Server Component, no
  // subscription to this page's own state), so without this the badge
  // stayed stuck at whatever count was true when the layout last
  // rendered, no matter how many notifications got marked read here.
  // This component stays framework-agnostic (no next/navigation import --
  // manager-shell/admin-shell bundle it directly with no `next` package
  // at all, same reasoning as NextAdminShell.tsx's own split): the
  // website's page.tsx passes `() => router.refresh()`, manager-shell/
  // admin-shell's App.tsx pass their own shellInfo reload.
  onMutated?: () => void;
} = {}) {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<NotificationRow | null>(null);
  const [resetResult, setResetResult] = useState<{ password: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  function load() {
    return fetch("/api/manage/notifications")
      .then((r) => r.json())
      .then((d: NotificationRow[]) => setRows(d.map((n) => ({ ...n, createdAt: formatDateTime(n.createdAt) }))));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  const unreadCount = (rows ?? []).filter((r) => !r.read).length;

  async function markRead(id: string) {
    await fetch(`/api/manage/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    load().catch(() => {});
    onMutated();
  }

  async function markAllRead() {
    setBusy(true);
    await fetch("/api/manage/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    });
    setBusy(false);
    load().catch(() => {});
    onMutated();
  }

  function openReset(row: NotificationRow) {
    setResetTarget(row);
    setResetResult(null);
    setResetError(null);
  }

  async function confirmReset() {
    if (!resetTarget?.entityId) return;
    setResetting(true);
    setResetError(null);
    const response = await fetch(`/api/manage/accounts/${resetTarget.entityId}/reset-password`, { method: "POST" });
    setResetting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setResetError(body.error ?? "failed to reset password");
      return;
    }
    const body = await response.json();
    setResetResult({ password: body.password });
    await markRead(resetTarget.id);
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {unreadCount > 0 ? (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" disabled={busy} onClick={markAllRead}>
            Mark all read ({unreadCount})
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--text-3)]">No notifications yet.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 ${row.read ? "border-[var(--border)] bg-[var(--bg-1)]" : "border-[var(--accent)] bg-[var(--accent-bg)]"}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={row.read ? "neutral" : "accent"}>{row.type.replace(/_/g, " ")}</Badge>
                  <span className="text-sm font-semibold text-[var(--text-1)]">{row.title}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--text-2)]">{row.body}</p>
                <p className="mt-1 text-xs text-[var(--text-3)]">{row.createdAt}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.type === "PASSWORD_RESET_REQUESTED" && row.entityId ? (
                  <Button size="sm" variant="primary" onClick={() => openReset(row)}>
                    Reset password
                  </Button>
                ) : SECTION_FOR_TYPE[row.type] ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      if (!row.read) markRead(row.id).catch(() => {});
                      onNavigateToSection(SECTION_FOR_TYPE[row.type]);
                    }}
                  >
                    View
                  </Button>
                ) : null}
                {!row.read ? (
                  <Button size="sm" variant="ghost" onClick={() => markRead(row.id)}>
                    Mark read
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <Modal open={resetTarget !== null} onClose={() => setResetTarget(null)} title="Reset trader password">
        {resetTarget ? (
          <div className="flex flex-col gap-3">
            {resetResult ? (
              <>
                <Alert tone="success">Password reset. Share this with the trader now -- it will not be shown again.</Alert>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-center font-mono text-lg text-[var(--text-1)]">
                  {resetResult.password}
                </div>
                <Button variant="primary" onClick={() => { setResetTarget(null); load().catch(() => {}); }}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--text-2)]">
                  Generates a new random password for this account and shows it once. The trader will need to be told the
                  new password directly (phone, secure channel) -- it isn&apos;t emailed automatically.
                </p>
                {resetError ? <Alert tone="danger">{resetError}</Alert> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setResetTarget(null)}>
                    Cancel
                  </Button>
                  <Button variant="primary" loading={resetting} onClick={confirmReset}>
                    Generate new password
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
