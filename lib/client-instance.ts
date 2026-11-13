// Order sounds by origin (owner 2026-11-13, option C), the browser side: one WebTrader tab = one client instance.
//
// The tab makes a random id once and sends it on every /api/trade/* request (header x-client-instance, lib/desktop-api.ts); the server stamps
// it on the events the request causes (origin_client_id, lib/client-origin.ts) and stores it on the order / position for the automatic events
// (an SL / TP hit, a stop-out, a pending trigger, a dealer action). WebTrader plays its trade sounds from list diffs, so it asks isMine(id)
// first: a change is this tab's when an event named this tab as its origin, or this tab itself just acted on that id (its own close / cancel /
// order, which covers an answer that comes back without an event origin). Anything else stays silent on this tab.

export const CLIENT_INSTANCE_HEADER = "x-client-instance";
const TTL_MS = 120_000;

let instance: string | null = null;
/** This tab's id (made once per page load). */
export function clientInstanceId(): string {
  if (!instance) {
    const raw = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    instance = raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 40).padEnd(16, "0");
  }
  return instance;
}

const own = new Map<string, number>();           // id -> when this tab acted on it
const eventOrigin = new Map<string, { origin: string | null; at: number }>();   // id -> the origin its latest event carried

function prune(now: number) {
  for (const [k, t] of own) if (now - t > TTL_MS) own.delete(k);
  for (const [k, v] of eventOrigin) if (now - v.at > TTL_MS) eventOrigin.delete(k);
}

/** This tab is acting on these order / position ids (before the request, or from its answer). */
export function markOwn(...ids: (string | null | undefined)[]): void {
  const now = Date.now();
  for (const id of ids) if (id) own.set(id, now);
  prune(now);
}

/** A trading event arrived: remember which client caused it for the ids it names (null / absent = no client). */
export function noteEventOrigin(event: { origin_client_id?: unknown; order_id?: unknown; position_id?: unknown; position?: unknown } | null | undefined): void {
  if (!event) return;
  const origin = typeof event.origin_client_id === "string" ? event.origin_client_id : null;
  const now = Date.now();
  const nestedId = event.position && typeof event.position === "object" ? (event.position as { id?: unknown }).id : undefined;
  for (const id of [event.order_id, event.position_id, nestedId]) if (typeof id === "string" && id) eventOrigin.set(id, { origin, at: now });
  prune(now);
}

/** Should this tab sound for a change of this order / position? Its own action, or an event whose origin is this tab. */
export function isMine(...ids: (string | null | undefined)[]): boolean {
  const me = clientInstanceId(); const now = Date.now();
  for (const id of ids) {
    if (!id) continue;
    const t = own.get(id); if (t !== undefined && now - t <= TTL_MS) return true;
    const e = eventOrigin.get(id); if (e && now - e.at <= TTL_MS && e.origin === me) return true;
  }
  return false;
}

/** Tests only. */
export function resetClientInstanceForTests(id?: string): void { instance = id ?? null; own.clear(); eventOrigin.clear(); }
