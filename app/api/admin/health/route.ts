import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

async function requireSuperAdmin() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return null;
  }
  return session;
}

// Same live timed round trip app/(super-admin)/(shell)/health/page.tsx's
// Server Component used to do inline -- exposed as JSON so a new
// HealthManager.tsx can self-fetch it. Only PostgreSQL has a real
// measurement anywhere in this app; the other rows stay hardcoded
// "Not monitored" here too, same reasoning as before (no Prometheus/
// Grafana wired up anywhere in this project).
export async function GET() {
  const session = await requireSuperAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const start = performance.now();
  let dbOperational = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOperational = false;
  }
  const dbLatencyMs = Math.round(performance.now() - start);

  return NextResponse.json([
    {
      service: "PostgreSQL (primary)",
      status: dbOperational ? "operational" : "degraded",
      latency: `${dbLatencyMs}ms`,
      uptime: "—",
    },
    { service: "API Gateway", status: "unmonitored", latency: "—", uptime: "—" },
    { service: "WebSocket Gateway", status: "unmonitored", latency: "—", uptime: "—" },
    { service: "Execution Engine", status: "unmonitored", latency: "—", uptime: "—" },
  ]);
}
