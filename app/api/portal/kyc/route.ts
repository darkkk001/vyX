import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { AnnualIncomeRange, SourceOfFunds, TradingExperience, EmploymentStatus, RiskTolerance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";
import { createNotification } from "@/lib/notifications";
import { KYC_DOCUMENT_TYPES, validateKycFile } from "@/lib/kyc-upload";

const ANNUAL_INCOME_RANGES = new Set<string>(Object.values(AnnualIncomeRange));
const SOURCES_OF_FUNDS = new Set<string>(Object.values(SourceOfFunds));
const TRADING_EXPERIENCES = new Set<string>(Object.values(TradingExperience));
const EMPLOYMENT_STATUSES = new Set<string>(Object.values(EmploymentStatus));
const RISK_TOLERANCES = new Set<string>(Object.values(RiskTolerance));

// Client-level KYC (one submission per CLIENT, not per Account -- see
// ClientKycRecord's own schema comment) -- distinct from
// app/api/trade/kyc/route.ts (account-level, still serving accounts
// never linked to a Client). Shares its upload validation
// (lib/kyc-upload.ts) but adds the suitability questionnaire
// (annualIncome/sourceOfFunds/tradingExperience/employmentStatus/
// riskTolerance) that registration deliberately never collects.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const record = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId } });
  if (!record) {
    return NextResponse.json(null);
  }
  return NextResponse.json({
    status: record.status,
    documentType: record.documentType,
    rejectionReason: record.rejectionReason,
    annualIncome: record.annualIncome,
    sourceOfFunds: record.sourceOfFunds,
    tradingExperience: record.tradingExperience,
    employmentStatus: record.employmentStatus,
    riskTolerance: record.riskTolerance,
    createdAt: record.createdAt.toISOString(),
  });
}

export async function POST(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const existing = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId } });
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
  if (!KYC_DOCUMENT_TYPES.has(documentType)) {
    return NextResponse.json({ error: "documentType must be passport, national_id, or drivers_license" }, { status: 400 });
  }

  const annualIncome = String(form.get("annualIncome") ?? "");
  const sourceOfFunds = String(form.get("sourceOfFunds") ?? "");
  const tradingExperience = String(form.get("tradingExperience") ?? "");
  const employmentStatus = String(form.get("employmentStatus") ?? "");
  const riskTolerance = String(form.get("riskTolerance") ?? "");

  if (!ANNUAL_INCOME_RANGES.has(annualIncome)) {
    return NextResponse.json({ error: "annualIncome is required" }, { status: 400 });
  }
  if (!SOURCES_OF_FUNDS.has(sourceOfFunds)) {
    return NextResponse.json({ error: "sourceOfFunds is required" }, { status: 400 });
  }
  if (!TRADING_EXPERIENCES.has(tradingExperience)) {
    return NextResponse.json({ error: "tradingExperience is required" }, { status: 400 });
  }
  if (!EMPLOYMENT_STATUSES.has(employmentStatus)) {
    return NextResponse.json({ error: "employmentStatus is required" }, { status: 400 });
  }
  if (!RISK_TOLERANCES.has(riskTolerance)) {
    return NextResponse.json({ error: "riskTolerance is required" }, { status: 400 });
  }

  const front = form.get("front");
  const back = form.get("back");
  const addressProof = form.get("addressProof");
  const frontFile = front instanceof File ? front : null;
  const backFile = back instanceof File ? back : null;
  // Optional -- ClientKycRecord.addressProofUrl has always been nullable
  // (same field on the account-level KycRecord is likewise never
  // required there); a broker that wants to make it mandatory does so at
  // review time by rejecting a submission that lacks it, not here.
  const addressProofFile = addressProof instanceof File && addressProof.size > 0 ? addressProof : null;

  const frontResult = await validateKycFile(frontFile, "Document front");
  if (frontResult.error !== null) return NextResponse.json(frontResult, { status: 400 });
  const backResult = await validateKycFile(backFile, "Document back");
  if (backResult.error !== null) return NextResponse.json(backResult, { status: 400 });
  const addressResult = addressProofFile ? await validateKycFile(addressProofFile, "Proof of address") : null;
  if (addressResult && addressResult.error !== null) return NextResponse.json(addressResult, { status: 400 });

  // Same private store/token as the account-level route -- see that
  // file's own comment on why this is a separate token from
  // BLOB_READ_WRITE_TOKEN. "kyc/client/..." keeps these paths distinct
  // from "kyc/<accountId>/..." even though the two could never actually
  // collide (cuid ids), just for a reviewer skimming the Blob store
  // directly to be able to tell the two flows apart at a glance.
  const kycToken = process.env.PRIVATE_READ_WRITE_TOKEN;
  if (!kycToken) {
    return NextResponse.json({ error: "document storage is not configured" }, { status: 503 });
  }

  const frontBlob = await put(`kyc/client/${session.clientId}/front`, frontResult.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: frontResult.sniffedType,
    token: kycToken,
  });
  const backBlob = await put(`kyc/client/${session.clientId}/back`, backResult.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: backResult.sniffedType,
    token: kycToken,
  });
  const addressBlob =
    addressResult && addressResult.error === null
      ? await put(`kyc/client/${session.clientId}/address`, addressResult.bytes, {
          access: "private",
          addRandomSuffix: true,
          contentType: addressResult.sniffedType,
          token: kycToken,
        })
      : null;

  const record = await prisma.clientKycRecord.upsert({
    where: { clientId: session.clientId },
    create: {
      clientId: session.clientId,
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      documentBackUrl: backBlob.url,
      addressProofUrl: addressBlob?.url ?? null,
      annualIncome: annualIncome as AnnualIncomeRange,
      sourceOfFunds: sourceOfFunds as SourceOfFunds,
      tradingExperience: tradingExperience as TradingExperience,
      employmentStatus: employmentStatus as EmploymentStatus,
      riskTolerance: riskTolerance as RiskTolerance,
    },
    update: {
      status: "PENDING",
      documentType,
      documentFrontUrl: frontBlob.url,
      documentBackUrl: backBlob.url,
      addressProofUrl: addressBlob?.url ?? null,
      annualIncome: annualIncome as AnnualIncomeRange,
      sourceOfFunds: sourceOfFunds as SourceOfFunds,
      tradingExperience: tradingExperience as TradingExperience,
      employmentStatus: employmentStatus as EmploymentStatus,
      riskTolerance: riskTolerance as RiskTolerance,
      rejectionReason: null,
      reviewedByAdminId: null,
      reviewedAt: null,
    },
  });

  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { fullName: true, email: true } });
  await createNotification(prisma, {
    brokerId: session.brokerId,
    type: "CLIENT_KYC_SUBMITTED",
    title: "New client KYC submission",
    body: `${client?.fullName ?? session.clientId} (${client?.email ?? ""}) submitted ${documentType}`,
    entityType: "ClientKycRecord",
    entityId: record.id,
  });

  return NextResponse.json({ status: record.status, documentType: record.documentType }, { status: 201 });
}
