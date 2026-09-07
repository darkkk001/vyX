import { headers } from "next/headers";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";

// Overrides app/layout.tsx's global "VyXTrader" tab title for every
// broker-facing route -- Next.js's metadata resolution takes the most
// specific layout/page's `title`, it doesn't merge/append, so this alone
// is enough to stop every broker's browser tab from all showing the same
// platform name.
// Favicon is per-tenant here too, for the same reason as title -- a
// broker's own browser tab should show ITS logo, not the platform's
// app/favicon.ico. Reuses the x-broker-logo-url header middleware.ts
// already resolved (see BrokerLayout below) instead of a second Prisma
// query for the same broker row. Next's metadata resolution takes the
// most specific segment's `icons` wholesale (not a merge with the root
// layout's file-convention favicon.ico), so this alone is enough to
// override it for every broker-facing route.
export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  if (!brokerId) return {};
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true } });
  const logoUrl = headerList.get("x-broker-logo-url") || null;
  return {
    ...(broker ? { title: broker.name } : {}),
    ...(logoUrl ? { icons: { icon: logoUrl } } : {}),
  };
}

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
