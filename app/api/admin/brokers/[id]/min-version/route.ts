import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { compareVersions, readFeedInfo } from "@/lib/download-feed";
import { refreshUpdateRequired } from "@/lib/client-builds";
import { confirmSentence } from "@/lib/min-version-text";

// Mandatory-update policy (owner 2026-10-29, web-min-version-brief.md), Super Admin only. Per broker and app, the lowest version allowed to sign in
// and trade; builds below it get 426 UPDATE_REQUIRED and the apps update in one step to the latest full package.
//   GET -> { apps: [{ app, minVersion, latestVersion (the feed's now), reason, setAt }] }
//   PUT { app, minVersion | null, reason, confirm } -> set / clear. Refused above the latest version of the broker's live feed (every client
//       would be blocked with nothing to update to). `confirm` must be the exact sentence the dialog shows. Audit MIN_VERSION_SET.
const APPS = ["terminal", "backoffice"] as const;
type App = (typeof APPS)[number];
const VERSION = /^\d+(\.\d+){1,3}$/;

async function gate() {
  const s = await getAdminSession();
  return requireAdminRole(s, ["SUPER_ADMIN"]) ? s! : null;
}

function feedOrigin() {
  return `https://www.${(process.env.ROOT_DOMAIN ?? "vyxtrader.com").split(":")[0]}`;
}

async function view(brokerId: string, slug: string) {
  const rows = await prisma.brokerAppMinVersion.findMany({ where: { brokerId } });
  return {
    apps: await Promise.all(APPS.map(async (app) => {
      const r = rows.find((x) => x.app === app);
      const feed = await readFeedInfo(app, slug, feedOrigin());
      return { app, minVersion: r?.minVersion ?? null, latestVersion: feed?.version ?? null, reason: r?.reason ?? "", setAt: r?.setAt.toISOString() ?? null };
    })),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await gate())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const b = await prisma.broker.findUnique({ where: { id }, select: { id: true, subdomain: true } });
  if (!b) return NextResponse.json({ error: "broker not found" }, { status: 404 });
  return NextResponse.json(await view(b.id, b.subdomain));
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const b = await prisma.broker.findUnique({ where: { id }, select: { id: true, subdomain: true } });
  if (!b) return NextResponse.json({ error: "broker not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const app = body?.app as App;
  if (!APPS.includes(app)) return NextResponse.json({ error: "app must be terminal or backoffice" }, { status: 400 });
  const raw = body?.minVersion;
  const minVersion = typeof raw === "string" ? raw.trim().replace(/^v/i, "") : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  const before = await prisma.brokerAppMinVersion.findUnique({ where: { brokerId_app: { brokerId: b.id, app } } });

  if (raw === null || minVersion === "") {
    if (before) {
      await prisma.$transaction([
        prisma.brokerAppMinVersion.delete({ where: { id: before.id } }),
        prisma.auditLog.create({ data: { brokerId: b.id, actorAdminId: s.adminId, action: "MIN_VERSION_SET", entityType: "Broker", entityId: b.id, oldValue: { app, minVersion: before.minVersion }, newValue: { app, minVersion: null, reason } } }),
      ]);
      await refreshUpdateRequired(b.id, app);
    }
    return NextResponse.json(await view(b.id, b.subdomain));
  }

  if (!VERSION.test(minVersion)) return NextResponse.json({ error: "Enter a version such as 1.0.100." }, { status: 400 });
  const feed = await readFeedInfo(app, b.subdomain, feedOrigin());
  if (!feed) return NextResponse.json({ error: `This broker has no published ${app} yet: there is nothing to update to.` }, { status: 409 });
  if (compareVersions(minVersion, feed.version) > 0) {
    return NextResponse.json({ error: `v${minVersion} is above the latest published version (v${feed.version}): every client would be blocked with nothing to update to.` }, { status: 409 });
  }
  if (body?.confirm !== confirmSentence(minVersion)) {
    return NextResponse.json({ error: "Type the confirmation exactly as shown.", confirm: confirmSentence(minVersion) }, { status: 400 });
  }
  await prisma.$transaction([
    prisma.brokerAppMinVersion.upsert({
      where: { brokerId_app: { brokerId: b.id, app } },
      create: { brokerId: b.id, app, minVersion, latestVersion: feed.version, reason, setByAdminId: s.adminId },
      update: { minVersion, latestVersion: feed.version, reason, setByAdminId: s.adminId, setAt: new Date() },
    }),
    prisma.auditLog.create({ data: { brokerId: b.id, actorAdminId: s.adminId, action: "MIN_VERSION_SET", entityType: "Broker", entityId: b.id, oldValue: { app, minVersion: before?.minVersion ?? null }, newValue: { app, minVersion, latestVersion: feed.version, reason } } }),
  ]);
  await refreshUpdateRequired(b.id, app);
  return NextResponse.json(await view(b.id, b.subdomain));
}
