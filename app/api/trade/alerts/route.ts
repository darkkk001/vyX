import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishAlertConfig } from "@/lib/nats";
import { validateAlertInput, checkActiveAlertLimit } from "@/lib/price-alerts";

// Phase 1 trust pack §3 -- replaces WebTrader.tsx's old client-side-only
// mock (an in-memory array the browser tab held, evaluated by that same
// tab's own local price feed, gone on reload) with a real, server-
// evaluated alert -- see PriceAlert's own schema comment for the full
// picture. Default (no ?status) matches every other list endpoint in
// this app's own "active view is the default, ?status=all is history"
// convention (app/api/trade/orders/route.ts).
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const showAll = new URL(request.url).searchParams.get("status") === "all";

  const alerts = await prisma.priceAlert.findMany({
    where: {
      accountId: session.accountId,
      ...(showAll ? {} : { status: "ACTIVE" }),
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(alerts);
}

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const validated = validateAlertInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { symbol, condition, price, expiresAt } = validated.value;

  // Only against a symbol this broker actually enables -- same check
  // every order route already runs, so an alert can't be set on a symbol
  // nothing ever ticks for the engine to check it against.
  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId: session.brokerId, enabled: true, symbol: { name: symbol } },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 });
  }

  const activeCount = await prisma.priceAlert.count({ where: { accountId: session.accountId, status: "ACTIVE" } });
  const limitError = checkActiveAlertLimit(activeCount);
  if (limitError) {
    return NextResponse.json({ error: limitError }, { status: 400 });
  }

  const alert = await prisma.priceAlert.create({
    data: {
      accountId: session.accountId,
      brokerId: session.brokerId,
      symbol,
      condition,
      price,
      expiresAt,
    },
  });

  // Hot-reloads engine/server's in-memory AlertCache -- see lib/nats.ts's
  // own comment. Best-effort: a publish failure here doesn't fail the
  // request (the alert still exists and would be picked up by the
  // engine's next boot-time load), same "don't let a NATS hiccup block a
  // real DB write that already succeeded" convention every other
  // publishTradingEvent call site in this app already follows.
  await publishAlertConfig({
    action: "create",
    id: alert.id,
    account_id: alert.accountId,
    broker_id: alert.brokerId,
    symbol: alert.symbol,
    condition: alert.condition,
    price: alert.price.toString(),
  });

  return NextResponse.json(alert, { status: 201 });
}
