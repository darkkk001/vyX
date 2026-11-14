import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { isAvatarPreset } from "@/lib/avatars";

// Profile's "Choose avatar" (owner 2026-11-14): { preset: "<name>" } saves one of the preset pictures (lib/avatars.ts),
// { preset: null } goes back to the initials. Only the signed-in client's own row.
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-avatar:${session.clientId}`, 30, 600);
  if (!allowed) return NextResponse.json({ error: "Too many changes. Try again later." }, { status: 429 });
  const body = (await request.json().catch(() => null)) as { preset?: unknown } | null;
  const preset = body?.preset ?? null;
  if (preset !== null && !isAvatarPreset(preset)) return NextResponse.json({ error: "Choose one of the avatars." }, { status: 400 });
  await prisma.client.updateMany({ where: { id: session.clientId, brokerId: session.brokerId }, data: { avatarPreset: preset } });
  return NextResponse.json({ ok: true, preset });
}
