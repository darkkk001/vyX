import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { roomBroker, roomSignedIn } from "@/lib/room/context";
import RoomFrame from "@/components/room/RoomFrame";
import RoomLoginView from "@/app/(broker)/room/login/LoginView";
import LoginForm from "./LoginForm";

// useSearchParams() inside LoginForm (for ?verify=success/invalid) opts
// this page out of static prerendering unless wrapped in Suspense -- same
// reasoning as app/(super-admin)/login/page.tsx's own Suspense wrapper.
// A broker with the CRM module gets the Trader's Room sign-in on this same path (owner routes 2026-11-04).
export default async function PortalLoginPage({ searchParams }: { searchParams: Promise<{ verify?: string; signedOut?: string; google?: string }> }) {
  const room = await roomBroker();
  if (room) {
    if (await roomSignedIn()) redirect("/room");
    const q = await searchParams;
    return <RoomFrame broker={room}><RoomLoginView broker={room} verify={q.verify} signedOut={q.signedOut === "1"} google={q.google} /></RoomFrame>;
  }
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;

  return (
    <Suspense fallback={null}>
      <LoginForm brokerName={broker?.name ?? "VyXTrader"} brokerLogoUrl={broker?.logoUrl ?? null} />
    </Suspense>
  );
}
