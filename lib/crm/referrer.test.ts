// Owner 2026-11-14: the CRM OWNER column shows the staff member assigned, otherwise the client who referred this one (their user id).
// crmClientRows sends `referrer` { id, ref } for a client who signed up through another client's link (same broker only), null
// otherwise. Live scratch DB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { crmClientRows } from "@/lib/crm/clients";
import { clientRef } from "@/lib/crm/core";

let brokerId = "", otherBrokerId = "";
const ids: { referrer?: string; referred?: string; plain?: string; foreign?: string; crossRef?: string } = {};

beforeAll(async () => {
  const s = randomUUID().slice(0, 8);
  brokerId = (await prisma.broker.create({ data: { name: `CRM Referrer ${s}`, subdomain: `crmref-${s}` } })).id;
  otherBrokerId = (await prisma.broker.create({ data: { name: `CRM Referrer other ${s}`, subdomain: `crmref2-${s}` } })).id;
  const mk = (b: string, tag: string, referredByClientId?: string) =>
    prisma.client.create({ data: { brokerId: b, email: `${tag}-${s}@test.local`, passwordHash: "x", fullName: tag, referredByClientId } });
  ids.referrer = (await mk(brokerId, "referrer")).id;
  ids.referred = (await mk(brokerId, "referred", ids.referrer)).id;
  ids.plain = (await mk(brokerId, "plain")).id;
  ids.foreign = (await mk(otherBrokerId, "foreign")).id;
  ids.crossRef = (await mk(brokerId, "crossref", ids.foreign)).id;   // a referrer at another broker is never shown
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { brokerId: { in: [brokerId, otherBrokerId] }, referredByClientId: { not: null } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: [brokerId, otherBrokerId] } } });
  await prisma.broker.deleteMany({ where: { id: { in: [brokerId, otherBrokerId] } } });
});

describe("crm clients: referrer", () => {
  it("a referred client carries the referrer's id and user id; others none", async () => {
    const rows = await crmClientRows(brokerId);
    const by = new Map(rows.map((r) => [r.id, r]));
    const referrer = await prisma.client.findUniqueOrThrow({ where: { id: ids.referrer! }, select: { clientNumber: true } });
    expect(by.get(ids.referred!)?.referrer).toEqual({ id: ids.referrer, ref: clientRef(referrer.clientNumber) });
    expect(by.get(ids.plain!)?.referrer).toBeNull();
    expect(by.get(ids.referrer!)?.referrer).toBeNull();
    expect(by.get(ids.crossRef!)?.referrer).toBeNull();
    expect(by.get(ids.referred!)?.owner).toBeNull();   // no staff assigned: the backoffice shows the referrer
  });
});
