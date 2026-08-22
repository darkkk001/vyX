import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB -- a logo, not a document scan

// Only SUPER_ADMIN uploads a broker's logo (from Register-broker / Tenant
// Detail in the super-admin app) -- unlike app/api/trade/kyc/route.ts's
// PRIVATE identity documents, this is stored PUBLIC since the whole point
// is displaying it in that broker's own login/sidebar/topbar UI.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "logo must be a PNG, JPEG, WebP, or SVG image" }, { status: 400 });
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: "logo must be under 2MB" }, { status: 400 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "file storage is not configured" }, { status: 503 });
  }

  const blob = await put(`broker-logos/${Date.now()}-${file.name}`, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type,
  });

  return NextResponse.json({ url: blob.url }, { status: 201 });
}
