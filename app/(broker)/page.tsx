import { headers } from "next/headers";
import { redirect } from "next/navigation";

// Sole handler for "/". middleware.ts only attaches x-broker-* headers on
// broker subdomains/custom domains — the root domain and admin.<root>
// pass through untouched, so their absence here means "not a broker
// request" and we send it to the Super Admin login instead.
export default async function RootPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");

  if (!brokerId) {
    redirect("/login");
  }

  const brokerSlug = headerList.get("x-broker-slug");
  const primaryColor = headerList.get("x-broker-primary-color");
  const logoUrl = headerList.get("x-broker-logo-url");
  const tier = headerList.get("x-broker-tier");

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={`${brokerSlug} logo`} style={{ height: 40 }} />
      ) : null}
      <h1 style={{ color: "var(--brand-primary)" }}>
        VyXTrader — {brokerSlug}
      </h1>
      <p>brokerId: {brokerId}</p>
      <p>tier: {tier}</p>
      <p>primaryColor: {primaryColor}</p>
    </main>
  );
}
