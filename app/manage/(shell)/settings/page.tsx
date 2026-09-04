import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import SettingsManager from "./SettingsManager";

// Kept its own BROKER_ADMIN-only check (stricter than app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard, unlike most other
// pages where the two checks are identical and redundant) -- a plain
// MANAGER should never even land on this route's shell, not just fail
// to load its data. SettingsManager itself now fetches its own data from
// /api/manage/settings (already returning this exact combined shape,
// unmodified) instead of receiving server-rendered props.
export const metadata: Metadata = { title: "System settings - Backoffice" };

export default async function ManagerSettingsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-2xl">
      <PageHeader title="System settings" description="Broker info (read-only - edited in the Super Admin console) and defaults this team controls." />
      <SettingsManager />
    </main>
  );
}
