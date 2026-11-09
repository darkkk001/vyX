import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bearerMatches } from "@/lib/internal-auth";
import { runCertExpiryCheck } from "@/lib/cert-expiry";

// Daily TLS certificate-expiry check of every broker host + www / feed / admin (lib/cert-expiry.ts). Vercel cron calls it
// with `Authorization: Bearer $CRON_SECRET` (vercel.json); the JSON lists every host's certificate for a manual look.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runCertExpiryCheck({
    brokers: () => prisma.broker.findMany({ where: { status: { not: "DISABLED" } }, select: { subdomain: true, customDomain: true } }),
  });
  return NextResponse.json(result);
}
