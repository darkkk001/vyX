import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import type { ReactNode } from "react";
import { roomBroker } from "@/lib/room/context";
import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import { RoomDataProvider } from "@/components/room/RoomData";
import RoomSidebar from "@/components/room/RoomSidebar";
import { partnerAccountOf } from "@/lib/room/partner";

// Signed-in Trader's Room screens. Sign-in and sign-up are /login and /register, outside this group.
export default async function RoomShellLayout({ children }: { children: ReactNode }) {
  const broker = await roomBroker();
  if (!broker) notFound();
  const session = await getClientSession();
  if (!session) redirect("/login");
  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { id: true, status: true } });
  if (!client || client.status !== "ACTIVE") redirect("/login");
  const isPartner = (await partnerAccountOf(prisma, client.id)) !== null;
  // read here, not in the browser, so the sidebar draws its saved state with no flash
  const jar = await cookies();
  const rail = jar.get("room_rail")?.value === "1";
  const closedGroups = decodeURIComponent(jar.get("room_nav_closed")?.value ?? "").split(",").filter(Boolean);
  return (
    <RoomDataProvider>
      <div className="r-shell">
        <RoomSidebar brokerName={broker.name} logoUrl={broker.logoUrl} isPartner={isPartner} rail={rail} closedGroups={closedGroups} />
        <main className="r-main">{children}</main>
      </div>
    </RoomDataProvider>
  );
}
