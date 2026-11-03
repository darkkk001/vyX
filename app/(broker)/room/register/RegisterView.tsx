import type { RoomBroker } from "@/lib/room/context";
import { issueRegisterFormToken } from "@/lib/portal-register-guard";
import Onboarding from "@/components/room/Onboarding";
import RegisterForm from "./RegisterForm";

// Onboarding step 1: create the client (same route and anti-bot gate as the portal: honeypot, signed form token,
// minimum fill time, per-IP limit). The e-mail link signs them in to the next steps. Served at /portal/register for a
// broker with the CRM module.
export default async function RoomRegisterView({ broker, referral }: { broker: RoomBroker; referral?: string }) {
  const formToken = await issueRegisterFormToken();
  const ref = referral ?? "";
  return (
    <Onboarding brokerName={broker.name} logoUrl={broker.logoUrl} step={0} right={<>Already registered? <a href="/portal/login" style={{ fontWeight: 600 }}>Sign in</a></>}>
      <RegisterForm formToken={formToken} referral={/^[A-Za-z0-9]{2,16}$/.test(ref) ? ref : ""} />
    </Onboarding>
  );
}
