import "server-only";
import { Prisma } from "@prisma/client";

// Trader's Room journal: preset tags, the rules check and the shapes the screen reads. Every closed trade is a journal
// row; the client's own data (tags, note, rules check) sits in TradeJournalEntry.

export const PRESET_TAGS = ["Plan", "FOMO", "News", "Revenge", "No SL"] as const;
export const RULES = [
  { key: "plan", label: "Followed the plan" },
  { key: "confirmation", label: "Waited for confirmation" },
  { key: "risk", label: "Risk within 2%" },
  { key: "breakeven", label: "Moved SL to breakeven" },
] as const;
export type RuleKey = (typeof RULES)[number]["key"];

/** Tags as typed by the client: trimmed, 1-24 characters, at most 12, no duplicates (case-insensitive). */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

export function cleanChecklist(raw: unknown): Record<RuleKey, boolean> {
  const r = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(RULES.map((x) => [x.key, r[x.key] === true])) as Record<RuleKey, boolean>;
}

export const JOURNAL_SELECT = {
  id: true, ticket: true, accountId: true, side: true, volume: true, initialVolume: true, openPrice: true, closePrice: true, slPrice: true,
  realizedPnl: true, swap: true, commission: true, openedAt: true, closedAt: true, symbol: { select: { name: true, digits: true } },
} satisfies Prisma.PositionSelect;
export type JournalPosition = Prisma.PositionGetPayload<{ select: typeof JOURNAL_SELECT }>;

export function netOf(p: JournalPosition): number {
  return (p.realizedPnl ?? new Prisma.Decimal(0)).add(p.swap).sub(p.commission).toNumber();
}
export function rOf(p: JournalPosition): number | null {
  if (!p.slPrice || !p.closePrice) return null;
  const open = p.openPrice.toNumber(), close = p.closePrice.toNumber(), sl = p.slPrice.toNumber();
  const dist = Math.abs(open - sl);
  if (dist <= 0) return null;
  return (p.side === "BUY" ? close - open : open - close) / dist;
}
