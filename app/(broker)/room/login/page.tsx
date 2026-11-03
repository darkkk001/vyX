import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { roomBroker } from "@/lib/room/context";
import { getClientSession } from "@/lib/client-auth";
import RoomBrand from "@/components/room/RoomBrand";
import LoginForm from "./LoginForm";
import ServerClock from "./ServerClock";

// Trader's Room sign-in (artboard "Login"): split brand panel + form, "Powered by QoreTrader" footer.
export default async function RoomLoginPage({ searchParams }: { searchParams: Promise<{ verify?: string }> }) {
  const verify = (await searchParams).verify;
  const broker = await roomBroker();
  if (!broker) notFound();
  if (await getClientSession()) redirect("/room");
  return (
    <div className="r-auth">
      <section className="r-auth-brand">
        <div className="r-brand" style={{ padding: 0 }}>
          <RoomBrand name={broker.name} logoUrl={broker.logoUrl} size={30} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 26 }}>
          <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true">
            <circle cx="75" cy="75" r="70" fill="none" stroke="var(--r-accent)" strokeOpacity="0.16" strokeWidth="1.2" />
            <circle cx="75" cy="75" r="58" fill="none" stroke="var(--r-accent)" strokeOpacity="0.24" strokeWidth="1" />
            <ellipse cx="75" cy="75" rx="52" ry="22" fill="none" stroke="var(--r-accent)" strokeWidth="1" opacity="0.65" transform="rotate(-24 75 75)" />
            <ellipse cx="75" cy="75" rx="52" ry="22" fill="none" stroke="var(--r-accent)" strokeWidth="1" opacity="0.65" transform="rotate(24 75 75)" />
            <path d="M75 42 108 75 75 108 42 75Z" fill="none" stroke="var(--r-accent)" strokeWidth="1.8" />
            <path d="M75 42V108M42 75H108" stroke="var(--r-accent)" strokeWidth="1" opacity="0.55" />
            <path d="M75 42 42 75h66Z" fill="var(--r-accent)" opacity="0.1" />
          </svg>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 30, fontWeight: 600, lineHeight: 1.25 }}>Client portal</div>
            <div style={{ fontSize: 14.5, color: "var(--r-text-2)", marginTop: 10, maxWidth: 380, lineHeight: 1.6 }}>
              Accounts, funding and verification in one place. Trade on desktop, web and mobile.
            </div>
          </div>
          <div className="mono" style={{ display: "flex", gap: 22, fontSize: 11.5, color: "var(--r-muted)", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span className="r-dot" style={{ color: "var(--r-ok)", width: 5, height: 5 }} />SERVERS ONLINE
            </span>
            <ServerClock />
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>Powered by QoreTrader</div>
      </section>
      <section className="r-auth-form">
        <LoginForm notice={verify === "success" ? { ok: true, text: "Email confirmed. Sign in to continue." } : verify === "invalid" ? { ok: false, text: "That link has expired. Open an account again with the same email for a new one." } : null} />
      </section>
    </div>
  );
}
