import { Prisma, type EngineStatus, type PrismaClient } from "@prisma/client";

// Multi-engine control plane (owner 2026-11-13, docs/ENGINE-REGISTRY.md): the engine registry, the broker -> engine assignment
// (Broker.engineId, the one source of truth) with its append-only history (EngineAssignmentLog), and the per-engine heartbeat rule.
// Dormant until the engine step: engines do not read engine_broker_scope or write lastBeatAt yet, and until an engine writes its own
// heartbeat the web's owner rule keeps using the single legacy heartbeat (RiskEngineHeartbeat 'risk'), so ownership is exactly today's.

export const ENGINE_STATUSES: readonly EngineStatus[] = ["PLANNED", "ACTIVE", "DRAINING", "RETIRED"];
/** Statuses that serve their brokers (the engine_broker_scope view lists only these). */
export const SERVING: ReadonlySet<EngineStatus> = new Set<EngineStatus>(["ACTIVE", "DRAINING"]);

export class EngineRegistryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** An engine id: 3 to 40 of a-z, 0-9 and dashes, starting with a letter (it becomes the engine's ENGINE_ID). */
export function validEngineId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9-]{2,39}$/.test(id);
}

/** A gateway URL: https, a host, no credentials. */
export function validGatewayUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 300) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

export type EngineHealth = "fresh" | "stale" | "never";
/** The engine's own heartbeat, as the console shows it. */
export function engineHealth(lastBeatAt: Date | null, staleAfterSecs: number, now: Date = new Date()): EngineHealth {
  if (!lastBeatAt) return "never";
  return now.getTime() - lastBeatAt.getTime() <= staleAfterSecs * 1000 ? "fresh" : "stale";
}

/**
 * Is the engine alive for an account's broker, for the web's owner rule (lib/risk-owner.ts)?
 *   - no assigned engine, or an engine that has never written its own heartbeat (every engine until the engine step): the legacy single
 *     heartbeat decides, exactly as today -- so the console cannot move risk to the web while the engine still acts on its own rule;
 *   - an engine that writes its own heartbeat: alive only while that heartbeat is fresh AND the engine is ACTIVE or DRAINING. A RETIRED or
 *     PLANNED engine, or a stale one, serves nothing, and the web reclaims its brokers' accounts.
 */
export function engineAliveForBroker(legacyAlive: boolean, engine: { status: EngineStatus | string; started: boolean; fresh: boolean } | null): boolean {
  if (!engine || !engine.started) return legacyAlive;
  return SERVING.has(engine.status as EngineStatus) && engine.fresh;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Assign, move or unassign a broker's engine (Broker.engineId), with its history row and audit row, in one transaction. The broker row is locked
 * so two moves cannot interleave. `engineId` null = unassign. A no-op (already there) writes nothing. The engine must exist and not be RETIRED.
 */
export async function assignBrokerEngine(
  prisma: PrismaClient,
  input: { brokerId: string; engineId: string | null; reason: string; adminId: string },
): Promise<{ changed: boolean; fromEngineId: string | null; toEngineId: string | null }> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new EngineRegistryError("a reason is required");
  if (reason.length > 500) throw new EngineRegistryError("the reason is too long (500 characters at most)");
  if (input.engineId !== null && !validEngineId(input.engineId)) throw new EngineRegistryError("unknown engine", 404);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; engineId: string | null; subdomain: string }[]>`
      SELECT id, "engineId", subdomain FROM "Broker" WHERE id = ${input.brokerId} FOR UPDATE`;
    const broker = rows[0];
    if (!broker) throw new EngineRegistryError("broker not found", 404);
    if (input.engineId !== null) {
      const engine = await tx.engine.findUnique({ where: { id: input.engineId }, select: { status: true } });
      if (!engine) throw new EngineRegistryError("unknown engine", 404);
      if (engine.status === "RETIRED") throw new EngineRegistryError("a retired engine takes no brokers", 409);
    }
    if (broker.engineId === input.engineId) return { changed: false, fromEngineId: broker.engineId, toEngineId: input.engineId };
    await tx.broker.update({ where: { id: broker.id }, data: { engineId: input.engineId } });
    await tx.engineAssignmentLog.create({
      data: { brokerId: broker.id, fromEngineId: broker.engineId, toEngineId: input.engineId, adminId: input.adminId, reason },
    });
    await tx.auditLog.create({
      data: {
        brokerId: broker.id, actorAdminId: input.adminId, action: "BROKER_ENGINE_ASSIGNED", entityType: "Broker", entityId: broker.id,
        oldValue: { engineId: broker.engineId }, newValue: { engineId: input.engineId, subdomain: broker.subdomain, reason },
      },
    });
    return { changed: true, fromEngineId: broker.engineId, toEngineId: input.engineId };
  });
}

/** The brokers an engine serves by the view (exactly what the engine will read with its ENGINE_ID). */
export async function servedBrokerIds(db: Db, engineId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ broker_id: string }[]>`SELECT broker_id FROM "engine_broker_scope" WHERE engine_id = ${engineId} ORDER BY broker_id`;
  return rows.map((r) => r.broker_id);
}

/** The console's view of an engine. */
export function engineView(
  e: { id: string; name: string; region: string; gatewayUrl: string; status: EngineStatus; lastBeatAt: Date | null; lastBeatVersion: string | null; staleAfterSecs: number; notes: string; createdAt: Date; updatedAt: Date },
  brokerCount: number,
  now: Date = new Date(),
) {
  return {
    id: e.id, name: e.name, region: e.region, gatewayUrl: e.gatewayUrl, status: e.status, notes: e.notes,
    staleAfterSecs: e.staleAfterSecs, lastBeatAt: e.lastBeatAt?.toISOString() ?? null, lastBeatVersion: e.lastBeatVersion,
    health: engineHealth(e.lastBeatAt, e.staleAfterSecs, now), brokerCount,
    createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
  };
}

/** Validate the editable fields of an engine (create: all required; edit: any subset). */
export function parseEngineInput(body: unknown, create: boolean) {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: { id?: string; name?: string; region?: string; gatewayUrl?: string; status?: EngineStatus; staleAfterSecs?: number; notes?: string } = {};
  if (create) {
    if (!validEngineId(b.id)) throw new EngineRegistryError("id: 3 to 40 of a-z, 0-9 and -, starting with a letter");
    out.id = b.id;
  }
  const text = (k: "name" | "region" | "notes", max: number, required: boolean) => {
    if (b[k] === undefined) { if (create && required) throw new EngineRegistryError(`${k} is required`); return; }
    if (typeof b[k] !== "string") throw new EngineRegistryError(`${k} must be text`);
    const v = (b[k] as string).trim();
    if (required && v.length === 0) throw new EngineRegistryError(`${k} is required`);
    if (v.length > max) throw new EngineRegistryError(`${k} is too long (${max} characters at most)`);
    out[k] = v;
  };
  text("name", 80, true); text("region", 80, true); text("notes", 1000, false);
  if (b.gatewayUrl !== undefined || create) {
    if (!validGatewayUrl(b.gatewayUrl)) throw new EngineRegistryError("gateway URL: an https address");
    out.gatewayUrl = b.gatewayUrl;
  }
  if (b.status !== undefined) {
    if (!ENGINE_STATUSES.includes(b.status as EngineStatus)) throw new EngineRegistryError("status: PLANNED, ACTIVE, DRAINING or RETIRED");
    out.status = b.status as EngineStatus;
  }
  if (b.staleAfterSecs !== undefined) {
    if (typeof b.staleAfterSecs !== "number" || !Number.isInteger(b.staleAfterSecs) || b.staleAfterSecs < 5 || b.staleAfterSecs > 600) {
      throw new EngineRegistryError("stale after: 5 to 600 seconds");
    }
    out.staleAfterSecs = b.staleAfterSecs;
  }
  return out;
}
