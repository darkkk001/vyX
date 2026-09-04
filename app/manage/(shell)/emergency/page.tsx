import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import EmergencyControls from "./EmergencyControls";

// BROKER_ADMIN by default -- same carve-out as Risk (this is the same
// broker-wide policy surface, just the kill switch half of it) --
// delegatable via EMERGENCY_CONTROLS (see lib/permissions.ts). Kept its
// own check here -- stricter than app/manage/(shell)/layout.tsx's own
// MANAGER-or-BROKER_ADMIN guard, same reasoning as the Manager Settings
// page's own kept check.
export const metadata: Metadata = { title: "Emergency controls - Backoffice" };

export default async function ManagerEmergencyPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-2xl">
      <PageHeader title="Emergency controls" description="The broker-wide kill switch. Existing open positions are never touched by this - it only blocks new orders." />
      <EmergencyControls />
    </main>
  );
}
