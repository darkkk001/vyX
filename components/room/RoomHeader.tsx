"use client";

import type { ReactNode } from "react";
import { useRoom } from "./RoomData";
import NotificationBell from "./NotificationBell";
import ThemeToggle from "./ThemeToggle";
import AppSwitcher from "./AppSwitcher";
import UserMenu from "./UserMenu";
import WalletBalance from "./WalletBalance";
import { useIsMobile } from "./useIsMobile";

// The page header on every Trader's Room screen: title, the funding wallet's balance (nothing account-specific), then
// theme, bell, apps, avatar.
// `right` replaces the picker on screens whose artboard shows something else there (Support's "New ticket").
// On a phone the bar is one row: menu, title, bell, apps, avatar. The picker, the balance and the theme move into the
// avatar menu, and `right` (a screen's own controls) sits just under the bar.
export default function RoomHeader({ title, right, picker = true }: { title: string; right?: ReactNode; picker?: boolean }) {
  const { data } = useRoom();
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <>
        <header className="r-head r-head-m">
          <button type="button" className="r-menu-btn" aria-label="Open menu" onClick={() => window.dispatchEvent(new Event("room:nav"))}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" /></svg>
          </button>
          <h1>{title}</h1>
          <NotificationBell />
          <AppSwitcher />
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
        {picker && data ? <WalletBalance /> : null}
        <ThemeToggle />
        <NotificationBell />
        <AppSwitcher />
        <UserMenu />
      </div>
    </header>
  );
}
