import { NextResponse } from "next/server";
import { isDownloadKind, originOf, readFeedInfo } from "@/lib/download-feed";

// /download/terminal and /download/backoffice: 302 to the current Setup.exe of THIS broker's feed. The broker comes from
// the host (middleware.ts resolves it and sets x-broker-slug), never from a hard-coded name.
export async function GET(request: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const slug = request.headers.get("x-broker-slug");
  if (!isDownloadKind(kind) || !slug) return new NextResponse("Not found", { status: 404 });
  const origin = originOf(request.headers);
  const info = await readFeedInfo(kind, slug, origin);
  if (!info) return new NextResponse("This download is not available right now. Try again in a minute.", { status: 503, headers: { "Retry-After": "60" } });
  return NextResponse.redirect(new URL(info.setupPath, origin), 302);
}
