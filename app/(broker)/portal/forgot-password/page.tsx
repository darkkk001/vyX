import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import ForgotPasswordForm from "./ForgotPasswordForm";

// Same header-driven branding pattern as ../login/page.tsx and
// ../register/page.tsx.
export default async function PortalForgotPasswordPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return <ForgotPasswordForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} />;
}
