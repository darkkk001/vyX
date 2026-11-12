import { NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { prisma } from "@/lib/prisma";
import { shownAvatar } from "@/lib/room/bitmoji";

// The signed-in trading account's own Bitmoji (owner 2026-11-12), for the user badge in WebTrader and the native
// terminal. Read-only. Auth is the trading session WebTrader and the terminal already use: the vyx_trade_session
// cookie or the same token as "Authorization: Bearer" (lib/account-auth.ts getAccountSession, broker-bound). The account
// comes only from that session, so an account can read nothing but its own. The client is reached through
// Account.clientId (set when the account belongs to a CRM client); the image is the one saved by the Room's Bitmoji
// connect (Client.bitmojiAvatarUrl), shown the Room's way (lib/room/bitmoji.ts shownAvatar), and only where
// BITMOJI_CONNECT_ENABLED lists the broker. Response: { "avatarUrl": string | null }.
export async function GET() {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { brokerId: true, broker: { select: { subdomain: true } }, client: { select: { brokerId: true, bitmojiAvatarUrl: true } } },
  });
  const saved = account && account.brokerId === session.brokerId && account.client?.brokerId === session.brokerId ? account.client.bitmojiAvatarUrl : null;
  const avatarUrl = account ? shownAvatar(account.broker.subdomain, saved) : null;
  return NextResponse.json({ avatarUrl }, { headers: { "Cache-Control": "private, no-store" } });
}
