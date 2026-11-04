import "server-only";
import type { CrmEntity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { handleOf } from "@/lib/crm/core";

// Notes and tasks of a lead or client, shaped for the backoffice inspector (author as a handle, SYSTEM when none).
export async function crmTimeline(brokerId: string, entityType: CrmEntity, entityId: string) {
  const [notes, tasks] = await Promise.all([
    prisma.crmNote.findMany({ where: { brokerId, entityType, entityId }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.crmTask.findMany({ where: { brokerId, entityType, entityId, doneAt: null }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }], take: 50 }),
  ]);
  const ids = [...new Set([...notes.map((n) => n.authorAdminId), ...tasks.map((t) => t.assignedAdminId)].filter((x): x is string => !!x))];
  const admins = ids.length ? await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }) : [];
  const handle = new Map(admins.map((a) => [a.id, handleOf(a.email)]));
  return {
    notes: notes.map((n) => ({ id: n.id, at: n.createdAt.toISOString(), by: n.authorAdminId ? handle.get(n.authorAdminId) ?? "STAFF" : "SYSTEM", body: n.body })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null, owner: t.assignedAdminId ? handle.get(t.assignedAdminId) ?? null : null })),
  };
}
