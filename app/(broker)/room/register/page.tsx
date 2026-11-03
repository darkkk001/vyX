import { notFound, redirect } from "next/navigation";
import { roomBroker } from "@/lib/room/context";

// The room's sign-up lives at /portal/register (owner routes 2026-11-04); this path only forwards old links.
export default async function RoomRegisterPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const { ref } = await searchParams;
  if (!(await roomBroker())) notFound();
  redirect(ref && /^[A-Za-z0-9]{2,16}$/.test(ref) ? `/portal/register?ref=${ref}` : "/portal/register");
}
