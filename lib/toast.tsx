"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// VYX-BASICS-AUDIT.md category 4 -- there was no shared toast system at
// all; individual pages rolled their own one-off inline banner (e.g.
// PositionsManager.tsx's pendingSubmittedToast) instead of a real,
// consistent, stacking notification. Framework-agnostic (no
// next/navigation import) so it can mount in components/admin/
// AdminShell.tsx itself -- the one shared markup layer already used by
// the website AND both bundled Tauri shells (manager-shell, admin-shell)
// -- rather than needing separate wiring per surface the way
// AdminRealtimeProvider does (that split exists only because the
// realtime WS connection needs a different enable/disable decision per
// surface; a toast has no such asymmetry).

export type ToastTone = "success" | "danger" | "info" | "warning";
type ToastItem = { id: string; message: string; tone: ToastTone };

const TOAST_DURATION_MS = 4000;

type ToastContextValue = { showToast: (message: string, tone?: ToastTone) => void };
const ToastContext = createContext<ToastContextValue | null>(null);

const toneClasses: Record<ToastTone, string> = {
  success: "border-[var(--buy)]/30 bg-[var(--buy-bg)] text-[var(--buy)]",
  danger: "border-[var(--sell)]/30 bg-[var(--sell-bg)] text-[var(--sell)]",
  warning: "border-[var(--warn)]/30 bg-[var(--warn-bg)] text-[var(--warn)]",
  info: "border-[var(--accent)]/30 bg-[var(--accent-bg)] text-[var(--accent)]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { id, message, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_DURATION_MS)
      );
    },
    [dismiss]
  );

  // Clears every pending timer on unmount -- a shell doesn't remount in
  // practice, but a leaked setTimeout calling setState on an unmounted
  // provider is exactly the class of bug this guards against for free.
  useEffect(() => {
    const timersMap = timers.current;
    return () => {
      for (const timer of timersMap.values()) clearTimeout(timer);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Bottom-right, stacked newest-at-bottom, fixed to the viewport
          (not the shell's own scroll container) so a toast never scrolls
          out of view on a long page. z-40: below Modal's overlay (which
          this app already treats as the topmost layer) but above
          everything else. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[320px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-start justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg ${toneClasses[t.tone]}`}
          >
            <span className="leading-[1.4]">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// No-op fallback outside a provider (e.g. a component rendered in a test
// harness with no shell around it) rather than throwing -- matches
// useAdminConnectionStatus's own "never blocks rendering" convention in
// lib/admin-realtime.tsx.
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return ctx ?? { showToast: () => {} };
}
