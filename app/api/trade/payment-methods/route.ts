import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Broker-configured deposit/withdrawal methods for the funds modal's
// method picker (components/webtrader/WebTrader.tsx) -- replaces that
// modal's previous hardcoded, non-functional "Bank transfer / Card /
// Crypto" buttons. Only `enabled` rows, and never pspApiKey/pspProvider
// (backoffice-internal, see app/api/manage/payment-methods/route.ts) --
// this is the trader-facing shape only.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const methods = await prisma.paymentMethod.findMany({
    where: { brokerId: session.brokerId, enabled: true },
    orderBy: { type: "asc" },
  });

  return NextResponse.json(
    methods.map((m) => ({
      id: m.id,
      type: m.type,
      minAmount: m.minAmount.toString(),
      maxAmount: m.maxAmount ? m.maxAmount.toString() : null,
      feePercent: m.feePercent.toString(),
      feeFixed: m.feeFixed.toString(),
      instructions: m.instructions,
      walletAddress: m.walletAddress,
    }))
  );
}
