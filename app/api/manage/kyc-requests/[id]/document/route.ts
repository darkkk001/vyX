import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Proxies a KYC document image -- the browser's network tab only ever
// sees this app's own domain, never the underlying Blob URL. Documents
// are stored with access: "private" (see app/api/trade/kyc/route.ts),
// so this server-side get() call (using PRIVATE_READ_WRITE_TOKEN -- a
// separate store/token from BLOB_READ_WRITE_TOKEN, see
// app/api/admin/brokers/logo/route.ts's own comment for why) is the
// only way to read them back at all -- there's no publicly-fetchable
// URL to leak in the first place. Auth + broker-scope are checked
// before ever touching Blob.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const side = new URL(request.url).searchParams.get("side");
  if (side !== "front" && side !== "back") {
    return NextResponse.json({ error: "side must be front or back" }, { status: 400 });
  }

  const record = await prisma.kycRecord.findUnique({
    where: { id },
    include: { account: { select: { brokerId: true } } },
  });
  if (!record || record.account.brokerId !== brokerId) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }

  const blobUrl = side === "front" ? record.documentFrontUrl : record.documentBackUrl;
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
    },
  });
}
