import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

// Persists the Manager surface's sun/moon toggle (lib/admin-theme.tsx's
// AdminThemeSurface) to AdminUser.theme -- any signed-in admin role can
// set their own theme, no MANAGER/BROKER_ADMIN/SUPPORT distinction
// needed since this touches nothing but the caller's own row. Mirrors
// app/api/admin/theme/route.ts exactly (Super Admin's equivalent) --
// kept as two thin routes rather than one shared one so each stays under
// its own surface's URL prefix, same convention as shell-info's own pair.
export async function PATCH(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (body?.theme !== "light" && body?.theme !== "dark") {
    return NextResponse.json({ error: "theme must be \"light\" or \"dark\"" }, { status: 400 });
  }

  await prisma.adminUser.update({ where: { id: session.adminId }, data: { theme: body.theme } });
  return NextResponse.json({ theme: body.theme });
}
