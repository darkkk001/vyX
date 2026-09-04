import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

// Super Admin surface's equivalent of app/api/manage/theme/route.ts --
// see that route's comment for the full reasoning (same shared AdminUser
// row, same lib/admin-theme.tsx client, just addressed under this
// surface's own URL prefix).
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
