import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientBuild, signManifest, type ClientManifest } from "@/lib/client-builds";

// GET /api/client/manifest?slug=<broker subdomain>&app=terminal|backoffice&buildId=<id>
// Public (no session yet -- the app calls it before sign-in), rate-limited. Returns the signed tenant
// manifest the native apps verify at start (lib/client-builds.ts): which host this build may talk to
// and whether the build is still alive. The build's own record decides status; an unknown build gets
// UNKNOWN (the app refuses to run with anything but ACTIVE).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const slug = (searchParams.get("slug") ?? "").trim().toLowerCase();
  const app = (searchParams.get("app") ?? "").trim().toLowerCase();
  const buildId = (searchParams.get("buildId") ?? "").trim();
  if (!slug || !app || !buildId) {
    return NextResponse.json({ error: "slug, app and buildId are required" }, { status: 400 });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { allowed } = await checkRateLimit(`client-manifest:${ip}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: "too many requests" }, { status: 429 });

  const broker = await prisma.broker.findUnique({ where: { subdomain: slug }, select: { id: true, subdomain: true } });
  if (!broker) return NextResponse.json({ error: "unknown broker" }, { status: 404 });
  const rootDomain = (process.env.ROOT_DOMAIN ?? "vyxtrader.com").split(":")[0];
  const build = buildId.startsWith("dev") ? null : await getClientBuild(buildId);
  const devAllowed = (process.env.CLIENT_BUILD_DEV_TENANTS ?? "zzzqa").split(",").map((s) => s.trim()).includes(broker.subdomain);
  const status: ClientManifest["status"] = buildId.startsWith("dev") ? (devAllowed ? "ACTIVE" : "UNKNOWN") : !build ? "UNKNOWN" : build.brokerId !== broker.id ? "UNKNOWN" : build.status;
  const now = Math.floor(Date.now() / 1000);
  const manifest: ClientManifest = { slug: broker.subdomain, apiHost: `${broker.subdomain}.${rootDomain}`, app, buildId, status, minVersion: "", iat: now, exp: now + 24 * 3600 };
  try {
    return NextResponse.json(signManifest(manifest), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("client manifest: signing failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "manifest signing is not configured" }, { status: 503 });
  }
}
