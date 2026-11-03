import "server-only";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";

// Real-time for the Trader's Room: a RoomChanged event per affected account (gateway room.>, room sockets only). The
// room refetches its figures from the server; the event carries no data. Never throws.
export type RoomChange = "funds" | "kyc" | "support" | "account";

export async function publishRoomChanged(brokerId: string, accountIds: string[], what: RoomChange): Promise<void> {
  await Promise.all(accountIds.map((id) => publishTradingEvent("RoomChanged", { broker_id: brokerId, account_id: id, what }).catch(() => {})));
}

/** Every account of the client (the room listens on each): for client-level changes such as a KYC decision. */
export async function publishRoomChangedForClient(brokerId: string, clientId: string, what: RoomChange): Promise<void> {
  const accounts = await prisma.account.findMany({ where: { clientId, brokerId }, select: { id: true } }).catch(() => []);
  await publishRoomChanged(brokerId, accounts.map((a) => a.id), what);
}
