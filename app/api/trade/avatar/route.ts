import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getAccountSession } from "@/lib/account-auth";
import { prisma } from "@/lib/prisma";
import { shownAvatar } from "@/lib/room/bitmoji";
import { referralCodeOf } from "@/lib/room/partner";
import { requestOrigin } from "@/lib/request-origin";
import { LOSS_AVATARS, PROFIT_AVATARS, avatarBg, avatarPath, shownAvatarOf } from "@/lib/avatars";

// The signed-in trading account's own avatar and referral (owner 2026-11-12, extended 2026-11-14 for the share card),
// for WebTrader and the native terminal. Auth is the trading session they already use: the vyx_trade_session cookie or
// the same token as "Authorization: Bearer" (lib/account-auth.ts getAccountSession, broker-bound). The account comes only
// from that session, so an account reads nothing but its own. The client is reached through Account.clientId.
// What shows: the connected Bitmoji (only where BITMOJI_CONNECT_ENABLED lists the broker), else the preset chosen in the
// Room's Profile (Client.avatarPreset), else nothing (initials). Every CRM client has a referral code (made here on the
// first read, lib/room/partner.ts referralCodeOf); its QR opens the broker's register page with the code.
// Response (URLs absolute):
// { avatarUrl, type: "bitmoji"|"preset"|"none", preset, imageUrl, referralCode, registerUrl, qr,
//   presets: { profit: [{ name, imageUrl, bg }], loss: [...] }, nameTag }
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { brokerId: true, nickname: true, fullName: true, broker: { select: { subdomain: true } }, client: { select: { id: true, brokerId: true, bitmojiAvatarUrl: true, avatarPreset: true, fullName: true } } },
  });
  const client = account && account.brokerId === session.brokerId && account.client?.brokerId === session.brokerId ? account.client : null;
  const origin = requestOrigin(request);
  const abs = (u: string | null) => (u && u.startsWith("/") ? `${origin}${u}` : u);
  const shown = shownAvatarOf(account && client ? shownAvatar(account.broker.subdomain, client.bitmojiAvatarUrl) : null, client?.avatarPreset);
  const referralCode = client ? await referralCodeOf(client.id).catch(() => null) : null;
  const registerUrl = referralCode ? `${origin}/register?ref=${encodeURIComponent(referralCode)}` : null;
  const list = (names: readonly string[]) => names.map((name) => ({ name, imageUrl: `${origin}${avatarPath(name, 1024)}`, bg: avatarBg(name) }));
  return NextResponse.json({
    avatarUrl: abs(shown.url),
    type: shown.type,
    preset: shown.preset,
    imageUrl: abs(shown.url1024),
    referralCode,
    registerUrl,
    qr: registerUrl ? await QRCode.toDataURL(registerUrl, { margin: 1, width: 240 }) : null,
    presets: { profit: list(PROFIT_AVATARS), loss: list(LOSS_AVATARS) },
    // the card's name tag (owner 2026-11-14): the account's nickname (Room > account Settings), else the client's name
    nameTag: account && account.brokerId === session.brokerId ? (account.nickname?.trim() || client?.fullName || account.fullName || null) : null,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
