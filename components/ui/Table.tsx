import { HTMLAttributes, ReactNode, RefObject, TdHTMLAttributes, ThHTMLAttributes } from "react";

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
  // VYX-BASICS-AUDIT.md category 8 -- opt-in vertical scroll boundary
  // for the table body, unused by every existing caller (both undefined
  // by default, no behavior change). Exists so a row-virtualizer (see
  // PositionsManager.tsx's "Open positions" table, the one place this
  // is actually needed -- 500+ real rows produced 300-800ms main-thread
  // long tasks and visibly janky scrolling without it) has a bounded,
  // measurable scroll element to attach to; @tanstack/react-virtual's
  // useVirtualizer needs a real getScrollElement(), which an
  // unconstrained page-scrolling table never had. Not the same thing as
  // category 2's still-deferred "every table gets a fixed-height
  // scroll container" item -- this is scoped to the one table that
  // measurably needs it to not freeze the tab, not a redesign of every
  // table's scroll behavior.
  scrollRef?: RefObject<HTMLDivElement | null>;
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
      <div ref={scrollRef} className="overflow-x-auto" style={maxBodyHeight ? { maxHeight: maxBodyHeight, overflowY: "auto" } : undefined}>
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
