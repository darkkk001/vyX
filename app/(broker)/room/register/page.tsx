import { notFound, redirect } from "next/navigation";
import { roomBroker } from "@/lib/room/context";
import { getClientSession } from "@/lib/client-auth";
import { issueRegisterFormToken } from "@/lib/portal-register-guard";
import Onboarding from "@/components/room/Onboarding";
import RegisterForm from "./RegisterForm";

// Onboarding step 1: create the client (same route and anti-bot gate as the portal: honeypot, signed form token,
// minimum fill time, per-IP limit). The e-mail link signs them in to the next steps.
export default async function RoomRegisterPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const ref = (await searchParams).ref ?? "";
  const broker = await roomBroker();
  if (!broker) notFound();
  if (await getClientSession()) redirect("/room/verify");
  const formToken = await issueRegisterFormToken();
  return (
    <Onboarding brokerName={broker.name} logoUrl={broker.logoUrl} step={0} right={<>Already registered? <a href="/room/login" style={{ fontWeight: 600 }}>Sign in</a></>}>
      <RegisterForm formToken={formToken} referral={/^[A-Za-z0-9]{2,16}$/.test(ref) ? ref : ""} />
    </Onboarding>
  );
}
