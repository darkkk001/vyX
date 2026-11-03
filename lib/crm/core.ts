import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, type AdminSessionPayload } from "@/lib/auth";

// Backoffice CRM tab (CRM module, owner brief 2026-11-03): LEADS PIPELINE and CLIENTS. Every /api/manage/crm route
// starts here: a MANAGER or BROKER_ADMIN of a broker with Broker.crmEnabled (404 when the module is off); SUPPORT may
// read (GET) like the other client screens, never write.

export type CrmStaff = AdminSessionPayload & { brokerId: string };

export async function crmStaff(kind: "read" | "write"): Promise<{ staff: CrmStaff } | { response: NextResponse }> {
  const s = await getAdminSession();
  const ok = !!s && !!s.brokerId && (s.role === "MANAGER" || s.role === "BROKER_ADMIN" || (kind === "read" && s.role === "SUPPORT"));
  if (!ok) return { response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const b = await prisma.broker.findUnique({ where: { id: s!.brokerId! }, select: { crmEnabled: true } });
  if (!b?.crmEnabled) return { response: NextResponse.json({ error: "The CRM module is off for this broker." }, { status: 404 }) };
  return { staff: s as CrmStaff };
}

export const leadRef = (n: number) => `L-${String(n).padStart(4, "0")}`;
export const clientRef = (n: number) => `C-${n}`;

/** Staff of the broker who can own a lead / client: id + a short handle for the tables ("AYESHA"). */
export async function crmOwners(brokerId: string) {
  const rows = await prisma.adminUser.findMany({
    where: { brokerId, status: "ACTIVE", role: { in: ["MANAGER", "BROKER_ADMIN", "SUPPORT"] } },
    select: { id: true, email: true, role: true },
    orderBy: { email: "asc" },
  });
  return rows.map((r) => ({ id: r.id, email: r.email, handle: handleOf(r.email), role: r.role }));
}

/** "sales.ayesha@broker.com" -> "AYESHA": the part after the last dot of the local part, upper case. */
export function handleOf(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (local.split(".").pop() || local).toUpperCase().slice(0, 12);
}
