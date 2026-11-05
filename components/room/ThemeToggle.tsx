"use client";

import type { MouseEvent } from "react";

// Light / dark switch in the header. The room_theme cookie is what RoomFrame reads, so the choice holds on every load
// with no flash. Both icons are drawn and the theme's CSS shows one, so nothing differs between server and client.
export default function ThemeToggle() {
  function toggle(e: MouseEvent<HTMLButtonElement>) {
    const room = e.currentTarget.closest<HTMLElement>(".room");
    if (!room) return;
    const next = room.dataset.theme === "light" ? "dark" : "light";
    room.dataset.theme = next;
    document.cookie = `room_theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }
  return (
    <button type="button" className="r-icon-btn" aria-label="Switch between light and dark" title="Switch between light and dark" onClick={toggle}>
      <svg className="r-theme-sun" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></svg>
      <svg className="r-theme-moon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" /></svg>
    </button>
  );
}
