"use client";

import { ReactNode, useEffect, useRef } from "react";

// Hand-rolled modal/dialog primitive -- none existed anywhere in the
// codebase before this (every confirmation was an inline expanding table
// row). Deliberately NOT portaled to document.body: the dark-theme tokens
// (--bg-1, --accent, etc., see app/admin-theme.css) are scoped to the
// [data-surface] wrapper div, which is a CSS-inheritance boundary a
// document.body portal would escape -- confirmed live, a portaled modal
// rendered with no background at all, page content bleeding through.
// position:fixed + z-index already overlays AdminShell's sidebar/topbar
// without needing to escape the DOM tree, since nothing in AdminShell
// creates a containing block (transform/filter/contain) that would clip
// a fixed-position descendant.
export function Modal({
  open,
  onClose,
  title,
  wide = false,
  // A 3rd, wider tier for content a 600px modal genuinely can't fit
  // without an inner table needing its own horizontal scroll (e.g. a
  // per-symbol pricing grid) -- added instead of widening every existing
  // `wide` caller, since 3 other pages already rely on 600px specifically.
  xl = false,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  xl?: boolean;
  // VYX-BASICS-AUDIT.md category 3 "Enter submits, Esc cancels" -- Esc
  // already worked (below), Enter didn't: every caller's modal body was
  // a plain <div>, not a <form>, so pressing Enter in a text input did
  // nothing (a <select>'s Enter is a native no-op either way). Passing
  // onSubmit wraps `children` in a real <form onSubmit>, so Enter-to-
  // submit comes from native browser form semantics, not a per-page
  // keydown handler -- callers keep their own submit Button as
  // type="submit" inside it (no onClick needed) and it just works.
  onSubmit?: () => void;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Split from the escape-key effect below on purpose: callers almost
  // always pass an inline `onClose={() => setX(false)}`, a fresh function
  // identity every render -- keying this on `open` alone means typing in
  // a field inside the modal (which re-renders the parent on every
  // keystroke) never re-runs this effect. It used to also depend on
  // `onClose`, which re-ran `cardRef.current?.focus()` on every single
  // keystroke anywhere in the modal, yanking focus off whatever input the
  // user was actively typing into and onto the modal's own wrapper div --
  // the bug behind "have to click back into the field after every
  // character."
  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[88vh] overflow-y-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-1)] p-5 outline-none ${
          xl ? "w-[880px] max-w-[92vw]" : wide ? "w-[600px]" : "w-[400px]"
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[14.5px] font-semibold text-[var(--text-1)]">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--text-3)] hover:text-[var(--text-1)]"
          >
            ✕
          </button>
        </div>
        {onSubmit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {children}
          </form>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// Layout helpers reused by the wider modals (Register Broker, Tenant
// Detail) -- mirror the mockup's .modal-section-label/.modal-row-2.
export function ModalSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4 first:mt-0">
      <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      {children}
    </div>
  );
}

export function ModalRow2({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2.5">{children}</div>;
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex gap-2 [&>*]:flex-1">{children}</div>;
}
