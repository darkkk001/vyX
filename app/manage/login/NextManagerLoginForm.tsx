"use client";

import { useRouter } from "next/navigation";
import ManagerLoginForm from "./ManagerLoginForm";

// Supplies the website's own behavior (router-based navigation to
// /manage/dashboard on success) on top of the now-portable
// ManagerLoginForm -- same split as NextTradeLoginForm.tsx/
// TradeLoginForm.tsx. page.tsx renders this, not ManagerLoginForm
// directly.
export default function NextManagerLoginForm({
  brokerName,
  logoUrl,
  sessionExpired = false,
}: {
  brokerName: string;
  logoUrl: string | null;
  sessionExpired?: boolean;
}) {
  const router = useRouter();
  return (
    <ManagerLoginForm
      brokerName={brokerName}
      logoUrl={logoUrl}
      sessionExpired={sessionExpired}
      onAuthenticated={() => router.push("/manage/dashboard")}
    />
  );
}
