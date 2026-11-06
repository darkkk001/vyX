import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { hashPassword } from "@/lib/client-auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { cleanNickname, tradingPasswordOk } from "@/lib/room/password-rules";
import { archiveRefusal } from "@/lib/room/account-settings";

// PATCH {action, ...}: the Settings drawer of one own account.
//   nickname {nickname}                     trading-password / investor-password {current, next}
//   investor-password-off {current}         archive, restore
// A password change needs the client's portal password and ends every session of the account. Archive ends them too.
const DEMO_LIMIT = 5;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-account-settings:${session.clientId}`, 12, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const { id } = await params;
  const account = await prisma.account.findFirst({
    where: { id, clientId: session.clientId, brokerId: session.brokerId, isWallet: false, status: { not: "CLOSED" } },
    select: { id: true, accountNumber: true, accountMode: true, isWallet: true, balance: true, credit: true, passwordHash: true, investorPasswordHash: true, archivedAt: true },
  });
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const audit = (name: string, newValue: Record<string, string | boolean | null>) =>
    prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: name, entityType: "Account", entityId: account.id, newValue } });

  if (action === "restore") {
    if (!account.archivedAt) return NextResponse.json({ status: "done" });
    if (account.accountMode === "DEMO") {
      const n = await prisma.account.count({ where: { clientId: session.clientId, accountMode: "DEMO", status: "ACTIVE", archivedAt: null } });
      if (n >= DEMO_LIMIT) return NextResponse.json({ error: "You already have 5 demo accounts." }, { status: 409 });
    }
    await prisma.account.update({ where: { id: account.id }, data: { archivedAt: null } });
    await audit("ACCOUNT_RESTORED", {});
    return NextResponse.json({ status: "done" });
  }
  if (account.archivedAt) return NextResponse.json({ error: "Restore this account first." }, { status: 409 });

  if (action === "nickname") {
    const nickname = cleanNickname(body?.nickname);
    await prisma.account.update({ where: { id: account.id }, data: { nickname } });
    await audit("ACCOUNT_NICKNAME_CHANGED", { nickname });
    return NextResponse.json({ status: "done", nickname });
  }

  if (action === "archive") {
    const refusal = await archiveRefusal(account);
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
    await prisma.account.update({ where: { id: account.id }, data: { archivedAt: new Date() } });
    await audit("ACCOUNT_ARCHIVED", {});
    await revokeAllAccountSessions(account.id).catch(() => 0);
    return NextResponse.json({ status: "done" });
  }

  if (action === "trading-password" || action === "investor-password" || action === "investor-password-off") {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { passwordHash: true } });
    const current = typeof body?.current === "string" ? body.current : "";
    if (!(await bcrypt.compare(current, client.passwordHash))) return NextResponse.json({ error: "Portal password is wrong." }, { status: 401 });
    if (action === "investor-password-off") {
      await prisma.account.update({ where: { id: account.id }, data: { investorPasswordHash: null } });
    } else {
      const next = body?.next;
      if (!tradingPasswordOk(next)) return NextResponse.json({ error: "The password does not meet the rules." }, { status: 400 });
      const other = action === "trading-password" ? account.investorPasswordHash : account.passwordHash;
      if (other && (await bcrypt.compare(next, other))) return NextResponse.json({ error: "The trading and read-only passwords must differ." }, { status: 400 });
      const hash = await hashPassword(next);
      await prisma.account.update({ where: { id: account.id }, data: action === "trading-password" ? { passwordHash: hash } : { investorPasswordHash: hash } });
    }
    await audit(action === "trading-password" ? "ACCOUNT_TRADING_PASSWORD_CHANGED" : "ACCOUNT_INVESTOR_PASSWORD_CHANGED", { set: action !== "investor-password-off" });
    await revokeAllAccountSessions(account.id).catch(() => 0);
    return NextResponse.json({ status: "done" });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
