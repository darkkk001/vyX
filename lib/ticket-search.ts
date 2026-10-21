import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Ticket search (Batch D, owner 2026-10-21): the backoffice global search (Ctrl+K) and GET /api/manage/search. Digits, with
// or without a leading "#", match Position.ticket, Order.ticket and Deal.ticket by PREFIX ("100003" lists 1000031,
// 1000038, ...; "#1000038" lists 1000038 and 10000381...). The exact ticket ranks first, then positions before orders before
// deals, then the newest (highest) ticket. Broker-scoped. A position's ticket is its opening order's ticket, so an exact
// match usually lists both the position and its order.

export type TicketHit = {
  type: "position" | "order" | "deal";
  id: string;
  ticket: number;
  exact: boolean;
  accountId: string;
  accountNumber: string;
  symbol: string;
  side: string;
  // position: OPEN | CLOSED | VOIDED; order: its OrderStatus; deal: FILLED | VOIDED
  status: string;
  positionId: string | null; // order: the position it opened or closes; deal: its position
  entry: string | null; // deal only: IN | OUT | OUT_BY | INOUT
  deleted: boolean; // the position (or the deal's / order's position) is soft-deleted
};

const PER_TYPE = 10;
const MAX_HITS = 20;

/// "100003" | "#100003" -> "100003"; anything else (letters, spaces, under 2 digits, longer than a bigint) -> null.
export function ticketQuery(q: string): string | null {
  const m = /^#?\s*(\d{2,18})$/.exec(q.trim());
  return m ? m[1] : null;
}

export function rankTickets(hits: TicketHit[]): TicketHit[] {
  const typeOrder = { position: 0, order: 1, deal: 2 } as const;
  return [...hits]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || typeOrder[a.type] - typeOrder[b.type] || b.ticket - a.ticket)
    .slice(0, MAX_HITS);
}

type Row = { id: string; ticket: bigint | number; accountId: string; accountNumber: string; symbol: string; side: string; status: string; positionId: string | null; entry: string | null; deleted: boolean };

export async function searchTickets(brokerId: string, digits: string): Promise<TicketHit[]> {
  const prefix = `${digits}%`; // digits only: no LIKE wildcard can come from the query
  const [positions, orders, deals] = await Promise.all([
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id, p.ticket, a.id AS "accountId", a."accountNumber", s.name AS symbol, p.side::text AS side, p.status::text AS status,
             NULL::text AS "positionId", NULL::text AS entry, (p."deletedAt" IS NOT NULL) AS deleted
      FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Symbol" s ON s.id = p."symbolId"
      WHERE p."brokerId" = ${brokerId} AND p.ticket::text LIKE ${prefix}
      ORDER BY (p.ticket::text = ${digits}) DESC, p.ticket DESC LIMIT ${PER_TYPE}`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT o.id, o.ticket, a.id AS "accountId", a."accountNumber", s.name AS symbol, o.side::text AS side, o.status::text AS status,
             COALESCE(op.id, o."closesPositionId") AS "positionId", NULL::text AS entry,
             COALESCE(op."deletedAt", cp."deletedAt") IS NOT NULL AS deleted
      FROM "Order" o JOIN "Account" a ON a.id = o."accountId" JOIN "Symbol" s ON s.id = o."symbolId"
      LEFT JOIN "Position" op ON op."originOrderId" = o.id
      LEFT JOIN "Position" cp ON cp.id = o."closesPositionId"
      WHERE o."brokerId" = ${brokerId} AND o.ticket::text LIKE ${prefix}
      ORDER BY (o.ticket::text = ${digits}) DESC, o.ticket DESC LIMIT ${PER_TYPE}`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT d.id, d.ticket, a.id AS "accountId", a."accountNumber", s.name AS symbol, d.side::text AS side,
             CASE WHEN d."voidedAt" IS NULL THEN 'FILLED' ELSE 'VOIDED' END AS status,
             d."positionId", d.entry::text AS entry, (p."deletedAt" IS NOT NULL) AS deleted
      FROM "Deal" d JOIN "Account" a ON a.id = d."accountId" JOIN "Symbol" s ON s.id = d."symbolId"
      LEFT JOIN "Position" p ON p.id = d."positionId"
      WHERE d."brokerId" = ${brokerId} AND d.ticket::text LIKE ${prefix}
      ORDER BY (d.ticket::text = ${digits}) DESC, d.ticket DESC LIMIT ${PER_TYPE}`),
  ]);
  const hit = (type: TicketHit["type"]) => (r: Row): TicketHit => ({
    type,
    id: r.id,
    ticket: Number(r.ticket),
    exact: String(r.ticket) === digits,
    accountId: r.accountId,
    accountNumber: r.accountNumber,
    symbol: r.symbol,
    side: r.side,
    status: r.status,
    positionId: r.positionId,
    entry: r.entry,
    deleted: r.deleted,
  });
  return rankTickets([...positions.map(hit("position")), ...orders.map(hit("order")), ...deals.map(hit("deal"))]);
}
