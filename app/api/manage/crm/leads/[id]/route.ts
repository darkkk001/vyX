import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { crmStaff, crmOwners, handleOf, clientRef } from "@/lib/crm/core";
import { LEAD_SELECT, shapeLead } from "@/lib/crm/leads";
import { crmTimeline } from "@/lib/crm/timeline";
import { hashPassword, issuePasswordResetToken } from "@/lib/client-auth";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";
import { brokerPublicOrigin } from "@/lib/request-origin";

// One lead. GET -> detail, notes (newest first), open tasks. PATCH {fullName?, email?, phone?, country?, source?, ownerId?,
// status?} -> edit / assign / mark lost / move stage. POST {action:"convert"} -> CONVERT: links the client with this
// e-mail, or creates one and sends the invitation to set a password (72 h).
async function load(brokerId: string, id: string) {
  return prisma.lead.findFirst({ where: { id, brokerId }, select: LEAD_SELECT });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const { id } = await params;
  const lead = await load(g.staff.brokerId, id);
  if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  const client = lead.clientId ? await prisma.client.findUnique({ where: { id: lead.clientId }, select: { clientNumber: true } }) : null;
  return NextResponse.json({ lead: { ...shapeLead(lead), clientRef: client ? clientRef(client.clientNumber) : null }, ...(await crmTimeline(g.staff.brokerId, "LEAD", lead.id)) });
}

const STATUSES = ["NEW", "CONTACTED", "DEMO", "FUNDED", "LOST"] as const;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const { id } = await params;
  const lead = await load(staff.brokerId, id);
  if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  const body = await request.json().catch(() => null);
  const data: Record<string, unknown> = {};
  const str = (k: string, n: number) => (typeof body?.[k] === "string" ? body[k].trim().slice(0, n) : undefined);
  const fullName = str("fullName", 100); if (fullName !== undefined) { if (!fullName) return NextResponse.json({ error: "Name is required." }, { status: 400 }); data.fullName = fullName; }
  const email = str("email", 200); if (email !== undefined) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 }); data.email = email.toLowerCase(); }
  for (const [k, n] of [["phone", 32], ["country", 64], ["source", 40]] as const) { const v = str(k, n); if (v !== undefined) data[k] = v || null; }
  if (body && "ownerId" in body) {
    const ownerId = typeof body.ownerId === "string" && body.ownerId ? body.ownerId : null;
    if (ownerId && !(await crmOwners(staff.brokerId)).some((o) => o.id === ownerId)) return NextResponse.json({ error: "Unknown owner." }, { status: 400 });
    data.assignedAdminId = ownerId;
  }
  if (body?.status !== undefined) {
    if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
    data.status = body.status;
    if (body.status === "CONTACTED") data.lastContactAt = new Date();
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const updated = await prisma.lead.update({ where: { id: lead.id }, data, select: LEAD_SELECT });
  const lines: string[] = [];
  if (data.status && data.status !== lead.status) lines.push(data.status === "LOST" ? "Marked lost." : `Stage set to ${data.status}.`);
  if ("assignedAdminId" in data && data.assignedAdminId !== lead.assignedAdminId) lines.push(updated.assignedAdmin ? `Assigned to ${handleOf(updated.assignedAdmin.email)}.` : "Unassigned.");
  if (["fullName", "email", "phone", "country", "source"].some((k) => k in data)) lines.push("Details edited.");
  if (lines.length) await prisma.crmNote.create({ data: { brokerId: staff.brokerId, entityType: "LEAD", entityId: lead.id, authorAdminId: staff.adminId, body: lines.join(" ") } });
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, action: "LEAD_UPDATED", entityType: "Lead", entityId: lead.id, oldValue: { status: lead.status, ownerId: lead.assignedAdminId }, newValue: JSON.parse(JSON.stringify(data)) } });
  return NextResponse.json({ lead: shapeLead(updated) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (body?.action !== "convert") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const lead = await load(staff.brokerId, id);
  if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  if (lead.clientId) return NextResponse.json({ error: "This lead is already a client." }, { status: 409 });

  let client = await prisma.client.findUnique({ where: { brokerId_email: { brokerId: staff.brokerId, email: lead.email } }, select: { id: true, clientNumber: true } });
  let invited = false;
  if (!client) {
    const created = await prisma.client.create({
      data: { brokerId: staff.brokerId, email: lead.email, fullName: lead.fullName, phone: lead.phone, country: lead.country, passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")), ownerAdminId: lead.assignedAdminId, source: lead.source },
      select: { id: true, clientNumber: true },
    });
    client = created;
    const broker = await prisma.broker.findUniqueOrThrow({ where: { id: staff.brokerId }, select: { name: true, subdomain: true, customDomain: true, logoUrl: true, primaryColor: true, supportEmail: true, emailEnabled: true, emailFromAddress: true, emailFromName: true } });
    const token = await issuePasswordResetToken(created.id, 72 * 3600);
    const url = `${brokerPublicOrigin(broker)}/portal/reset-password?token=${token}`;
    const { html, text } = renderBrokerEmail(
      { name: broker.name, logoUrl: broker.logoUrl, primaryColor: broker.primaryColor, supportEmail: broker.supportEmail },
      { preheader: `Your ${broker.name} client account is ready.`, heading: "Your account is ready", bodyLines: [`${broker.name} opened a client account for you. Choose a password to sign in.`], cta: { label: "Set password", url }, extraNote: "This link expires in 72 hours." }
    );
    await sendBrokerEmail({ name: broker.name, emailEnabled: broker.emailEnabled, emailFromAddress: broker.emailFromAddress, emailFromName: broker.emailFromName }, { to: lead.email, subject: `Your ${broker.name} account is ready`, html, text }).catch((err) => console.error("[crm] invitation e-mail failed", err));
    invited = true;
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { clientId: client.id, status: lead.status === "NEW" ? "CONTACTED" : lead.status } });
  await prisma.crmNote.create({ data: { brokerId: staff.brokerId, entityType: "LEAD", entityId: lead.id, authorAdminId: staff.adminId, body: invited ? `Converted to client ${clientRef(client.clientNumber)}; invitation sent.` : `Linked to client ${clientRef(client.clientNumber)}.` } });
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, clientId: client.id, action: "LEAD_CONVERTED", entityType: "Lead", entityId: lead.id, newValue: { clientId: client.id, invited } } });
  return NextResponse.json({ clientId: client.id, clientRef: clientRef(client.clientNumber), invited });
}
