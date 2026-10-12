import "server-only";
import { prisma } from "@/lib/prisma";
import { clientIpFromHeaders, ipAllowed } from "@/lib/ip-allowlist";

// Step 3b item 3: the staff IP allowlist at sign-in (the same rule getAdminSession applies on every request, lib/auth.ts).
// Super Admin (no broker) is never limited. Called AFTER the password is right, so an address check never tells a stranger
// which e-mails exist.
export const STAFF_IP_REFUSED = { error: "this address is not allowed to sign in. Ask your admin to add it, or sign in from an allowed address.", code: "IP_NOT_ALLOWED" } as const;

export async function staffAddressAllowed(brokerId: string | null, headers: { get(name: string): string | null }): Promise<boolean> {
  if (!brokerId) return true;
  const b = await prisma.broker.findUnique({ where: { id: brokerId }, select: { staffIpAllowlist: true } });
  const list = b?.staffIpAllowlist ?? [];
  return list.length === 0 || ipAllowed(clientIpFromHeaders(headers), list);
}
