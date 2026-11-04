import "server-only";
import { NextResponse } from "next/server";
import type { AdminSessionPayload } from "@/lib/auth";
import { getPermissionContext, PERMISSION_LABELS, type Permission } from "@/lib/permissions";

// Web security batch 1 S2 / S3 (owner 2026-10-29): group and symbol writes by permission, judged on the fields a request CHANGES (the group
// form sends every field on each save, so "present" would refuse every rename by a group editor).
// - config (name, display name, lots, swap-free, side restriction, tier, ...): GROUPS_SYMBOLS
// - routing (category A-book / B-book / coverage, dealing mode, force dealing mode, mode restriction): DEALING
// - risk (leverage, margin call level, stop-out level): RISK_SETTINGS
// - halt (a symbol's trading hours emptied, i.e. no session left): EMERGENCY_CONTROLS, on top of GROUPS_SYMBOLS
// BROKER_ADMIN holds them all. A request that mixes classes needs every permission involved and is refused whole, naming the first missing.
export type WriteClass = "config" | "routing" | "risk" | "halt";
const NEEDS: Record<WriteClass, Permission> = { config: "GROUPS_SYMBOLS", routing: "DEALING", risk: "RISK_SETTINGS", halt: "EMERGENCY_CONTROLS" };
const ORDER: WriteClass[] = ["config", "routing", "risk", "halt"];

/** null = allowed; otherwise the 403 { error, permission, permissionLabel } to return. */
export async function writeRefusal(session: AdminSessionPayload | null, classes: Iterable<WriteClass>, routeName: string): Promise<NextResponse | null> {
  const wanted = new Set(classes);
  if (wanted.size === 0) return null;
  const ctx = await getPermissionContext(session, routeName);
  for (const c of ORDER) {
    if (!wanted.has(c)) continue;
    const p = NEEDS[c];
    if (ctx.forbidUnless(p)) {
      return NextResponse.json({ error: `This change needs the "${PERMISSION_LABELS[p]}" permission.`, permission: p, permissionLabel: PERMISSION_LABELS[p] }, { status: 403 });
    }
  }
  return null;
}

/** Equal for the group compare: numbers, Decimals and strings by their text, null / undefined alike. */
export function same(a: unknown, b: unknown): boolean {
  const t = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return t(a) === t(b);
}
