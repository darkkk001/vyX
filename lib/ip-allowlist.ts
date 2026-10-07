// Step 3b item 3 (owner 2026-10-07): the staff IP allowlist. The client address is the Vercel-provided x-forwarded-for, FIRST hop
// (owner decision), read in ONE place (clientIpFromHeaders) and used by the allowlist and the staff device record alike.
export function clientIpFromHeaders(h: { get(name: string): string | null }): string {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

export const MAX_ALLOWLIST_ENTRIES = 50;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4ToInt(ip: string): number | null {
  const m = V4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export type AllowEntry = { kind: "v4"; base: number; bits: number } | { kind: "v6"; text: string };

/** One entry: an IPv4 address, an IPv4 range 1.2.3.0/24, or one IPv6 address (exact). null = not a valid entry. */
export function parseAllowEntry(raw: string): AllowEntry | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const slash = t.indexOf("/");
  if (slash < 0) {
    const n = v4ToInt(t);
    if (n !== null) return { kind: "v4", base: n, bits: 32 };
    return /^[0-9a-f:]+$/.test(t) && t.includes(":") && t.length <= 39 ? { kind: "v6", text: t } : null;
  }
  const n = v4ToInt(t.slice(0, slash));
  const bits = Number(t.slice(slash + 1));
  if (n === null || !Number.isInteger(bits) || bits < 8 || bits > 32) return null;   // a /0 to /7 would allow half the internet
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return { kind: "v4", base: (n & mask) >>> 0, bits };
}

export function ipAllowed(ip: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  const t = ip.trim().toLowerCase();
  if (!t) return false;
  const asV4 = v4ToInt(t);
  for (const raw of entries) {
    const e = parseAllowEntry(raw);
    if (!e) continue;
    if (e.kind === "v6") { if (e.text === t) return true; continue; }
    if (asV4 === null) continue;
    const mask = e.bits === 32 ? 0xffffffff : (~((1 << (32 - e.bits)) - 1)) >>> 0;
    if (((asV4 & mask) >>> 0) === e.base) return true;
  }
  return false;
}

export type AllowlistCheck = { ok: true; entries: string[] } | { ok: false; error: string; code?: string };

/** Validates a list the admin wants to save. An empty list switches the allowlist off. A non-empty list must contain the address
 *  the admin is saving it from (never lock yourself out). */
export function checkAllowlistSave(list: unknown, currentIp: string): AllowlistCheck {
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) return { ok: false, error: "the allowed addresses must be a list of text" };
  const entries = [...new Set((list as string[]).map((x) => x.trim()).filter((x) => x.length > 0))];
  if (entries.length === 0) return { ok: true, entries: [] };
  if (entries.length > MAX_ALLOWLIST_ENTRIES) return { ok: false, error: `at most ${MAX_ALLOWLIST_ENTRIES} addresses` };
  const bad = entries.find((e) => parseAllowEntry(e) === null);
  if (bad) return { ok: false, error: `"${bad}" is not an address (use 203.0.113.7 or 203.0.113.0/24, ranges no wider than /8)` };
  if (!ipAllowed(currentIp, entries)) {
    return { ok: false, error: currentIp ? `your address ${currentIp} is not in the list: add it first, or you would lock yourself out` : "your address could not be read: not saved, you could lock yourself out", code: "IP_LOCKOUT" };
  }
  return { ok: true, entries };
}

/** Password change interval (days): staff must change their password when it is older than this. */
export const MIN_PASSWORD_MAX_AGE_DAYS = 7;
export const MAX_PASSWORD_MAX_AGE_DAYS = 3650;
export function passwordExpired(changedAt: Date | null, createdAt: Date, maxAgeDays: number | null, now: Date): boolean {
  if (maxAgeDays === null || maxAgeDays <= 0) return false;
  const since = changedAt ?? createdAt;
  return now.getTime() - since.getTime() > maxAgeDays * 86_400_000;
}
