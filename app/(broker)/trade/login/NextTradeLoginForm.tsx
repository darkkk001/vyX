"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import TradeLoginForm from "./TradeLoginForm";

// Supplies the website's own behavior (searchParams-derived prefill from
// the root-domain launcher's handoff, and router-based navigation to
// /trade on success) on top of the now-portable TradeLoginForm -- same
// "Next-specific wrapper around a portable core" split as AdminShell.tsx/
// NextAdminShell.tsx. page.tsx renders this, not TradeLoginForm directly.
export default function NextTradeLoginForm({
  brokerName,
  brokerLogoUrl,
  supportEmail,
}: {
  brokerName: string;
  brokerLogoUrl?: string | null;
  supportEmail: string | null;
}) {
  return (
    <Suspense fallback={null}>
      <NextTradeLoginFormInner brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} supportEmail={supportEmail} />
    </Suspense>
  );
}

function NextTradeLoginFormInner({
  brokerName,
  brokerLogoUrl,
  supportEmail,
}: {
  brokerName: string;
  brokerLogoUrl?: string | null;
  supportEmail: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <TradeLoginForm
      brokerName={brokerName}
      brokerLogoUrl={brokerLogoUrl}
      supportEmail={supportEmail}
      initialAccountNumber={searchParams.get("account") ?? ""}
      initialError={searchParams.get("error") ? "Invalid account number or password" : null}
      initialPendingToken={searchParams.get("pendingToken")}
      initialRemember={searchParams.get("remember") !== "0"}
      onAuthenticated={(remember) => {
        router.push(remember ? "/trade" : "/trade?remember=0");
        router.refresh();
      }}
    />
  );
}
