import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { roomBroker } from "@/lib/room/context";
import RoomFrame from "@/components/room/RoomFrame";
import RoomForgotView from "@/app/(broker)/room/forgot-password/ForgotView";
import ForgotPasswordForm from "./ForgotPasswordForm";

// Same header-driven branding pattern as ../login/page.tsx and
// ../register/page.tsx. A broker with the CRM module gets the Trader's Room version on this same path.
export default async function PortalForgotPasswordPage() {
  const room = await roomBroker();
  if (room) return <RoomFrame broker={room}><RoomForgotView broker={room} /></RoomFrame>;

  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return <ForgotPasswordForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} />;
}
