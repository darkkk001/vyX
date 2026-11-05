import { redirect } from "next/navigation";

// My Tier lives on the Dashboard now (owner 2026-11-05); an old link lands on that section.
export default function RoomTierMoved() {
  redirect("/room#tier");
}
