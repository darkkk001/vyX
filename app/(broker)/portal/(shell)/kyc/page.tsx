import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import KycForm from "./KycForm";

// Real page (Stage 5) -- replaces the ComingSoonPanel placeholder. Server
// Component fetches the current submission (if any); KycForm.tsx (client)
// renders either the status view or the submission form and handles the
// upload itself.
export default async function PortalKycPage() {
  const session = await getClientSession(); // layout.tsx already redirected if this were null
  const record = await prisma.clientKycRecord.findUnique({
    where: { clientId: session!.clientId },
    select: {
      status: true,
      documentType: true,
      rejectionReason: true,
      annualIncome: true,
      sourceOfFunds: true,
      tradingExperience: true,
      employmentStatus: true,
      riskTolerance: true,
    },
  });

  return <KycForm initialRecord={record} />;
}
