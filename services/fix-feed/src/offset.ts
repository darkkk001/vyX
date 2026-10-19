// broker_offset_sec for the FIX feed. The MT5 EA sends its trade server's offset from UTC (TimeTradeServer() -
// TimeGMT()); the engine uses it to put D1/W1/MN1/Y1 bucket boundaries at the broker's day start
// (market_data::bucket_start). cTrader FIX carries no server-local time at all, so the offset is derived from the
// convention MT5 FX servers use: midnight server time = 17:00 New York, i.e. New York's UTC offset + 7h
// (+3h while the US is on daylight time, +2h otherwise). That keeps daily candles identical to the MT5 feed's.

export function newYorkOffsetMinutes(atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(new Date(atMs));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return -300;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -mins : mins;
}

export function brokerOffsetSec(atMs: number = Date.now()): number {
  return (newYorkOffsetMinutes(atMs) + 7 * 60) * 60;
}
