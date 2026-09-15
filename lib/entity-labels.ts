import { prisma } from "@/lib/prisma";

// Backoffice audit 2026-09-15 §6 -- every manage endpoint that hands an
// AuditLog / Notification row to a backoffice used to expose only
// entityType + entityId (a cuid), and every client sliced the cuid into a
// fake "reference" (DASH's live-audit line even printed the whole cuid).
// Positions and orders have carried a numeric MT-style `ticket` since
// 2026-09-11 (prisma: order_ticket_seq), accounts have accountNumber,
// everything else has a name -- so the readable identity is resolved HERE,
// once per response, batched per entity type, and sent as `entityLabel`.
// Unknown types / deleted rows fall back to "" and the client shows the
// type alone rather than a cuid.

export type EntityRef = { entityType: string | null; entityId: string | null };

function norm(t: string | null): string {
  return (t ?? "").replace(/[_\s]/g, "").toUpperCase();
}

export async function resolveEntityLabels(brokerId: string, refs: EntityRef[]): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r.entityId) continue;
    const t = norm(r.entityType);
    if (!byType.has(t)) byType.set(t, new Set());
    byType.get(t)!.add(r.entityId);
  }
  const out = new Map<string, string>();
  const ids = (t: string) => [...(byType.get(t) ?? [])];
  const money = (v: { toNumber(): number }) => v.toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const jobs: Promise<void>[] = [];
  if (ids("POSITION").length) {
    jobs.push(
      prisma.position
        .findMany({ where: { id: { in: ids("POSITION") }, brokerId }, select: { id: true, ticket: true, symbol: { select: { name: true } }, side: true, volume: true, account: { select: { accountNumber: true } } } })
        .then((rows) => rows.forEach((p) => out.set(p.id, `#${p.ticket} ${p.symbol.name} ${p.side} ${p.volume.toString()} · ${p.account.accountNumber}`)))
    );
  }
  if (ids("ORDER").length) {
    jobs.push(
      prisma.order
        .findMany({ where: { id: { in: ids("ORDER") }, brokerId }, select: { id: true, ticket: true, symbol: { select: { name: true } }, side: true, volume: true, account: { select: { accountNumber: true } } } })
        .then((rows) => rows.forEach((o) => out.set(o.id, `#${o.ticket} ${o.symbol.name} ${o.side} ${o.volume.toString()} · ${o.account.accountNumber}`)))
    );
  }
  const accountIds = [...ids("ACCOUNT"), ...ids("TRADINGACCOUNT")];
  if (accountIds.length) {
    jobs.push(
      prisma.account
        .findMany({ where: { id: { in: accountIds }, brokerId }, select: { id: true, accountNumber: true, fullName: true } })
        .then((rows) => rows.forEach((a) => out.set(a.id, `${a.accountNumber} · ${a.fullName}`)))
    );
  }
  const txIds = [...ids("TRANSACTION"), ...ids("FUNDSREQUEST")];
  if (txIds.length) {
    jobs.push(
      prisma.transaction
        .findMany({ where: { id: { in: txIds }, brokerId }, select: { id: true, type: true, amount: true, account: { select: { accountNumber: true } } } })
        .then((rows) => rows.forEach((t) => out.set(t.id, `${t.type} ${money(t.amount)} · ${t.account.accountNumber}`)))
    );
  }
  if (ids("GROUP").length) {
    jobs.push(prisma.group.findMany({ where: { id: { in: ids("GROUP") }, brokerId }, select: { id: true, name: true } }).then((rows) => rows.forEach((g) => out.set(g.id, g.name))));
  }
  if (ids("ADMINUSER").length || ids("ADMIN").length) {
    jobs.push(
      prisma.adminUser
        .findMany({ where: { id: { in: [...ids("ADMINUSER"), ...ids("ADMIN")] } }, select: { id: true, email: true } })
        .then((rows) => rows.forEach((a) => out.set(a.id, a.email)))
    );
  }
  if (ids("BROKERSYMBOL").length) {
    jobs.push(
      prisma.brokerSymbol
        .findMany({ where: { id: { in: ids("BROKERSYMBOL") }, brokerId }, select: { id: true, symbol: { select: { name: true } } } })
        .then((rows) => rows.forEach((s) => out.set(s.id, s.symbol.name)))
    );
  }
  if (ids("LEAD").length) {
    jobs.push(prisma.lead.findMany({ where: { id: { in: ids("LEAD") }, brokerId }, select: { id: true, fullName: true } }).then((rows) => rows.forEach((l) => out.set(l.id, l.fullName))));
  }
  if (ids("KYCRECORD").length || ids("KYCREQUEST").length) {
    jobs.push(
      prisma.kycRecord
        .findMany({ where: { id: { in: [...ids("KYCRECORD"), ...ids("KYCREQUEST")] } }, select: { id: true, account: { select: { accountNumber: true, fullName: true, brokerId: true } } } })
        .then((rows) => rows.filter((k) => k.account.brokerId === brokerId).forEach((k) => out.set(k.id, `KYC ${k.account.accountNumber} · ${k.account.fullName}`)))
    );
  }
  if (ids("CLIENTKYCRECORD").length || ids("CLIENTKYCREQUEST").length) {
    jobs.push(
      prisma.clientKycRecord
        .findMany({ where: { id: { in: [...ids("CLIENTKYCRECORD"), ...ids("CLIENTKYCREQUEST")] } }, select: { id: true, client: { select: { fullName: true, email: true, brokerId: true } } } })
        .then((rows) => rows.filter((k) => k.client.brokerId === brokerId).forEach((k) => out.set(k.id, `KYC ${k.client.fullName || k.client.email}`)))
    );
  }
  if (ids("LIVEACCOUNTREQUEST").length) {
    jobs.push(
      prisma.liveAccountRequest
        .findMany({ where: { id: { in: ids("LIVEACCOUNTREQUEST") } }, select: { id: true, client: { select: { fullName: true, email: true, brokerId: true } } } })
        .then((rows) => rows.filter((r) => r.client.brokerId === brokerId).forEach((r) => out.set(r.id, `${r.client.fullName || r.client.email}`)))
    );
  }
  if (ids("IBRELATIONSHIP").length) {
    jobs.push(
      prisma.ibRelationship
        .findMany({ where: { id: { in: ids("IBRELATIONSHIP") }, brokerId }, select: { id: true, ibAccount: { select: { accountNumber: true } }, clientAccount: { select: { accountNumber: true } } } })
        .then((rows) => rows.forEach((r) => out.set(r.id, `IB ${r.ibAccount.accountNumber} → ${r.clientAccount.accountNumber}`)))
    );
  }
  await Promise.all(jobs.map((j) => j.catch(() => undefined)));
  return out;
}
