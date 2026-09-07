import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Backoffice approval queue for Client Portal Live account requests --
// same review-queue shape as KYC/funds (getAdminSession +
// forbidUnlessBrokerAdminOrPermission), reusing the KYC_REVIEW permission
// since approving a Live account is the same trust decision as approving
// identity documents in practice (both gate a client's ability to trade
// real money) and this platform doesn't have a separate permission for it.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const requests = await prisma.liveAccountRequest.findMany({
    where: { brokerId },
    include: {
      client: { select: { fullName: true, email: true, country: true, phone: true } },
      accountType: { select: { name: true } },
      createdAccount: { select: { accountNumber: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json(
    requests.map((r) => ({
      id: r.id,
      status: r.status,
      rejectionReason: r.rejectionReason,
      accountTypeName: r.accountType?.name ?? null,
      createdAccountNumber: r.createdAccount?.accountNumber ?? null,
      clientFullName: r.client.fullName,
      clientEmail: r.client.email,
      clientCountry: r.client.country,
      clientPhone: r.client.phone,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}
