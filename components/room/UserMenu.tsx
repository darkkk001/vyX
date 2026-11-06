"use client";

import { useEffect, useRef, useState } from "react";
import { useRoom } from "./RoomData";
import { initials } from "./format";
import { money } from "./format";
import AccountPicker from "./AccountPicker";
import ThemeToggle from "./ThemeToggle";
import { useIsMobile } from "./useIsMobile";

// The client's menu at the right of the top bar: the tier card, the masked name and e-mail, the links. Sign out ends the
// session on the server first (POST /api/portal/logout); the browser only moves on once that worked. On a phone it also
// holds what the top bar has no room for.
type Tier = { current: string; nextReview: string; next: { name: string; minLots: number } | null; lots90: string };

const maskWord = (w: string) => (w.length <= 1 ? w : `${w[0]}${"*".repeat(Math.min(w.length - 1, 5))}`);
export const maskName = (n: string) => n.trim().split(/\s+/).map(maskWord).join(" ");
export function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  if (!domain) return maskWord(e);
  return `${user.slice(0, 2)}${"*".repeat(Math.min(Math.max(user.length - 2, 1), 5))}@${domain}`;
}

function TierCard({ t }: { t: Tier }) {
  const days = Math.max(0, Math.ceil((new Date(t.nextReview).getTime() - Date.now()) / 86_400_000));
  const pct = t.next ? Math.min(100, (Number(t.lots90) / t.next.minLots) * 100) : 100;
  return (
    <a href="/room" className="r-tier-mini" role="menuitem">
      <span style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontFamily: "var(--r-head)", fontSize: 14, fontWeight: 600 }}>{t.current}</span>
        <span style={{ fontSize: 11.5, color: "var(--r-text-2)" }}>{days} {days === 1 ? "day" : "days"} left</span>
      </span>
      <span role="progressbar" aria-label={`Progress to ${t.next?.name ?? "top tier"}`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} style={{ display: "block", height: 5, borderRadius: 3, background: "var(--r-line)", marginTop: 9, overflow: "hidden" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--r-accent)" }} />
      </span>
      <span style={{ display: "block", fontSize: 11, color: "var(--r-muted)", marginTop: 7 }}>{t.next ? `${t.lots90} of ${t.next.minLots} lots to ${t.next.name}` : "Top tier"}</span>
    </a>
  );
}
export default function UserMenu() {
  const { data, selected } = useRoom();
  const mobile = useIsMobile();
  const [tier, setTier] = useState<Tier | null>(null);
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

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/room/tier", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((t) => { if (live && t) setTier(t); }).catch(() => {});
    return () => { live = false; };
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
          {tier ? <TierCard t={tier} /> : null}
          <div style={{ padding: "8px 12px 10px", borderBottom: "1px solid var(--r-line)", marginBottom: 4 }}>
            <div data-masked="name" style={{ fontSize: 13, fontWeight: 600 }}>{maskName(data.client.fullName)}</div>
            <div data-masked="email" className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 3, overflowWrap: "anywhere" }}>{maskEmail(data.client.email)}</div>
          </div>
          {mobile ? (
            <>
              <div style={{ padding: "6px 8px 8px" }}><AccountPicker /></div>
              {selected ? <div className="r-user-row"><span>Balance</span><span className="mono">{money(selected.figures.balance)} {selected.currency}</span></div> : null}
              <div className="r-user-row"><span>Theme</span><ThemeToggle /></div>
            </>
          ) : null}
          <a role="menuitem" href="/room/profile">Profile</a>
          <a role="menuitem" href="/room/specifications">Trading conditions</a>
          <button type="button" role="menuitem" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</button>
          {error ? <div className="r-error" role="status" style={{ padding: "8px 12px" }}>{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
