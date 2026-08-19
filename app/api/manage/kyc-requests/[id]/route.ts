import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.kycRecord.findUnique({
    where: { id },
    include: { account: { select: { brokerId: true } } },
  });
  if (!existing || existing.account.brokerId !== brokerId) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json({ error: "record already reviewed" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action === "APPROVE" ? "APPROVE" : body?.action === "REJECT" ? "REJECT" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be APPROVE or REJECT" }, { status: 400 });
  }
  const rejectionReason = typeof body?.rejectionReason === "string" ? body.rejectionReason.trim().slice(0, 500) : "";
  if (action === "REJECT" && !rejectionReason) {
    return NextResponse.json({ error: "rejectionReason is required to reject" }, { status: 400 });
  }

  const status = action === "APPROVE" ? "APPROVED" : "REJECTED";

  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.kycRecord.update({
      where: { id },
      data: {
        status,
        reviewedByAdminId: session!.adminId,
        reviewedAt: new Date(),
        rejectionReason: action === "REJECT" ? rejectionReason : null,
      },
    });

    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: action === "APPROVE" ? "KYC_APPROVAL" : "KYC_REJECTION",
        entityType: "KycRecord",
        entityId: id,
        oldValue: { status: "PENDING" },
        newValue: { status, rejectionReason: action === "REJECT" ? rejectionReason : null },
      },
    });

    return record;
  });

  return NextResponse.json({ id: updated.id, status: updated.status });
}
