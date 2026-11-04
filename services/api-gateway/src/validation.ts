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

// A trader's own slippage max: a decimal string in points/pips, or the literal "unlimited" that every
// client already sends when the trader set no cap (lib/risk.ts's isValidMaxSlippageInput accepts the
// same two forms). Rejecting "unlimited" here would refuse the common case.
const slippageInput = z.union([z.literal("unlimited"), decimalString()]);

export const placeMarketOrderSchema = z.object({
  symbol,
  side,
  volume,
  sl_price: optionalPrice,
  tp_price: optionalPrice,
  // PRIORITY 1 (FAILOVER): the client's own idempotency key, passed straight through to the engine so
  // the fill (or the rejection) is written under it. That is what lets the web resolve a LOST ANSWER by
  // key instead of having to choose between a double fill and an error -- see lib/engine-ingress.ts.
  //
  // Optional, and deliberately NOT validated beyond a length bound: the gateway does not own this
  // value's meaning, it only carries it. An absent key keeps the old behaviour exactly (the engine
  // falls back to `engine:<order id>`), so a client that does not send one is not refused.
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  // THE CLIENT'S OWN SCREEN PRICE, for the slippage cap only -- the engine prices the fill itself.
  //
  // OPTIONAL, deliberately. The web guard (lib/engine-ingress.ts) forwards symbol/side/volume/key and no
  // price, so requiring one here would refuse every order that path sends. Absent = no reference to
  // compare against and therefore no cap check, exactly as the close route treats a missing closePrice.
  // A client calling this Gateway DIRECTLY must send it to get the cap the web applies -- making it
  // mandatory belongs with retiring the web guard, not before.
  price: decimalString().nullable().optional(),
  // the trader's own SLIPPAGE MAX, either spelling; points wins when both are sent, as on the web
  maxSlippagePoints: slippageInput.nullable().optional(),
  maxSlippagePips: slippageInput.nullable().optional(),
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
// POST /v1/positions/:id/close. Everything is optional, because the engine prices the close itself off
// the Gateway's fresh tick: `closePrice` is the client's OWN reference (what its screen showed) and is
// used only for the slippage comparison, exactly as the web close route uses it. Sending none means
// "fill at the server price, no reference to check against" -- the same meaning it has there.
export const closePositionSchema = z.object({
  closePrice: decimalString().nullable().optional(),
  maxSlippagePoints: slippageInput.nullable().optional(),
  maxSlippagePips: slippageInput.nullable().optional(),
  // Carried for traceability only, and length-bounded like the market route's. A DIRECT close has no
  // key-based dedupe to offer -- see the route's own comment: neither this service nor the web has one,
  // the guarantee is the engine's compare-and-set. Declared so it survives `req.body = result.data`.
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  // PARTIAL CLOSE IS NOT SUPPORTED HERE, and this is why it is DECLARED rather than omitted: an
  // undeclared key is stripped by `req.body = result.data`, so a client asking to close 0.01 of a 1.00
  // position would have been silently closed in FULL. `z.never()` makes that a 400 instead. The engine's
  // own /v1/positions/{id}/close takes no volume either -- it is a full-close primitive, so partial
  // closes stay on the web route until the engine grows one.
  volume: z.never().optional(),
});

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
