import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { measureGaps, OhlcChangedError, parseCsv, run, scales, serverToUtc, type Mt5Row } from "./core";

// Owner 2026-11-09: the volume-only backfill writes tickVolume on bars whose stored count is 0 and nothing else. Real Postgres only
// (VOLUME_BACKFILL_TEST_URL, a scratch database: the engine's market_data schema or the web's vyx_test); never a live database.
const url = process.env.VOLUME_BACKFILL_TEST_URL ?? "";
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const db = new PrismaClient({ datasourceUrl: url || "postgresql://invalid@127.0.0.1:1/none" });
const SYM = "TESTVB" + randomUUID().slice(0, 6).toUpperCase();
const SYM2 = SYM + "B";
const H = 3600_000;
const t0 = Date.UTC(2026, 10, 2, 0, 0); // Mon 2026-11-02 00:00 UTC
const at = (i: number) => new Date(t0 + i * H);
let ok = false;

type Row = { b: Date; open: string; high: string; low: string; close: string; v: bigint };
async function snapshot(sym: string): Promise<Row[]> {
  return db.$queryRaw<Row[]>`SELECT "bucketStart" AS b, open::text, high::text, low::text, close::text, "tickVolume"::bigint AS v FROM "Candle" WHERE symbol = ${sym} ORDER BY timeframe, "bucketStart"`;
}
async function seed(sym: string, vols: number[]) {
  for (let i = 0; i < vols.length; i++) {
    const o = (4000 + i * 1.23456).toFixed(5);
    await db.$executeRaw`INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "tickVolume", "updatedAt")
      VALUES (${sym}, 'H1'::"CandleTimeframe", ${at(i)}, ${o}::numeric, ${(+o + 2.5).toFixed(5)}::numeric, ${(+o - 1.75).toFixed(5)}::numeric, ${(+o + 0.33333).toFixed(5)}::numeric, ${vols[i]}, now())`;
  }
}

beforeAll(async () => {
  if (!url || !local) { console.warn("volume-backfill core.test: no scratch VOLUME_BACKFILL_TEST_URL, skipping the DB tests"); return; }
  ok = true;
  // H1 bars 0..59: 0..19 have no volume (the gap), 20..59 carry our FIX count = 3 x the MT5 count we export below; bar 30 is also 0 (a lone hole)
  await seed(SYM, Array.from({ length: 60 }, (_, i) => (i < 20 || i === 30 ? 0 : 30 * (i + 1))));
  await seed(SYM2, Array.from({ length: 10 }, () => 0));   // a symbol with no overlap: no trusted scale
});
afterAll(async () => {
  if (ok) await db.$executeRaw`DELETE FROM "Candle" WHERE symbol IN (${SYM}, ${SYM2})`;
  await db.$disconnect();
});

const mt5 = (): Mt5Row[] => [
  ...Array.from({ length: 60 }, (_, i) => ({ symbol: SYM, timeframe: "H1", bucket: at(i), volume: 10 * (i + 1) })),
  { symbol: SYM, timeframe: "H1", bucket: at(100), volume: 77 },   // MT5 has a bar we never stored: dropped, never inserted
  ...Array.from({ length: 10 }, (_, i) => ({ symbol: SYM2, timeframe: "H1", bucket: at(i), volume: 5 })),
];

describe("server time -> UTC (NY-close MT5 server)", () => {
  it("is GMT+3 in US daylight time and GMT+2 outside it, or a fixed offset when given", () => {
    expect(serverToUtc(new Date(Date.UTC(2026, 6, 1, 0, 0))).toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(serverToUtc(new Date(Date.UTC(2026, 11, 1, 0, 0))).toISOString()).toBe("2026-11-30T22:00:00.000Z");
    expect(serverToUtc(new Date(Date.UTC(2026, 11, 1, 0, 0)), 0).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const p = parseCsv("symbol,timeframe,server_time,tick_volume\nXAUUSD,H1,2026.11.05 10:00,321\nbad,line\nXAUUSD,Y1,2026.01.01 00:00,5\n");
    expect(p.rows).toEqual([{ symbol: "XAUUSD", timeframe: "H1", bucket: new Date("2026-11-05T08:00:00Z"), volume: 321 }]);
    expect(p.bad).toBe(2);
  });
});

describe("volume-only backfill on a real database", () => {
  it("measures every zero-volume run exactly, read-only", async () => {
    if (!ok) return;
    const before = await snapshot(SYM);
    const g = await measureGaps(db, SYM);
    expect(g.runs.map((r) => [r.from.toISOString(), r.to.toISOString(), r.bars])).toEqual([[at(0).toISOString(), at(19).toISOString(), 20], [at(30).toISOString(), at(30).toISOString(), 1]]);
    expect(g.totals).toEqual([{ symbol: SYM, timeframe: "H1", zero: 21, nonZero: 39 }]);
    expect(await snapshot(SYM)).toEqual(before);
  });

  it("scales by the median stored / MT5 ratio and refuses a symbol without enough overlap", async () => {
    if (!ok) return;
    const sc = await scales(db, mt5());
    expect(sc.get(SYM)).toEqual({ scale: 3, samples: 39 });
    expect(sc.get(SYM2)).toEqual({ scale: null, samples: 0 });
  });

  it("dry run (the default) writes nothing and counts update / skip / drop", async () => {
    if (!ok) return;
    const before = [await snapshot(SYM), await snapshot(SYM2)];
    const c = await run(db, mt5());
    expect(c).toEqual([
      { symbol: SYM, timeframe: "H1", scale: 3, wouldUpdate: 21, skippedNonZero: 39, droppedNoBar: 1, droppedNoScale: 0, updated: 0 },
      { symbol: SYM2, timeframe: "H1", scale: null, wouldUpdate: 0, skippedNonZero: 0, droppedNoBar: 0, droppedNoScale: 10, updated: 0 },
    ]);
    expect([await snapshot(SYM), await snapshot(SYM2)]).toEqual(before);
  });

  it("apply fills only the zero bars; OHLC byte-identical, no row added or removed, non-zero counts untouched; a re-run does nothing", async () => {
    if (!ok) return;
    const before = await snapshot(SYM); const before2 = await snapshot(SYM2);
    const c = await run(db, mt5(), { apply: true });
    expect(c[0]).toMatchObject({ symbol: SYM, updated: 21, wouldUpdate: 21, skippedNonZero: 39, droppedNoBar: 1 });
    const after = await snapshot(SYM);
    expect(after.length).toBe(before.length);
    expect(after.map(({ b, open, high, low, close }) => ({ b, open, high, low, close }))).toEqual(before.map(({ b, open, high, low, close }) => ({ b, open, high, low, close })));
    for (let i = 0; i < 60; i++) {
      const was = before[i].v, now = after[i].v;
      if (was === BigInt(0)) expect(now).toBe(BigInt(3 * 10 * (i + 1)));   // filled, scaled to our count
      else expect(now).toBe(was);                                   // a FIX count is never touched
    }
    expect(await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Candle" WHERE symbol = ${SYM} AND "bucketStart" = ${at(100)}`).toEqual([{ n: BigInt(0) }]);
    expect(await snapshot(SYM2)).toEqual(before2);   // no scale: untouched
    const again = await run(db, mt5(), { apply: true });
    expect(again[0]).toMatchObject({ updated: 0, wouldUpdate: 0, skippedNonZero: 60 });
    expect(await snapshot(SYM)).toEqual(after);
  });

  it("if OHLC changes inside the transaction (a trigger here), the whole symbol x timeframe rolls back", async () => {
    if (!ok) return;
    const sym = SYM + "R";
    await seed(sym, Array.from({ length: 40 }, (_, i) => (i < 5 ? 0 : 20 * (i + 1))));
    const fn = "vb_test_" + randomUUID().slice(0, 8);
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.symbol = '${sym}' THEN NEW.open := NEW.open + 1; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "Candle" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const before = await snapshot(sym);
      const rows = Array.from({ length: 40 }, (_, i) => ({ symbol: sym, timeframe: "H1", bucket: at(i), volume: 10 * (i + 1) }));
      await expect(run(db, rows, { apply: true })).rejects.toBeInstanceOf(OhlcChangedError);
      expect(await snapshot(sym)).toEqual(before);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Candle"`); await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
      await db.$executeRaw`DELETE FROM "Candle" WHERE symbol = ${sym}`;
    }
  });
});
