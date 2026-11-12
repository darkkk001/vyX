import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";

// Profile's "Disconnect": the Bitmoji goes, the initials come back. Allowed whatever the flag says, so a client can
// always remove it.
export async function DELETE() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  await prisma.client.updateMany({
    where: { id: session.clientId, brokerId: session.brokerId },
    data: { bitmojiAvatarUrl: null, bitmojiConnectedAt: null },
  });
  return NextResponse.json({ ok: true });
}
