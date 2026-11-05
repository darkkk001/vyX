"use client";

import { useEffect, useRef, useState } from "react";
import { useRoom } from "./RoomData";
import { initials } from "./format";
import AccountPicker from "./AccountPicker";
import NotificationBell from "./NotificationBell";
import ThemeToggle from "./ThemeToggle";
import { useIsMobile } from "./useIsMobile";

// The client's menu at the right of the top bar. Sign out ends the session on the server first (POST /api/portal/logout);
// the browser only moves on once that worked. On a phone it also holds what the top bar has no room for.
export default function UserMenu() {
  const { data } = useRoom();
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal/logout", { method: "POST" });
      if (res.ok) { window.location.assign("/login"); return; }
      setError("Could not sign out. Try again.");
    } catch {
      setError("No connection. Try again.");
    }
    setBusy(false);
  }

  if (!data) return null;
  return (
    <div className="r-user" ref={box}>
      <button type="button" className="r-user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="r-avatar">{initials(data.client.fullName)}</span>
        <span className="r-user-name">{data.client.fullName}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--r-muted)" strokeWidth="1.5" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {open ? (
        <div className="r-user-menu" role="menu">
          {mobile ? (
            <>
              <div style={{ padding: "6px 8px 8px" }}><AccountPicker /></div>
              <div className="r-user-row"><span>Theme</span><ThemeToggle /></div>
              <div className="r-user-row"><span>Notifications</span><NotificationBell /></div>
            </>
          ) : null}
          <a role="menuitem" href="/room/profile">Profile</a>
          <button type="button" role="menuitem" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</button>
          {error ? <div className="r-error" role="status" style={{ padding: "8px 12px" }}>{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
