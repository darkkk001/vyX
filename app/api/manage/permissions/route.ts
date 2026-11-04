import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { canReadAsManagerOrSupport, PERMISSIONS, PERMISSION_LABELS } from "@/lib/permissions";
import { STAFF_CHECKLIST } from "@/lib/permission-labels";

// The staff permission list, owned by the server (owner 2026-10-29, super-admin batch k1): the backoffice Staff page and the Super Admin
// Assign dialog render THIS list in THIS order and never hard-code it. `checklist` = the eight Staff page items; `other` = the remaining
// delegatable keys with their labels (shown where they are used: risk settings, emergency controls, pricing, ...).
export async function GET() {
  const session = await getAdminSession();
  if (!canReadAsManagerOrSupport(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const inList = new Set<string>(STAFF_CHECKLIST.map((c) => c.key));
  return NextResponse.json({
    checklist: STAFF_CHECKLIST.map((c) => ({ key: c.key, label: c.label })),
    other: PERMISSIONS.filter((p) => !inList.has(p)).map((p) => ({ key: p, label: PERMISSION_LABELS[p] })),
  });
}
