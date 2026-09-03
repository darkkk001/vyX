import { describe, expect, it } from "vitest";
import { sortRowsBy } from "@/lib/table-sort";

// VYX-BASICS-AUDIT.md category 2's "Column sort" item -- the part of
// components/ui/TableExtras.tsx's useTableSort that's actually
// unit-testable (this project has no React/DOM test harness -- see this
// function's own comment in lib/table-sort.ts).

type Row = { id: string; name: string | null; amount: number | null };

const rows: Row[] = [
  { id: "a", name: "Charlie", amount: 30 },
  { id: "b", name: "alice", amount: null },
  { id: "c", name: "Bob", amount: 10 },
];

describe("sortRowsBy", () => {
  it("sorts numbers ascending", () => {
    const sorted = sortRowsBy(rows, (r) => r.amount, "amount", "asc");
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]); // 10, 30, null last
  });

  it("sorts numbers descending, still pushing null to the end", () => {
    const sorted = sortRowsBy(rows, (r) => r.amount, "amount", "desc");
    expect(sorted.map((r) => r.id)).toEqual(["a", "c", "b"]); // 30, 10, null last
  });

  it("sorts strings case-insensitively via localeCompare, ascending", () => {
    const sorted = sortRowsBy(rows, (r) => r.name, "name", "asc");
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]); // alice, Bob, Charlie
  });

  it("is stable/no-op on an empty array", () => {
    expect(sortRowsBy([], () => null, "x", "asc")).toEqual([]);
  });

  it("never mutates the input array", () => {
    const copy = [...rows];
    sortRowsBy(rows, (r) => r.amount, "amount", "asc");
    expect(rows).toEqual(copy);
  });
});
