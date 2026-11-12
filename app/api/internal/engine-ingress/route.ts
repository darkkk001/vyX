import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { engineFillsFor, engineIngressGatewayHost, engineIngressScope } from "@/lib/engine-ingress";

export const dynamic = "force-dynamic";

// What the RUNNING deployment's engine ingress sees (lib/engine-ingress.ts): enabled, how many accounts, the
// gateway host, and with ?accountId= whether that account's MARKET orders divert. Proves the scope without a
// trade. Same shared-secret gate as the other internal routes; it never returns the account list itself.
export async function GET(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const accountId = request.nextUrl.searchParams.get("accountId");
  return NextResponse.json({
    ...engineIngressScope(),
    gatewayHost: engineIngressGatewayHost(),
    ...(accountId ? { accountId, fillsFor: engineFillsFor(accountId) } : {}),
  });
}
