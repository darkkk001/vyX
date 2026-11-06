import "server-only";
import { prisma } from "@/lib/prisma";

// What stops an account being archived. Archiving hides it and refuses sign-in until the client restores it, so nothing
// may still be running on it. A demo balance is play money and does not count; a live balance does.
export async function archiveRefusal(a: { id: string; accountMode: string; isWallet: boolean; balance: { isZero(): boolean }; credit: { isZero(): boolean } }): Promise<string | null> {
  if (a.isWallet) return "The funding wallet cannot be archived.";
  const [positions, orders, requests, partner] = await Promise.all([
    prisma.position.count({ where: { accountId: a.id, status: "OPEN" } }),
    prisma.order.count({ where: { accountId: a.id, status: { in: ["PENDING", "ACCEPTED", "REQUOTED"] } } }),
    prisma.transaction.count({ where: { accountId: a.id, status: "PENDING" } }),
    prisma.client.count({ where: { partnerAccountId: a.id } }),
  ]);
  if (positions > 0) return "Close the open positions first.";
  if (orders > 0) return "Cancel the pending orders first.";
  if (requests > 0) return "This account has a funds request in progress.";
  if (partner > 0) return "This account receives your partner commissions.";
  if (a.accountMode === "LIVE" && !(a.balance.isZero() && a.credit.isZero())) return "Move the balance out first.";
  return null;
}
