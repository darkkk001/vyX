import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { resolveTradingWindows, type BridgeSession, type BridgeSessionsSource } from "@/lib/bridge-sessions";

// Platform API bridge config (A.1.2): what GET /api/bridge/config serves a licensed QoreBridge, for its license's
// broker only. LP connections and their symbol tables (LpConnection / LpConnectionSymbol, the bridge's [[lp]] and
// [[lp.symbol]]) and the routing rules (view "HedgeRoutingRule", which the bridge still reads from its own database
// connection today; served here so a later bridge can compare or drop that read).
//
// Never in here: an LP password (stays on the bridge server, [lp_secret."<id>"]), a CA file path, raw-log settings.
// `version` is the SHA-256 of the canonical JSON of everything else, so it changes exactly when the content does --
// trading windows included (a TradingSession edit, or the default rule moving with US daylight time).
//
// Each LP symbol carries its trading windows (lib/bridge-sessions.ts): `sessions` = same-day UTC windows when the
// market is open, `sessionsSource` = "configured" (the broker's TradingSession rows) or "default" (the platform rule).

export type BridgeLpSymbol = {
  engine: string;
  venueId: string;
  contractSize: string;
  minUnits: string;
  stepUnits: string;
  sessionsSource: BridgeSessionsSource;
  sessions: BridgeSession[];
};
export type BridgeLp = {
  id: string; // = LiquidityProvider.id = the bridge's [[lp]] id
  role: "TRADE" | "QUOTE";
  enabled: boolean;
  host: string;
  port: number;
  senderCompId: string;
  targetCompId: string;
  senderSubId: string | null;
  targetSubId: string | null;
  username: string | null;
  tls: "OFF" | "WEBPKI" | "NATIVE";
  tlsServerName: string | null;
  dialect: "FIX44" | "CSERVER";
  heartbeatSecs: number;
  resetSeqOnLogon: boolean;
  ackTimeoutMs: number | null;
  orderTtlSecs: number | null;
  maxAttempts: number | null;
  reconcileTimeoutSecs: number | null;
  symbols: BridgeLpSymbol[];
};
export type BridgeRoutingRule = { id: string; groupId: string | null; symbol: string | null; lpId: string; priority: number; weight: string; enabled: boolean };
export type BridgeConfigBody = { brokerId: string; lps: BridgeLp[]; routing: BridgeRoutingRule[] };
export type BridgeConfig = BridgeConfigBody & { version: string };

const byString = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export async function buildBridgeConfig(brokerId: string, now: Date = new Date()): Promise<BridgeConfig> {
  const rows = await prisma.lpConnection.findMany({
    where: { brokerId },
    include: { symbols: { include: { symbol: { select: { id: true, name: true, category: true } } } } },
  });
  // this broker's own trading windows for the symbols its LPs trade (TradingSession rows hang off BrokerSymbol)
  const symbolIds = [...new Set(rows.flatMap((c) => c.symbols.map((s) => s.symbolId)))];
  const brokerSymbols = symbolIds.length
    ? await prisma.brokerSymbol.findMany({
        where: { brokerId, symbolId: { in: symbolIds } },
        select: { symbolId: true, tradingSessions: { select: { dayOfWeek: true, openTime: true, closeTime: true, kind: true } } },
      })
    : [];
  const sessionRows = new Map(brokerSymbols.map((b) => [b.symbolId, b.tradingSessions.map((t) => ({ ...t, kind: t.kind as string }))]));
  const lps: BridgeLp[] = rows
    .map((c) => ({
      id: c.liquidityProviderId,
      role: c.role,
      enabled: c.enabled,
      host: c.host,
      port: c.port,
      senderCompId: c.senderCompId,
      targetCompId: c.targetCompId,
      senderSubId: c.senderSubId,
      targetSubId: c.targetSubId,
      username: c.username,
      tls: c.tls,
      tlsServerName: c.tlsServerName,
      dialect: c.dialect,
      heartbeatSecs: c.heartbeatSecs,
      resetSeqOnLogon: c.resetSeqOnLogon,
      ackTimeoutMs: c.ackTimeoutMs,
      orderTtlSecs: c.orderTtlSecs,
      maxAttempts: c.maxAttempts,
      reconcileTimeoutSecs: c.reconcileTimeoutSecs,
      symbols: c.symbols
        .map((s) => ({
          engine: s.symbol.name,
          venueId: s.venueId,
          contractSize: s.contractSize.toString(),
          minUnits: s.minUnits.toString(),
          stepUnits: s.stepUnits.toString(),
          ...resolveTradingWindows(sessionRows.get(s.symbolId) ?? [], s.symbol.category, s.symbol.name, now),
        }))
        .sort(byString((s) => s.engine)),
    }))
    .sort(byString((l) => `${l.id}\n${l.role}`));
  const rules = await prisma.$queryRaw<{ id: string; groupId: string | null; symbol: string | null; lpId: string; priority: number; weight: { toString(): string }; enabled: boolean }[]>`
    SELECT "id", "groupId", "symbol", "lpId", "priority", "weight", "enabled" FROM "HedgeRoutingRule" WHERE "brokerId" = ${brokerId}`;
  const routing: BridgeRoutingRule[] = rules
    .map((r) => ({ id: r.id, groupId: r.groupId, symbol: r.symbol, lpId: r.lpId, priority: Number(r.priority), weight: r.weight.toString(), enabled: r.enabled }))
    .sort(byString((r) => r.id));
  const body: BridgeConfigBody = { brokerId, lps, routing };
  return { version: bridgeConfigVersion(body), ...body };
}

/** SHA-256 hex of the canonical JSON (the objects above are built with a fixed key order and sorted arrays). */
export function bridgeConfigVersion(body: BridgeConfigBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
