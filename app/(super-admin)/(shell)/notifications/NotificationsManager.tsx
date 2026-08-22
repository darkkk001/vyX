"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Alert } from "@/components/ui/Alert";

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  brokerName: string;
  entityType: string | null;
  entityId: string | null;
  read: boolean;
  createdAt: string;
};

// Mirrors app/manage/(shell)/notifications/NotificationsManager.tsx --
// same reset-password-inline pattern, targeting AdminUser (broker
// backoffice staff) instead of Account.
export default function NotificationsManager({ initialRows }: { initialRows: NotificationRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<NotificationRow | null>(null);
  const [resetResult, setResetResult] = useState<{ password: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const unreadCount = initialRows.filter((r) => !r.read).length;

  async function markRead(id: string) {
    await fetch(`/api/admin/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    router.refresh();
  }

  async function markAllRead() {
    setBusy(true);
    await fetch("/api/admin/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    });
    setBusy(false);
    router.refresh();
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
    const response = await fetch(`/api/admin/admins/${resetTarget.entityId}/reset-password`, { method: "POST" });
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
        {initialRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--text-3)]">No password-reset requests.</p>
        ) : (
          initialRows.map((row) => (
            <div
              key={row.id}
              className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 ${row.read ? "border-[var(--border)] bg-[var(--bg-1)]" : "border-[var(--accent)] bg-[var(--accent-bg)]"}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={row.read ? "neutral" : "accent"}>{row.brokerName}</Badge>
                  <span className="text-sm font-semibold text-[var(--text-1)]">{row.title}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--text-2)]">{row.body}</p>
                <p className="mt-1 text-xs text-[var(--text-3)]">{row.createdAt}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.entityId ? (
                  <Button size="sm" variant="primary" onClick={() => openReset(row)}>
                    Reset password
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

      <Modal open={resetTarget !== null} onClose={() => setResetTarget(null)} title="Reset backoffice password">
        {resetTarget ? (
          <div className="flex flex-col gap-3">
            {resetResult ? (
              <>
                <Alert tone="success">Password reset. Share this with them now -- it will not be shown again.</Alert>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-center font-mono text-lg text-[var(--text-1)]">
                  {resetResult.password}
                </div>
                <Button variant="primary" onClick={() => { setResetTarget(null); router.refresh(); }}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--text-2)]">
                  Generates a new random password for this backoffice account and shows it once. Tell them directly
                  (phone, secure channel) -- it isn&apos;t emailed automatically.
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
