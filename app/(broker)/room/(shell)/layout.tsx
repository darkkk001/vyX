import { redirect, notFound } from "next/navigation";
import type { ReactNode } from "react";
import { roomBroker } from "@/lib/room/context";
import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import { RoomDataProvider } from "@/components/room/RoomData";
import RoomSidebar from "@/components/room/RoomSidebar";
import { partnerAccountOf } from "@/lib/room/partner";

// Signed-in Trader's Room screens. Sign-in and sign-up are /portal/login and /portal/register, outside this group.
export default async function RoomShellLayout({ children }: { children: ReactNode }) {
  const broker = await roomBroker();
  if (!broker) notFound();
  const session = await getClientSession();
  if (!session) redirect("/portal/login");
  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { id: true, status: true } });
  if (!client || client.status !== "ACTIVE") redirect("/portal/login");
  const isPartner = (await partnerAccountOf(prisma, client.id)) !== null;
  return (
    <RoomDataProvider>
      <div className="r-shell">
        <RoomSidebar brokerName={broker.name} logoUrl={broker.logoUrl} isPartner={isPartner} />
        <main className="r-main">{children}</main>
      </div>
    </RoomDataProvider>
  );
}
