import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession, type ClientSessionPayload } from "@/lib/client-auth";
import { parseWordmark, type WordmarkStyle } from "@/lib/room/wordmark";

// Trader's Room (CRM module, owner brief 2026-11-03). Every room page and /api/room route starts here: the host's
// broker must have the CRM module on (Broker.crmEnabled, read per request, so the switch needs no redeploy), and the
// API routes also need a signed-in Client of that broker.

export type RoomBroker = { id: string; name: string; subdomain: string; logoUrl: string | null; primaryColor: string | null; wordmark: WordmarkStyle | null };

/** The host's broker when its CRM module is on; null = the Trader's Room does not exist on this host. */
export async function roomBroker(): Promise<RoomBroker | null> {
  const brokerId = (await headers()).get("x-broker-id");
  if (!brokerId) return null;
  const b = await prisma.broker.findUnique({
    where: { id: brokerId },
    select: { id: true, name: true, subdomain: true, logoUrl: true, primaryColor: true, wordmark: true, crmEnabled: true, status: true },
  });
  if (!b || !b.crmEnabled) return null;
  return { id: b.id, name: b.name, subdomain: b.subdomain, logoUrl: b.logoUrl, primaryColor: b.primaryColor, wordmark: parseWordmark(b.wordmark, b.name) };
}

/** True only for a session the room shell will let in, so sign-in never bounces a suspended client back and forth. */
export async function roomSignedIn(): Promise<boolean> {
  const session = await getClientSession();
  if (!session) return false;
  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { status: true } });
  return client?.status === "ACTIVE";
}

export type RoomSession = ClientSessionPayload & { broker: RoomBroker };

/** For /api/room/*: the session, or the response to send (404 when the module is off, 401 when signed out). */
export async function roomApiSession(): Promise<{ session: RoomSession } | { response: NextResponse }> {
  const broker = await roomBroker();
  if (!broker) return { response: NextResponse.json({ error: "not found" }, { status: 404 }) };
  const session = await getClientSession({ activity: false }); // the room's own reads never keep a session alive
  if (!session) return { response: NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 }) };
  return { session: { ...session, broker } };
}

/** The Client's own account, or null (another client's account answers exactly like a missing one). */
export async function ownAccount(session: ClientSessionPayload, accountId: unknown) {
  if (typeof accountId !== "string" || !accountId) return null;
  return prisma.account.findFirst({
    where: { id: accountId, clientId: session.clientId, brokerId: session.brokerId, archivedAt: null },
    select: { isWallet: true, id: true, accountNumber: true, accountMode: true, currency: true, leverage: true, balance: true, credit: true, status: true, groupId: true, createdAt: true },
  });
}
