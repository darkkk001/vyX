import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { issueSsoToken } from "@/lib/sso";
import { checkRateLimit } from "@/lib/rate-limit";

// Called by a broker's OWN external portal/backend -- not by a browser --
// after IT has already authenticated the trader in its own system. Proves
// that with the broker's ssoSecret (X-Broker-Secret header, generated
// once in Super Admin -- see app/(super-admin)/(shell)/brokers), then
// hands back a short-lived one-time token. The broker's frontend redirects
// the trader's browser to /trade/sso?token=<this>, which exchanges it for
// a real WebTrader session -- no id/password re-entry, see docs/
// webtrader-stm-architecture-review.md §4.1 for the full flow.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`sso-token:${brokerId}`, 30, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many requests, try again shortly" }, { status: 429 });
  }

  const providedSecret = request.headers.get("x-broker-secret");
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { ssoSecret: true, status: true } });
  if (!broker || !broker.ssoSecret || broker.status !== "ACTIVE" || providedSecret !== broker.ssoSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const accountNumber = typeof body?.accountNumber === "string" ? body.accountNumber.trim() : "";
  if (!accountNumber) {
    return NextResponse.json({ error: "accountNumber is required" }, { status: 400 });
  }

  // Same constant-shape lookup as authenticateAccount -- the broker's
  // portal doesn't get to distinguish "wrong account number" from
  // "account belongs to a different broker" from "account disabled".
  const account = await prisma.account.findUnique({ where: { accountNumber } });
  if (!account || account.brokerId !== brokerId || account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const ssoToken = await issueSsoToken({ accountId: account.id, brokerId });
  return NextResponse.json({ ssoToken });
}
