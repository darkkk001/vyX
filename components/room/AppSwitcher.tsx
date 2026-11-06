"use client";

import { useEffect, useRef, useState } from "react";

// The grid icon beside the avatar: the client's apps.
const APPS = [
  { label: "Client portal", href: "/room", blank: false, d: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" },
  { label: "WebTrader", href: "/trade", blank: true, d: "M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6" },
  { label: "Partnership", href: "/room/partner", blank: false, d: "M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M11.5 7a2 2 0 1 0 0-4M11.5 9.5c1.7.5 2.8 2 2.8 4" },
];

export default function AppSwitcher() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="r-bell" ref={box}>
      <button type="button" className="r-bell-btn" aria-label="Apps" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          {[3, 8, 13].flatMap((y) => [3, 8, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />))}
        </svg>
      </button>
      {open ? (
        <div className="r-apps" role="menu" aria-label="Apps">
          {APPS.map((a) => (
            <a key={a.label} role="menuitem" href={a.href} {...(a.blank ? { target: "_blank", rel: "noopener" } : {})}>
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="var(--r-accent)" strokeWidth="1.3" aria-hidden="true"><path d={a.d} /></svg>
              <span>{a.label}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
