import "server-only";
import { Prisma, type LeadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { leadRef, handleOf } from "@/lib/crm/core";

// CRM leads pipeline: NEW -> CONTACTED -> DEMO -> FUNDED, or LOST. A Trader's Room sign-up makes a lead by itself (source
// WEBSITE, or "IB · <code>" through a partner's link) and moves it along: DEMO when the client opens a demo account,
// FUNDED at the first completed deposit. Staff add leads by hand or CSV. Older statuses (QUALIFIED, CONVERTED) are kept
// for existing rows and shown as CONTACTED / FUNDED.

export const PIPELINE: LeadStatus[] = ["NEW", "CONTACTED", "DEMO", "FUNDED", "LOST"];
export function pipelineOf(s: LeadStatus): (typeof PIPELINE)[number] {
  return s === "QUALIFIED" ? "CONTACTED" : s === "CONVERTED" ? "FUNDED" : s;
}
export function statusFilter(s: string | null): Prisma.LeadWhereInput {
  switch (s) {
    case "CONTACTED": return { status: { in: ["CONTACTED", "QUALIFIED"] } };
    case "FUNDED": return { status: { in: ["FUNDED", "CONVERTED"] } };
    case "NEW": case "DEMO": case "LOST": return { status: s };
    default: return {};
  }
}

export const LEAD_SELECT = {
  id: true, number: true, fullName: true, email: true, phone: true, country: true, source: true, status: true, notes: true,
  assignedAdminId: true, clientId: true, lastContactAt: true, createdAt: true, assignedAdmin: { select: { email: true } },
} satisfies Prisma.LeadSelect;
export type LeadRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>;

export function maskPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/\s+/g, "");
  if (d.length < 7) return p;
  const head = d.startsWith("+") ? d.slice(0, d.length > 11 ? 4 : 3) : d.slice(0, 3);
  return `${head} ${d.slice(head.length, head.length + 3)} ····${d.slice(-3)}`;
}

export function shapeLead(l: LeadRow) {
  return {
    id: l.id,
    ref: leadRef(l.number),
    fullName: l.fullName,
    email: l.email,
    phone: l.phone,
    phoneMasked: maskPhone(l.phone),
    country: l.country,
    source: l.source ?? "MANUAL",
    status: pipelineOf(l.status),
    owner: l.assignedAdmin ? { id: l.assignedAdminId, handle: handleOf(l.assignedAdmin.email) } : null,
    clientId: l.clientId,
    lastContactAt: l.lastContactAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

/** A sign-up through the Trader's Room makes its lead (or links the lead staff already had for that e-mail). Never throws. */
export async function leadFromSignup(p: { brokerId: string; clientId: string; fullName: string; email: string; source: string }) {
  try {
    const existing = await prisma.lead.findFirst({ where: { brokerId: p.brokerId, email: p.email }, orderBy: { createdAt: "desc" }, select: { id: true, clientId: true } });
    if (existing) {
      if (!existing.clientId) await prisma.lead.update({ where: { id: existing.id }, data: { clientId: p.clientId } });
      return;
    }
    const lead = await prisma.lead.create({ data: { brokerId: p.brokerId, fullName: p.fullName, email: p.email, source: p.source, status: "NEW", clientId: p.clientId } });
    await prisma.crmNote.create({ data: { brokerId: p.brokerId, entityType: "LEAD", entityId: lead.id, body: p.source.startsWith("IB · ") ? `Lead created from IB referral link ${p.source.slice(5)}.` : "Lead created from the website sign-up." } });
  } catch (err) {
    console.error("[crm] lead from sign-up failed", err);
  }
}

/** Moves the client's lead forward (never back, never out of LOST by itself): DEMO on a demo account, FUNDED on money in. */
export async function advanceLead(brokerId: string, clientId: string, to: "DEMO" | "FUNDED") {
  try {
    const order: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "DEMO", "FUNDED", "CONVERTED"];
    const lead = await prisma.lead.findFirst({ where: { brokerId, clientId }, select: { id: true, status: true } });
    if (!lead || lead.status === "LOST" || order.indexOf(lead.status) >= order.indexOf(to)) return;
    await prisma.lead.update({ where: { id: lead.id }, data: { status: to } });
    await prisma.crmNote.create({ data: { brokerId, entityType: "LEAD", entityId: lead.id, body: to === "DEMO" ? "Opened a demo account." : "First deposit completed." } });
  } catch (err) {
    console.error("[crm] lead advance failed", err);
  }
}
