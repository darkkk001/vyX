"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// Backoffice (Manager + Super Admin) light/dark theme -- the same
// data-attribute/CSS-token pattern as components/webtrader's own
// data-mode="light" on .wt-root (app/(broker)/trade/webtrader.css), just
// split across two files because the [data-surface] element (set by
// app/manage/layout.tsx / app/(super-admin)/layout.tsx) is an ancestor
// of components/admin/AdminShell.tsx's header (where the sun/moon toggle
// actually lives, several route-group layouts deeper). AdminThemeSurface
// owns both the data-mode attribute AND the context value from the same
// piece of state, so they can never drift apart the way two independently
// synced states could.
//
// Persisted server-side on AdminUser.theme (see that field's schema
// comment) via PATCH /api/manage/theme or /api/admin/theme -- not
// localStorage, matching ChartSettings.theme's own "per-account, not
// per-browser" reasoning. Defaults "light" for a session-less request
// (the login pages) or an admin who has never toggled, same override
// rule every other "saved value beats default" field in this codebase
// follows.
export type AdminThemeMode = "dark" | "light";

type AdminThemeContextValue = {
  mode: AdminThemeMode;
  toggle: () => void;
};

const AdminThemeContext = createContext<AdminThemeContextValue | null>(null);

export function AdminThemeSurface({
  surface,
  initialMode,
  saveUrl,
  className,
  children,
}: {
  surface: "manager" | "super-admin";
  initialMode: AdminThemeMode;
  saveUrl: string;
  className?: string;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<AdminThemeMode>(initialMode);

  // Optimistic save, same shape as WebTrader.tsx's changeColorMode: flip
  // local state immediately, fire the PATCH, toast-free failure (a
  // dropped save just means the next page load falls back to whatever
  // was last persisted -- acceptable for a cosmetic preference, matching
  // the terminal's own accepted behavior here).
  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: AdminThemeMode = prev === "light" ? "dark" : "light";
      fetch(saveUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      }).catch(() => {});
      return next;
    });
  }, [saveUrl]);

  return (
    <div data-surface={surface} data-mode={mode} className={className}>
      <AdminThemeContext.Provider value={{ mode, toggle }}>{children}</AdminThemeContext.Provider>
    </div>
  );
}

// For AdminShell's header toggle button. Falls back to a static "light"
// no-op if rendered with no AdminThemeSurface ancestor (e.g. the bundled
// manager-shell/admin-shell Vite apps, which don't mount one yet -- same
// "safe default, never crash" precedent as lib/admin-realtime.tsx's
// useAdminConnectionStatus).
export function useAdminTheme(): AdminThemeContextValue {
  const ctx = useContext(AdminThemeContext);
  return ctx ?? { mode: "light", toggle: () => {} };
}
