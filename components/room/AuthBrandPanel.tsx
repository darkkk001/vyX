import type { RoomBroker } from "@/lib/room/context";
import { readInfraSummary } from "@/lib/infra-health";
import { readLivePrices, roomServiceStatus } from "@/lib/room/service-status";
import RoomLogo from "@/components/room/RoomLogo";
import ServerClock from "@/app/(broker)/room/login/ServerClock";

// The left brand panel of the Trader's Room sign-in and forgot-password pages: the broker's full logo, the headline,
// the service status line and the clock, and the platform footer.
export default async function AuthBrandPanel({ broker }: { broker: RoomBroker }) {
  // what a client depends on: the way in and the prices they trade on (neither read throws; no report shows no line)
  const [caddy, prices] = await Promise.all([readInfraSummary("caddy"), readLivePrices()]);
  const status = roomServiceStatus([caddy.state, prices]);
  return (
    <section className="r-auth-brand">
      <RoomLogo name={broker.name} logoUrl={broker.logoUrl} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 26 }}>
        <div>
          <div style={{ fontFamily: "var(--r-head)", fontSize: 30, fontWeight: 600, lineHeight: 1.25 }}>Client portal</div>
          <div style={{ fontSize: 14.5, color: "var(--r-text-2)", marginTop: 10, maxWidth: 380, lineHeight: 1.6 }}>
            Accounts, funding and verification in one place. Trade on desktop, web and mobile.
          </div>
        </div>
        <div className="mono" style={{ display: "flex", gap: 22, fontSize: 11.5, color: "var(--r-muted)", flexWrap: "wrap" }}>
          {status ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span className="r-dot" style={{ color: status === "ONLINE" ? "var(--r-ok)" : "var(--r-pending)", width: 5, height: 5 }} />
              {status === "ONLINE" ? "SERVERS ONLINE" : "SOME SERVICES AFFECTED"}
            </span>
          ) : null}
          <ServerClock />
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>Powered by VyX Technologies</div>
    </section>
  );
}
