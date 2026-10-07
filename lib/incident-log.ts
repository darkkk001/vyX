// Step 3b item 4 (owner 2026-10-07): the trading halt incident log. No new table: every halt, close-only and sign-out-all already
// writes an AuditLog row (who, when, the new state). An INCIDENT is one stretch of a restriction (from the row that switched it on to
// the row that switched it off, with its length), or one sign-out of all clients (a point in time). Pure, so it is unit-tested.
export type IncidentKind = "HALT" | "CLOSE_ONLY" | "GROUP_HALT" | "GROUP_CLOSE_ONLY" | "SIGN_OUT_CLIENTS";

export type IncidentAuditRow = {
  id: string;
  action: string;
  entityId: string;
  createdAt: Date;
  actorEmail: string | null;
  oldValue: unknown;
  newValue: unknown;
};

export type Incident = {
  id: string;
  kind: IncidentKind;
  scope: string;               // "All trading", the group's name, "All clients"
  startedAt: string;           // ISO
  endedAt: string | null;      // null = still on
  startedBy: string;
  endedBy: string | null;
  durationSeconds: number | null;
  active: boolean;
};

export const INCIDENT_ACTIONS = ["RISK_HALT_TOGGLED", "RISK_CLOSE_ONLY_TOGGLED", "GROUP_HALT_TOGGLED", "GROUP_CLOSE_ONLY_TOGGLED", "BROKER_CLIENT_SESSIONS_REVOKED"] as const;

function flag(v: unknown, key: string): boolean | null {
  if (v && typeof v === "object" && key in (v as Record<string, unknown>)) {
    const x = (v as Record<string, unknown>)[key];
    if (typeof x === "boolean") return x;
  }
  return null;
}

/** rows in any order; groupNames: group id -> name. Newest incident first. */
export function buildIncidents(rows: IncidentAuditRow[], groupNames: ReadonlyMap<string, string>, now: Date = new Date()): Incident[] {
  const asc = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const open = new Map<string, Incident>();
  const out: Incident[] = [];
  for (const r of asc) {
    const who = r.actorEmail ?? "system";
    if (r.action === "BROKER_CLIENT_SESSIONS_REVOKED") {
      out.push({ id: r.id, kind: "SIGN_OUT_CLIENTS", scope: "All clients", startedAt: r.createdAt.toISOString(), endedAt: r.createdAt.toISOString(), startedBy: who, endedBy: who, durationSeconds: 0, active: false });
      continue;
    }
    let kind: IncidentKind; let key: string; let scope: string; let on: boolean | null;
    if (r.action === "RISK_HALT_TOGGLED") { kind = "HALT"; key = "b:halt"; scope = "All trading"; on = flag(r.newValue, "tradingHalted"); }
    else if (r.action === "RISK_CLOSE_ONLY_TOGGLED") { kind = "CLOSE_ONLY"; key = "b:co"; scope = "All trading"; on = flag(r.newValue, "closeOnly"); }
    else if (r.action === "GROUP_HALT_TOGGLED") { kind = "GROUP_HALT"; key = `g:${r.entityId}:halt`; scope = groupNames.get(r.entityId) ?? "A group"; on = flag(r.newValue, "tradingHalted"); }
    else if (r.action === "GROUP_CLOSE_ONLY_TOGGLED") { kind = "GROUP_CLOSE_ONLY"; key = `g:${r.entityId}:co`; scope = groupNames.get(r.entityId) ?? "A group"; on = flag(r.newValue, "closeOnly"); }
    else continue;
    if (on === null) continue;
    const cur = open.get(key);
    if (on) {
      if (cur) continue;   // already on: a repeated switch-on starts nothing new
      const inc: Incident = { id: r.id, kind, scope, startedAt: r.createdAt.toISOString(), endedAt: null, startedBy: who, endedBy: null, durationSeconds: null, active: true };
      open.set(key, inc); out.push(inc);
    } else if (cur) {
      cur.endedAt = r.createdAt.toISOString(); cur.endedBy = who; cur.active = false;
      cur.durationSeconds = Math.max(0, Math.round((r.createdAt.getTime() - new Date(cur.startedAt).getTime()) / 1000));
      open.delete(key);
    }
  }
  // a stretch still on: its length so far
  for (const inc of open.values()) inc.durationSeconds = Math.max(0, Math.round((now.getTime() - new Date(inc.startedAt).getTime()) / 1000));
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}
