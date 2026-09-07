import { Suspense } from "react";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import ResetPasswordForm from "./ResetPasswordForm";

// useSearchParams() inside ResetPasswordForm (for ?token=) opts this page
// out of static prerendering unless wrapped in Suspense -- same reasoning
// as ../login/page.tsx's own Suspense wrapper.
export default async function PortalResetPasswordPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return (
    <Suspense fallback={null}>
      <ResetPasswordForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} />
    </Suspense>
  );
}
