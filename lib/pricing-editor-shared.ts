import { Prisma } from "@prisma/client";

// Shared PATCH-body parsing/validation for the three per-symbol pricing
// editors (Group/AccountType/Account -- app/api/manage/{groups,account-
// types,accounts}/[id]/pricing/route.ts). All three write to a table with
// the same 6-field shape (spreadMarkup, targetTotalSpreadPips,
// commissionPerLot, swapLong, swapShort) since the 2026-09-07 nullable-
// widening migration, so the parsing/validation rules are identical --
// centralized here rather than tripled.
//
// Blank/omitted = null = "not set, inherit from the next resolution
// level" (lib/pricing-engine.ts) -- NOT zero. This is a deliberate
// change from GroupSymbolConfig's pre-Stage-5 behavior (which coerced
// blank to an explicit 0, back when null wasn't a real option yet); an
// admin who wants a genuine explicit-zero override still types "0". Only
// genuinely non-numeric input (stray text) rejects.
export function parseNullableDecimal(value: unknown): { ok: true; value: Prisma.Decimal | null } | { ok: false } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string" && typeof value !== "number") return { ok: false };
  try {
    const d = new Prisma.Decimal(value);
    return d.isFinite() ? { ok: true, value: d } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export type ParsedSymbolPricingPatch = {
  spreadMarkup: Prisma.Decimal | null;
  targetTotalSpreadPips: Prisma.Decimal | null;
  commissionPerLot: Prisma.Decimal | null;
  swapLong: Prisma.Decimal | null;
  swapShort: Prisma.Decimal | null;
};

// Returns the parsed fields, or a string error message. spreadMarkup and
// targetTotalSpreadPips are mutually exclusive (2026-09-07 design
// decision Q2) -- the UI's own mode toggle should never send both, but
// this is the actual enforcement point (app-level, not a DB constraint,
// matching this codebase's existing convention for cross-field
// invariants -- see GroupSymbolConfig's own schema comment).
export function parseSymbolPricingPatch(body: Record<string, unknown> | null): ParsedSymbolPricingPatch | string {
  const spreadMarkup = parseNullableDecimal(body?.spreadMarkup);
  const targetTotalSpreadPips = parseNullableDecimal(body?.targetTotalSpreadPips);
  const commissionPerLot = parseNullableDecimal(body?.commissionPerLot);
  const swapLong = parseNullableDecimal(body?.swapLong);
  const swapShort = parseNullableDecimal(body?.swapShort);
  if (!spreadMarkup.ok || !targetTotalSpreadPips.ok || !commissionPerLot.ok || !swapLong.ok || !swapShort.ok) {
    return "spreadMarkup, targetTotalSpreadPips, commissionPerLot, swapLong, and swapShort must each be a valid number or left blank";
  }
  if (spreadMarkup.value !== null && targetTotalSpreadPips.value !== null) {
    return "set either spreadMarkup or targetTotalSpreadPips, not both";
  }
  if (spreadMarkup.value !== null && spreadMarkup.value.lt(0)) return "spreadMarkup must not be negative";
  if (targetTotalSpreadPips.value !== null && targetTotalSpreadPips.value.lt(0)) return "targetTotalSpreadPips must not be negative";
  if (commissionPerLot.value !== null && commissionPerLot.value.lt(0)) return "commissionPerLot must not be negative";
  return {
    spreadMarkup: spreadMarkup.value,
    targetTotalSpreadPips: targetTotalSpreadPips.value,
    commissionPerLot: commissionPerLot.value,
    swapLong: swapLong.value,
    swapShort: swapShort.value,
  };
}

// A row is "empty" (nothing to save, equivalent to a reset) when every
// field is null -- callers use this to decide whether a PATCH with no
// reset flag should still upsert a now-pointless all-null row or just
// delete/skip it, same "don't write a no-op row" convention as
// lib/group-pricing.ts's chargeCommission.
export function isEmptyPricingPatch(p: ParsedSymbolPricingPatch): boolean {
  return p.spreadMarkup === null && p.targetTotalSpreadPips === null && p.commissionPerLot === null && p.swapLong === null && p.swapShort === null;
}

export function decimalOrNull(v: Prisma.Decimal | null): string | null {
  return v === null ? null : v.toString();
}

// Tri-state swap-free parse for Account/AccountType/Group PATCH routes --
// null (explicit) means "inherit from the next level," `undefined`
// (field absent from the body) means "leave the existing value
// untouched" (standard partial-PATCH semantics, matching how every other
// optional field in those routes already behaves).
export function parseTriStateBoolean(value: unknown): { present: false } | { present: true; value: boolean | null } {
  if (value === undefined) return { present: false };
  if (value === null) return { present: true, value: null };
  if (typeof value === "boolean") return { present: true, value };
  return { present: true, value: null }; // defensive: anything else collapses to "inherit" rather than throwing
}
