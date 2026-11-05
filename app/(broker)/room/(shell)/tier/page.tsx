import { redirect } from "next/navigation";

// My Tier lives on the Dashboard now (owner 2026-11-05); an old link lands on its strip.
export default function RoomTierMoved() {
  redirect("/room#tier");
}
