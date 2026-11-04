import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { generateTotpSecret, totpUri, verifyTotp } from "@/lib/totp";
import { checkRateLimit } from "@/lib/rate-limit";

// Trader's Room 2FA (authenticator app). POST {action:"setup"} -> a new secret + QR (not on until confirmed);
// {action:"confirm", code} -> on; {action:"disable", password, code} -> off. Once on, sign-in and withdrawals ask for it.
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-2fa:${session.clientId}`, 10, 300);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const client = await prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { email: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true } });
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const audit = (action: string) => prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action, entityType: "Client", entityId: session.clientId, newValue: { source: "CLIENT" } } });

  if (body?.action === "setup") {
    if (client.twoFactorEnabled) return NextResponse.json({ error: "2FA is already on." }, { status: 409 });
    const secret = generateTotpSecret();
    await prisma.client.update({ where: { id: session.clientId }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    const uri = totpUri(secret, client.email, session.broker.name);
    return NextResponse.json({ secret, qr: await QRCode.toDataURL(uri) });
  }
  if (body?.action === "confirm") {
    if (client.twoFactorEnabled) return NextResponse.json({ status: "on" });
    if (!client.twoFactorSecret || !verifyTotp(client.twoFactorSecret, code)) return NextResponse.json({ error: "Wrong code. Check the time on your phone." }, { status: 400 });
    await prisma.client.update({ where: { id: session.clientId }, data: { twoFactorEnabled: true } });
    await audit("CLIENT_2FA_ENABLED");
    return NextResponse.json({ status: "on" });
  }
  if (body?.action === "disable") {
    if (!client.twoFactorEnabled || !client.twoFactorSecret) return NextResponse.json({ status: "off" });
    const password = typeof body?.password === "string" ? body.password : "";
    if (!(await bcrypt.compare(password, client.passwordHash))) return NextResponse.json({ error: "Password is wrong." }, { status: 401 });
    if (!verifyTotp(client.twoFactorSecret, code)) return NextResponse.json({ error: "Wrong code." }, { status: 400 });
    await prisma.client.update({ where: { id: session.clientId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
    await audit("CLIENT_2FA_DISABLED");
    return NextResponse.json({ status: "off" });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
