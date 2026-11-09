import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { secretMatches } from "@/lib/internal-auth";
import { backfillClientBuildsToPostgres, ClientBuildStatusError, getClientBuild, isBridgeLicense, listClientBuilds, registerClientBuild, setClientBuildStatus } from "@/lib/client-builds";
import { BridgeLicenseError, changeBridgeLicenseStatus } from "@/lib/bridge-licenses";

// The native-build registry (kill switch). Super admin session, or the publish scripts' shared
// secret (x-registry-secret = CLIENT_BUILD_REGISTRY_SECRET) for registration from the build machine.
//   GET                          -> every registered build (newest first)
//   POST {buildId, slug, app, version, note?}   -> register (ACTIVE)
//   PATCH {buildId, status: ACTIVE|REVOKED, note?} -> the kill switch / reinstatement. For a bridge LICENSE (license
//        enforcement 1.2): REVOKED goes through the same revoke as Super Admin's (audit row, FEED, nudge; note = the
//        reason), and ACTIVE is refused (409) for a REVOKED license (permanent) or a SUSPENDED one (Resume in Super
//        Admin: /api/admin/bridge-licenses/<licenseId>). Bridge exe builds (version "exe") are unchanged.
//   PUT                          -> one-time backfill: every build only Redis knows gets its Postgres row (never overwrites)
async function authorized(request: NextRequest): Promise<boolean> {
  const secret = (process.env.CLIENT_BUILD_REGISTRY_SECRET ?? "").trim();   // trimmed: a value pasted with a trailing newline must still match
  const provided = (request.headers.get("x-registry-secret") ?? "").trim();
  // hashed constant-time compare: the old length check before timingSafeEqual told a caller the secret's length
  if (secretMatches(provided, secret)) return true;
  const session = await getAdminSession();
  return !!session && session.role === "SUPER_ADMIN";
}

export async function GET(request: NextRequest) {
  if (!(await authorized(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await listClientBuilds());
}

export async function POST(request: NextRequest) {
  if (!(await authorized(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const buildId = typeof body?.buildId === "string" ? body.buildId.trim() : "";
  const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  // "bridge": a QoreBridge exe build (version "exe"); its licenses are issued through /api/admin/bridge-licenses
  const app = body?.app === "terminal" || body?.app === "backoffice" || body?.app === "bridge" ? body.app : null;
  const version = typeof body?.version === "string" ? body.version.trim() : "";
  if (!buildId || !slug || !app || !version) return NextResponse.json({ error: "buildId, slug, app, version are required" }, { status: 400 });
  if (await getClientBuild(buildId)) return NextResponse.json({ error: "buildId already registered" }, { status: 409 });
  const broker = await prisma.broker.findUnique({ where: { subdomain: slug }, select: { id: true, subdomain: true } });
  if (!broker) return NextResponse.json({ error: "unknown broker slug" }, { status: 404 });
  const rec = await registerClientBuild({ buildId, brokerId: broker.id, brokerSubdomain: broker.subdomain, app, version, note: typeof body?.note === "string" ? body.note.slice(0, 200) : "" });
  return NextResponse.json(rec, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  if (!(await authorized(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const buildId = typeof body?.buildId === "string" ? body.buildId.trim() : "";
  const status = body?.status === "REVOKED" ? "REVOKED" : body?.status === "ACTIVE" ? "ACTIVE" : null;
  if (!buildId || !status) return NextResponse.json({ error: "buildId and status ACTIVE|REVOKED are required" }, { status: 400 });
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : undefined;
  const pg = await prisma.clientBuild.findUnique({ where: { buildId }, select: { app: true, version: true, status: true } });
  const known = pg ?? (await getClientBuild(buildId));
  if (known && isBridgeLicense(known)) {
    const current = pg?.status ?? known.status;
    if (status === "ACTIVE") {
      if (current === "REVOKED") return NextResponse.json({ error: "a revoked bridge license cannot be reinstated: issue a new license" }, { status: 409 });
      if (current === "SUSPENDED") return NextResponse.json({ error: "this bridge license is suspended: resume it in Super Admin" }, { status: 409 });
      return NextResponse.json(await getClientBuild(buildId));
    }
    try {
      const session = await getAdminSession().catch(() => null);
      await changeBridgeLicenseStatus({ licenseId: buildId, action: "revoke", reason: note?.trim() || "Revoked through the build registry", adminId: session?.adminId ?? null });
    } catch (e) {
      if (e instanceof BridgeLicenseError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return NextResponse.json(await getClientBuild(buildId));
  }
  try {
    const rec = await setClientBuildStatus(buildId, status, note);
    if (!rec) return NextResponse.json({ error: "unknown buildId" }, { status: 404 });
    return NextResponse.json(rec);
  } catch (e) {
    if (e instanceof ClientBuildStatusError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

export async function PUT(request: NextRequest) {
  if (!(await authorized(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const written = await backfillClientBuildsToPostgres();
  const total = (await listClientBuilds()).length;
  return NextResponse.json({ written, registry: total });
}
