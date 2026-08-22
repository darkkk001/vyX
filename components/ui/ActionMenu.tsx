"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/IconButton";

export type ActionMenuItem = {
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  title?: string;
};

// A row's actions collapsed behind one trigger, instead of every action
// sitting exposed in the row at all times (a raw one-click "Close" next
// to a live trade was the concrete complaint this replaces). Closes on
// an outside click or Escape; each item's own onClick is responsible for
// anything further (opening a confirm modal, calling an API, etc.) --
// this component only owns open/closed state.
export function ActionMenu({ items, disabled }: { items: ActionMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <IconButton title="Actions" disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </IconButton>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[150px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-2)] py-1 shadow-lg">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={`block w-full px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                item.tone === "danger"
                  ? "text-[var(--sell)] hover:bg-[var(--sell-bg)]"
                  : "text-[var(--text-1)] hover:bg-[var(--bg-3)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
