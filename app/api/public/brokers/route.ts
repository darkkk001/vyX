import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { excludeDemoBroker } from "@/lib/demo-policy";

// Unauthenticated, broker-agnostic — populates the "server" picker on the
// root-domain launcher (app/launch) and the generic desktop app build, the
// same way an MT5 terminal's server dropdown lists available brokers before
// you log in to any specific one. Only the fields needed to route a trader
// to the right subdomain; no balances, no counts, nothing sensitive.
export async function GET() {
  const brokers = await prisma.broker.findMany({
    where: { status: "ACTIVE", ...excludeDemoBroker() }, // the QoreTrader demo is not listed in the launcher
    select: { name: true, subdomain: true, logoUrl: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(brokers);
}
