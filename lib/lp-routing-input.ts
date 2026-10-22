import { Prisma, type PrismaClient } from "@prisma/client";
import { symbolHiddenFromBroker } from "@/lib/synthetic-symbols";

// QoreBridge M5: the editable fields of a routing rule (app/api/manage/lp-routing). A rule picks the provider(s) for a
// market-book group's hedges: groupId null = every group, symbolId null = every symbol; the most specific rule wins
// (group + symbol, group, symbol, broker-wide). priority = the failover level (1 = primary), weight = this provider's
// share of its level's volume, enabled = whether QoreBridge uses it.

type Db = PrismaClient | Prisma.TransactionClient;

export type RuleFields = {
  liquidityProviderId?: string;
  groupId?: string | null;
  symbolId?: string | null;
  priority?: number;
  weight?: Prisma.Decimal;
  enabled?: boolean;
  notes?: string | null;
};

export class RuleInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Reads and checks the fields present in `body` (absent = unchanged). Every id must belong to the broker. */
export async function parseRuleFields(db: Db, brokerId: string, body: Record<string, unknown> | null): Promise<RuleFields> {
  const out: RuleFields = {};
  if (!body) return out;
  if ("liquidityProviderId" in body) {
    const id = typeof body.liquidityProviderId === "string" ? body.liquidityProviderId : "";
    const provider = id ? await db.liquidityProvider.findUnique({ where: { id } }) : null;
    if (!provider || provider.brokerId !== brokerId) throw new RuleInputError("liquidity provider not found", 404);
    out.liquidityProviderId = provider.id;
  }
  if ("groupId" in body) {
    if (body.groupId === null || body.groupId === "") out.groupId = null;
    else {
      const group = typeof body.groupId === "string" ? await db.group.findUnique({ where: { id: body.groupId } }) : null;
      if (!group || group.brokerId !== brokerId) throw new RuleInputError("group not found", 404);
      out.groupId = group.id;
    }
  }
  if ("symbolId" in body) {
    if (body.symbolId === null || body.symbolId === "") out.symbolId = null;
    else {
      const symbol = typeof body.symbolId === "string" ? await db.symbol.findUnique({ where: { id: body.symbolId } }) : null;
      if (!symbol || (await symbolHiddenFromBroker(db, brokerId, symbol.name))) throw new RuleInputError("symbol not found", 404);
      out.symbolId = symbol.id;
    }
  }
  if ("priority" in body) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p <= 0) throw new RuleInputError("priority must be a positive integer");
    out.priority = p;
  }
  if ("weight" in body) {
    let w: Prisma.Decimal;
    try {
      w = new Prisma.Decimal(String(body.weight));
    } catch {
      throw new RuleInputError("weight must be a number above 0");
    }
    if (!w.isFinite() || w.lte(0) || w.gt(1_000_000)) throw new RuleInputError("weight must be a number above 0");
    out.weight = w.toDecimalPlaces(4);
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new RuleInputError("enabled must be true or false");
    out.enabled = body.enabled;
  }
  if ("notes" in body) out.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  return out;
}

/** The audit snapshot of a rule (strings for decimals). */
export function ruleSnapshot(r: { liquidityProviderId: string; groupId: string | null; symbolId: string | null; priority: number; weight: Prisma.Decimal; enabled: boolean; notes: string | null }) {
  return { liquidityProviderId: r.liquidityProviderId, groupId: r.groupId, symbolId: r.symbolId, priority: r.priority, weight: r.weight.toString(), enabled: r.enabled, notes: r.notes };
}
