import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import { identityLocked, dateOnly, type KycState } from "@/lib/client-profile";
import ProfileView from "./ProfileView";

// The client's own details, editable (PATCH /api/portal/me) under lib/client-profile.ts's rules, plus password
// change (POST /api/portal/change-password). Restored 2026-09-28 from the unmerged 2026-09-18 snapshot.
export default async function PortalProfilePage() {
  const session = await getClientSession();
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: session!.clientId },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      country: true,
      dateOfBirth: true,
      emailVerifiedAt: true,
      createdAt: true,
      kycRecord: { select: { status: true } },
    },
  });
  const kycStatus = (client.kycRecord?.status ?? null) as KycState;

  return (
    <ProfileView
      initialClient={{
        id: client.id,
        email: client.email,
        fullName: client.fullName,
        phone: client.phone,
        country: client.country,
        dateOfBirth: dateOnly(client.dateOfBirth),
        emailVerifiedAt: client.emailVerifiedAt ? client.emailVerifiedAt.toISOString() : null,
        createdAt: client.createdAt.toISOString(),
        kycStatus,
        identityLocked: identityLocked(kycStatus),
      }}
    />
  );
}
