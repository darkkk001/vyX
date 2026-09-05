import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Called by middleware.ts (Edge runtime) to look up a Broker by host, since
// Prisma cannot use directly on the Edge runtime. "Middleware is excluded
// from the matcher" only stops middleware from recursing into itself --
// it never stopped an external caller from hitting this route directly,
// and this had no auth of its own (2026-09-05 security audit finding,
// confirmed live: curl from outside with no internal header returned
// {id, subdomain, tier, logoUrl, primaryColor} with a 200, and a 404 for
// an unknown subdomain -- letting anyone brute-force the platform's full
// broker roster and each one's pricing tier). Now gated the same way
// every other internal-only route on this platform already is (lib/
// nats.ts, app/api/manage/feed-health, app/api/manage/accounts/[id]/
// positions) -- a shared secret header only this app's own middleware
// (and other trusted internal callers) can send.
export async function GET(request: NextRequest) {
  const internalSecretHeader = request.headers.get("x-internal-secret");
  const expectedSecret = process.env.INTERNAL_SERVICE_SECRET ?? "";
  if (!expectedSecret || internalSecretHeader !== expectedSecret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
