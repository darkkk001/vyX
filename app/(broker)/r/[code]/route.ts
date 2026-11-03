import { NextResponse, type NextRequest } from "next/server";
import { requestOrigin } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";

// A partner's referral link, https://<broker host>/r/<code>: to the Trader's Room sign-up with the code kept. A broker
// without the CRM module, or a malformed code, lands on the plain sign-up.
export async function GET(request: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const brokerId = request.headers.get("x-broker-id");
  const crm = brokerId ? (await prisma.broker.findUnique({ where: { id: brokerId }, select: { crmEnabled: true } }))?.crmEnabled === true : false;
  const url = new URL(crm ? "/room/register" : "/portal/register", requestOrigin(request));
  if (crm && /^[A-Za-z0-9]{2,16}$/.test(code)) url.searchParams.set("ref", code.toUpperCase());
  return NextResponse.redirect(url, 302);
}
