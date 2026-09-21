import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { KYC_DOCUMENT_TYPES, validateKycFile } from "@/lib/kyc-upload";

// Admin-side KYC document upload, for an account a broker created by hand.
//
// app/api/trade/kyc is the same operation authenticated as the TRADER -- the
// client uploading their own documents. That path cannot serve a walk-in the
// broker onboards for them, because nobody has the client's trading password
// at that point. This is its admin-authenticated sibling and it writes the
// SAME place: the account-level KycRecord, blobs under kyc/<accountId>/, which
// is exactly what the backoffice KYC review screen
// (app/api/manage/kyc-requests) already lists. So a document uploaded here
// shows up in the client's KYC section with no extra wiring.
//
// Deliberately NOT the ClientKycRecord path (kyc/client/<clientId>/): that one
// is keyed on a portal Client, and an admin-created account has clientId null.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  // Tenant scoping: an admin may only touch accounts of their own broker.
  const account = await prisma.account.findUnique({
    where: { id },
    select: { id: true, brokerId: true, accountNumber: true, fullName: true },
  });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form data" }, { status: 400 });
  }

  const documentType = String(form.get("documentType") ?? "");
  if (!KYC_DOCUMENT_TYPES.has(documentType)) {
    return NextResponse.json({ error: "documentType must be passport, national_id, or drivers_license" }, { status: 400 });
  }

  const front = form.get("front");
  const back = form.get("back");
  const addressProof = form.get("addressProof");
  const frontFile = front instanceof File ? front : null;
  // Back and address proof are optional here. A passport is a single page, and
  // the broker is uploading whatever the walk-in actually handed over; the
  // reviewer rejects an incomplete submission at review time, same rule the
  // portal route documents for its own address proof.
  const backFile = back instanceof File && back.size > 0 ? back : null;
  const addressFile = addressProof instanceof File && addressProof.size > 0 ? addressProof : null;

  // Magic-byte sniffing and the size cap come from the shared helper, so an
  // admin upload cannot bypass the checks the trader path applies.
  const frontResult = await validateKycFile(frontFile, "Document front");
  if (frontResult.error !== null) return NextResponse.json(frontResult, { status: 400 });
  const backResult = backFile ? await validateKycFile(backFile, "Document back") : null;
  if (backResult && backResult.error !== null) return NextResponse.json(backResult, { status: 400 });
  const addressResult = addressFile ? await validateKycFile(addressFile, "Proof of address") : null;
  if (addressResult && addressResult.error !== null) return NextResponse.json(addressResult, { status: 400 });

  const kycToken = process.env.PRIVATE_READ_WRITE_TOKEN;
  if (!kycToken) {
    return NextResponse.json({ error: "document storage is not configured" }, { status: 503 });
  }

  // contentType is the SNIFFED type from the real bytes, never the declared
  // file.type -- it is what the document proxy later serves back.
  const frontBlob = await put(`kyc/${account.id}/front`, frontResult.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: frontResult.sniffedType,
    token: kycToken,
  });
  const backBlob = backResult
    ? await put(`kyc/${account.id}/back`, backResult.bytes, {
        access: "private",
        addRandomSuffix: true,
        contentType: backResult.sniffedType,
        token: kycToken,
      })
    : null;
  const addressBlob = addressResult
    ? await put(`kyc/${account.id}/address`, addressResult.bytes, {
        access: "private",
        addRandomSuffix: true,
        contentType: addressResult.sniffedType,
        token: kycToken,
      })
    : null;

  const record = await prisma.kycRecord.upsert({
    where: { accountId: account.id },
    create: {
      accountId: account.id,
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      documentBackUrl: backBlob?.url ?? null,
      addressProofUrl: addressBlob?.url ?? null,
    },
    // Re-uploading clears any previous decision: the record goes back to
    // PENDING so a replaced document is reviewed again rather than inheriting
    // an APPROVED status it was never checked under.
    update: {
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      ...(backBlob ? { documentBackUrl: backBlob.url } : {}),
      ...(addressBlob ? { addressProofUrl: addressBlob.url } : {}),
      rejectionReason: null,
      reviewedByAdminId: null,
      reviewedAt: null,
    },
  });

  // Who uploaded on the client's behalf is the whole point of the audit row --
  // this is a document the client never touched.
  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: session!.adminId,
      action: "KYC_DOCUMENT_UPLOADED_BY_ADMIN",
      entityType: "KycRecord",
      entityId: record.id,
      newValue: {
        accountNumber: account.accountNumber,
        documentType,
        sides: [frontBlob ? "front" : null, backBlob ? "back" : null, addressBlob ? "address" : null].filter(Boolean),
      },
    },
  });

  return NextResponse.json({ id: record.id, status: record.status, documentType: record.documentType }, { status: 201 });
}
