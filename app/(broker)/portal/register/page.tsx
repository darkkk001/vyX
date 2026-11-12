import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import RegisterForm from "./RegisterForm";
import { issueRegisterFormToken } from "@/lib/portal-register-guard";
import { roomBroker, roomSignedIn } from "@/lib/room/context";
import RoomFrame from "@/components/room/RoomFrame";
import RoomRegisterView from "@/app/(broker)/room/register/RegisterView";

// After "Continue with Google" found no client with that email (app/api/auth/google/callback): the email comes filled in.
async function googleEmailParam(searchParams: Promise<{ email?: string; google?: string }>): Promise<string> {
  const q = await searchParams;
  const email = q.google === "1" && typeof q.email === "string" ? q.email.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

// Same header-driven branding pattern as app/(broker)/trade/login/page.tsx
// -- resolved fresh per request, never baked into the build.
// A broker with the CRM module gets the Trader's Room sign-up on this same path (owner routes 2026-11-04).
export default async function PortalRegisterPage({ searchParams }: { searchParams: Promise<{ ref?: string; email?: string; google?: string }> }) {
  const room = await roomBroker();
  if (room) {
    if (await roomSignedIn()) redirect("/room/verify");
    return <RoomFrame broker={room}><RoomRegisterView broker={room} referral={(await searchParams).ref} googleEmail={await googleEmailParam(searchParams)} /></RoomFrame>;
  }
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  // anti-bot (lib/portal-register-guard.ts): one form token per page view, posted back on submit
  const formToken = await issueRegisterFormToken();
  return <RegisterForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} formToken={formToken} />;
}
