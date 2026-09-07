import { Suspense } from "react";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import LoginForm from "./LoginForm";

// useSearchParams() inside LoginForm (for ?verify=success/invalid) opts
// this page out of static prerendering unless wrapped in Suspense -- same
// reasoning as app/(super-admin)/login/page.tsx's own Suspense wrapper.
export default async function PortalLoginPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return (
    <Suspense fallback={null}>
      <LoginForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} />
    </Suspense>
  );
}
