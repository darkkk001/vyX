import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clientIpFromHeaders } from "@/lib/ip-allowlist";

// Step 3b item 5: the staff sign-in record (AdminSignIn). The newest KEEP rows per person stay.
export const KEEP_SIGN_INS = 200;
type Db = PrismaClient | Prisma.TransactionClient;

export async function recordStaffSignIn(
  params: { adminId: string; brokerId: string | null; headers: { get(name: string): string | null }; outcome: "SIGNED_IN" | "IP_BLOCKED" },
  db: Db = prisma
): Promise<void> {
  try {
    const clientBuild = (params.headers.get("x-client-build") ?? "").trim();
    const userAgent = [params.headers.get("user-agent"), clientBuild ? `VyxBuild/${clientBuild}` : ""].filter(Boolean).join(" ").slice(0, 300);
    await db.adminSignIn.create({ data: { adminId: params.adminId, brokerId: params.brokerId, ip: clientIpFromHeaders(params.headers), userAgent, outcome: params.outcome } });
    const cut = await db.adminSignIn.findMany({ where: { adminId: params.adminId }, orderBy: { createdAt: "desc" }, skip: KEEP_SIGN_INS, take: 1, select: { createdAt: true } });
    if (cut[0]) await db.adminSignIn.deleteMany({ where: { adminId: params.adminId, createdAt: { lte: cut[0].createdAt } } });
  } catch (err) {
    // the record never stops a sign-in
    console.error("[staff-devices] could not record the sign-in", err);
  }
}
