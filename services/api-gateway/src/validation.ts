// Shared request-body validation for the order routes — per
// docs/security.md §2: "a shared schema-validation layer (e.g. zod) at
// the API Gateway boundary, applied uniformly to every incoming request
// before it reaches OMS/Risk." Closes the ad hoc, per-route `if (!body.x)`
// checks that routes/orders.ts had before, which never validated
// volume/sl_price/tp_price/requested_price as real decimal strings —
// garbage there either threw uncaught out of `new Decimal(...)` (crashing
// the handler with Express's default HTML 500, not a clean API error) or
// got forwarded to the Rust core for it to reject after a wasted hop.

import { Decimal } from "decimal.js";
import { z } from "zod";
import type { NextFunction, Request, Response } from "express";

// A string Decimal.js can actually parse, as a Zod refinement rather
// than a regex — decimal.js's own parser is the single source of truth
// for "valid decimal" everywhere else in this service, so validation
// here can't drift from what the rest of the codebase accepts.
function decimalString(opts: { positive?: boolean } = {}) {
  return z.string().superRefine((value, ctx) => {
    let d: Decimal;
    try {
      d = new Decimal(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a valid decimal number" });
      return;
    }
    if (!d.isFinite()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a finite number" });
    } else if (opts.positive && !d.gt(0)) {
      // decimal.js's own isPositive() treats zero as positive (sign >=
      // 0) — not what "volume must be positive" means here, so gt(0).
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be positive" });
    }
  });
}

const symbol = z.string().min(1, "symbol is required");
const side = z.enum(["BUY", "SELL"]);
const volume = decimalString({ positive: true });
// Accepts a missing key AND an explicit `null` as the same "no value" --
// engine/server's `Option<Decimal>` fields already deserialize `null` to
// `None` (plain serde default behavior), so a client explicitly clearing
// an existing sl_price/tp_price by sending `null` shouldn't be rejected
// here just because `.optional()` alone only covers "key omitted."
const optionalPrice = decimalString().nullable().optional();

export const placeMarketOrderSchema = z.object({
  symbol,
  side,
  volume,
  sl_price: optionalPrice,
  tp_price: optionalPrice,
});

export const placePendingOrderSchema = z.object({
  symbol,
  side,
  order_type: z.enum(["LIMIT", "STOP"]),
  volume,
  requested_price: decimalString(),
  sl_price: optionalPrice,
  tp_price: optionalPrice,
});

// current_price is client-supplied here on purpose, same as the existing
// Next.js path (WebTrader.tsx's editPositionSlTp call) -- it's only used
// to validate the requested SL/TP against (risk::validate_sl_tp), never
// as a fill/close price, so there's nothing for a client to gain by
// lying about it beyond having their own SL/TP request rejected.
export const modifyPositionSchema = z.object({
  current_price: decimalString(),
  sl_price: optionalPrice,
  tp_price: optionalPrice,
});

// Validates req.body against `schema` and replaces it with the parsed
// (typed) result on success, so downstream handlers read already-valid
// data. On failure, responds 400 with every issue at once (not just the
// first) rather than making the client guess-and-check field by field.
export function validateBody(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "invalid request body",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
