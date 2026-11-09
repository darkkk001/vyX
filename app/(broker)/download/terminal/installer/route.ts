import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { originOf, readFeedInfo } from "@/lib/download-feed";

export const dynamic = "force-dynamic";

// GET: straight to this broker's current Windows installer, the same file as the Downloads page button (owner
// 2026-11-09: the Dashboard's "Trade on" Download starts the download directly). No installer published yet: the
// download page, which says so.
export async function GET() {
  const h = await headers();
  const slug = h.get("x-broker-slug");
  const origin = originOf(h);
  const feed = slug ? await readFeedInfo("terminal", slug, origin).catch(() => null) : null;
  return NextResponse.redirect(new URL(feed ? feed.setupPath : "/download/terminal", origin), 302);
}
