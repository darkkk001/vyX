"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

type AdminSession = {
  sessionId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
};

// Redis-backed admin session list/revoke (docs/authentication.md §2) --
// same shape as the trader terminal's own Security panel session list
// (components/webtrader/WebTrader.tsx), ported here so it's shared by
// both Manager's and Super Admin's own Security pages instead of building
// it twice. Self-fetches from /api/admin/sessions -- works unmodified in
// a bundled admin-shell/manager-shell desktop app too, same "no Server
// Component of its own" reasoning every other *Manager.tsx component here
// already follows.
// onLoggedOut defaults to a hard navigation to loginHref (the website's
// real behavior) -- kept as a plain optional callback, same "callback
// with a hard-nav default" pattern already established by LogoutButton
// and AccountsManager's own onOpenAccount, so a bundled desktop shell
// (manager-shell/, admin-shell/ -- no real /login route to navigate to)
// can override it to reset its own local logged-out state instead.
export default function AdminSessionsCard({
  loginHref,
  onLoggedOut,
}: {
  loginHref: string;
  onLoggedOut?: () => void;
}) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch("/api/admin/sessions")
      .then((r) => r.json())
      .then((rows: AdminSession[]) => setSessions(rows))
      .catch(() => setLoadError("failed to load sessions"));
  }

  useEffect(load, []);

  async function revoke(session: AdminSession) {
    setRevokingId(session.sessionId);
    setError(null);
    const res = await fetch(`/api/admin/sessions/${session.sessionId}`, { method: "DELETE" });
    setRevokingId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "failed to revoke session");
      return;
    }
    if (session.current) {
      // Same as logging out -- the current session's own token was just
      // deleted server-side, so there's nothing left to stay signed in
      // with.
      if (onLoggedOut) {
        onLoggedOut();
      } else {
        window.location.href = loginHref;
      }
      return;
    }
    load();
  }

  return (
    <Card title="Active sessions" description="Every device currently signed in to this admin account.">
      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {sessions === null ? (
        loadError ? <Alert tone="danger">{loadError}</Alert> : <p className="text-sm text-[var(--text-3)]">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No active sessions found.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div>
                <div className="text-xs text-[var(--text-1)]">
                  {s.userAgent ? s.userAgent.slice(0, 60) : "Unknown device"}
                  {s.current ? <span className="ml-2 text-[var(--buy)]">(this device)</span> : null}
                </div>
                <div className="font-mono text-[11px] text-[var(--text-3)]">
                  {s.ip ?? "unknown IP"} ·{" "}
                  {new Date(s.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <Button
                type="button"
                variant={s.current ? "secondary" : "danger"}
                size="sm"
                loading={revokingId === s.sessionId}
                onClick={() => revoke(s)}
              >
                {s.current ? "Log out" : "Revoke"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
