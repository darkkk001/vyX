"use client";

import type { ReactNode } from "react";
import { useRoom } from "./RoomData";
import NotificationBell from "./NotificationBell";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import AccountPicker from "./AccountPicker";
import { useIsMobile } from "./useIsMobile";
import { money } from "./format";

// The page header on every Trader's Room screen: title, the account picker, its balance. `right` replaces the picker
// on screens whose artboard shows something else there (Support's "New ticket", Profile's "Sign out"). `bell` adds the
// notifications bell, on the screens whose artboard shows it (Dashboard).
// On a phone the bar is one row: menu, title, balance, avatar. The picker, theme and notifications move into the avatar
// menu, and `right` (a screen's own controls) sits just under the bar.
export default function RoomHeader({ title, right, picker = true, bell = false }: { title: string; right?: ReactNode; picker?: boolean; bell?: boolean }) {
  const { data, selected } = useRoom();
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <>
        <header className="r-head r-head-m">
          <button type="button" className="r-menu-btn" aria-label="Open menu" onClick={() => window.dispatchEvent(new Event("room:nav"))}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" /></svg>
          </button>
          <h1>{title}</h1>
          {selected ? <span className="r-head-bal">{money(selected.figures.balance)}</span> : null}
          <UserMenu />
        </header>
        {right ? <div className="r-head-page">{right}</div> : null}
      </>
    );
  }
  return (
    <header className="r-head">
      <h1>{title}</h1>
      <div className="r-head-right">
        {right}
        {picker && data && data.accounts.length > 0 ? (
          <>
            <AccountPicker />
            {selected ? (
              <span className="r-head-bal">{money(selected.figures.balance)} <span style={{ color: "var(--r-muted)", fontWeight: 400 }}>{selected.currency}</span></span>
            ) : null}
          </>
        ) : null}
        <ThemeToggle />
        {bell ? <NotificationBell /> : null}
        <UserMenu />
      </div>
    </header>
  );
}
