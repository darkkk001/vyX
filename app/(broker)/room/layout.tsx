import { notFound } from "next/navigation";
import type { Viewport } from "next";
import type { ReactNode } from "react";
import { roomBroker } from "@/lib/room/context";
import RoomFrame from "@/components/room/RoomFrame";

// Trader's Room root (CRM module). The whole tree is a 404 unless the host's broker has Broker.crmEnabled on, so a
// broker without the module sees no change.
// the page may run under the iPhone status bar; the sticky header pads itself with the safe area (room.css)
export const viewport: Viewport = { viewportFit: "cover" };

export default async function RoomLayout({ children }: { children: ReactNode }) {
  const broker = await roomBroker();
  if (!broker) notFound();
  return <RoomFrame broker={broker}>{children}</RoomFrame>;
}
