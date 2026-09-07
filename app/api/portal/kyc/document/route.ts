import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";

// A client viewing their own previously-submitted document -- same proxy
// pattern as app/api/manage/kyc-requests/[id]/document/route.ts (the
// reviewing-admin side), scoped to the caller's own ClientKycRecord
// instead of any record in the broker.
export async function GET(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const side = new URL(request.url).searchParams.get("side");
  if (side !== "front" && side !== "back" && side !== "address") {
    return NextResponse.json({ error: "side must be front, back, or address" }, { status: 400 });
  }

  const record = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId } });
  if (!record) {
    return NextResponse.json({ error: "no submission found" }, { status: 404 });
  }

  const blobUrl = side === "front" ? record.documentFrontUrl : side === "back" ? record.documentBackUrl : record.addressProofUrl;
  if (!blobUrl) {
    return NextResponse.json({ error: "no document on this side" }, { status: 404 });
  }

  const kycToken = process.env.PRIVATE_READ_WRITE_TOKEN;
  if (!kycToken) {
    return NextResponse.json({ error: "document storage is not configured" }, { status: 503 });
  }

  let result;
  try {
    result = await get(blobUrl, { access: "private", token: kycToken });
  } catch {
    return NextResponse.json({ error: "document storage is unreachable" }, { status: 502 });
  }
  if (!result || result.statusCode !== 200) {
    return NextResponse.json({ error: "document not found in storage" }, { status: 404 });
  }

  return new Response(result.stream, {
    headers: {
      "content-type": result.blob.contentType,
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
