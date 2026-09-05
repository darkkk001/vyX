import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createNotification } from "@/lib/notifications";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DOCUMENT_TYPES = new Set(["passport", "national_id", "drivers_license"]);

// Security fix (2026-09-05 audit) -- ALLOWED_TYPES alone only checked the
// CLIENT-DECLARED Content-Type of the multipart part, which any HTTP
// client controls independently of the actual bytes (a raw curl/Postman
// request can label arbitrary content "image/jpeg"). The document proxy
// (.../document/route.ts) then served that same attacker-declared type
// straight back to a reviewing admin. Sniffing the real file signature
// closes that gap -- the value stored/served is now derived from the
// bytes themselves, never trusted from the client.
function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf"; // "%PDF-"
  }
  return null;
}

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

async function validateFile(
  file: File | null,
  label: string
): Promise<{ error: string } | { error: null; bytes: Buffer; sniffedType: string }> {
  if (!file || file.size === 0) {
    return { error: `${label} is required` };
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return { error: `${label} must be a JPEG, PNG, or PDF` };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { error: `${label} must be under 10MB` };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffedType = sniffMimeType(bytes);
  if (!sniffedType) {
    return { error: `${label} doesn't look like a real JPEG, PNG, or PDF file` };
  }
  return { error: null, bytes, sniffedType };
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
