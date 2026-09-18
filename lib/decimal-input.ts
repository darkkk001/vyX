import { Prisma } from "@prisma/client";

// One parser for every number a CLIENT sends that ends up in money math or a
// Decimal column (pentest 2026-09-18 #6/#7/#12). `new Prisma.Decimal(x)`
// alone is not a gate: "NaN" and "Infinity" parse WITHOUT throwing, and every
// comparison against NaN is false, so a NaN price/volume/amount sailed
// through evaluateLiveMarketPrice's 2% band, validateSlTp, checkPreTradeMargin
// and the volume range check, and a NaN maxSlippagePips silently switched the
// slippage gate off. The only thing that stopped a NaN from being stored was
// the Postgres numeric column rejecting it -- as an unhandled 500. Meanwhile
// " 5" / "5abc" / "" DO throw, which without a try/catch at the call site was
// also a 500.
//
// Returns a finite Decimal, or null for anything else (absent, empty,
// unparseable, NaN, +-Infinity). Never throws. Callers turn null into a clean
// 400 and never touch the raw value again.
export function toFiniteDecimal(value: unknown): Prisma.Decimal | null {
  if (value == null) return null;
  if (value instanceof Prisma.Decimal) return value.isFinite() ? value : null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (text === "") return null;
  // Prisma.Decimal accepts hex/binary/octal ("0x10" -> 16); no client of this
  // platform ever legitimately sends those for a price or amount.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  try {
    const d = new Prisma.Decimal(text);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

// Convenience for routes that keep the client's value as a string for audit
// fields (requestedPrice, clientReferencePrice): the same validity rule, as a
// boolean.
export function isFiniteDecimalString(value: string | null | undefined): value is string {
  return toFiniteDecimal(value) !== null;
}
