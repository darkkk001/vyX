import type { ReactNode } from "react";
import type { RoomBroker } from "@/lib/room/context";
import { readInfraSummary } from "@/lib/infra-health";
import { readLivePrices, roomServiceStatus } from "@/lib/room/service-status";
import RoomLogo from "@/components/room/RoomLogo";
import ServerClock from "@/app/(broker)/room/login/ServerClock";

// The left brand panel of the Trader's Room sign-in, register and forgot-password pages. Always dark (both themes),
// with a soft glow in the broker's accent: the broker's full logo at the top, the headline in the middle, the service
// status line and the clock at the bottom. Everything broker-specific comes from the tenant config.
/** What the client portal is for (owner 2026-11-12), the same for every broker. */
export const PORTAL_POINTS = ["Open live and demo accounts", "Deposit, withdraw and transfer funds", "Verify your identity", "Track your trading and tier"];

export default async function AuthBrandPanel({ broker }: { broker: RoomBroker }) {
  // what a client depends on: the way in and the prices they trade on (neither read throws; no report shows no line)
  const [caddy, prices] = await Promise.all([readInfraSummary("caddy"), readLivePrices()]);
  const status = roomServiceStatus([caddy.state, prices]);
  return (
    // Owner 2026-11-12, every broker: the top row is the broker's logo with its wordmark beside it (Broker.wordmark);
    // in the middle the logo large (about 140 px), the "Client portal" label, "<broker> Client Portal" and what the
    // portal is for. On a phone only the top row shows (the middle block is hidden).
    <section className={`r-auth-brand${broker.logoUrl ? " has-mark" : ""}`}>
      <RoomLogo name={broker.name} logoUrl={broker.logoUrl} wordmark={broker.wordmark} />
      <div className="r-auth-copy">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {broker.logoUrl ? <img className="r-auth-mark" src={broker.logoUrl} alt="" /> : null}
        <div className="r-auth-eyebrow">CLIENT PORTAL</div>
        <div className="r-auth-title">{broker.name} Client Portal</div>
        <ul className="r-auth-points">
          {PORTAL_POINTS.map((t) => <li key={t}>{t}</li>)}
        </ul>
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
