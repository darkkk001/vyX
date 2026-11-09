import type { RoomBroker } from "@/lib/room/context";
import { AuthShell } from "@/components/room/AuthBrandPanel";
import LoginForm from "./LoginForm";

// Trader's Room sign-in: the dark brand panel (the broker's full logo) + form, "Powered by VyX Technologies" at the
// bottom of the page. Served at /login for a broker with the CRM module.
export default async function RoomLoginView({ broker, verify, signedOut = false }: { broker: RoomBroker; verify?: string; signedOut?: boolean }) {
  return (
    <AuthShell broker={broker}>
      <LoginForm notice={signedOut ? { ok: true, text: "You were signed out. Sign in to continue." } : verify === "success" ? { ok: true, text: "Email confirmed. Sign in to continue." } : verify === "invalid" ? { ok: false, text: "That link has expired. Open an account again with the same email for a new one." } : null} />
    </AuthShell>
  );
}
