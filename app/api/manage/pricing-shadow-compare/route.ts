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

export async function GET(request: Request) {
  // Phase 2 batch 6 (issue 209): the Super Admin broker page tells Super Admin to run this before flipping a broker's
  // pricing engine, but it refused SUPER_ADMIN. Super Admin names the broker (?broker=<id or subdomain>).
  const admin = await getAdminSession();
  if (admin?.role === "SUPER_ADMIN") {
    const ref = new URL(request.url).searchParams.get("broker")?.trim();
    if (!ref) return NextResponse.json({ error: "broker (id or subdomain) is required for Super Admin" }, { status: 400 });
    const broker = await prisma.broker.findFirst({ where: { OR: [{ id: ref }, { subdomain: ref }] }, select: { id: true } });
    if (!broker) return NextResponse.json({ error: "broker not found" }, { status: 404 });
    return NextResponse.json(await runShadowPricingComparison(prisma, broker.id));
  }
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const summary = await runShadowPricingComparison(prisma, session.brokerId!);
  return NextResponse.json(summary);
}
