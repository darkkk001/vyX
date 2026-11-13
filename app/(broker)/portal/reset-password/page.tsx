import { Suspense } from "react";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import ResetPasswordForm from "./ResetPasswordForm";
import { humanCheckSiteKey } from "@/lib/turnstile";
import DevToolsGuard from "@/components/security/DevToolsGuard";

// useSearchParams() inside ResetPasswordForm (for ?token=) opts this page
// out of static prerendering unless wrapped in Suspense -- same reasoning
// as ../login/page.tsx's own Suspense wrapper.
export default async function PortalResetPasswordPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  const humanKey = brokerId ? await humanCheckSiteKey(brokerId) : null;
  return (
    <Suspense fallback={null}>
      <DevToolsGuard />
      <ResetPasswordForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} humanKey={humanKey} />
    </Suspense>
  );
}
