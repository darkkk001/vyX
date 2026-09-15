import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { getClientBuild, listClientBuilds, registerClientBuild, setClientBuildStatus } from "@/lib/client-builds";

// The native-build registry (kill switch). Super admin session, or the publish scripts' shared
// secret (x-registry-secret = CLIENT_BUILD_REGISTRY_SECRET) for registration from the build machine.
//   GET                          -> every registered build (newest first)
//   POST {buildId, slug, app, version, note?}   -> register (ACTIVE)
//   PATCH {buildId, status: ACTIVE|REVOKED, note?} -> the kill switch / reinstatement
async function authorized(request: NextRequest): Promise<boolean> {
  const secret = process.env.CLIENT_BUILD_REGISTRY_SECRET ?? "";
  const provided = request.headers.get("x-registry-secret") ?? "";
  if (secret && provided && provided === secret) return true;
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
  const app = body?.app === "terminal" || body?.app === "backoffice" ? body.app : null;
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
  const rec = await setClientBuildStatus(buildId, status, typeof body?.note === "string" ? body.note.slice(0, 200) : undefined);
  if (!rec) return NextResponse.json({ error: "unknown buildId" }, { status: 404 });
  return NextResponse.json(rec);
}
