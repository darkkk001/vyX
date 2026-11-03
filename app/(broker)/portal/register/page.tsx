import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import RegisterForm from "./RegisterForm";
import { issueRegisterFormToken } from "@/lib/portal-register-guard";

// Same header-driven branding pattern as app/(broker)/trade/login/page.tsx
// -- resolved fresh per request, never baked into the build.
export default async function PortalRegisterPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  // anti-bot (lib/portal-register-guard.ts): one form token per page view, posted back on submit
  const formToken = await issueRegisterFormToken();
  return <RegisterForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} formToken={formToken} />;
}
