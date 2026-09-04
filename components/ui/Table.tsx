import { HTMLAttributes, ReactNode, RefObject, TdHTMLAttributes, ThHTMLAttributes } from "react";

// VYX-BASICS-AUDIT.md category 2's own "Fixed-height scroll container,
// sticky header, in-panel scrollbar" -- the one item that comment down in
// maxBodyHeight's old doc left "QUEUED, not done" while the rest of
// category 2 (sort/resize/column-hide/skeleton/error-state, all in
// TableExtras.tsx) landed. A max-height only ever caps -- a table shorter
// than this renders at its natural height with no scrollbar at all -- so
// one universal default is safe for every one of this component's ~29
// call sites, from a 3-row settings table to a 500-row deal log, without
// auditing each individually. min() keeps it from overflowing a short
// viewport (a laptop with devtools open, a narrow modal) the fixed 640px
// PositionsManager.tsx's virtualizer case already used on its own alone
// wouldn't.
const DEFAULT_MAX_BODY_HEIGHT = "min(640px, 65vh)";

// The wrapper doubles as the mockup's ".panel" -- every table-only page
// (no surrounding Card) gets panel chrome (border/radius/header row) for
// free instead of looking like a bare table floating on the page.
export function Table({
  title,
  description,
  action,
  children,
  scrollRef,
  maxBodyHeight,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  // A real scroll element for a row-virtualizer to attach to (see
  // PositionsManager.tsx's "Open positions" table -- @tanstack/react-
  // virtual's useVirtualizer needs a real getScrollElement()). Works the
  // same with or without an explicit maxBodyHeight now that the default
  // below always gives the body a bounded scroll container.
  scrollRef?: RefObject<HTMLDivElement | null>;
  // Explicit pixel override for a caller with its own measured height
  // requirement (PositionsManager's virtualized case: exactly 640).
  // Omit this for every other table -- DEFAULT_MAX_BODY_HEIGHT applies
  // automatically, no per-page opt-in needed.
  maxBodyHeight?: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-1)]">
      {(title || action) && (
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-[18px] py-4">
          <div>
            {title ? <span className="text-[13.5px] font-semibold text-[var(--text-1)]">{title}</span> : null}
            {description ? <p className="mt-0.5 text-xs text-[var(--text-3)]">{description}</p> : null}
          </div>
          {action}
        </div>
      )}
      <div
        ref={scrollRef}
        className="overflow-x-auto"
        style={{ maxHeight: maxBodyHeight ?? DEFAULT_MAX_BODY_HEIGHT, overflowY: "auto" }}
      >
        <table className="w-full border-collapse text-[12.5px]">{children}</table>
      </div>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-[var(--bg-2)]">
      <tr>{children}</tr>
    </thead>
  );
}

const alignClasses = { left: "text-left", right: "text-right", center: "text-center" } as const;

export function TableHeaderCell({
  align = "left",
  className = "",
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      className={`border-b border-[var(--border)] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)] ${alignClasses[align]} ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TableRow({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={`border-b border-[var(--bg-2)] last:border-0 hover:bg-[var(--bg-2)] ${className}`} {...rest}>
      {children}
    </tr>
  );
}

export function TableCell({
  align = "left",
  mono = false,
  primary = false,
  className = "",
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center"; mono?: boolean; primary?: boolean }) {
  return (
    <td
      className={`px-4 py-2.5 ${primary ? "font-semibold text-[var(--text-1)]" : "text-[var(--text-2)]"} ${alignClasses[align]} ${mono ? "font-mono" : ""} ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}

export function TableEmptyState({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-[var(--text-3)]">
        {children}
      </td>
    </tr>
  );
}
