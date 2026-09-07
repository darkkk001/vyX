import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";

// Public-to-the-client (not admin-only) listing of this broker's enabled
// account types, for the Trading Accounts tab's Create Account picker --
// app/api/manage/account-types is the admin CRUD surface for the same
// table, deliberately not reused here since it requires an admin session.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const types = await prisma.accountType.findMany({
    where: { brokerId: session.brokerId, enabled: true },
    select: { id: true, name: true, description: true, isDefault: true },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json(types);
}
