import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientBuild, manifestExecFields, signManifest, type ClientManifest } from "@/lib/client-builds";
import { evaluateBridgeLicense, loadBridgeLicense, normalizeMachine, signBridgeVerdict } from "@/lib/bridge-license-state";

// GET /api/client/manifest?slug=<broker subdomain>&app=terminal|backoffice&buildId=<id>
// Public (no session yet -- the app calls it before sign-in), rate-limited. Returns the signed tenant
// manifest the native apps verify at start (lib/client-builds.ts): which host this build may talk to
// and whether the build is still alive. The build's own record decides status; an unknown build gets
// UNKNOWN (the app refuses to run with anything but ACTIVE).
//
// app=bridge (license enforcement 1.2, C:\vyx\handoff\license-enforcement-contract.md 2a): buildId is the licenseId,
// optional exeBuild (the bridge exe's build id) and machine (the bridge's 64-hex machine hash). Always 200 with the
// signed verdict: ACTIVE | SUSPENDED (+ suspendReason) | REVOKED | EXPIRED | UNKNOWN | REFUSED (machine), with the
// short `reason` code (lib/bridge-license-state.ts evaluateBridgeLicense).
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

  if (app === "bridge") {
    // a revoked exe build stops every license running it
    const exeBuild = (searchParams.get("exeBuild") ?? "").trim();
    const exe = exeBuild && exeBuild !== "dev" ? await getClientBuild(exeBuild) : null;
    const machineParam = searchParams.get("machine");
    const license = await loadBridgeLicense(buildId);
    const verdict = await evaluateBridgeLicense(license, {
      brokerId: broker.id,
      // absent = not checked (bridges before 1.2); present but not a machine hash = refused
      machine: machineParam === null ? undefined : normalizeMachine(machineParam),
      exeRevoked: exe?.app === "bridge" && exe.status === "REVOKED",
    });
    try {
      return NextResponse.json(await signBridgeVerdict(broker.subdomain, buildId, verdict, broker.id), { headers: { "cache-control": "no-store" } });
    } catch (err) {
      console.error("client manifest: signing failed", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "manifest signing is not configured" }, { status: 503 });
    }
  }

  const build = buildId.startsWith("dev") ? null : await getClientBuild(buildId);
  const devAllowed = (process.env.CLIENT_BUILD_DEV_TENANTS ?? "zzzqa").split(",").map((s) => s.trim()).includes(broker.subdomain);
  // terminal / backoffice builds are only ever ACTIVE or REVOKED; anything else that is not ACTIVE reads as REVOKED
  const status: ClientManifest["status"] = buildId.startsWith("dev")
    ? devAllowed
      ? "ACTIVE"
      : "UNKNOWN"
    : !build || build.app === "bridge" || build.brokerId !== broker.id
      ? "UNKNOWN"
      : build.status === "ACTIVE"
        ? "ACTIVE"
        : "REVOKED";
  const now = Math.floor(Date.now() / 1000);
  // mandatory-update policy (owner 2026-10-29): the broker's minimum for this app, inside the signed payload ("" = none); a blocked client still gets
  // this manifest and the feed, so it can update
  const minRow = await prisma.brokerAppMinVersion.findUnique({ where: { brokerId_app: { brokerId: broker.id, app } }, select: { minVersion: true } });
  const manifest: ClientManifest = { slug: broker.subdomain, apiHost: `${broker.subdomain}.${rootDomain}`, app, buildId, status, minVersion: minRow?.minVersion ?? "", iat: now, exp: now + 24 * 3600, ...manifestExecFields(app, broker.id) };
  try {
    return NextResponse.json(signManifest(manifest), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("client manifest: signing failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "manifest signing is not configured" }, { status: 503 });
  }
}
