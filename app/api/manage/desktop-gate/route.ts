import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { mintDesktopGateToken } from "@/lib/desktop-gate";

// The one entry point manager-tauri's window actually navigates to first
// -- see src-tauri/src/main.rs. Not blocked by middleware.ts's /manage/*
// 404 (that check only matches /manage and /manage/*, not /api/manage/*
// -- see its own comment on why every /api/manage/* route stays
// reachable). x-broker-id is already attached by middleware's normal
// broker-resolution path, since this route isn't one of the blocked ones.
//
// On success, sets a signed cookie proving THIS broker's manager-tauri
// build authenticated itself, then redirects into the real, live
// /manage/login page -- which itself already redirects to /manage/
// dashboard if a session cookie from a previous "Remember me"/still-valid
// login already exists, exactly as it would for a normal browser tab.
export async function GET(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  const secret = request.nextUrl.searchParams.get("secret");
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;

  if (!brokerId || !secret || !internalSecret) {
    return new NextResponse("Not found", { status: 404 });
  }

  const broker = await prisma.broker.findUnique({
    where: { id: brokerId },
    select: { desktopGateSecret: true },
  });

  if (!broker?.desktopGateSecret || broker.desktopGateSecret !== secret) {
    return new NextResponse("Not found", { status: 404 });
  }

  const token = await mintDesktopGateToken(`manage:${brokerId}`, internalSecret);

  const response = NextResponse.redirect(new URL("/manage/login", request.url));
  response.cookies.set("vyx_manage_gate", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 180 * 24 * 60 * 60,
  });
  return response;
}
