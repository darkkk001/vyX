import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Public, unauthenticated by design -- the exact same branding data
// app/(broker)/trade/page.tsx and trade/login/page.tsx already inject
// server-side into every page load (brokerName/supportEmail via Prisma,
// logoUrl already resolved into the x-broker-logo-url header by
// middleware.ts), just as a small JSON endpoint so a bundled desktop
// shell -- which has no Server Component of its own to do this -- can
// fetch it the same way it fetches everything else, through the
// existing api_request bridge, before a session exists.
export async function GET(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, supportEmail: true, primaryColor: true } });

  return NextResponse.json({
    brokerName: broker?.name ?? "VyXTrader",
    brokerLogoUrl: request.headers.get("x-broker-logo-url") ?? "",
    supportEmail: broker?.supportEmail ?? null,
    primaryColor: broker?.primaryColor ?? null,
  });
}
