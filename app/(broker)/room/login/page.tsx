import { notFound, redirect } from "next/navigation";
import { roomBroker } from "@/lib/room/context";

// The room's sign-in lives at /portal/login (owner routes 2026-11-04); this path only forwards old links.
export default async function RoomLoginPage({ searchParams }: { searchParams: Promise<{ verify?: string }> }) {
  const { verify } = await searchParams;
  if (!(await roomBroker())) notFound();
  redirect(verify === "success" || verify === "invalid" ? `/portal/login?verify=${verify}` : "/portal/login");
}
