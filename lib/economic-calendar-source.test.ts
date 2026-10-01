import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getEconomicCalendar, resetCalendarSourceForTests } from "./economic-calendar-source";

// web6 (owner 2026-10-01, issue 18: the calendar sat on "LOADING..." and then showed "0 EVENTS" while events existed).
// The ForexFactory fetch now times out and serves the last good week; an empty or non-array upstream body never
// replaces a good cache; a failed refresh backs off instead of making every reader wait again.
let ready = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    ready = true;
  } catch {
    console.warn("economic-calendar-source.test.ts: DB unreachable, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  resetCalendarSourceForTests(150);
  if (ready) await prisma.economicCalendarCache.deleteMany({});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ff = (title: string, date: string, impact = "High") => ({ title, country: "USD", date, impact, forecast: "1%", previous: "2%" });
const GOOD = [ff("Old Week Event", "2026-10-01T08:30:00-04:00"), ff("Another", "2026-10-02T08:30:00-04:00", "Low")];
async function seedCache(events: unknown[], ageMs: number) {
  await prisma.economicCalendarCache.create({ data: { id: "forexfactory", events: events as object, fetchedAt: new Date(Date.now() - ageMs) } });
}
const cachedTitles = async () => ((await prisma.economicCalendarCache.findUnique({ where: { id: "forexfactory" } }))?.events as { event: string }[] | undefined)?.map((e) => e.event);
function stubFetch(answer: () => Promise<Response>) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      answer().then(resolve, reject);
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const STALE = 2 * 60 * 60_000;
const CACHED_EVENTS = [{ time: "2026-10-01T12:30:00.000Z", country: "USD", event: "Cached Event", impact: "high", actual: null, estimate: null, previous: null }];

describe("getEconomicCalendar (web6)", () => {
  it("a hanging upstream times out and the stale week is served (never a hang, never an empty list)", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, STALE);
    stubFetch(() => new Promise<Response>(() => {}));
    const t = Date.now();
    const r = await getEconomicCalendar();
    expect({ source: r.source, titles: r.events.map((e) => e.event), fast: Date.now() - t < 5_000 }).toEqual({ source: "forexfactory-stale", titles: ["Cached Event"], fast: true });
  });

  it("an empty upstream week never replaces a good cache", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, STALE);
    stubFetch(json([]));
    const r = await getEconomicCalendar();
    expect({ source: r.source, n: r.events.length, cache: await cachedTitles() }).toEqual({ source: "forexfactory-stale", n: 1, cache: ["Cached Event"] });
  });

  it("a non-array upstream body (an HTML / error object) never replaces a good cache", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, STALE);
    stubFetch(json({ error: "rate limited" }));
    const r = await getEconomicCalendar();
    expect({ source: r.source, cache: await cachedTitles() }).toEqual({ source: "forexfactory-stale", cache: ["Cached Event"] });
  });

  it("after a failed refresh the next reader gets the stale week at once (no second upstream wait)", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, STALE);
    const fn = stubFetch(async () => new Response("down", { status: 503 }));
    await getEconomicCalendar();
    await getEconomicCalendar();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a good week replaces the cache and its high-impact events are recorded (holidays dropped)", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, STALE);
    stubFetch(json([...GOOD, ff("Bank Holiday", "2026-10-02T00:00:00-04:00", "Holiday")]));
    const r = await getEconomicCalendar();
    const recorded = await prisma.economicEvent.findMany({ where: { title: "Old Week Event" } });
    expect({ source: r.source, cache: await cachedTitles(), recorded: recorded.length }).toEqual({ source: "forexfactory", cache: ["Old Week Event", "Another"], recorded: 1 });
  });

  it("a fresh cache is served without touching upstream", async () => {
    if (!ready) return;
    await seedCache(CACHED_EVENTS, 60_000);
    const fn = stubFetch(json(GOOD));
    const r = await getEconomicCalendar();
    expect({ source: r.source, calls: fn.mock.calls.length }).toEqual({ source: "forexfactory-cached", calls: 0 });
  });

  it("no cache at all and upstream down: the error surfaces (the route then tries its fallback / 503)", async () => {
    if (!ready) return;
    stubFetch(async () => new Response("down", { status: 503 }));
    await expect(getEconomicCalendar()).rejects.toThrow(/503/);
  });
});
