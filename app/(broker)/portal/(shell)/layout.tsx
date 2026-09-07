import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import PortalSidebar from "@/components/portal/PortalSidebar";
import styles from "@/components/portal/PortalShell.module.css";

// Everything under app/(broker)/portal/(shell)/* requires a signed-in
// Client Portal session -- route group (invisible in the URL), same
// "auth pages stay siblings, never wrapped in this shell" pattern as
// app/manage/(shell)/layout.tsx: /portal/register and /portal/login live
// OUTSIDE this group entirely, so they're never gated and never show the
// sidebar around a login form.
const PAGE_TITLES: Record<string, string> = {
  "/portal": "Dashboard",
  "/portal/accounts": "Trading Accounts",
  "/portal/funds": "Deposits & Withdrawals",
  "/portal/kyc": "KYC",
  "/portal/profile": "Profile",
  "/portal/webtrader": "WebTrader",
};

export default async function PortalShellLayout({ children }: { children: React.ReactNode }) {
  const session = await getClientSession();
  if (!session) {
    redirect("/portal/login");
  }

  const [broker, client] = await Promise.all([
    prisma.broker.findUnique({ where: { id: session!.brokerId }, select: { name: true, logoUrl: true } }),
    prisma.client.findUnique({ where: { id: session!.clientId }, select: { fullName: true, email: true } }),
  ]);

  // A session whose Client row is somehow gone (deleted, or a stale
  // Redis-backed token surviving past a hard data change) is treated the
  // same as "not logged in" -- same defensive shape getAccountSession's
  // own callers already rely on elsewhere in this codebase.
  if (!client) {
    redirect("/portal/login");
  }

  const pathname = (await headers()).get("x-pathname") ?? "";
  const pageTitle = PAGE_TITLES[pathname] ?? "Client Portal";

  return (
    <div className={styles.root}>
      <PortalSidebar
        brokerName={broker?.name ?? "VyXTrader"}
        brokerLogoUrl={broker?.logoUrl ?? null}
        clientFullName={client!.fullName}
        clientEmail={client!.email}
      />
      <div className={styles.main}>
        <div className={styles.topbar}>
          <span className={styles.pageTitle}>{pageTitle}</span>
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
