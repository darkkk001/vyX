"use client";

import { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionMenuItem } from "@/components/ui/ActionMenu";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { sortRowsBy, type SortDirection } from "@/lib/table-sort";

export type { SortDirection };

// VYX-BASICS-AUDIT.md category 2 -- shared table chrome every backoffice
// list was missing (sort, resize, column show/hide, row right-click,
// multi-select, a real loading skeleton, and a genuine error state
// distinct from "zero rows"). Built once here instead of per-page so a
// fix here fixes every table that opts in, matching this codebase's own
// ActionMenu.tsx precedent (a raw one-click action replaced by one
// shared component, not five hand-rolled copies).

// --- Skeleton -----------------------------------------------------------

// Matches the real table's row height/padding (px-4 py-2.5, Table.tsx's
// own text-[12.5px]) so nothing jumps size when real rows swap in --
// category 8's "no layout shift after data loads" rides along with this
// for free once a page uses it instead of its own "Loading..." text.
export function TableSkeleton({ columns, rows = 6 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-[var(--bg-2)] last:border-0">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className="px-4 py-2.5">
              <div className="h-3 animate-pulse rounded bg-[var(--bg-3)]" style={{ width: `${55 + ((r * 7 + c * 13) % 35)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// --- Error state (distinct from "genuinely zero rows") ------------------

// The bug this fixes: every page's own `.catch(() => setRows([]))` made
// a fetch failure render identically to "this account has no open
// positions" -- an admin has no way to tell "broker has zero deals
// today" from "the deals API just 500'd". Callers pass a tri-state
// (rows | null loading | "error" sentinel via a separate `error` flag)
// and render this instead of TableEmptyState when the load failed.
export function TableErrorState({ colSpan, message = "Couldn't load this data.", onRetry }: { colSpan: number; message?: string; onRetry: () => void }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center">
        <div className="flex flex-col items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--sell)]">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="13" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-sm text-[var(--sell)]">{message}</p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </td>
    </tr>
  );
}

// --- Page-level loading/error (non-table pages) --------------------------
//
// The same "Loading vs Error vs Empty must never collapse into one
// state" fix as TableSkeleton/TableErrorState above, for pages that
// aren't a table at all (a stat-grid dashboard, a settings form) --
// those still had the exact same bug: `.catch(() => {})` left `data`
// null forever on a fetch failure, so the page just showed "Loading..."
// with no way out, indistinguishable from a slow network. Not folded
// into TableSkeleton/TableErrorState themselves since those render as
// <tr>/<td> and can't be dropped into a non-table page.
export function PageLoading() {
  return (
    <div className="flex flex-col gap-3 py-4">
      {Array.from({ length: 4 }, (_, r) => (
        <div key={r} className="h-4 animate-pulse rounded bg-[var(--bg-3)]" style={{ width: `${40 + ((r * 17) % 45)}%` }} />
      ))}
    </div>
  );
}

export function PageError({ message = "Couldn't load this page.", onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--sell)]">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="13" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p className="text-sm text-[var(--sell)]">{message}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

// --- Sort -----------------------------------------------------------------
// sortRowsBy/SortDirection live in lib/table-sort.ts (see that file's
// own comment for why) and are re-exported above for callers that only
// need to import from this one module.

// Three-state cycle per header click: unsorted -> asc -> desc -> unsorted
// (back to the server/natural order) -- never gets "stuck" sorted with no
// way back short of a reload, same reasoning as every other dismissible
// UI state in this app.
export function useTableSort<T>(rows: T[], getValue: (row: T, key: string) => string | number | null) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<SortDirection>("asc");
  // Tracks clicks on the CURRENT column only, to drive the
  // asc -> desc -> unsorted cycle (a third click clears sorting instead
  // of toggling forever with no way back to natural order).
  const [clickCount, setClickCount] = useState(0);

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey !== key) {
        setSortKey(key);
        setDirection("asc");
        setClickCount(1);
        return;
      }
      const next = clickCount + 1;
      if (next >= 3) {
        setSortKey(null);
        setClickCount(0);
        return;
      }
      setClickCount(next);
      setDirection(next === 2 ? "desc" : "asc");
    },
    [sortKey, clickCount]
  );

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    return sortRowsBy(rows, getValue, sortKey, direction);
  }, [rows, sortKey, direction, getValue]);

  return { sortedRows, sortKey, direction, onSort: handleSort };
}


// Drop-in replacement for TableHeaderCell that adds the click-to-sort
// chrome (cursor, arrow indicator) -- kept separate from
// TableHeaderCell itself so every non-sortable header stays exactly as
// simple as it was. Takes `style`/`resizeHandle` itself (rather than a
// caller wrapping it in a second <th>) because a <th> can't validly
// contain another <th> -- callers that also need resize just pass a
// <ColumnResizeHandle> through `resizeHandle`.
export function SortableHeaderCell({
  sortKey,
  activeSortKey,
  direction,
  onSort,
  align = "left",
  style,
  resizeHandle,
  children,
}: {
  sortKey: string;
  activeSortKey: string | null;
  direction: SortDirection;
  onSort: (key: string) => void;
  align?: "left" | "right" | "center";
  style?: CSSProperties;
  resizeHandle?: ReactNode;
  children: ReactNode;
}) {
  const active = activeSortKey === sortKey;
  const cellAlign = { left: "text-left", right: "text-right", center: "text-center" } as const;
  const buttonAlign = { left: "justify-start", right: "justify-end", center: "justify-center" } as const;
  return (
    <th
      style={style}
      className={`relative border-b border-[var(--border)] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)] ${cellAlign[align]}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex w-full items-center gap-1 ${buttonAlign[align]} ${active ? "text-[var(--text-1)]" : "hover:text-[var(--text-2)]"}`}
      >
        {children}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className={active ? "opacity-100" : "opacity-25"}>
          {active && direction === "desc" ? <path d="M7 10l5 5 5-5z" /> : <path d="M7 14l5-5 5 5z" />}
        </svg>
      </button>
      {resizeHandle}
    </th>
  );
}

// --- Column resize (drag border, persisted) --------------------------------

const MIN_COLUMN_WIDTH = 60;

// Persists per table (storageKey) so a dealer's preferred widths survive
// a reload -- same "small per-viewer preference in localStorage"
// reasoning as chart-settings.ts's own persisted prefs, not shared state
// worth a server round-trip.
export function useColumnWidths(storageKey: string, defaults: Record<string, number>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return defaults;
    try {
      const saved = window.localStorage.getItem(`vyx-col-widths:${storageKey}`);
      return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    } catch {
      return defaults;
    }
  });

  const persist = useCallback(
    (next: Record<string, number>) => {
      try {
        window.localStorage.setItem(`vyx-col-widths:${storageKey}`, JSON.stringify(next));
      } catch {
        // private window / storage disabled -- widths just don't survive reload
      }
    },
    [storageKey]
  );

  const dragState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragState.current) return;
      const { key, startX, startWidth } = dragState.current;
      const next = Math.max(MIN_COLUMN_WIDTH, startWidth + (e.clientX - startX));
      setWidths((prev) => ({ ...prev, [key]: next }));
    }
    function onMouseUp() {
      if (!dragState.current) return;
      dragState.current = null;
      setWidths((prev) => {
        persist(prev);
        return prev;
      });
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [persist]);

  const startResize = useCallback(
    (key: string) => (e: ReactMouseEvent) => {
      e.preventDefault();
      dragState.current = { key, startX: e.clientX, startWidth: widths[key] ?? defaults[key] ?? 120 };
    },
    [widths, defaults]
  );

  return { widths, startResize };
}

// Absolutely-positioned drag handle on a header cell's right edge --
// caller wraps its own <TableHeaderCell style={{width}}> content and
// drops this in alongside it (needs the parent <th> to be
// position:relative, which ResizableHeaderCell below provides).
export function ColumnResizeHandle({ onMouseDown }: { onMouseDown: (e: ReactMouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--accent)]/40"
      style={{ touchAction: "none" }}
    />
  );
}

// --- Column show/hide (right-click header row) -----------------------------

export type ColumnDef = { key: string; label: string; alwaysVisible?: boolean; align?: "left" | "right" | "center" };

export function useColumnVisibility(storageKey: string, columns: ColumnDef[]) {
  const defaults = useMemo(() => Object.fromEntries(columns.map((c) => [c.key, true])), [columns]);
  const [visible, setVisible] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return defaults;
    try {
      const saved = window.localStorage.getItem(`vyx-col-visible:${storageKey}`);
      return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    } catch {
      return defaults;
    }
  });

  const toggle = useCallback(
    (key: string) => {
      setVisible((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        try {
          window.localStorage.setItem(`vyx-col-visible:${storageKey}`, JSON.stringify(next));
        } catch {
          // private window / storage disabled
        }
        return next;
      });
    },
    [storageKey]
  );

  return { visible, toggle };
}

// The "Right-click for more columns" convention already used on
// WebTrader's Watchlist rail (a different widget, quote columns not
// table columns) -- this is the same interaction applied to an actual
// <thead>, since the audit's checkbox pointed at that hint text as if
// every table already had this, which wasn't true anywhere but there.
export function ColumnVisibilityMenu({
  columns,
  visible,
  onToggle,
  x,
  y,
  onClose,
}: {
  columns: ColumnDef[];
  visible: Record<string, boolean>;
  onToggle: (key: string) => void;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y }}
      className="z-30 min-w-[170px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-2)] py-1 shadow-lg"
    >
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Columns</p>
      {columns.map((col) => (
        <label
          key={col.key}
          title={col.alwaysVisible ? "Always shown -- needed to tell rows apart" : undefined}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-1)] ${col.alwaysVisible ? "opacity-40" : "cursor-pointer hover:bg-[var(--bg-3)]"}`}
        >
          <input
            type="checkbox"
            checked={col.alwaysVisible ? true : (visible[col.key] ?? true)}
            disabled={col.alwaysVisible}
            onChange={() => onToggle(col.key)}
          />
          {col.label}
        </label>
      ))}
    </div>
  );
}

// --- Row right-click context menu ------------------------------------------

// Same ActionMenuItem shape as the existing ⋮ menu (ActionMenu.tsx) --
// right-click is a second entry point to the exact same actions, not a
// separate feature to keep in sync by hand.
export function useRowContextMenu<T>() {
  const [state, setState] = useState<{ row: T; x: number; y: number } | null>(null);
  const open = useCallback((row: T, e: ReactMouseEvent) => {
    e.preventDefault();
    setState({ row, x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { contextMenu: state, openContextMenu: open, closeContextMenu: close };
}

export function RowContextMenu({ items, x, y, onClose }: { items: ActionMenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y }}
      className="z-30 min-w-[150px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-2)] py-1 shadow-lg"
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose();
            item.onClick();
          }}
          className={`block w-full px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            item.tone === "danger" ? "text-[var(--sell)] hover:bg-[var(--sell-bg)]" : "text-[var(--text-1)] hover:bg-[var(--bg-3)]"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// --- Multi-select + bulk action bar ----------------------------------------

export function useRowSelection<T extends { id: string }>(rows: T[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Drop anything no longer in `rows` (closed/filtered out from under a
  // stale selection) instead of leaving a phantom count in the bulk bar.
  useEffect(() => {
    setSelectedIds((prev) => {
      const validIds = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }, [rows]);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  return { selectedIds, toggle, toggleAll, allSelected, someSelected, clear };
}

export function SelectAllCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label="Select all rows" />;
}

export type BulkAction = { label: string; onClick: () => void; variant?: "danger" | "primary" | "secondary"; disabled?: boolean };

// Sticky above the table (not fixed to viewport) so it stays attached to
// the list it acts on when a page has more than one table.
export function BulkActionBar({ count, actions, onClear }: { count: number; actions: BulkAction[]; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="sticky top-0 z-20 flex items-center justify-between gap-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-[var(--accent)]">{count} selected</span>
        <IconButton title="Clear selection" onClick={onClear} className="h-6 w-6">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      </div>
      <div className="flex gap-2">
        {actions.map((a, i) => (
          <Button key={i} size="sm" variant={a.variant ?? "secondary"} disabled={a.disabled} onClick={a.onClick}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
