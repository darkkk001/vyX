import { Prisma } from "@prisma/client";

// Flat (type-wide) pricing on an AccountType: spreadMarkup / commissionPerLot / swapLong / swapShort / swapFree.
//
// null = inherit: the Group / broker symbol level decides (lib/pricing-engine.ts resolvePricingV2 falls through a
// null). An explicit value, 0 included, OUTRANKS the group. Audit 2026-09-24 (money): create used to write 0 for
// every field it was not given, and edit turned a stored null back into 0, so a type made in the backoffice gave
// every account on it 0 markup, 0 commission, 0 swaps and swap-free off, whatever its group said.
//
// Input rules, shared by POST and PATCH (app/api/manage/account-types):
// - null or "" (blank) = inherit (null)
// - a finite number = that value (0 is a real, explicit zero)
// - anything else = refused with a message, never silently zeroed
// - absent: POST = inherit; PATCH = keep what is stored (partial update)
// - swapFree: true / false are explicit, null = inherit; absent as above

export type TypePricing = {
  spreadMarkup: Prisma.Decimal | null;
  commissionPerLot: Prisma.Decimal | null;
  swapLong: Prisma.Decimal | null;
  swapShort: Prisma.Decimal | null;
  swapFree: boolean | null;
};

const DECIMAL_FIELDS = ["spreadMarkup", "commissionPerLot", "swapLong", "swapShort"] as const;

export function parseTypePricing(body: unknown, existing?: TypePricing): { error: string } | TypePricing {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: TypePricing = {
    spreadMarkup: existing?.spreadMarkup ?? null,
    commissionPerLot: existing?.commissionPerLot ?? null,
    swapLong: existing?.swapLong ?? null,
    swapShort: existing?.swapShort ?? null,
    swapFree: existing?.swapFree ?? null,
  };
  for (const field of DECIMAL_FIELDS) {
    const v = b[field];
    if (v === undefined) continue;
    if (v === null || (typeof v === "string" && v.trim() === "")) {
      out[field] = null;
      continue;
    }
    let d: Prisma.Decimal | null = null;
    try {
      d = new Prisma.Decimal(String(v).trim());
    } catch {
      d = null;
    }
    if (!d || !d.isFinite()) return { error: `${field} must be a number, or blank to inherit from the group` };
    out[field] = d;
  }
  if (b.swapFree !== undefined) out.swapFree = typeof b.swapFree === "boolean" ? b.swapFree : null;
  return out;
}

/** For audit rows and API responses: null stays null (inherit), never "0". */
export function typePricingJson(p: TypePricing) {
  return {
    spreadMarkup: p.spreadMarkup?.toString() ?? null,
    commissionPerLot: p.commissionPerLot?.toString() ?? null,
    swapLong: p.swapLong?.toString() ?? null,
    swapShort: p.swapShort?.toString() ?? null,
    swapFree: p.swapFree,
  };
}
