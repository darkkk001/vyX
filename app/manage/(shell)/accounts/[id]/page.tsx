import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import ClientActivityView from "./ClientActivityView";

// No Prisma query here anymore -- app/manage/(shell)/layout.tsx's own
// MANAGER-or-BROKER_ADMIN guard is identical to what this page checked
// itself. ClientActivityView now self-fetches from a new
// /api/manage/accounts/[id]/activity GET (which also handles the
// not-found/wrong-broker case previously done via next/navigation's
// notFound()) instead of a Server Component Prisma read.
export default async function ClientActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const { id } = await params;

  return <ClientActivityView accountId={id} />;
}
