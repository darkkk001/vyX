import type { RoomBroker } from "@/lib/room/context";
import { readInfraSummary } from "@/lib/infra-health";
import { roomServiceStatus } from "@/lib/room/service-status";
import RoomBrand from "@/components/room/RoomBrand";
import LoginForm from "./LoginForm";
import ServerClock from "./ServerClock";

// Trader's Room sign-in (artboard "Login"): split brand panel + form, "Powered by VyX Technologies" footer. Served at
// /login for a broker with the CRM module.
export default async function RoomLoginView({ broker, verify, signedOut = false }: { broker: RoomBroker; verify?: string; signedOut?: boolean }) {
  // what a client depends on: the way in and the prices (readInfraSummary never throws; no report shows no line)
  const checks = await Promise.all([readInfraSummary("caddy"), readInfraSummary("qorebridge-feed")]);
  const status = roomServiceStatus(checks.map((c) => c.state));
  return (
    <div className="r-auth">
      <section className="r-auth-brand">
        <div />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 26 }}>
          <div className="r-brand r-auth-logo" style={{ padding: 0, justifyContent: "center" }}>
            <RoomBrand name={broker.name} logoUrl={broker.logoUrl} size={44} />
          </div>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>{broker.name} Client Portal</div>
            <div style={{ fontSize: 14.5, color: "var(--r-text-2)", margin: "10px auto 0", maxWidth: 380, lineHeight: 1.6 }}>
              Accounts, funding and verification in one place. Trade on desktop, web and mobile.
            </div>
          </div>
          <div className="mono" style={{ display: "flex", justifyContent: "center", gap: 22, fontSize: 11.5, color: "var(--r-muted)", flexWrap: "wrap" }}>
            {status ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span className="r-dot" style={{ color: status === "ONLINE" ? "var(--r-ok)" : "var(--r-pending)", width: 5, height: 5 }} />
                {status === "ONLINE" ? "SERVERS ONLINE" : "SOME SERVICES AFFECTED"}
              </span>
            ) : null}
            <ServerClock />
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--r-faint)", textAlign: "center" }}>Powered by VyX Technologies</div>
      </section>
      <section className="r-auth-form">
        <LoginForm notice={signedOut ? { ok: true, text: "You were signed out. Sign in to continue." } : verify === "success" ? { ok: true, text: "Email confirmed. Sign in to continue." } : verify === "invalid" ? { ok: false, text: "That link has expired. Open an account again with the same email for a new one." } : null} />
      </section>
    </div>
  );
}
