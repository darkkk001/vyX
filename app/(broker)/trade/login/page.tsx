import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import NextTradeLoginForm from "./NextTradeLoginForm";

// Resolved fresh per request (never baked into the build) -- same
// principle as app/(broker)/layout.tsx's own header-driven branding.
export default async function TradeLoginPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, supportEmail: true, logoUrl: true } })
    : null;

  return (
    <NextTradeLoginForm
      brokerName={broker?.name ?? "VyXTrader"}
      brokerLogoUrl={broker?.logoUrl ?? null}
      supportEmail={broker?.supportEmail ?? null}
    />
  );
}
