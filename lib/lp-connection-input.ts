import { Prisma, type PrismaClient } from "@prisma/client";
import { symbolHiddenFromBroker } from "@/lib/synthetic-symbols";

// Platform API bridge config, A.1.3: the editable fields of an LP connection (the FIX session a QoreBridge opens) and
// of its symbol rows. The rules are the bridge's own (qorebridge bin/qorebridge/src/config.rs lp_settings() and
// venue(), qb-fix SessionConfig::validate) plus the database CHECKs of 20261103180000_lp_connection, so a value the
// bridge would refuse is refused here, with its reason, before it reaches the database.
// Never a password: the platform does not store one (owner decision 2026-11-03); it is set on the bridge server.

type Db = PrismaClient | Prisma.TransactionClient;

export class LpConnectionInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const LP_TLS_MODES = ["OFF", "WEBPKI", "NATIVE"] as const;
export const LP_DIALECTS = ["FIX44", "CSERVER"] as const;
export const LP_ROLES = ["TRADE", "QUOTE"] as const;
/** Super Admin only (owner decision 2026-11-03): never shown to or editable by a broker. Null = the bridge's default. */
export const LP_TIMEOUT_FIELDS = ["ackTimeoutMs", "orderTtlSecs", "maxAttempts", "reconcileTimeoutSecs"] as const;
const TIMEOUT_LIMITS: Record<(typeof LP_TIMEOUT_FIELDS)[number], [number, number, string]> = {
  ackTimeoutMs: [1, 60_000, "ack timeout must be 1 to 60000 ms"],
  orderTtlSecs: [1, 3_600, "order time-to-live must be 1 to 3600 seconds"],
  maxAttempts: [1, 20, "attempts must be 1 to 20"],
  reconcileTimeoutSecs: [1, 600, "reconcile timeout must be 1 to 600 seconds"],
};

export type ConnectionFields = {
  liquidityProviderId?: string;
  role?: (typeof LP_ROLES)[number];
  enabled?: boolean;
  host?: string;
  port?: number;
  senderCompId?: string;
  targetCompId?: string;
  senderSubId?: string | null;
  targetSubId?: string | null;
  username?: string | null;
  tls?: (typeof LP_TLS_MODES)[number];
  tlsServerName?: string | null;
  dialect?: (typeof LP_DIALECTS)[number];
  heartbeatSecs?: number;
  resetSeqOnLogon?: boolean;
};
export type TimeoutFields = Partial<Record<(typeof LP_TIMEOUT_FIELDS)[number], number | null>>;

// a FIX field value: printable ASCII, no spaces (no SOH, no '|')
const FIX_TEXT = /^[\x21-\x7e]+$/;
const HOSTNAME = /^[A-Za-z0-9.-]+$/;

function text(body: Record<string, unknown>, key: string, label: string, max: number, pattern: RegExp, patternMsg: string): string {
  const v = typeof body[key] === "string" ? (body[key] as string).trim() : "";
  if (!v) throw new LpConnectionInputError(`${label} is required`);
  if (v.length > max) throw new LpConnectionInputError(`${label} must be at most ${max} characters`);
  if (!pattern.test(v)) throw new LpConnectionInputError(`${label} ${patternMsg}`);
  return v;
}
function optionalText(body: Record<string, unknown>, key: string, label: string, max: number, pattern: RegExp, patternMsg: string): string | null {
  if (body[key] === null || body[key] === undefined || (typeof body[key] === "string" && !(body[key] as string).trim())) return null;
  return text(body, key, label, max, pattern, patternMsg);
}
function int(body: Record<string, unknown>, key: string, min: number, max: number, msg: string): number {
  const n = typeof body[key] === "number" ? (body[key] as number) : typeof body[key] === "string" && (body[key] as string).trim() ? Number(body[key]) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new LpConnectionInputError(msg);
  return n;
}
function oneOf<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[], label: string): T {
  const v = body[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new LpConnectionInputError(`${label} must be one of ${allowed.join(", ")}`);
  return v as T;
}
function bool(body: Record<string, unknown>, key: string, label: string): boolean {
  if (typeof body[key] !== "boolean") throw new LpConnectionInputError(`${label} must be true or false`);
  return body[key] as boolean;
}

/** Reads the connection fields present in `body` (absent = unchanged); `create` makes the session fields required. */
export async function parseConnectionFields(db: Db, brokerId: string, body: Record<string, unknown> | null, create: boolean): Promise<ConnectionFields> {
  if (!body || typeof body !== "object") throw new LpConnectionInputError("body must be a JSON object");
  if ("password" in body || "passwordEnv" in body || "passwordFile" in body) {
    throw new LpConnectionInputError("the LP password is never stored on the platform: set it on the bridge server");
  }
  const out: ConnectionFields = {};
  const has = (k: string) => create || k in body;
  if (create || "liquidityProviderId" in body) {
    const id = typeof body.liquidityProviderId === "string" ? body.liquidityProviderId : "";
    const lp = id ? await db.liquidityProvider.findUnique({ where: { id } }) : null;
    if (!lp || lp.brokerId !== brokerId) throw new LpConnectionInputError("liquidity provider not found", 404);
    out.liquidityProviderId = lp.id;
  }
  if ("role" in body) out.role = oneOf(body, "role", LP_ROLES, "role");
  if ("enabled" in body) out.enabled = bool(body, "enabled", "enabled");
  if (has("host")) out.host = text(body, "host", "host", 253, HOSTNAME, "must be a host name or IP address (no scheme, port or spaces)");
  if (has("port")) out.port = int(body, "port", 1, 65_535, "port must be 1 to 65535");
  if (has("senderCompId")) out.senderCompId = text(body, "senderCompId", "SenderCompID", 64, FIX_TEXT, "must have no spaces");
  if (has("targetCompId")) out.targetCompId = text(body, "targetCompId", "TargetCompID", 64, FIX_TEXT, "must have no spaces");
  if ("senderSubId" in body) out.senderSubId = optionalText(body, "senderSubId", "SenderSubID", 64, FIX_TEXT, "must have no spaces");
  if ("targetSubId" in body) out.targetSubId = optionalText(body, "targetSubId", "TargetSubID", 64, FIX_TEXT, "must have no spaces");
  if ("username" in body) out.username = optionalText(body, "username", "username", 64, FIX_TEXT, "must have no spaces");
  if (has("tls")) out.tls = oneOf(body, "tls", LP_TLS_MODES, "TLS");
  if ("tlsServerName" in body) out.tlsServerName = optionalText(body, "tlsServerName", "TLS server name", 253, HOSTNAME, "must be a host name");
  if ("dialect" in body) out.dialect = oneOf(body, "dialect", LP_DIALECTS, "dialect");
  if ("heartbeatSecs" in body) out.heartbeatSecs = int(body, "heartbeatSecs", 1, 300, "heartbeat must be 1 to 300 seconds");
  if ("resetSeqOnLogon" in body) out.resetSeqOnLogon = bool(body, "resetSeqOnLogon", "reset sequence on logon");
  if (out.tls === "OFF" && out.tlsServerName) throw new LpConnectionInputError("a TLS server name needs TLS on");
  return out;
}

/** Super Admin only. Each value: an integer within its limit, or null (= the bridge's default). */
export function parseTimeoutFields(body: Record<string, unknown> | null): TimeoutFields {
  if (!body || typeof body !== "object") throw new LpConnectionInputError("body must be a JSON object");
  const out: TimeoutFields = {};
  for (const k of LP_TIMEOUT_FIELDS) {
    if (!(k in body)) continue;
    if (body[k] === null) out[k] = null;
    else {
      const [min, max, msg] = TIMEOUT_LIMITS[k];
      out[k] = int(body, k, min, max, msg);
    }
  }
  if (Object.keys(out).length === 0) throw new LpConnectionInputError(`nothing to change: send one of ${LP_TIMEOUT_FIELDS.join(", ")}`);
  return out;
}

/** True when a broker's body tries to set a Super-Admin-only value. */
export function touchesTimeouts(body: Record<string, unknown> | null): boolean {
  return !!body && LP_TIMEOUT_FIELDS.some((k) => k in body);
}

// ---- symbol rows (the bridge's [[lp.symbol]]) ----

export type SymbolFields = { symbolId?: string; venueId?: string; contractSize?: Prisma.Decimal; minUnits?: Prisma.Decimal; stepUnits?: Prisma.Decimal };
const MAX_UNITS = new Prisma.Decimal("99999999999999"); // DECIMAL(18,4)

function units(body: Record<string, unknown>, key: string, label: string): Prisma.Decimal {
  const raw = body[key];
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "x");
  } catch {
    throw new LpConnectionInputError(`${label} must be a number above 0`);
  }
  if (!d.isFinite() || d.lte(0)) throw new LpConnectionInputError(`${label} must be a number above 0`);
  if (d.gt(MAX_UNITS)) throw new LpConnectionInputError(`${label} is too large`);
  // stored with 4 decimals: a 5th would be rounded silently, so it is refused instead
  if (d.decimalPlaces() > 4) throw new LpConnectionInputError(`${label} can have at most 4 decimals`);
  return d;
}

/** Reads the symbol-row fields present in `body`; `create` makes them required. Cross-field rules: checkSymbolRow. */
export async function parseSymbolFields(db: Db, brokerId: string, body: Record<string, unknown> | null, create: boolean): Promise<SymbolFields> {
  if (!body || typeof body !== "object") throw new LpConnectionInputError("body must be a JSON object");
  const out: SymbolFields = {};
  if (create) {
    const id = typeof body.symbolId === "string" ? body.symbolId : "";
    const symbol = id ? await db.symbol.findUnique({ where: { id } }) : null;
    if (!symbol || (await symbolHiddenFromBroker(db, brokerId, symbol.name))) throw new LpConnectionInputError("symbol not found", 404);
    out.symbolId = symbol.id;
  }
  if (create || "venueId" in body) out.venueId = text(body, "venueId", "venue symbol", 32, FIX_TEXT, "must have no spaces");
  if (create || "contractSize" in body) out.contractSize = units(body, "contractSize", "contract size");
  if (create || "minUnits" in body) out.minUnits = units(body, "minUnits", "minimum units");
  if (create || "stepUnits" in body) out.stepUnits = units(body, "stepUnits", "step units");
  return out;
}

/** The bridge's venue() rules on a whole row: min on its own step; a cServer venue symbol is its numeric id. */
export function checkSymbolRow(row: { venueId: string; minUnits: Prisma.Decimal; stepUnits: Prisma.Decimal }, dialect: string) {
  if (!row.minUnits.mod(row.stepUnits).isZero()) throw new LpConnectionInputError("minimum units must be a multiple of step units");
  if (dialect === "CSERVER" && !/^\d+$/.test(row.venueId)) throw new LpConnectionInputError("a cTrader venue symbol is its numeric symbol id");
}

/** An enabled cTrader (CSERVER) connection needs its symbol table: the bridge refuses one without it. */
export function checkCserverHasSymbols(dialect: string, enabled: boolean, symbolCount: number) {
  if (dialect === "CSERVER" && enabled && symbolCount === 0) {
    throw new LpConnectionInputError("a cTrader connection needs at least one symbol before it can be enabled", 409);
  }
}

/** Pre-fill for a new symbol row: Symbol.contractSize, and the broker's minLot / lotStep in units. */
export async function symbolDefaults(db: Db, brokerId: string, symbolId: string) {
  const symbol = await db.symbol.findUnique({ where: { id: symbolId } });
  if (!symbol || (await symbolHiddenFromBroker(db, brokerId, symbol.name))) throw new LpConnectionInputError("symbol not found", 404);
  const bs = await db.brokerSymbol.findFirst({ where: { brokerId, symbolId }, select: { minLot: true, lotStep: true } });
  const minLot = bs?.minLot ?? new Prisma.Decimal("0.01");
  const lotStep = bs?.lotStep ?? new Prisma.Decimal("0.01");
  return {
    symbolId,
    symbolName: symbol.name,
    contractSize: symbol.contractSize.toString(),
    minUnits: minLot.mul(symbol.contractSize).toDecimalPlaces(4).toString(),
    stepUnits: lotStep.mul(symbol.contractSize).toDecimalPlaces(4).toString(),
  };
}

/** The audit snapshot of a connection (timeouts included: the audit log is the platform's, not the broker's screen). */
export function connectionSnapshot(c: Record<string, unknown>) {
  const keys = ["liquidityProviderId", "role", "enabled", "host", "port", "senderCompId", "targetCompId", "senderSubId", "targetSubId", "username", "tls", "tlsServerName", "dialect", "heartbeatSecs", "resetSeqOnLogon", ...LP_TIMEOUT_FIELDS];
  return Object.fromEntries(keys.map((k) => [k, c[k] ?? null]));
}
export function symbolSnapshot(s: { symbolId: string; venueId: string; contractSize: Prisma.Decimal; minUnits: Prisma.Decimal; stepUnits: Prisma.Decimal }, symbolName?: string) {
  return { symbolId: s.symbolId, symbol: symbolName ?? null, venueId: s.venueId, contractSize: s.contractSize.toString(), minUnits: s.minUnits.toString(), stepUnits: s.stepUnits.toString() };
}
