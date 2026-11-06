"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomEvent } from "./RoomData";
import { dayTime } from "./format";

// The bell on every Room screen: a list with title, date and an unread dot (GET /api/room/notifications). Opening it marks
// them read on the server; the dots stay until it closes, so the client sees what was new. Esc or a click outside closes.
type Item = { id: string; title: string; body: string; read: boolean; at: string };

export default function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/room/notifications", { cache: "no-store" });
      if (!res.ok) { setFailed(true); return; }
      const body = (await res.json()) as { unread: number; items: Item[] };
      setItems(body.items);
      setUnread(body.unread);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) { await load(); return; }
    await load();
    if (unread === 0) return;
    const res = await fetch("/api/room/notifications", { method: "POST" }).catch(() => null);
    if (res?.ok) setUnread(0);
  }

  return (
    <div ref={box} className="r-bell">
      <button type="button" className="r-bell-btn" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} onClick={() => void toggle()}>
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8.5 2a4 4 0 0 0-4 4c0 3-1.3 4.4-1.3 4.4h10.6S12.5 9 12.5 6a4 4 0 0 0-4-4ZM7 13.5a1.6 1.6 0 0 0 3 0" /></svg>
        {unread > 0 ? <span className="r-bell-count">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="r-bell-panel" role="dialog" aria-label="Notifications">
          <div className="r-label" style={{ padding: "12px 14px 8px" }}>Notifications</div>
          {failed ? <div className="r-note" style={{ padding: "4px 14px 14px" }}>Could not load notifications.</div> : null}
          {!failed && items.length === 0 ? <div className="r-note" style={{ padding: "4px 14px 14px" }}>No notifications</div> : null}
          {items.map((n) => (
            <div key={n.id} className="r-bell-row" data-unread={!n.read} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span aria-label={n.read ? undefined : "Unread"} style={{ width: 7, height: 7, borderRadius: "50%", marginTop: 6, flexShrink: 0, background: n.read ? "transparent" : "var(--r-accent)" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: n.read ? 400 : 600 }}>{n.title}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--r-muted)", marginTop: 4 }}>{dayTime(n.at)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
