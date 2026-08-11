import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Called by middleware.ts (Edge runtime) to look up a Broker by host, since
// Prisma cannot run on the Edge runtime. Not intended to be called
// directly by clients — middleware is excluded from the matcher via
// config.matcher, but this route has no auth of its own, so it only ever
// returns the small set of fields middleware needs to inject as headers.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const subdomain = searchParams.get("subdomain");
  const customDomain = searchParams.get("customDomain");

  if (!subdomain && !customDomain) {
    return NextResponse.json({ error: "missing host param" }, { status: 400 });
  }

  const broker = await prisma.broker.findFirst({
    where: subdomain
      ? { subdomain, status: "ACTIVE" }
      : { customDomain, status: "ACTIVE" },
    select: {
      id: true,
      subdomain: true,
      tier: true,
      logoUrl: true,
      primaryColor: true,
    },
  });

  if (!broker) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  return NextResponse.json(broker);
}
