import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { engineFillsFor, engineIngressGatewayHost, engineIngressScope, engineLiveRoutesFor } from "@/lib/engine-ingress";

export const dynamic = "force-dynamic";

// What the RUNNING deployment's engine ingress sees (lib/engine-ingress.ts): enabled, how many accounts, the
// gateway host, and with ?accountId= whether that account's MARKET orders divert (fillsFor) and why: on the DEMO
// ingress list (demoList) or switched on by the live allowlist (liveAllowlist). Proves the scope without a trade. Same shared-secret gate as the other internal routes; it never returns the account list itself.
export async function GET(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const accountId = request.nextUrl.searchParams.get("accountId");
  return NextResponse.json({
    ...engineIngressScope(),
    gatewayHost: engineIngressGatewayHost(),
    ...(accountId ? await accountScope(accountId) : {}),
  });
}

async function accountScope(accountId: string) {
  const demoList = engineFillsFor(accountId);
  const liveAllowlist = await engineLiveRoutesFor(accountId);
  return { accountId, fillsFor: demoList || liveAllowlist, demoList, liveAllowlist };
}
