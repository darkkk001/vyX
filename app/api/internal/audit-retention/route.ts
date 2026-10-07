import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { purgeExpiredAuditLogs } from "@/lib/audit-retention";

// Step 3b item 2b: Vercel Cron once a day (vercel.json). Deletes each broker's audit rows older than its own
// "Audit log kept for" setting (never under 365 days). Same bearer CRON_SECRET check as app/api/internal/swap-rollover.
export async function GET(request: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET ?? "";
  const auth = request.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!expectedSecret || provided !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const purged = await purgeExpiredAuditLogs(prisma);
  return NextResponse.json({ brokers: purged.length, deleted: purged.reduce((n, p) => n + p.deleted, 0) });
}
