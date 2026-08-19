import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createNotification } from "@/lib/notifications";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DOCUMENT_TYPES = new Set(["passport", "national_id", "drivers_license"]);

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const record = await prisma.kycRecord.findUnique({ where: { accountId: session.accountId } });
  if (!record) {
    return NextResponse.json(null);
  }
  return NextResponse.json({
    status: record.status,
    documentType: record.documentType,
    rejectionReason: record.rejectionReason,
    createdAt: record.createdAt.toISOString(),
  });
}

function validateFile(file: File | null, label: string): { error: string } | null {
  if (!file || file.size === 0) {
    return { error: `${label} is required` };
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return { error: `${label} must be a JPEG, PNG, or PDF` };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { error: `${label} must be under 10MB` };
  }
  return null;
}

// Identity verification -- see components/webtrader/WebTrader.tsx's
// "Verify identity" modal. Stored PRIVATE in Vercel Blob (not public):
// this is ID-document PII, so only server-side code holding
// BLOB_READ_WRITE_TOKEN can ever read it back -- see
// app/api/manage/kyc-requests/[id]/document/route.ts, the only reader.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const existing = await prisma.kycRecord.findUnique({ where: { accountId: session.accountId } });
  if (existing && (existing.status === "PENDING" || existing.status === "APPROVED")) {
    return NextResponse.json(
      {
        error:
          existing.status === "PENDING"
            ? "you already have a submission under review"
            : "your identity is already verified",
      },
      { status: 409 }
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form data" }, { status: 400 });
  }

  const documentType = String(form.get("documentType") ?? "");
  if (!DOCUMENT_TYPES.has(documentType)) {
    return NextResponse.json({ error: "documentType must be passport, national_id, or drivers_license" }, { status: 400 });
  }

  const front = form.get("front");
  const back = form.get("back");
  const frontFile = front instanceof File ? front : null;
  const backFile = back instanceof File ? back : null;

  const frontError = validateFile(frontFile, "Document front");
  if (frontError) return NextResponse.json(frontError, { status: 400 });
  const backError = validateFile(backFile, "Document back");
  if (backError) return NextResponse.json(backError, { status: 400 });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "document storage is not configured" }, { status: 503 });
  }

  const frontBlob = await put(`kyc/${session.accountId}/front`, frontFile!, {
    access: "private",
    addRandomSuffix: true,
    contentType: frontFile!.type,
  });
  const backBlob = await put(`kyc/${session.accountId}/back`, backFile!, {
    access: "private",
    addRandomSuffix: true,
    contentType: backFile!.type,
  });

  const record = await prisma.kycRecord.upsert({
    where: { accountId: session.accountId },
    create: {
      accountId: session.accountId,
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      documentBackUrl: backBlob.url,
    },
    update: {
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      documentBackUrl: backBlob.url,
      rejectionReason: null,
      reviewedByAdminId: null,
      reviewedAt: null,
    },
  });

  const account = await prisma.account.findUnique({ where: { id: session.accountId }, select: { accountNumber: true, fullName: true } });
  await createNotification(prisma, {
    brokerId: session.brokerId,
    type: "KYC_SUBMITTED",
    title: "New KYC submission",
    body: `${account?.fullName ?? session.accountId} (${account?.accountNumber ?? ""}) submitted ${documentType}`,
    entityType: "KycRecord",
    entityId: record.id,
  });

  return NextResponse.json({ status: record.status, documentType: record.documentType }, { status: 201 });
}
