import { NextRequest, NextResponse } from "next/server";
import { bridgeReportSignatureOk, expiryState } from "@/lib/bridge-licenses";
import { evaluateBridgeLicense, loadBridgeLicense, normalizeMachine, recordLicenseReport, trySignBridgeVerdict } from "@/lib/bridge-license-state";
import { prisma } from "@/lib/prisma";
import { parseBridgeDetail, storeBridgeReport, type BridgeReport } from "@/lib/bridge-status";
import { publishTradingEvent } from "@/lib/nats";
import { checkRateLimit } from "@/lib/rate-limit";

// POST /api/internal/bridge-status: a QoreBridge reporting in (every 15 s) for the backoffice's CONNECTED badge
// (owner 2026-10-23). Auth: x-bridge-license (the licenseId) + x-bridge-signature (hex HMAC-SHA256 of the raw body
// with the license's report key). The broker is the license's, never the body's.
// Body: { at, lps: [{ id, status }], intake, feed, machine }. Liveness only.
// v2 (Phase 2.1 #4, qorebridge docs/bridge-status-report.md): `v: 2` plus health, hedging, license, lanes, held for the
// status console, stored beside the badge fields (lib/bridge-status.ts parseBridgeDetail). A v1 body has none of them and
// works exactly as before (no console detail); the 8,192-byte cap is unchanged.
//
// License enforcement 1.2 (C:\vyx\handoff\license-enforcement-contract.md 2c + 4), after the HMAC check:
//   ACTIVE (and machine ok)                      200 as before, plus license: { status: "ACTIVE", reason: "" }
//   SUSPENDED / REVOKED / expired / machine      403 { error: "forbidden", reason, license: <signed verdict> }
//   unsigned or not a bridge license             a bare 403 { error: "forbidden" } (nothing to prove)
// `machine` (inside the signed body) is checked against the license's machine (one server per license); a bridge
// that does not send it (before 1.2) is not checked. Every signed report from the license's own machine updates the
// license's online status (Super Admin), including a suspended / revoked / expired one.
export async function POST(request: NextRequest) {
  const licenseId = (request.headers.get("x-bridge-license") ?? "").trim();
  const raw = await request.text();
  if (!licenseId || raw.length > 8_192) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!bridgeReportSignatureOk(licenseId, raw, request.headers.get("x-bridge-signature"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const license = await loadBridgeLicense(licenseId);
  if (!license) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(await checkRateLimit(`bridge-status:${licenseId}`, 20, 60)).allowed) return NextResponse.json({ error: "too many reports" }, { status: 429 });

  let body: { lps?: unknown; intake?: unknown; feed?: unknown; machine?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  // absent = not checked (a bridge before 1.2); present but not a 64-hex hash = refused `machine`
  const machine = body.machine === undefined ? undefined : normalizeMachine(body.machine);
  const verdict = await evaluateBridgeLicense(license, { machine });
  if (verdict.reason !== "machine") await recordLicenseReport(licenseId, machine ?? null).catch(() => {});
  if (verdict.status !== "ACTIVE") {
    const signed = await trySignBridgeVerdict(license.brokerSubdomain, licenseId, verdict, license.brokerId);
    return NextResponse.json(signed ? { error: "forbidden", reason: verdict.reason, license: signed } : { error: "forbidden", reason: verdict.reason }, { status: 403 });
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
    licenseExpiresAt: verdict.facts?.expiresAt ?? null,
    detail: parseBridgeDetail(body),
  };
  // 30 days before expiry: one dealer FEED entry per license (the badge says it on every report)
  if (expiryState(report.licenseExpiresAt) === "expiring") {
    const already = await prisma.auditLog.count({ where: { action: "BRIDGE_LICENSE_EXPIRING", entityId: licenseId } });
    if (already === 0) {
      await prisma.auditLog.create({
        data: {
          brokerId: license.brokerId,
          action: "BRIDGE_LICENSE_EXPIRING",
          entityType: "ClientBuild",
          entityId: licenseId,
          newValue: { licenseId, expiresAt: new Date(report.licenseExpiresAt!).toISOString() },
        },
      });
    }
  }
  const { before, after } = await storeBridgeReport(license.brokerId, report);
  // the backoffice refreshes the badge at once on a change (admin stream only: dealing.>)
  if (before !== after) await publishTradingEvent("BridgeStatusChanged", { broker_id: license.brokerId, status: after }).catch(() => {});
  return NextResponse.json({ ok: true, badge: after, license: { status: "ACTIVE", reason: "" } });
}
