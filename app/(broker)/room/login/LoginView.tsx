import type { RoomBroker } from "@/lib/room/context";
import AuthBrandPanel from "@/components/room/AuthBrandPanel";
import LoginForm from "./LoginForm";

// Trader's Room sign-in (artboard "Login"): split brand panel (the broker's full logo, "Powered by VyX Technologies")
// + form. Served at /login for a broker with the CRM module.
export default async function RoomLoginView({ broker, verify, signedOut = false }: { broker: RoomBroker; verify?: string; signedOut?: boolean }) {
  return (
    <div className="r-auth">
      <AuthBrandPanel broker={broker} />
      <section className="r-auth-form">
        <LoginForm notice={signedOut ? { ok: true, text: "You were signed out. Sign in to continue." } : verify === "success" ? { ok: true, text: "Email confirmed. Sign in to continue." } : verify === "invalid" ? { ok: false, text: "That link has expired. Open an account again with the same email for a new one." } : null} />
      </section>
    </div>
  );
}
