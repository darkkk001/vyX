# Deep backfill — repair ALL stored candle history from Pepperstone (VPS runbook)

Branch `fix/deep-backfill-full-history` (on top of `b0d3967`). Everything below
runs **on the Contabo box** (`C:\vyxtrader\repo`, engine service
`vyxtrader-engine`, market store Postgres 16 at `127.0.0.1:5432/market_data`,
Pepperstone MT5 in `C:\MT5-Pepperstone`, UTC+3) unless a step says otherwise.
§7 is the same engine-side sequence over WinRM for a session that has
credentials.

## 0. What is wrong and what this does

Until `b0d3967` (2026-09-18) every bar the engine built from ticks was a
~1 Hz point sample of flush-window opens: `db::upsert_candles_batch` bound the
window's **open** as open, high, low *and* close, and the window was bucketed
by its **last** tick. Stored high/low are understated and close is wrong for
every bar the EA's own backfill never overwrote — and the EA's deep pass only
reaches ~1 day on M1, ~5 on M5, ~15 on M15 (`HistoryBackfillBarCounts[]`),
the shallow 5-minute pass even less. On top of that, pre-v1.39 EA passes with
a straddled `TimeTradeServer()-TimeGMT()` wrote **phantom rows at hh:mm:01**
beside the real buckets (real broker OHLC, wrong key), which no overwrite
ever touches.

The store has been fed since **2026-08-12** (052de3a, first EA build), so
"all history" is ~5.5 weeks of M1 per symbol (~36k bars) plus every higher
timeframe. This runbook:

1. deploys the engine build that (a) rejects off-grid bars, (b) **deletes the
   phantom rows at boot** (`retention::sweep_offgrid_candles`, idempotent,
   logs the counts) and nightly;
2. runs EA **v1.40**'s new **full-history deep pass**: every symbol x
   timeframe paged backwards from now in `HistoryBackfillBarCounts[]`-sized
   `CopyRates` chunks (1500 M1..M30, 750 H1, 200 H4..MN1) until
   `DeepBackfillFromDate` or the broker's oldest bar, one request per timer
   step with `DeepBackfillFullSpacingMs` between them, through the existing
   `/internal/history` authoritative overwrite — so afterwards every bucket
   from that date holds Pepperstone's own OHLC;
3. proves it with `scripts/candle-integrity-report.mjs` before and after.

Nothing here touches Neon or the trade DB. `MARKET_DATA_WRITE=local` has been
in force since 2026-09-15, so the VPS store is the only candle store written.

## 1. Before numbers (5 min)

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
cd C:\vyxtrader\repo
git fetch --all
git checkout fix/deep-backfill-full-history      # or main once merged
git log --oneline -1                              # note the hash

# engine-role URL exactly as in C:\vyxtrader\scripts\start-engine.cmd's MARKET_DATA_DATABASE_URL
$env:MARKET_DATA_DATABASE_URL = "postgres://engine:<engine role password>@127.0.0.1:5432/market_data"
mkdir C:\vyxtrader\backup\deep-backfill -Force | Out-Null

# integrity report per symbol (plain node; `pg` comes from services\api-gateway\node_modules)
foreach ($s in "XAUUSD","EURUSD","GBPUSD") {   # every symbol in Market Watch that matters
  node scripts\candle-integrity-report.mjs $s --days=45 | Tee-Object C:\vyxtrader\backup\deep-backfill\before-$s.txt
}
# phantom-row preview only (the two SELECTs; do NOT run the whole file yet -- step 3 does)
psql "$env:MARKET_DATA_DATABASE_URL" -c "SET TIME ZONE 'UTC'; SELECT timeframe, count(*) AS off_grid_rows, min(\"bucketStart\"), max(\"bucketStart\") FROM \"Candle\" WHERE (EXTRACT(EPOCH FROM \"bucketStart\")*1000)::bigint % (CASE timeframe WHEN 'M1' THEN 60000 WHEN 'M5' THEN 300000 WHEN 'M15' THEN 900000 WHEN 'M30' THEN 1800000 WHEN 'H1' THEN 3600000 ELSE 60000 END) <> 0 GROUP BY 1 ORDER BY 1;" | Tee-Object C:\vyxtrader\backup\deep-backfill\before-offgrid.txt
```

What the report columns mean is in the script header. On the *before* run
expect: `unalgn` > 0 on M1 (and possibly M5..H1) for the days the old EA
straddled; `vsM1:wider` > 0 on M5..D1 for days older than the M1 backfill
reach (the higher timeframe already holds the broker bar, M1 still holds the
point sample); `avg_range` on M1 visibly lower for older days than for the
last day.

Also back up the store (seconds, a few hundred MB):

```powershell
pg_dump -U postgres -h 127.0.0.1 -Fc market_data > C:\vyxtrader\backup\deep-backfill\market_data-pre.dump
```

## 2. Engine build + restart (10 min, ~5 s of feed downtime)

nssm runs the release exe in place (`start-engine.cmd` -> `engine\target\release\trading-core-server.exe`,
same as `deploy\contabo-deploy.ps1`), so keep the running one before the
build overwrites it:

```powershell
cd C:\vyxtrader\repo\engine
Copy-Item .\target\release\trading-core-server.exe C:\vyxtrader\backup\deep-backfill\trading-core-server.pre.exe
cargo build --release -p server            # ends with "Finished `release` profile"
nssm restart vyxtrader-engine
Start-Sleep 5
$H = @{ "x-internal-secret" = "<INTERNAL_SERVICE_SECRET from start-engine.cmd>" }
(Invoke-RestMethod http://127.0.0.1:8081/internal/feed-stats -Headers $H) | Select-Object market_data_write, market_data_reader, local_db_ok, local_db_fail, ticks_in
```

Then read the engine's stdout log (`nssm get vyxtrader-engine AppStdout` tells
you the path) for these lines, which appear within seconds of boot:

```
off-grid candle sweep: phantom rows found, deleting in batches   timeframe=M1 off_grid_rows=NNN
off-grid candle sweep: timeframe done                            timeframe=M1 rows_deleted=NNN
off-grid candle sweep complete   sink=local phantom_rows_deleted=NNN per_timeframe=[("M1", NNN), ...]
```

`phantom_rows_deleted` must equal the total of step 1's preview. On every
later boot it reads `0` (the sweep is one `count(*)` per timeframe and no
DELETE when clean).

Rollback: stop the service, copy `trading-core-server.pre.exe` back over the
release exe, `nssm start vyxtrader-engine`.

## 3. Off-grid cleanup — verify (or run by hand)

The boot sweep in step 2 already did it. Verify with the file's own SELECT
(its DELETE is a no-op on a clean store, so running the whole file is safe;
it prints the per-timeframe counts and a final "remaining" query that must
return no rows):

```powershell
psql "$env:MARKET_DATA_DATABASE_URL" -f C:\vyxtrader\repo\deploy\market-data-offgrid-cleanup.sql | Tee-Object C:\vyxtrader\backup\deep-backfill\offgrid-cleanup.txt
```

If for any reason the new engine is *not* running yet (e.g. you only want the
data repaired), this file alone is the cleanup: preview, transactional
DELETE, verify.

## 4. EA v1.40 — full-history pass (the one action; hours of background requests)

On the Pepperstone terminal (`C:\MT5-Pepperstone`, portable mode; RDP —
MetaEditor and the Inputs dialog have no CLI):

1. Copy `C:\vyxtrader\repo\mt5-ea\VyXTraderPriceFeed.mq5` over
   `C:\MT5-Pepperstone\MQL5\Experts\VyXTraderPriceFeed.mq5`.
2. MetaEditor: open it, **F7**. The log must end `0 errors, 0 warnings`
   (v1.40 compiles 0 errors / 0 warnings headlessly, see below). A headless
   alternative that works from any PowerShell on the box:
   `& "C:\MT5-Pepperstone\metaeditor64.exe" /compile:"C:\MT5-Pepperstone\MQL5\Experts\VyXTraderPriceFeed.mq5" /log:"C:\vyxtrader\backup\deep-backfill\ea-compile.log"`
   then `Get-Content ... -Encoding Unicode | Select-String Result`.
3. Check **Tools > Options > Charts > Max bars in chart**: `Unlimited` or at
   least `100000`. `CopyRates` cannot page past this limit; the EA logs
   `terminal max bars per chart = N` and appends `-- TOO LOW` if it is below
   the M1 span.
4. On the chart that runs the EA: **right-click > Expert list > (the EA) >
   Properties > Inputs**. The recompile already reinitialised it (which runs
   the ordinary shallow pass); now set:

   | Input | Value | Why |
   |---|---|---|
   | `ForceDeepBackfill` | `true` | the deep pass runs again although the done-flag global variable is set |
   | `DeepBackfillFullHistory` | `true` | *with* the line above: page every timeframe back to the date instead of one request each |
   | `DeepBackfillFromDate` | `2026.08.12 00:00` (default, UTC) | store inception. M1 older than 30 days is trimmed by the nightly retention anyway, so `2026.08.19` saves ~13% of the M1 requests if you prefer |
   | `DeepBackfillFullSpacingMs` | `5000` on a weekday, `500` on a weekend | idle floor between page requests; each request freezes the tick push for its own duration (see §4.1) |

   Leave every other input exactly as it is (`UseDirectMode=true`,
   `DirectServerUrl`, `ApiSecret`, symbol source). **OK** reinitialises the
   EA and starts the pass.

5. Watch the **Experts** tab (or `C:\MT5-Pepperstone\MQL5\Logs\<yyyymmdd>.log`).
   Expected lines, in order:

   ```
   VyXTraderPriceFeed (history backfill): FULL-HISTORY deep pass from 2026.08.12 00:00 UTC (5.3 weeks): 12 symbols x 9 timeframes, ~26 M1 pages of 1500 bars per symbol, 5000ms between pages; terminal max bars per chart = 100000
   VyXTraderPriceFeed (history backfill): XAUUSD M1 page 0 (pos 0) 1500 bars in 1834ms, oldest 2026.09.17 08:12 UTC
   VyXTraderPriceFeed (history backfill): XAUUSD M1 page 1 (pos 1500) 1500 bars in 1790ms, oldest 2026.09.16 07:10 UTC
   ...
   VyXTraderPriceFeed (history backfill): XAUUSD M1 page 25 (pos 37500) 412 bars in 610ms, oldest 2026.08.11 23:00 UTC
   VyXTraderPriceFeed (history backfill): XAUUSD M1 full history done -- 26 pages, 37912 bars, oldest 2026.08.11 23:00 UTC (reached DeepBackfillFromDate)
   VyXTraderPriceFeed (history backfill): XAUUSD M5 page 0 (pos 0) 1500 bars in ...
   ...
   VyXTraderPriceFeed (history backfill): XAUUSD MN1 full history done -- 1 pages, 200 bars, oldest 2009.12.31 21:00 UTC (broker has no older bars)
   ... (next symbol) ...
   VyXTraderPriceFeed (history backfill): FULL-HISTORY deep pass complete in 4212.3s -- 468 requests (0 failed), 611240 bars sent, from 2026.08.12 00:00 UTC
   VyXTraderPriceFeed (history backfill): ForceDeepBackfill is still true -- set it (and DeepBackfillFullHistory) back to false in the Inputs tab, or the next reinit runs this whole pass again
   ```

   `page N short (terminal still loading history) -- retry k/5` is normal
   for a timeframe the terminal had not loaded that deep yet (CopyRates
   starts the download and the retry a few seconds later gets the page).
   `gave up after 5 retries` means that symbol x timeframe's older history
   was not sent — rerun the pass later for it (the pass is idempotent).

   Engine side, `/internal/feed-stats` keeps serving during the pass; the
   engine's log shows one `history bars off the timeframe grid -- skipped`
   warning **only** if the terminal's offset is still not whole-minute
   (it cannot be on v1.39+).

6. When `FULL-HISTORY deep pass complete` has logged: Properties > Inputs
   again, set `ForceDeepBackfill=false` and `DeepBackfillFullHistory=false`,
   OK. (MQL5 cannot reset an input from code; left true, every later reinit
   — any properties tweak, a terminal restart — would repeat the hours-long
   pass.) The global variables `VyXTraderPriceFeed_DeepBackfillDone = 1`
   and `VyXTraderPriceFeed_DeepBackfillFullDoneUtc = <epoch>` (Tools >
   Global Variables, F3) record that and when it completed.

### 4.1 Expected duration

Per symbol, from 2026-08-12: ~26 M1 pages + 5 M5 + 2 M15 + 1 M30 + 1 H1 +
2 H4 + 1 D1 + 1 W1 + 1 MN1 = **~40 requests**. Per request the Experts log
prints the real duration; the historic measurement was 3–6 s per 500 bars
*against Neon with per-row upserts*, the batched upsert against the local
store is expected at 1–3 s per 1500-bar page. So per symbol:

| spacing | 1500-bar page ≈ 2 s | ≈ 10 s (worst measured) |
|---|---|---|
| 5000 ms (weekday) | 40 × 7 s ≈ **5 min** | 40 × 15 s ≈ 10 min |
| 500 ms (weekend) | 40 × 2.5 s ≈ **1.7 min** | 40 × 10.5 s ≈ 7 min |

Multiply by the Market Watch symbol count (the first log line prints it):
12 symbols ≈ **1–2 h** on a weekday, ~20–80 min on a weekend; 30 symbols
≈ 2.5–5 h / 1–3.5 h. Extrapolate from the first symbol's `full history done`
line for MN1: that is 1/N of the total. During a weekday pass the live tick
push is paused for each request's duration (MQL5 has one thread per EA),
i.e. roughly 30–60% of the time at 5 s spacing — charts still move, with
hiccups; the engine's gap-fill and the pass itself make every bucket whole.
**Prefer a weekend.**

## 5. After numbers + confirming history matches Pepperstone

```powershell
cd C:\vyxtrader\repo
foreach ($s in "XAUUSD","EURUSD","GBPUSD") {
  node scripts\candle-integrity-report.mjs $s --days=45 | Tee-Object C:\vyxtrader\backup\deep-backfill\after-$s.txt
}
psql "$env:MARKET_DATA_DATABASE_URL" -f deploy\market-data-offgrid-cleanup.sql | Select-String "remaining" -Context 0,3
```

Compare `before-*.txt` with `after-*.txt`:

* `unalgn` = **0** on every timeframe and day (step 2/3 did this);
* `vsM1:wider` and `narrower` = **0** on every day since the from-date
  (every timeframe now comes from the same broker bars);
* M1 `avg_range` **up** on every tick-built day (it was a point sample);
  `o=h|l` down; `flat` only where the market was genuinely closed;
* M1/M5 `bars` per weekday ≈ 1380–1440 / 276–288 (gaps the store never had
  are now filled from the broker).

Spot-check three bars against the terminal itself (Pepperstone's chart is
broker time = UTC+3, the store is UTC):

```powershell
psql "$env:MARKET_DATA_DATABASE_URL" -c "SET TIME ZONE 'UTC'; SELECT \"bucketStart\", open, high, low, close FROM \"Candle\" WHERE symbol='XAUUSD' AND timeframe='M1' AND \"bucketStart\" IN ('2026-08-20 09:00+00','2026-09-01 14:30+00','2026-09-15 07:05+00') ORDER BY 1;"
```

In MT5: XAUUSD M1 chart, **Ctrl+D** (Data Window), hover the bar at
**12:00, 17:30 and 10:05 broker time** on those dates (UTC + 3 h). Open /
High / Low / Close must match to the 5th decimal (the store rounds to
`%.5f`, MT5 shows the symbol's digits). Do the same for one H1 and one D1
bar (D1 buckets start 21:00 UTC = 00:00 broker).

Same check from the web side, without psql:
`GET https://feed.vyxtrader.com/internal/candles?symbol=XAUUSD&tf=M1&limit=...`
with header `X-Market-Data-Secret: <MARKET_DATA_READ_SECRET>` (the value Vercel
holds; `/internal/candles` is the one read route Caddy proxies) — the JSON
must show the same OHLC.

## 6. Rollback

* Engine: §2's rollback (old exe back, restart). The sweep's deletes are
  intentional and are not undone by that — restore
  `market_data-pre.dump` with `pg_restore -U postgres -h 127.0.0.1 -d market_data --clean --if-exists` only if you truly want the phantoms back.
* EA: the previous `.mq5` is in git history (`git show b0d3967:mt5-ea/VyXTraderPriceFeed.mq5`);
  v1.40 with both new inputs `false` behaves exactly as v1.39.
* Data written by the pass is the broker's own bars — there is nothing to
  roll back; re-running the pass is idempotent.

## 7. WinRM variant (engine-side steps from a workstation with credentials)

The VPS exposes WinRM over HTTPS (5986). Everything except §4's Inputs
dialog (GUI only) runs remotely:

```powershell
$opt = New-PSSessionOption -SkipCACheck -SkipCNCheck
$s = New-PSSession -ComputerName <vps-ip-or-host> -Port 5986 -UseSSL -Credential (Get-Credential) -SessionOption $opt

Invoke-Command -Session $s -ScriptBlock {
  $env:Path += ";C:\Program Files\PostgreSQL\16\bin;C:\Users\<user>\.cargo\bin"
  $env:MARKET_DATA_DATABASE_URL = "postgres://engine:<pw>@127.0.0.1:5432/market_data"
  mkdir C:\vyxtrader\backup\deep-backfill -Force | Out-Null
  cd C:\vyxtrader\repo; git fetch --all; git checkout fix/deep-backfill-full-history; git log --oneline -1
  foreach ($sym in "XAUUSD","EURUSD") { node scripts\candle-integrity-report.mjs $sym --days=45 > "C:\vyxtrader\backup\deep-backfill\before-$sym.txt" }
  pg_dump -U postgres -h 127.0.0.1 -Fc market_data > C:\vyxtrader\backup\deep-backfill\market_data-pre.dump   # needs PGPASSWORD
  Copy-Item engine\target\release\trading-core-server.exe C:\vyxtrader\backup\deep-backfill\trading-core-server.pre.exe
  cd engine; cargo build --release -p server 2>&1 | Select-Object -Last 2
  nssm restart vyxtrader-engine; Start-Sleep 8
  Invoke-RestMethod http://127.0.0.1:8081/internal/feed-stats -Headers @{ "x-internal-secret" = "<secret>" } | Select-Object market_data_write, local_db_ok, local_db_fail, ticks_in
  psql $env:MARKET_DATA_DATABASE_URL -f C:\vyxtrader\repo\deploy\market-data-offgrid-cleanup.sql
  # EA: copy + headless compile (MetaEditor's /compile needs no window; if it hangs under WinRM, do this one via RDP)
  Copy-Item C:\vyxtrader\repo\mt5-ea\VyXTraderPriceFeed.mq5 C:\MT5-Pepperstone\MQL5\Experts\VyXTraderPriceFeed.mq5 -Force
  Start-Process "C:\MT5-Pepperstone\metaeditor64.exe" -ArgumentList '/compile:"C:\MT5-Pepperstone\MQL5\Experts\VyXTraderPriceFeed.mq5"','/log:"C:\vyxtrader\backup\deep-backfill\ea-compile.log"' -Wait
  Get-Content C:\vyxtrader\backup\deep-backfill\ea-compile.log -Encoding Unicode | Select-String Result
}
```

The terminal picks up the recompiled `.ex5` and reinitialises the EA on its
own (shallow pass). §4 step 4 (setting the four inputs) and step 6 (resetting
them) still need the RDP session; progress can be tailed remotely:

```powershell
Invoke-Command -Session $s { Get-Content "C:\MT5-Pepperstone\MQL5\Logs\$(Get-Date -Format yyyyMMdd).log" -Tail 20 | Select-String "history backfill" }
```

and the after-report + spot-check queries of §5 run in the same session.
