import type { RoomBroker } from "@/lib/room/context";
import { AuthShell } from "@/components/room/AuthBrandPanel";
import RoomForgotForm from "./RoomForgotForm";
import { humanCheckSiteKey } from "@/lib/turnstile";

// Trader's Room forgot password: the sign-in's layout + the reset request. Served at /portal/forgot-password for a
// broker with the CRM module (the sign-in's "Forgot password?" link).
export default async function RoomForgotView({ broker }: { broker: RoomBroker }) {
  return (
    <AuthShell broker={broker}>
      <RoomForgotForm humanKey={await humanCheckSiteKey(broker.id)} />
    </AuthShell>
  );
}
