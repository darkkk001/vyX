import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createNotification } from "@/lib/notifications";
import { KYC_DOCUMENT_TYPES as DOCUMENT_TYPES, validateKycFile as validateFile } from "@/lib/kyc-upload";

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

  const frontResult = await validateFile(frontFile, "Document front");
  if (frontResult.error !== null) return NextResponse.json(frontResult, { status: 400 });
  const backResult = await validateFile(backFile, "Document back");
  if (backResult.error !== null) return NextResponse.json(backResult, { status: 400 });

  // Deliberately a separate store/token from BLOB_READ_WRITE_TOKEN (see
  // app/api/admin/brokers/logo/route.ts) -- a Vercel Blob store's access
  // mode (public/private) is fixed at creation, so a public logo store
  // and this route's private KYC documents can't share one token.
  const kycToken = process.env.PRIVATE_READ_WRITE_TOKEN;
  if (!kycToken) {
    return NextResponse.json({ error: "document storage is not configured" }, { status: 503 });
  }

  // Storing the SNIFFED type (from the real bytes), never the client-
  // declared file.type -- same fix as validateFile above, applied at the
  // point that actually determines what the document proxy serves back.
  const frontBlob = await put(`kyc/${session.accountId}/front`, frontResult.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: frontResult.sniffedType,
    token: kycToken,
  });
  const backBlob = await put(`kyc/${session.accountId}/back`, backResult.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: backResult.sniffedType,
    token: kycToken,
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
