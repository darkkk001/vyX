import { headers } from "next/headers";
import type { ReactNode } from "react";

// Applies to every broker-facing route (WebTrader, broker login, etc).
// Reads the headers middleware.ts attached and injects branding as CSS
// custom properties — resolved fresh on every request, never baked into a
// build, so a broker's branding update takes effect immediately.
export default async function BrokerLayout({
  children,
}: {
  children: ReactNode;
}) {
  const headerList = await headers();
  const primaryColor = headerList.get("x-broker-primary-color") || "#1e8a5f";
  const logoUrl = headerList.get("x-broker-logo-url") || "";
  const brokerSlug = headerList.get("x-broker-slug") || "";
  const brokerTier = headerList.get("x-broker-tier") || "";

  return (
    <div
      data-broker={brokerSlug}
      data-broker-tier={brokerTier}
      data-broker-logo={logoUrl}
      style={{ ["--brand-primary" as string]: primaryColor }}
    >
      {children}
    </div>
  );
}
