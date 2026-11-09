import "server-only";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Duplicate protection for the Trader's Room money forms (owner 2026-11-09: two 500 USD deposits from repeated clicks).
//
// withRequestKey: every Deposit / Withdraw / Transfer form load sends one key. The first POST claims the RoomRequestKey
// row (unique per client + key, so the database decides between parallel POSTs). A repeat with the same key gets the
// first answer back, marked duplicate, and creates nothing. A failed first attempt frees the key, so the client can
// correct the form and send again.
//
// withTwinGuard: the same claim on a key made of the request itself (account, type, amount, method), valid for 60 s, so a
// second form (a new key) sending the same request within 60 s, even in parallel, gets the first answer. No database
// connection is held while waiting: the unique row is the lock (a held lock transaction plus a second connection for the
// create starves a small pool, the serverless one has a single connection).

export const REQUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/;
export const TWIN_SECONDS = 60;
const WAIT_MS = 10_000;
const STEP_MS = 120;
// an unanswered claim older than this is a crashed attempt: free to take
const STALE_MS = 60_000;

export type RequestKind = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER" | "TOPUP";

export async function withRequestKey(clientId: string, kind: RequestKind, key: unknown, run: () => Promise<NextResponse>): Promise<NextResponse> {
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) {
    return NextResponse.json({ error: "Reload the page and try again." }, { status: 400 });
  }
  return claim(clientId, kind, `form:${key}`, null, run);
}

/** One request per (account, type, amount, method) within 60 s: a twin gets the first one's answer. */
export async function withTwinGuard(clientId: string, kind: RequestKind, parts: (string | number)[], run: () => Promise<NextResponse>): Promise<NextResponse> {
  return claim(clientId, kind, `twin:${parts.join(":")}`, TWIN_SECONDS * 1000, run);
}

async function claim(clientId: string, kind: RequestKind, key: string, ttlMs: number | null, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    let claimed = false;
    try {
      await prisma.roomRequestKey.create({ data: { clientId, key, kind } });
      claimed = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
    if (claimed) return runClaimed(clientId, key, run);

    // someone holds the key: its answer, or wait for it
    const row = await prisma.roomRequestKey.findUnique({ where: { clientId_key: { clientId, key } }, select: { id: true, kind: true, status: true, response: true, createdAt: true } });
    if (!row) continue; // the first attempt failed and freed the key: claim it
    const age = Date.now() - row.createdAt.getTime();
    const expired = ttlMs != null && row.status != null && age > ttlMs;
    if (expired || (row.status == null && age > STALE_MS)) {
      await prisma.roomRequestKey.deleteMany({ where: { id: row.id, createdAt: row.createdAt } });
      continue;
    }
    if (row.kind !== kind) return NextResponse.json({ error: "Reload the page and try again." }, { status: 409 });
    if (row.status != null) return NextResponse.json({ ...(row.response as Record<string, unknown>), duplicate: true }, { status: 200 });
    if (Date.now() > deadline) return NextResponse.json({ error: "This request is already being sent." }, { status: 409 });
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
}

async function runClaimed(clientId: string, key: string, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const free = () => prisma.roomRequestKey.deleteMany({ where: { clientId, key, status: null } });
  let res: NextResponse;
  try {
    res = await run();
  } catch (e) {
    await free().catch(() => {});
    throw e;
  }
  if (res.status >= 200 && res.status < 300) {
    const body = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
    // a twin's answer stored under a form key stays the twin's answer (without the duplicate mark doubled up)
    const { duplicate: _d, ...stored } = body;
    void _d;
    await prisma.roomRequestKey.update({ where: { clientId_key: { clientId, key } }, data: { status: res.status, response: stored as Prisma.InputJsonValue } });
  } else {
    await free();
  }
  return res;
}

/**
 * A short per-client lock (a RoomRequestKey row named lock:<name>, deleted when done): one "check, then create" at a time,
 * e.g. the 5-minute deposit rule, so two parallel deposits both see the first one. No connection is held while waiting.
 */
export async function withClientLock<T>(clientId: string, name: string, run: () => Promise<T>): Promise<T> {
  const key = `lock:${name}`;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      await prisma.roomRequestKey.create({ data: { clientId, key, kind: "LOCK" } });
      break;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
    const row = await prisma.roomRequestKey.findUnique({ where: { clientId_key: { clientId, key } }, select: { id: true, createdAt: true } });
    if (row && Date.now() - row.createdAt.getTime() > STALE_MS) await prisma.roomRequestKey.deleteMany({ where: { id: row.id, createdAt: row.createdAt } });
    else if (Date.now() > deadline) throw new Error("client lock wait timed out");
    else await new Promise((r) => setTimeout(r, STEP_MS));
  }
  try {
    return await run();
  } finally {
    await prisma.roomRequestKey.deleteMany({ where: { clientId, key } }).catch(() => {});
  }
}

export const twinSince = () => new Date(Date.now() - TWIN_SECONDS * 1000);
/** Amount as the twin key sees it: 500, 500.0 and 500.00 are one request. */
export const twinAmount = (d: Prisma.Decimal) => d.toFixed(2);
