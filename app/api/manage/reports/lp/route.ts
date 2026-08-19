import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

// BROKER_ADMIN only, matching the LP roster page itself (not the broader
// MANAGER+BROKER_ADMIN gate the other reports use). Exports the only
// real data that exists -- the provider roster -- no fabricated
// execution/latency columns (see the Latency/Execution Quality pages'
// own comments for why those can't be real yet).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const providers = await prisma.liquidityProvider.findMany({
    where: { brokerId: session!.brokerId! },
    include: { _count: { select: { routingRules: true } } },
    orderBy: { createdAt: "desc" },
  });

  const csv = toCsv(
    providers.map((p) => ({
      name: p.name,
      status: p.status,
      protocol: p.protocol ?? "",
      contactName: p.contactName ?? "",
      contactEmail: p.contactEmail ?? "",
      contactPhone: p.contactPhone ?? "",
      routingRules: String(p._count.routingRules),
      createdAt: p.createdAt.toISOString(),
    })),
    [
      { key: "name", label: "Name" },
      { key: "status", label: "Status" },
      { key: "protocol", label: "Protocol" },
      { key: "contactName", label: "Contact Name" },
      { key: "contactEmail", label: "Contact Email" },
      { key: "contactPhone", label: "Contact Phone" },
      { key: "routingRules", label: "Routing Rules" },
      { key: "createdAt", label: "Added At" },
    ]
  );

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="lp-report.csv"' },
  });
}
