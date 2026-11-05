import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withConfigEvent } from "@/lib/config-events";
import { defaultHmrCorrelations, resetHmrCache, seedHmrCorrelations } from "@/lib/hmr";
import { forbidden, parseCurrency, requireHmrAdmin } from "@/lib/hmr-admin";

// GET: the per-currency symbol lists (seeded from the broker's enabled symbols on first use, C2) plus the symbols the broker can pick
// from. PUT { currency, symbols }: replace one currency's list. Only symbols the broker has enabled can be listed.
export async function GET() {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  await seedHmrCorrelations(prisma, brokerId);
  const [rows, enabledRows] = await Promise.all([
    prisma.hmrCorrelation.findMany({ where: { brokerId }, orderBy: { currency: "asc" } }),
    prisma.brokerSymbol.findMany({ where: { brokerId, enabled: true }, select: { symbol: { select: { name: true, baseCurrency: true, quoteCurrency: true } } } }),
  ]);
  const enabledSymbols = enabledRows.map((r) => r.symbol);
  return NextResponse.json({
    correlations: Object.fromEntries(rows.map((r) => [r.currency, r.symbols])),
    defaults: defaultHmrCorrelations(enabledSymbols),
    enabledSymbols: enabledSymbols.map((s) => s.name).sort(),
  });
}

async function putHandler(request: NextRequest) {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const body = await request.json().catch(() => null);
  const currency = parseCurrency(body?.currency);
  if (!currency) return NextResponse.json({ error: "currency must be a 3-letter code such as USD" }, { status: 400 });
  if (!Array.isArray(body?.symbols) || body.symbols.some((s: unknown) => typeof s !== "string")) return NextResponse.json({ error: "symbols must be a list of symbol names" }, { status: 400 });
  const symbols = [...new Set((body.symbols as string[]).map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
  const enabled = await prisma.brokerSymbol.findMany({ where: { brokerId, enabled: true }, select: { symbol: { select: { name: true } } } });
  const enabledNames = new Set(enabled.map((e) => e.symbol.name));
  const unknown = symbols.filter((s) => !enabledNames.has(s));
  if (unknown.length > 0) return NextResponse.json({ error: `not enabled for this broker: ${unknown.join(", ")}`, code: "SYMBOL_NOT_ENABLED" }, { status: 400 });
  await prisma.$transaction(async (tx) => {
    const before = await tx.hmrCorrelation.findUnique({ where: { brokerId_currency: { brokerId, currency } } });
    await tx.hmrCorrelation.upsert({ where: { brokerId_currency: { brokerId, currency } }, create: { brokerId, currency, symbols }, update: { symbols } });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: "HMR_CORRELATION_UPDATED", entityType: "HmrCorrelation", entityId: `${brokerId}:${currency}`, oldValue: { currency, symbols: before?.symbols ?? null }, newValue: { currency, symbols } },
    });
  });
  resetHmrCache(brokerId);
  return NextResponse.json({ currency, symbols });
}

export const PUT = withConfigEvent("settings", putHandler);
