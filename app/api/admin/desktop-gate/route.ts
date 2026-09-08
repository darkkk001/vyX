import { NextRequest, NextResponse } from "next/server";
import { mintDesktopGateToken } from "@/lib/desktop-gate";

// Super Admin twin of app/api/manage/desktop-gate/route.ts -- see its own
// comment for the full flow. No Broker involved here (Super Admin isn't
// broker-scoped), so the secret this checks is a single platform-wide env
// var baked into admin-tauri's build instead of a per-broker DB column.
export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.SUPER_ADMIN_DESKTOP_GATE_SECRET;
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;

  if (!secret || !expectedSecret || !internalSecret || secret !== expectedSecret) {
    return new NextResponse("Not found", { status: 404 });
  }

  const token = await mintDesktopGateToken("super-admin", internalSecret);

  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.set("vyx_admin_gate", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 180 * 24 * 60 * 60,
  });
  return response;
}
