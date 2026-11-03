import { NextResponse, type NextRequest } from "next/server";
import { requestOrigin } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";

// A partner's referral link, https://<broker host>/r/<code>: to the sign-up, with the code kept for a broker with the
// CRM module. A broker without it, or a malformed code, lands on the same sign-up with no code.
export async function GET(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const brokerId = request.headers.get("x-broker-id");
  const crm = brokerId ? (await prisma.broker.findUnique({ where: { id: brokerId }, select: { crmEnabled: true } }))?.crmEnabled === true : false;
  const url = new URL("/portal/register", requestOrigin(request));
  if (crm && /^[A-Za-z0-9]{2,16}$/.test(code)) url.searchParams.set("ref", code.toUpperCase());
  return NextResponse.redirect(url, 302);
}
