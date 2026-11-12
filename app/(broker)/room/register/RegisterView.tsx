import type { RoomBroker } from "@/lib/room/context";
import { issueRegisterFormToken } from "@/lib/portal-register-guard";
import { humanCheckSiteKey } from "@/lib/turnstile";
import { AuthShell } from "@/components/room/AuthBrandPanel";
import RegisterForm from "./RegisterForm";

// Onboarding step 1: create the client (same route and anti-bot gate as the portal: honeypot, signed form token,
// minimum fill time, per-IP limit), in the sign-in's layout. The e-mail link signs them in to the next steps, which
// keep the onboarding layout. Served at /register for a broker with the CRM module.
export default async function RoomRegisterView({ broker, referral, googleEmail = "" }: { broker: RoomBroker; referral?: string; googleEmail?: string }) {
  const [formToken, humanKey] = await Promise.all([issueRegisterFormToken(), humanCheckSiteKey(broker.id)]);
  const ref = referral ?? "";
  return (
    <AuthShell broker={broker}>
      <div className="r-auth-box r-auth-box-wide">
        <RegisterForm formToken={formToken} humanKey={humanKey} referral={/^[A-Za-z0-9]{2,16}$/.test(ref) ? ref : ""} initialEmail={googleEmail} />
        <div style={{ borderTop: "1px solid var(--r-line)", paddingTop: 18, fontSize: 13, color: "var(--r-text-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>Already registered?</span>
          <a href="/login" style={{ fontWeight: 600 }}>Sign in</a>
        </div>
      </div>
    </AuthShell>
  );
}
