import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { checkCustomDomain, customDomainCnameTarget, normalizeCustomDomain } from "@/lib/custom-domain";

// A broker's own client domain (white label, 2026-11-04), Super Admin only.
//   GET  -> the domain, whether it is live, the DNS records the broker adds, a fresh check.
//   PUT  {customDomain: "portal.brokername.com" | null} -> set / clear; checked at once (live = redirect starts).
//   POST -> check again; a passing check marks it live, a failing one never un-marks a live domain (no flapping).
// The domain must also be attached to the platform's Vercel project (Domains), which the platform cannot do itself.
async function gate() {
  const s = await getAdminSession();
  return requireAdminRole(s, ["SUPER_ADMIN"]) ? s! : null;
}

function records(host: string) {
  const apex = host.split(".").slice(-2).join(".");
  const sub = host.slice(0, -(apex.length + 1));
  return {
    cname: { host: sub || "@", value: customDomainCnameTarget(), fqdn: host },
    note: `Add at the DNS host of ${apex}. If Vercel asks for ownership proof, it also needs the TXT record _vercel.${apex} it shows when the domain is attached.`,
  };
}

async function view(id: string, check: boolean) {
  const b = await prisma.broker.findUnique({ where: { id }, select: { id: true, subdomain: true, customDomain: true, customDomainVerifiedAt: true } });
  if (!b) return null;
  return {
    subdomain: b.subdomain,
    customDomain: b.customDomain,
    live: b.customDomainVerifiedAt !== null,
    liveSince: b.customDomainVerifiedAt?.toISOString() ?? null,
    records: b.customDomain ? records(b.customDomain) : null,
    check: b.customDomain && check ? await checkCustomDomain(b.customDomain) : null,
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await gate())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const v = await view(id, true);
  return v ? NextResponse.json(v) : NextResponse.json({ error: "broker not found" }, { status: 404 });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const before = await prisma.broker.findUnique({ where: { id }, select: { customDomain: true, customDomainVerifiedAt: true } });
  if (!before) return NextResponse.json({ error: "broker not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  let host: string | null = null;
  if (body?.customDomain !== null && body?.customDomain !== "") {
    const n = normalizeCustomDomain(body?.customDomain);
    if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
    host = n.host;
    const taken = await prisma.broker.findFirst({ where: { customDomain: host, NOT: { id } }, select: { id: true } });
    if (taken) return NextResponse.json({ error: "another broker already uses this domain" }, { status: 409 });
  }
  const check = host ? await checkCustomDomain(host) : null;
  const same = host === before.customDomain;
  const verifiedAt = !host ? null : check?.live ? new Date() : same ? before.customDomainVerifiedAt : null;
  await prisma.$transaction([
    prisma.broker.update({ where: { id }, data: { customDomain: host, customDomainVerifiedAt: verifiedAt } }),
    prisma.auditLog.create({ data: { brokerId: id, actorAdminId: s.adminId, action: "BROKER_CUSTOM_DOMAIN_CHANGED", entityType: "Broker", entityId: id, oldValue: { customDomain: before.customDomain, live: before.customDomainVerifiedAt !== null }, newValue: { customDomain: host, live: verifiedAt !== null, check } } }),
  ]);
  return NextResponse.json({ ...(await view(id, false)), check });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const b = await prisma.broker.findUnique({ where: { id }, select: { customDomain: true, customDomainVerifiedAt: true } });
  if (!b) return NextResponse.json({ error: "broker not found" }, { status: 404 });
  if (!b.customDomain) return NextResponse.json({ error: "this broker has no custom domain" }, { status: 400 });
  const check = await checkCustomDomain(b.customDomain);
  if (check.live && !b.customDomainVerifiedAt) {
    await prisma.$transaction([
      prisma.broker.update({ where: { id }, data: { customDomainVerifiedAt: new Date() } }),
      prisma.auditLog.create({ data: { brokerId: id, actorAdminId: s.adminId, action: "BROKER_CUSTOM_DOMAIN_LIVE", entityType: "Broker", entityId: id, newValue: { customDomain: b.customDomain, check } } }),
    ]);
  }
  return NextResponse.json({ ...(await view(id, false)), check });
}
