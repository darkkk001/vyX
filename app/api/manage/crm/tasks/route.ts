import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmStaff, crmOwners, handleOf } from "@/lib/crm/core";

// CRM tasks. GET ?mine=1 -> open tasks (the caller's, or all of the broker), due first. POST {entityType, entityId,
// title, dueAt?, ownerId?} -> a task. PATCH {id, done} -> done / reopened.
export async function GET(request: NextRequest) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const mine = new URL(request.url).searchParams.get("mine") === "1";
  const rows = await prisma.crmTask.findMany({ where: { brokerId: g.staff.brokerId, doneAt: null, ...(mine ? { assignedAdminId: g.staff.adminId } : {}) }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }], take: 500 });
  return NextResponse.json({ tasks: rows.map((t) => ({ id: t.id, entityType: t.entityType, entityId: t.entityId, title: t.title, dueAt: t.dueAt?.toISOString() ?? null, ownerId: t.assignedAdminId })) });
}

export async function POST(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const b = await request.json().catch(() => null);
  const entityType = b?.entityType === "LEAD" ? "LEAD" : b?.entityType === "CLIENT" ? "CLIENT" : null;
  const title = typeof b?.title === "string" ? b.title.trim().slice(0, 140) : "";
  if (!entityType || typeof b?.entityId !== "string" || !title) return NextResponse.json({ error: "Give the task a title." }, { status: 400 });
  const exists = entityType === "LEAD"
    ? await prisma.lead.findFirst({ where: { id: b.entityId, brokerId: staff.brokerId }, select: { id: true } })
    : await prisma.client.findFirst({ where: { id: b.entityId, brokerId: staff.brokerId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let dueAt: Date | null = null;
  if (typeof b?.dueAt === "string" && b.dueAt) {
    dueAt = new Date(b.dueAt);
    if (Number.isNaN(dueAt.getTime())) return NextResponse.json({ error: "Due date is not a date." }, { status: 400 });
  }
  const ownerId = typeof b?.ownerId === "string" && b.ownerId ? b.ownerId : staff.adminId;
  const owners = await crmOwners(staff.brokerId);
  if (!owners.some((o) => o.id === ownerId)) return NextResponse.json({ error: "Unknown owner." }, { status: 400 });
  const t = await prisma.crmTask.create({ data: { brokerId: staff.brokerId, entityType, entityId: b.entityId, title, dueAt, assignedAdminId: ownerId, createdByAdminId: staff.adminId } });
  return NextResponse.json({ id: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null, owner: handleOf(owners.find((o) => o.id === ownerId)!.email) }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const b = await request.json().catch(() => null);
  if (typeof b?.id !== "string" || typeof b?.done !== "boolean") return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const res = await prisma.crmTask.updateMany({ where: { id: b.id, brokerId: g.staff.brokerId }, data: { doneAt: b.done ? new Date() : null } });
  if (res.count === 0) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  return NextResponse.json({ status: b.done ? "done" : "open" });
}
