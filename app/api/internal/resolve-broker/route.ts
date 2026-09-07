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

  // 2026-09-07 outage fix -- a custom apex domain added to the Vercel
  // project 308-redirects to its www subdomain at the platform level
  // (same thing the root ROOT_DOMAIN already has to account for, see
  // middleware.ts's own comment on isRootOrSuperAdmin) BEFORE the
  // request ever reaches this app, so the Host our middleware actually
  // sees is always "www.<customDomain>", never the bare form -- but
  // Broker.customDomain is stored bare (see BrokersManager.tsx's
  // "trade.acmefx.com" placeholder, no www). An exact-match lookup on
  // the bare stored value against the www-prefixed live Host therefore
  // never matched, 404ing every request to every broker's custom
  // domain (confirmed live via `vercel logs`: www.futurixglobal.com's
  // resolve-broker calls were 100% 404 while futurixglobal.vyxtrader.com's
  // were 100% 200, on the exact same broker row). Matching both the
  // bare and www-prefixed form here -- rather than assuming which way a
  // given customDomain happens to be stored -- means this can't recur
  // however a value ends up saved.
  const customDomainVariants = customDomain
    ? Array.from(
        new Set([customDomain, customDomain.replace(/^www\./, ""), `www.${customDomain.replace(/^www\./, "")}`]),
      )
    : [];

  const broker = await prisma.broker.findFirst({
    where: subdomain
      ? { subdomain, status: "ACTIVE" }
      : { customDomain: { in: customDomainVariants }, status: "ACTIVE" },
    select: {
      id: true,
      subdomain: true,
      tier: true,
      logoUrl: true,
      primaryColor: true,
      customDomain: true,
    },
  });

  if (!broker) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  return NextResponse.json(broker);
}
