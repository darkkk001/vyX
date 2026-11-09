// Volume-only backfill (owner 2026-11-09). Fills "Candle"."tickVolume" from an MT5 export ONLY on bars whose stored tickVolume is 0.
// It never writes open / high / low / close, never inserts a bar and never deletes one: the only write is
//   UPDATE "Candle" SET "tickVolume" = v WHERE symbol = s AND timeframe = tf AND "bucketStart" = t AND "tickVolume" = 0
// and every symbol x timeframe runs in its own transaction that checks the OHLC checksum and the row count before and after
// (any difference rolls the transaction back). Dry run by default. Plan: C:\vyx\handoff\volume-backfill-plan-2026-11-09.md.
import { Prisma, PrismaClient } from "@prisma/client";

export type Mt5Row = { symbol: string; timeframe: string; bucket: Date; volume: number };
export type GapRun = { symbol: string; timeframe: string; from: Date; to: Date; bars: number };
export type Counts = { symbol: string; timeframe: string; scale: number | null; wouldUpdate: number; skippedNonZero: number; droppedNoBar: number; droppedNoScale: number; updated: number };

export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
/** Fewest overlapping bars (stored count > 0 and MT5 > 0) a symbol needs before its scale is trusted. */
export const MIN_SCALE_SAMPLES = 30;

/** US daylight time (second Sunday of March 02:00 New York .. first Sunday of November 02:00 New York), as a UTC instant test. */
export function usDst(utc: Date): boolean {
  const y = utc.getUTCFullYear();
  const nthSunday = (month: number, n: number) => { const d = new Date(Date.UTC(y, month, 1)); const first = (7 - d.getUTCDay()) % 7; return 1 + first + 7 * (n - 1); };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6); // 02:00 EDT = 06:00 UTC
  const t = utc.getTime();
  return t >= start && t < end;
}

/** An NY-close MT5 server (GMT+3 in US daylight time, GMT+2 otherwise): server wall time -> UTC. `fixedOffsetHours` overrides. */
export function serverToUtc(serverWall: Date, fixedOffsetHours?: number): Date {
  if (fixedOffsetHours !== undefined) return new Date(serverWall.getTime() - fixedOffsetHours * 3600_000);
  const guess = new Date(serverWall.getTime() - 2 * 3600_000);
  const off = usDst(new Date(serverWall.getTime() - 3 * 3600_000)) || usDst(guess) ? 3 : 2;
  return new Date(serverWall.getTime() - off * 3600_000);
}

/** CSV from mt5-ea/VolumeExport.mq5: symbol,timeframe,server_time (YYYY.MM.DD HH:MM),tick_volume. Bad lines are counted, never guessed. */
export function parseCsv(text: string, fixedOffsetHours?: number): { rows: Mt5Row[]; bad: number } {
  const rows: Mt5Row[] = []; let bad = 0;
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [symbol, timeframe, server, vol] = line.split(",").map((s) => s.trim());
    const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/.exec(server ?? "");
    const v = Number(vol);
    if (!symbol || !(TIMEFRAMES as readonly string[]).includes(timeframe) || !m || !Number.isFinite(v) || v < 0) { bad++; continue; }
    const wall = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    rows.push({ symbol: symbol.toUpperCase(), timeframe, bucket: serverToUtc(wall, fixedOffsetHours), volume: Math.round(v) });
  }
  return { rows, bad };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b); const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Read-only: every run of consecutive bars with tickVolume = 0, per symbol x timeframe, plus the zero / non-zero totals. */
export async function measureGaps(db: PrismaClient, symbol?: string): Promise<{ runs: GapRun[]; totals: { symbol: string; timeframe: string; zero: number; nonZero: number }[] }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const where = symbol ? Prisma.sql`WHERE symbol = ${symbol}` : Prisma.empty;
    const runs = await tx.$queryRaw<{ symbol: string; timeframe: string; from: Date; to: Date; bars: bigint }[]>`
      WITH x AS (
        SELECT symbol, timeframe::text AS timeframe, "bucketStart" AS b, ("tickVolume" = 0) AS z,
               row_number() OVER (PARTITION BY symbol, timeframe ORDER BY "bucketStart")
             - row_number() OVER (PARTITION BY symbol, timeframe, ("tickVolume" = 0) ORDER BY "bucketStart") AS g
        FROM "Candle" ${where})
      SELECT symbol, timeframe, min(b) AS "from", max(b) AS "to", count(*) AS bars FROM x WHERE z
      GROUP BY symbol, timeframe, g ORDER BY symbol, timeframe, min(b)`;
    const totals = await tx.$queryRaw<{ symbol: string; timeframe: string; zero: bigint; nonZero: bigint }[]>`
      SELECT symbol, timeframe::text AS timeframe, count(*) FILTER (WHERE "tickVolume" = 0) AS zero, count(*) FILTER (WHERE "tickVolume" <> 0) AS "nonZero"
      FROM "Candle" ${where} GROUP BY symbol, timeframe ORDER BY symbol, timeframe`;
    return {
      runs: runs.map((r) => ({ ...r, bars: Number(r.bars) })),
      totals: totals.map((t) => ({ ...t, zero: Number(t.zero), nonZero: Number(t.nonZero) })),
    };
  });
}

type Stored = Map<number, number>; // bucket ms -> stored tickVolume
async function storedFor(tx: Prisma.TransactionClient, symbol: string, timeframe: string, buckets: Date[]): Promise<Stored> {
  const got = await tx.$queryRaw<{ b: Date; v: bigint }[]>`
    SELECT "bucketStart" AS b, "tickVolume"::bigint AS v FROM "Candle"
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}::"CandleTimeframe" AND "bucketStart" = ANY(${buckets}::timestamptz[])`;
  return new Map(got.map((r) => [r.b.getTime(), Number(r.v)]));
}
async function ohlcChecksum(tx: Prisma.TransactionClient, symbol: string, timeframe: string) {
  const [r] = await tx.$queryRaw<{ n: bigint; h: string | null }[]>`
    SELECT count(*) AS n, md5(string_agg(concat_ws('|', "bucketStart", open, high, low, close), ',' ORDER BY "bucketStart")) AS h
    FROM "Candle" WHERE symbol = ${symbol} AND timeframe = ${timeframe}::"CandleTimeframe"`;
  return `${r.n}:${r.h ?? ""}`;
}

/** Per symbol: the median of stored / MT5 over bars where both are > 0 (all timeframes pooled); null below MIN_SCALE_SAMPLES. */
export async function scales(db: PrismaClient, rows: Mt5Row[]): Promise<Map<string, { scale: number | null; samples: number }>> {
  const ratios = new Map<string, number[]>();
  const groups = groupBy(rows);
  for (const [k, list] of groups) {
    const [symbol, timeframe] = k.split("|");
    const stored = await db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); return storedFor(tx, symbol, timeframe, list.map((r) => r.bucket)); });
    for (const r of list) { const s = stored.get(r.bucket.getTime()); if (s && s > 0 && r.volume > 0) (ratios.get(symbol) ?? ratios.set(symbol, []).get(symbol)!).push(s / r.volume); }
  }
  const out = new Map<string, { scale: number | null; samples: number }>();
  for (const sym of new Set(rows.map((r) => r.symbol))) { const xs = ratios.get(sym) ?? []; out.set(sym, { scale: xs.length >= MIN_SCALE_SAMPLES ? median(xs) : null, samples: xs.length }); }
  return out;
}

function groupBy(rows: Mt5Row[]) {
  const g = new Map<string, Mt5Row[]>();
  for (const r of rows) { const k = `${r.symbol}|${r.timeframe}`; (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
  return g;
}

export class OhlcChangedError extends Error {}

/** Dry run (apply = false, the default) or apply: per symbol x timeframe, counts what would be / was updated, skipped (stored count already
 *  non-zero) and dropped (no stored bar with that key, or no trusted scale for the symbol). Apply checks OHLC + row count before and after. */
export async function run(db: PrismaClient, rows: Mt5Row[], opts: { apply?: boolean; scaleBySymbol?: Map<string, { scale: number | null }> } = {}): Promise<Counts[]> {
  const apply = opts.apply === true;
  const sc = opts.scaleBySymbol ?? (await scales(db, rows));
  const out: Counts[] = [];
  for (const [k, list] of groupBy(rows)) {
    const [symbol, timeframe] = k.split("|");
    const scale = sc.get(symbol)?.scale ?? null;
    const c: Counts = { symbol, timeframe, scale, wouldUpdate: 0, skippedNonZero: 0, droppedNoBar: 0, droppedNoScale: 0, updated: 0 };
    await db.$transaction(async (tx) => {
      if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const stored = await storedFor(tx, symbol, timeframe, list.map((r) => r.bucket));
      const todo: { b: Date; v: number }[] = [];
      for (const r of list) {
        const s = stored.get(r.bucket.getTime());
        if (s === undefined) { c.droppedNoBar++; continue; }
        if (s !== 0) { c.skippedNonZero++; continue; }
        if (scale === null) { c.droppedNoScale++; continue; }
        if (r.volume <= 0) { c.skippedNonZero++; continue; }   // MT5 itself has no volume for the bar: nothing to write
        todo.push({ b: r.bucket, v: Math.max(1, Math.round(r.volume * scale)) });
      }
      c.wouldUpdate = todo.length;
      if (!apply || todo.length === 0) return;
      const before = await ohlcChecksum(tx, symbol, timeframe);
      const n = await tx.$executeRaw`
        UPDATE "Candle" AS c SET "tickVolume" = u.v
        FROM UNNEST(${todo.map((t) => t.b)}::timestamptz[], ${todo.map((t) => String(t.v))}::bigint[]) AS u(b, v)
        WHERE c.symbol = ${symbol} AND c.timeframe = ${timeframe}::"CandleTimeframe" AND c."bucketStart" = u.b AND c."tickVolume" = 0`;
      const after = await ohlcChecksum(tx, symbol, timeframe);
      if (after !== before) throw new OhlcChangedError(`${symbol} ${timeframe}: OHLC or row count changed (${before} -> ${after}); rolled back`);
      c.updated = n;
    }, { timeout: 120_000 });
    out.push(c);
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || TIMEFRAMES.indexOf(a.timeframe as never) - TIMEFRAMES.indexOf(b.timeframe as never));
}
