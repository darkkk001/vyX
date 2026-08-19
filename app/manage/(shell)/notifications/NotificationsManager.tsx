"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

export default function NotificationsManager({ initialRows }: { initialRows: NotificationRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unreadCount = initialRows.filter((r) => !r.read).length;

  async function markRead(id: string) {
    await fetch(`/api/manage/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    router.refresh();
  }

  async function markAllRead() {
    setBusy(true);
    await fetch("/api/manage/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    });
    setBusy(false);
    router.refresh();
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
          <p className="py-8 text-center text-sm text-[var(--text-3)]">No notifications yet.</p>
        ) : (
          initialRows.map((row) => (
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
              {!row.read ? (
                <Button size="sm" variant="ghost" onClick={() => markRead(row.id)}>
                  Mark read
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
