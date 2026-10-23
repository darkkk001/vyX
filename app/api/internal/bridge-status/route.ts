import { NextRequest, NextResponse } from "next/server";
import { getClientBuild } from "@/lib/client-builds";
import { bridgeReportSignatureOk } from "@/lib/bridge-licenses";
import { storeBridgeReport, type BridgeReport } from "@/lib/bridge-status";
import { publishTradingEvent } from "@/lib/nats";
import { checkRateLimit } from "@/lib/rate-limit";

// POST /api/internal/bridge-status: a QoreBridge reporting in (every 15 s) for the backoffice's CONNECTED badge
// (owner 2026-10-23). Auth: x-bridge-license (the licenseId) + x-bridge-signature (hex HMAC-SHA256 of the raw body
// with the license's report key). The license must be a registered, ACTIVE bridge license; the broker is the
// license's, never the body's. Body: { at, lps: [{ id, status }], intake, feed }. Liveness only.
export async function POST(request: NextRequest) {
  const licenseId = (request.headers.get("x-bridge-license") ?? "").trim();
  const raw = await request.text();
  if (!licenseId || raw.length > 8_192) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!bridgeReportSignatureOk(licenseId, raw, request.headers.get("x-bridge-signature"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const license = await getClientBuild(licenseId);
  if (!license || license.app !== "bridge" || license.status !== "ACTIVE") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(await checkRateLimit(`bridge-status:${licenseId}`, 20, 60)).allowed) return NextResponse.json({ error: "too many reports" }, { status: 429 });

  let body: { lps?: unknown; intake?: unknown; feed?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const lps = Array.isArray(body.lps) ? (body.lps as { status?: unknown }[]).slice(0, 32) : [];
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
  const report: BridgeReport = {
    licenseId,
    receivedAt: Date.now(), // the platform's clock, never the bridge's
    lpsReady: lps.filter((l) => l?.status === "Ready").length,
    lpsTotal: lps.length,
    intake: pick(body.intake, ["ok", "degraded", "down", "off"] as const, "off"),
    feed: pick(body.feed, ["ok", "degraded", "off"] as const, "off"),
  };
  const { before, after } = await storeBridgeReport(license.brokerId, report);
  // the backoffice refreshes the badge at once on a change (admin stream only: dealing.>)
  if (before !== after) await publishTradingEvent("BridgeStatusChanged", { broker_id: license.brokerId, status: after }).catch(() => {});
  return NextResponse.json({ ok: true, badge: after });
}
