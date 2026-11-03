import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { roomBroker } from "@/lib/room/context";
import RoomFrame from "@/components/room/RoomFrame";

// Trader's Room root (CRM module). The whole tree is a 404 unless the host's broker has Broker.crmEnabled on, so a
// broker without the module sees no change.
export default async function RoomLayout({ children }: { children: ReactNode }) {
  const broker = await roomBroker();
  if (!broker) notFound();
  return <RoomFrame broker={broker}>{children}</RoomFrame>;
}
