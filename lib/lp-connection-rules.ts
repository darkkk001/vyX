// LP connection checks for the browser (Phase 2.1 A.3). The same rules and the same words as the server's
// lib/lp-connection-input.ts (which needs Prisma, so it cannot run in a client component): a value the server would
// refuse is refused in the form first. The server stays the authority; its refusal is shown as it comes.
// Never a password: the platform does not store one (owner decision 2026-11-03); it is set on the bridge server.

export const LP_TLS_MODES = ["WEBPKI", "NATIVE", "OFF"] as const;
export const LP_DIALECTS = ["FIX44", "CSERVER"] as const;
export const LP_ROLES = ["TRADE", "QUOTE"] as const;
export type LpTls = (typeof LP_TLS_MODES)[number];
export type LpDialect = (typeof LP_DIALECTS)[number];
export type LpRole = (typeof LP_ROLES)[number];

export const TLS_LABEL: Record<LpTls, string> = { WEBPKI: "On", NATIVE: "On (Windows certificates)", OFF: "Off" };
export const DIALECT_LABEL: Record<LpDialect, string> = { FIX44: "FIX 4.4", CSERVER: "cTrader" };
export const ROLE_LABEL: Record<LpRole, string> = { TRADE: "Trading", QUOTE: "Prices" };

// a FIX field value: printable ASCII, no spaces (no SOH, no '|')
const FIX_TEXT = /^[\x21-\x7e]+$/;
const HOSTNAME = /^[A-Za-z0-9.-]+$/;

/** The editable session fields, as the form holds them (text for numbers, "" for an empty optional field). */
export type ConnectionDraft = {
  role: LpRole;
  dialect: LpDialect;
  host: string;
  port: string;
  senderCompId: string;
  targetCompId: string;
  senderSubId: string;
  targetSubId: string;
  username: string;
  tls: LpTls;
  tlsServerName: string;
  heartbeatSecs: string;
  resetSeqOnLogon: boolean;
  enabled: boolean;
};

/** A new trading session: FIX 4.4, TLS on, 30 s heartbeat, switched on. */
export function newDraft(): ConnectionDraft {
  return {
    role: "TRADE",
    dialect: "FIX44",
    host: "",
    port: "",
    senderCompId: "",
    targetCompId: "",
    senderSubId: "",
    targetSubId: "",
    username: "",
    tls: "WEBPKI",
    tlsServerName: "",
    heartbeatSecs: "30",
    resetSeqOnLogon: false,
    enabled: true,
  };
}

function text(v: string, label: string, max: number, pattern: RegExp, patternMsg: string, required: boolean): string | null {
  const t = v.trim();
  if (!t) return required ? `${label} is required` : null;
  if (t.length > max) return `${label} must be at most ${max} characters`;
  if (!pattern.test(t)) return `${label} ${patternMsg}`;
  return null;
}
function int(v: string, min: number, max: number, msg: string): string | null {
  const t = v.trim();
  const n = t ? Number(t) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? null : msg;
}

/** The first problem with a draft, or null. `symbolCount`: the connection's symbol rows (0 for a new one). */
export function draftProblem(d: ConnectionDraft, symbolCount: number): string | null {
  return (
    text(d.host, "host", 253, HOSTNAME, "must be a host name or IP address (no scheme, port or spaces)", true) ??
    int(d.port, 1, 65_535, "port must be 1 to 65535") ??
    text(d.senderCompId, "SenderCompID", 64, FIX_TEXT, "must have no spaces", true) ??
    text(d.targetCompId, "TargetCompID", 64, FIX_TEXT, "must have no spaces", true) ??
    text(d.senderSubId, "SenderSubID", 64, FIX_TEXT, "must have no spaces", false) ??
    text(d.targetSubId, "TargetSubID", 64, FIX_TEXT, "must have no spaces", false) ??
    text(d.username, "username", 64, FIX_TEXT, "must have no spaces", false) ??
    text(d.tlsServerName, "TLS server name", 253, HOSTNAME, "must be a host name", false) ??
    (d.tls === "OFF" && d.tlsServerName.trim() ? "a TLS server name needs TLS on" : null) ??
    int(d.heartbeatSecs, 1, 300, "heartbeat must be 1 to 300 seconds") ??
    (d.dialect === "CSERVER" && d.enabled && symbolCount === 0 ? "a cTrader connection needs at least one symbol before it can be enabled" : null)
  );
}

/** The request body for a draft (optional text "" = null). */
export function draftBody(d: ConnectionDraft): Record<string, unknown> {
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  return {
    role: d.role,
    dialect: d.dialect,
    host: d.host.trim(),
    port: Number(d.port.trim()),
    senderCompId: d.senderCompId.trim(),
    targetCompId: d.targetCompId.trim(),
    senderSubId: opt(d.senderSubId),
    targetSubId: opt(d.targetSubId),
    username: opt(d.username),
    tls: d.tls,
    tlsServerName: opt(d.tlsServerName),
    heartbeatSecs: Number(d.heartbeatSecs.trim()),
    resetSeqOnLogon: d.resetSeqOnLogon,
    enabled: d.enabled,
  };
}

/** Only the fields that differ from `before` (a PATCH sends nothing else). Role is fixed once created. */
export function changedFields(before: Record<string, unknown>, d: ConnectionDraft): Record<string, unknown> {
  const body = draftBody(d);
  delete body.role;
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => (before[k] ?? null) !== v));
}

// ---- symbol rows (the bridge's [[lp.symbol]]) ----

export type SymbolDraft = { venueId: string; contractSize: string; minUnits: string; stepUnits: string };

// BigInt() calls, not literals: the build targets below ES2020
const ZERO = BigInt(0);
const SCALE = BigInt(10_000);
const MAX_SCALED = BigInt("99999999999999") * SCALE; // DECIMAL(18,4)

/** A decimal in units as an integer of 1/10000 (DECIMAL(18,4)), or a refusal in the server's words. */
function units(v: string, label: string): bigint | string {
  const t = v.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return `${label} must be a number above 0`;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > 4) return `${label} can have at most 4 decimals`;
  const scaled = BigInt(whole) * SCALE + BigInt((frac + "0000").slice(0, 4));
  if (scaled <= ZERO) return `${label} must be a number above 0`;
  if (scaled > MAX_SCALED) return `${label} is too large`;
  return scaled;
}

/** The first problem with a symbol row on a connection of this dialect, or null. */
export function symbolProblem(s: SymbolDraft, dialect: LpDialect): string | null {
  const venue = text(s.venueId, "venue symbol", 32, FIX_TEXT, "must have no spaces", true);
  if (venue) return venue;
  const cs = units(s.contractSize, "contract size");
  if (typeof cs === "string") return cs;
  const min = units(s.minUnits, "minimum units");
  if (typeof min === "string") return min;
  const step = units(s.stepUnits, "step units");
  if (typeof step === "string") return step;
  if (min % step !== ZERO) return "minimum units must be a multiple of step units";
  if (dialect === "CSERVER" && !/^\d+$/.test(s.venueId.trim())) return "a cTrader venue symbol is its numeric symbol id";
  return null;
}

export function symbolBody(s: SymbolDraft): Record<string, string> {
  return { venueId: s.venueId.trim(), contractSize: s.contractSize.trim(), minUnits: s.minUnits.trim(), stepUnits: s.stepUnits.trim() };
}
