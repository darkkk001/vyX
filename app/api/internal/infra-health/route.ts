import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { parseInfraReport, recordInfraHealth } from "@/lib/infra-health";

// VPS-side infrastructure checks report here (owner 2026-10-05): deploy/vps/caddy-health-check.ps1 runs every
// 5 minutes as a scheduled task and POSTs its result with `x-internal-secret: INTERNAL_SERVICE_SECRET` (the same
// secret the VPS gateway already holds). This route matches middleware.ts's `/api/internal/*` exclusion, so no
// broker resolution. Stores the latest report, sends one alert e-mail on OK -> FAIL and one on recovery
// (lib/infra-health.ts), and Feed health shows it.
export async function POST(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = parseInfraReport(body);
  if (!parsed) return NextResponse.json({ error: "invalid report" }, { status: 400 });
  const result = await recordInfraHealth(parsed.component, parsed.report);
  return NextResponse.json({ stored: true, ...result });
}
