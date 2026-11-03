import { Prisma, type PrismaClient } from "@prisma/client";
import { LP_TIMEOUT_FIELDS } from "@/lib/lp-connection-input";

// Platform API bridge config, A.1.3: how an LP connection is shown. A broker never sees the Super-Admin-only
// timeout / retry values (owner decision 2026-11-03); Super Admin does. No password exists to show.

type Db = PrismaClient | Prisma.TransactionClient;

export const CONNECTION_INCLUDE = {
  liquidityProvider: { select: { name: true } },
  symbols: { include: { symbol: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.LpConnectionInclude;

export type ConnectionRow = Prisma.LpConnectionGetPayload<{ include: typeof CONNECTION_INCLUDE }>;

export function connectionView(c: ConnectionRow, opts: { timeouts: boolean }) {
  const view: Record<string, unknown> = {
    id: c.id,
    liquidityProviderId: c.liquidityProviderId,
    liquidityProviderName: c.liquidityProvider.name,
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
    symbols: c.symbols.map((s) => ({
      id: s.id,
      symbolId: s.symbolId,
      symbolName: s.symbol.name,
      venueId: s.venueId,
      contractSize: s.contractSize.toString(),
      minUnits: s.minUnits.toString(),
      stepUnits: s.stepUnits.toString(),
    })),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
  if (opts.timeouts) for (const k of LP_TIMEOUT_FIELDS) view[k] = c[k];
  return view;
}

/** The connection if it belongs to the broker (locked FOR UPDATE inside a transaction when `lock`). */
export async function loadConnection(db: Db, id: string, brokerId: string | null, lock = false): Promise<ConnectionRow | null> {
  if (lock) await db.$queryRaw`SELECT id FROM "LpConnection" WHERE id = ${id} FOR UPDATE`;
  const c = await db.lpConnection.findUnique({ where: { id }, include: CONNECTION_INCLUDE });
  if (!c || (brokerId !== null && c.brokerId !== brokerId)) return null;
  return c;
}
