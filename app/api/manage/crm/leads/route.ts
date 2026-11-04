import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { crmStaff, crmOwners } from "@/lib/crm/core";
import { LEAD_SELECT, PIPELINE, shapeLead, statusFilter } from "@/lib/crm/leads";
import { toCsv } from "@/lib/csv";

// CRM — LEADS PIPELINE. GET ?status=&source=&owner=&q=[&format=csv] -> counts per stage, 30-day conversion, the rows
// (500 newest), the owners to filter / assign by. POST {fullName, email, phone?, country?, source?, ownerId?} -> a lead.
export async function GET(request: NextRequest) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const brokerId = g.staff.brokerId;
  const q = new URL(request.url).searchParams;
  const status = q.get("status");
  const source = q.get("source");
  const owner = q.get("owner");
  const text = (q.get("q") ?? "").trim();
  const where: Prisma.LeadWhereInput = {
    brokerId,
    ...statusFilter(status),
    ...(source && source !== "ALL" ? (source === "IB" ? { source: { startsWith: "IB · " } } : { source }) : {}),
    ...(owner && owner !== "ALL" ? { assignedAdminId: owner === "NONE" ? null : owner } : {}),
    ...(text ? { OR: [{ fullName: { contains: text, mode: "insensitive" } }, { email: { contains: text, mode: "insensitive" } }, { phone: { contains: text } }, ...(/^L-?\d+$/i.test(text) ? [{ number: Number(text.replace(/\D/g, "")) }] : [])] } : {}),
  };
  const since30 = new Date(Date.now() - 30 * 86400e3);
  const [rows, grouped, created30, funded30, owners, total] = await Promise.all([
    prisma.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: "desc" }, take: q.get("format") === "csv" ? 10_000 : 500 }),
    prisma.lead.groupBy({ by: ["status"], where: { brokerId }, _count: { _all: true } }),
    prisma.lead.count({ where: { brokerId, createdAt: { gte: since30 } } }),
    prisma.lead.count({ where: { brokerId, createdAt: { gte: since30 }, status: { in: ["FUNDED", "CONVERTED"] } } }),
    crmOwners(brokerId),
    prisma.lead.count({ where }),
  ]);
  const shaped = rows.map(shapeLead);
  if (q.get("format") === "csv") {
    const body = toCsv(shaped.map((l) => ({ ...l, owner: l.owner?.handle ?? "" })), [
      { key: "ref", label: "ID" }, { key: "fullName", label: "Name" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
      { key: "country", label: "Country" }, { key: "source", label: "Source" }, { key: "status", label: "Status" }, { key: "owner", label: "Owner" },
      { key: "lastContactAt", label: "Last contact (UTC)" }, { key: "createdAt", label: "Created (UTC)" },
    ]);
    return new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
  }
  const counts = Object.fromEntries(PIPELINE.map((s) => [s, 0])) as Record<string, number>;
  for (const r of grouped) {
    const k = r.status === "QUALIFIED" ? "CONTACTED" : r.status === "CONVERTED" ? "FUNDED" : r.status;
    counts[k] = (counts[k] ?? 0) + r._count._all;
  }
  return NextResponse.json({
    counts,
    conversion30d: created30 ? ((funded30 / created30) * 100).toFixed(1) : "0.0",
    total,
    rows: shaped,
    owners,
    sources: ["WEBSITE", "IB", "ADS", "REFERRAL", "MANUAL", "CSV"],
  });
}

export async function POST(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const body = await request.json().catch(() => null);
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim().slice(0, 100) : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  if (!fullName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Name and a valid email are required." }, { status: 400 });
  const str = (k: string, n: number) => (typeof body?.[k] === "string" && body[k].trim() ? body[k].trim().slice(0, n) : null);
  const ownerId = typeof body?.ownerId === "string" && body.ownerId ? body.ownerId : null;
  if (ownerId && !(await crmOwners(staff.brokerId)).some((o) => o.id === ownerId)) return NextResponse.json({ error: "Unknown owner." }, { status: 400 });
  const lead = await prisma.lead.create({
    data: { brokerId: staff.brokerId, fullName, email, phone: str("phone", 32), country: str("country", 64), source: str("source", 40) ?? "MANUAL", status: "NEW", assignedAdminId: ownerId },
    select: LEAD_SELECT,
  });
  await prisma.crmNote.create({ data: { brokerId: staff.brokerId, entityType: "LEAD", entityId: lead.id, authorAdminId: staff.adminId, body: "Lead added by hand." } });
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, action: "LEAD_CREATED", entityType: "Lead", entityId: lead.id, newValue: { fullName, email, source: lead.source } } });
  return NextResponse.json({ lead: shapeLead(lead) }, { status: 201 });
}
