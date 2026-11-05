import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { revokeAllClientSessions } from "@/lib/client-auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";

// A client's password changed outside the Trader's Room form (forgot-password link, portal Change password). The portal
// password can also be the trading password of the client's accounts, so the old one must not live on there.
//  - accounts on the same password move to the new one; an account with its own separate password keeps it;
//  - every session ends: all the client's (but the one that made the change, if any) and all of every own account.
export async function replaceClientPassword(args: {
  clientId: string;
  passwordHash: string;
  keepSessionId?: string;
  clientData?: Prisma.ClientUpdateInput;
  action: string;
  audit: Prisma.InputJsonObject;
}): Promise<{ moved: number }> {
  const { clientId, passwordHash } = args;
  const { accountIds, moved } = await prisma.$transaction(async (tx) => {
    const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { brokerId: true, passwordHash: true } });
    const accounts = await tx.account.findMany({ where: { clientId, brokerId: client.brokerId }, select: { id: true, passwordHash: true } });
    const shared = accounts.filter((a) => a.passwordHash === client.passwordHash).map((a) => a.id);
    await tx.client.update({ where: { id: clientId }, data: { ...args.clientData, passwordHash } });
    if (shared.length) await tx.account.updateMany({ where: { id: { in: shared } }, data: { passwordHash } });
    await tx.auditLog.create({
      data: { brokerId: client.brokerId, clientId, action: args.action, entityType: "Client", entityId: clientId, newValue: { ...args.audit, accountsMoved: shared.length, accountsKeptOwnPassword: accounts.length - shared.length } },
    });
    return { accountIds: accounts.map((a) => a.id), moved: shared.length };
  });
  await revokeAllClientSessions(clientId, args.keepSessionId);
  // the password is already changed; a session that could not be ended must show up in the logs, not stop the answer
  await Promise.all(accountIds.map((id) => revokeAllAccountSessions(id).catch((err) => console.error("[client-password] session revoke failed", { accountId: id, err }))));
  return { moved };
}
