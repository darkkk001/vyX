import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

// Only PostgreSQL has a real measurement anywhere in this app -- a timed
// round trip at request time. The other rows the design reference shows
// (API Gateway, WebSocket Gateway, Execution Engine) have no health-check
// source anywhere in this project (no Prometheus/Grafana wired up, per
// the master architecture doc's own Phase 9 -- that's future
// infrastructure, not something to fake numbers for here). Shown as
// "Not monitored" rather than invented uptime/latency figures.
export default async function PlatformHealthPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const start = performance.now();
  let dbOperational = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOperational = false;
  }
  const dbLatencyMs = Math.round(performance.now() - start);

  const rows = [
    {
      service: "PostgreSQL (primary)",
      status: dbOperational ? ("operational" as const) : ("degraded" as const),
      latency: `${dbLatencyMs}ms`,
      uptime: "—",
      monitored: true,
    },
    { service: "API Gateway", status: "unmonitored" as const, latency: "—", uptime: "—", monitored: false },
    { service: "WebSocket Gateway", status: "unmonitored" as const, latency: "—", uptime: "—", monitored: false },
    { service: "Execution Engine", status: "unmonitored" as const, latency: "—", uptime: "—", monitored: false },
  ];

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Platform health" description="Service status across the platform" />
      <Table>
        <TableHead>
          <TableHeaderCell>Service</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="right">Latency</TableHeaderCell>
          <TableHeaderCell align="right">Uptime (30d)</TableHeaderCell>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.service}>
              <TableCell primary>{r.service}</TableCell>
              <TableCell>
                <Badge tone={r.status === "operational" ? "success" : r.status === "degraded" ? "danger" : "neutral"}>
                  {r.status === "unmonitored" ? "Not monitored" : r.status}
                </Badge>
              </TableCell>
              <TableCell align="right" mono>
                {r.latency}
              </TableCell>
              <TableCell align="right" mono>
                {r.uptime}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
