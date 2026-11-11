import type { ReactNode } from "react";
import type { RoomBroker } from "@/lib/room/context";
import { readInfraSummary } from "@/lib/infra-health";
import { readLivePrices, roomServiceStatus } from "@/lib/room/service-status";
import RoomLogo from "@/components/room/RoomLogo";
import ServerClock from "@/app/(broker)/room/login/ServerClock";

// The left brand panel of the Trader's Room sign-in, register and forgot-password pages. Always dark (both themes),
// with a soft glow in the broker's accent: the broker's full logo at the top, the headline in the middle, the service
// status line and the clock at the bottom. Everything broker-specific comes from the tenant config.
export default async function AuthBrandPanel({ broker }: { broker: RoomBroker }) {
  // what a client depends on: the way in and the prices they trade on (neither read throws; no report shows no line)
  const [caddy, prices] = await Promise.all([readInfraSummary("caddy"), readLivePrices()]);
  const status = roomServiceStatus([caddy.state, prices]);
  return (
    // Owner 2026-11-12: the broker's logo large (about 140 px), centred above the headline, for every broker. The top row
    // keeps the name; its small mark shows only on a phone, where the headline block is hidden.
    <section className={`r-auth-brand${broker.logoUrl ? " has-mark" : ""}`}>
      <RoomLogo name={broker.name} logoUrl={broker.logoUrl} />
      <div className="r-auth-copy">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {broker.logoUrl ? <img className="r-auth-mark" src={broker.logoUrl} alt="" /> : null}
        <div className="r-auth-title">Trade with {broker.name}</div>
        <div className="r-auth-line">Forex, gold, indices and crypto. One account, every platform.</div>
      </div>
      <div className="r-auth-status mono">
        {status ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span className="r-dot" style={{ color: status === "ONLINE" ? "var(--r-ok)" : "var(--r-pending)", width: 5, height: 5 }} />
            {status === "ONLINE" ? "SERVERS ONLINE" : "SOME SERVICES AFFECTED"}
          </span>
        ) : null}
        <ServerClock />
      </div>
    </section>
  );
}

/** The whole sign-in / register / forgot-password page: brand panel, the page's own form, the platform footer. */
export async function AuthShell({ broker, children }: { broker: RoomBroker; children: ReactNode }) {
  return (
    <div className="r-auth">
      <AuthBrandPanel broker={broker} />
      <section className="r-auth-form">{children}</section>
      <div className="r-auth-foot">Powered by VyX Technologies</div>
    </div>
  );
}
