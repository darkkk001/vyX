import { NextRequest, NextResponse } from "next/server";
import { brandForHost } from "@/lib/broker-brand";
import { logoVariant } from "@/lib/broker-logo";
import { LOGO_HEIGHTS, logoResizable, logoVariantPath, logoVersion, type LogoHeight } from "@/lib/broker-logo-paths";

export const dynamic = "force-dynamic";

// The broker's logo, resized (lib/broker-logo-paths.ts): /brand-logo/<version>/<height>[@2x].<webp|png>. The broker
// comes from the Host header (dotted path, so middleware.ts does not run). The version is the logo URL's hash, so a
// copy never changes: cached for a year, by browsers and the CDN.
const FILE = new RegExp(`^(${LOGO_HEIGHTS.join("|")})(@2x)?\\.(webp|png)$`);
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest, { params }: { params: Promise<{ v: string; file: string }> }) {
  const { v, file } = await params;
  const m = FILE.exec(file);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  const height = Number(m[1]) as LogoHeight;
  const retina = !!m[2];
  const format = m[3] as "webp" | "png";
  const { logoUrl } = await brandForHost(request.headers.get("host"));
  if (!logoResizable(logoUrl)) return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  // an old page asking for a replaced logo: send it to the current one, uncached
  if (logoVersion(logoUrl) !== v) {
    return NextResponse.redirect(new URL(logoVariantPath(logoUrl, height, format, retina), request.nextUrl.origin), { status: 307, headers: NO_STORE });
  }
  try {
    const body = await logoVariant(logoUrl, height, retina, format);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": format === "webp" ? "image/webp" : "image/png",
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("[brand-logo] could not resize, sending the original", err);
    return NextResponse.redirect(logoUrl, { status: 307, headers: NO_STORE });
  }
}
