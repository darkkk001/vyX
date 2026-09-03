import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import ClientActivityView from "./ClientActivityView";

// VYX-BASICS-AUDIT.md category 6 "deep links work" / "clear title" --
// a bare "Account — Backoffice" tab title would satisfy the letter of
// the checkbox but not its point (this page IS the deep-linkable
// target the checkbox names); worth the one small extra lookup for a
// real "which account am I looking at" title. Not the same query
// ClientActivityView's own client-side fetch does (that one also needs
// email/kyc/group/timeline) -- this is deliberately the cheapest
// possible read for a title alone.
//
// Scoped by brokerId, same as every other admin-facing Account read in
// this app -- Next.js calls generateMetadata independently of (and
// before) the page component below, so without this an admin at Broker
// A pasting/guessing another broker's account id would briefly see
// Broker B's real client name + account number in their own browser
// tab title/history, a cross-tenant leak the page component's own
// broker-scoped guard never gets a chance to stop.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return { title: "Account — Backoffice" };
  }
  const account = await prisma.account.findUnique({
    where: { id, brokerId: session!.brokerId },
    select: { fullName: true, accountNumber: true },
  });
  return { title: account ? `${account.fullName} — ${account.accountNumber} — Backoffice` : "Account — Backoffice" };
}

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
