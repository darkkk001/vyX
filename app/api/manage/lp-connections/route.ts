import { withConfigEvent } from "@/lib/config-events";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
// owner 2026-11-10: Liquidity providers is a delegatable permission (BROKER_ADMIN, or a MANAGER holding LIQUIDITY_PROVIDERS)
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import {
  checkCserverHasSymbols,
  checkSymbolRow,
  connectionSnapshot,
  LpConnectionInputError,
  parseConnectionFields,
  parseSymbolFields,
  symbolSnapshot,
  touchesTimeouts,
  type SymbolFields,
} from "@/lib/lp-connection-input";
import { CONNECTION_INCLUDE, connectionView } from "@/lib/lp-connections";

// Platform API bridge config, A.1.3: the FIX sessions the broker's QoreBridge opens to its liquidity providers
// (served to the bridge by GET /api/bridge/config). BROKER_ADMIN, like routing rules. No password field exists: it is
// set on the bridge server. Timeout / retry values are Super Admin's (/api/admin/lp-connections) and never shown here.

async function brokerAdmin() {
  const session = await getAdminSession();
  return (await forbidUnlessBrokerAdminOrPermission(session, "LIQUIDITY_PROVIDERS")) ? null : session!;
}

export async function GET() {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await prisma.lpConnection.findMany({ where: { brokerId: session.brokerId! }, include: CONNECTION_INCLUDE, orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map((c) => connectionView(c, { timeouts: false })));
}

/** POST: a new connection for one of the broker's providers, optionally with its symbol rows (`symbols: [...]`) in the
 *  same step. A cTrader connection starts disabled unless it comes with its symbols. Audited LP_CONNECTION_CREATED. */
async function postHandler(request: NextRequest) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (touchesTimeouts(body)) return NextResponse.json({ error: "timeouts and retries are set by the platform operator" }, { status: 403 });
  try {
    const fields = await parseConnectionFields(prisma, brokerId, body, true);
    const rawSymbols = Array.isArray(body?.symbols) ? (body!.symbols as unknown[]) : [];
    if (rawSymbols.length > 200) throw new LpConnectionInputError("at most 200 symbols per connection");
    const dialect = fields.dialect ?? "FIX44";
    const symbols: Required<SymbolFields>[] = [];
    for (const raw of rawSymbols) {
      const s = await parseSymbolFields(prisma, brokerId, raw as Record<string, unknown>, true);
      checkSymbolRow(s as Required<SymbolFields>, dialect);
      if (symbols.some((x) => x.symbolId === s.symbolId)) throw new LpConnectionInputError("a symbol appears twice");
      symbols.push(s as Required<SymbolFields>);
    }
    const enabled = fields.enabled ?? (dialect !== "CSERVER" || symbols.length > 0);
    checkCserverHasSymbols(dialect, enabled, symbols.length);

    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.lpConnection.create({
        data: {
          brokerId,
          liquidityProviderId: fields.liquidityProviderId!,
          role: fields.role ?? "TRADE",
          enabled,
          host: fields.host!,
          port: fields.port!,
          senderCompId: fields.senderCompId!,
          targetCompId: fields.targetCompId!,
          senderSubId: fields.senderSubId ?? null,
          targetSubId: fields.targetSubId ?? null,
          username: fields.username ?? null,
          tls: fields.tls!,
          tlsServerName: fields.tlsServerName ?? null,
          dialect,
          ...(fields.heartbeatSecs !== undefined ? { heartbeatSecs: fields.heartbeatSecs } : {}),
          ...(fields.resetSeqOnLogon !== undefined ? { resetSeqOnLogon: fields.resetSeqOnLogon } : {}),
          symbols: { create: symbols.map((s) => ({ symbolId: s.symbolId, venueId: s.venueId, contractSize: s.contractSize, minUnits: s.minUnits, stepUnits: s.stepUnits })) },
        },
        include: CONNECTION_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "LP_CONNECTION_CREATED",
          entityType: "LpConnection",
          entityId: c.id,
          newValue: { ...connectionSnapshot(c), liquidityProvider: c.liquidityProvider.name, symbols: c.symbols.map((s) => symbolSnapshot(s, s.symbol.name)) },
        },
      });
      return c;
    });
    return NextResponse.json(connectionView(created, { timeouts: false }), { status: 201 });
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "this provider already has a connection for that role" }, { status: 409 });
    }
    throw e;
  }
}

// live reference data (owner 2026-10-29): every open backoffice re-reads this list at once
export const POST = withConfigEvent("lps", postHandler);
