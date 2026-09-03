"use client";

import { ReactNode } from "react";

// Shared accordion header for the right-panel sections (Order ticket,
// Trading sessions, Economic calendar) -- same rotate-chevron mechanics
// as WebTrader.tsx's own watchlist-category header (.wl-category-chevron),
// just not scoped to a single symbol category. A real <button> (not the
// watchlist header's div[role=button]) so it's focusable/keyboard-
// activatable for free, per the collapsible-panel-system brief's own
// "chevrons focusable" requirement.
export default function CollapsibleSection({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="collapsible-section">
      <button type="button" className="collapsible-section-header" aria-expanded={!collapsed} onClick={onToggle}>
        <span className={`wl-category-chevron${collapsed ? " collapsed" : ""}`}>›</span>
        <span>{title}</span>
      </button>
      {collapsed ? null : <div className="collapsible-section-body">{children}</div>}
    </div>
  );
}
