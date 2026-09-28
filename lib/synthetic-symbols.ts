import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Synthetic symbols for the shadow-bot tenant (owner decision 2026-09-28): vGOLD, vEUR, vGBP, vJPY, vIDX. Their
// prices come only from the engine's /internal/synth-feed (own secret), never from the MT5 feed; they are listed on the
// zzshadowbot broker only and hidden from / refused for every other broker.
//
// ONE reserved prefix (web side). The engine holds the same value in engine/market-data/src/synthetic.rs
// (SYNTH_PREFIX); lib/synthetic-symbols.test.ts fails if the two differ.
//
// Case rule: CASE-SENSITIVE, a leading lowercase "v" only. Real instrument names are upper case, and real upper-case
// "V..." names exist (VIX, VOD, ...), so a case-insensitive rule could hide or drop a real symbol; the lowercase rule
// reserves nothing a real feed or broker uses (checked on the live DB 2026-09-28: no Symbol / BrokerSymbol / LivePrice
// / Candle / PriceAlert name starts with "v" or "V" in any case).
export const SYNTH_PREFIX = "v";
export const SHADOWBOT_SUBDOMAIN = "zzshadowbot";

/** Leading-prefix match only (startsWith), case-sensitive: never a suffix or substring match. */
export function isSyntheticSymbol(name: string | null | undefined): boolean {
  return typeof name === "string" && name.startsWith(SYNTH_PREFIX);
}

/** The exact form every synthetic name takes: "v" + upper-case letters / digits (vGOLD, vIDX). */
const SYNTH_NAME = /^v[A-Z0-9]+$/;

/**
 * A typed symbol name as the order / alert routes look it up. They upper-case the input ("xauusd" -> "XAUUSD"); a
 * well-formed synthetic name keeps its exact case ("vGOLD" stays "vGOLD", which "VGOLD" would never match). Anything
 * else is upper-cased exactly as before, so e.g. "vix" still resolves to a real "VIX".
 */
export function canonicalSymbolName(raw: string): string {
  const t = raw.trim();
  return SYNTH_NAME.test(t) ? t : t.toUpperCase();
}

/** Only the shadow-bot tenant sees or configures synthetic symbols. */
export async function brokerMaySeeSynthetic(db: Db, brokerId: string): Promise<boolean> {
  const b = await db.broker.findUnique({ where: { id: brokerId }, select: { subdomain: true } });
  return b?.subdomain === SHADOWBOT_SUBDOMAIN;
}
