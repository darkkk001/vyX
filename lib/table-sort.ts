export type SortDirection = "asc" | "desc";

// Pure comparison logic behind components/ui/TableExtras.tsx's
// useTableSort -- kept in lib/*.ts (not the .tsx component file) so it's
// unit-testable through this project's existing vitest setup, which
// only parses plain .ts (every other *.test.ts here is a pure-function
// test, see lib/margin.test.ts; there's no React/DOM test harness
// installed, and adding one is out of scope for a sort comparator).
export function sortRowsBy<T>(rows: T[], getValue: (row: T, key: string) => string | number | null, sortKey: string, direction: SortDirection): T[] {
  const withValues = rows.map((row) => ({ row, value: getValue(row, sortKey) }));
  withValues.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    const cmp = typeof a.value === "number" && typeof b.value === "number" ? a.value - b.value : String(a.value).localeCompare(String(b.value));
    return direction === "asc" ? cmp : -cmp;
  });
  return withValues.map((w) => w.row);
}
