import { notFound, redirect } from "next/navigation";
import { roomBroker } from "@/lib/room/context";
import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import { dateOnly } from "@/lib/client-profile";
import { COUNTRIES } from "@/lib/countries";
import Onboarding from "@/components/room/Onboarding";
import VerifyFlow from "./VerifyFlow";

// Onboarding steps 2-4 for a signed-in client: personal details, documents (to the broker's KYC review), then funding.
// Demo trading works before any of it; withdrawals wait for approved KYC.
export default async function RoomVerifyPage() {
  const broker = await roomBroker();
  if (!broker) notFound();
  const session = await getClientSession();
  if (!session) redirect("/portal/login");
  const c = await prisma.client.findUnique({ where: { id: session.clientId }, select: { phone: true, country: true, dateOfBirth: true, kycRecord: { select: { status: true, rejectionReason: true } } } });
  if (!c) redirect("/portal/login");
  const kyc = c.kycRecord?.status ?? null;
  return (
    <Onboarding brokerName={broker.name} logoUrl={broker.logoUrl} right={<a href="/room" style={{ fontWeight: 600 }}>Go to dashboard</a>}>
      <VerifyFlow
        initial={{ phone: c.phone ?? "", country: c.country ?? "", dateOfBirth: dateOnly(c.dateOfBirth) ?? "" }}
        kyc={kyc}
        rejectionReason={kyc === "REJECTED" ? c.kycRecord?.rejectionReason ?? null : null}
        countries={COUNTRIES.map((x) => ({ code: x.code, name: x.name }))}
      />
    </Onboarding>
  );
}
