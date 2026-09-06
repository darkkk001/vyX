import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { runShadowPricingComparison } from "@/lib/pricing-shadow-compare";

// Phase 2 pricing engine, Stage 3 -- read-only shadow comparison. Lets a
// broker's own admin see, before Broker.pricingEngineEnabled is ever
// flipped on for them, exactly which (account, symbol) pairs would price
// differently under the full Stage 2 resolver versus what's actually
// charged today. Scoped to the caller's own broker (same session.brokerId
// pattern every other /api/manage/* route uses) -- there is no cross-
// broker variant of this, a broker only ever needs to see its own numbers
// before its own cutover. See lib/pricing-shadow-compare.ts's own module
// comment for exactly what "old" vs "new" means here.
async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const summary = await runShadowPricingComparison(prisma, session.brokerId!);
  return NextResponse.json(summary);
}
