# Neon → VPS market-data store — S2 runbook (Contabo, RDP)

Stage S2 of docs/market-data.md §8. Everything below runs **on the Contabo
box** in an elevated PowerShell unless a step says "Neon console". Nothing
here changes what the web app reads (that is S3/S4) and Neon keeps every
row until S6 — each step is reversible with the line under it.

Before you start you need two things from the **Neon console**:

* the **production** branch's Postgres **version** (Branches → production →
  the version shown next to the compute; 16 or 17) — `pg_dump` must be the
  same major or newer than the server it dumps. If Neon says **17, install
  PostgreSQL 17 below instead of 16**; the engine does not care which.
* the production branch's **direct (non-pooled) connection string** — the
  one WITHOUT `-pooler` in the host, i.e. `ep-flat-boat-b1wjz20p.c-5.eu-central-1.aws.neon.tech`
  (the branch whose `LivePrice.tickAt` advances every second; NOT
  `dev` / `ep-old-night`). Copy it as `$NEON` in step 3. `pg_dump` over the
  pooler fails on the COPY stream.

Verification after each step is what gates the next one.

---

## 1. Install PostgreSQL (once)

1. Download the EDB installer: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads
   → Windows x86-64 → **16.x** (or **17.x** if Neon is 17). Run it as
   Administrator. Choose: install dir default (`C:\Program Files\PostgreSQL\16`),
   data dir `D:\pgdata` if the box has a D: drive, else default; **port 5432**;
   superuser password — write it in the box's password store, you need it
   in step 2; locale `C`; untick Stack Builder at the end.
2. The installer registers the `postgresql-x64-16` service (auto-start).
   Confirm and make `psql` available in this shell:

```powershell
Get-Service postgresql-x64-16          # Status: Running
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
psql --version                           # psql (PostgreSQL) 16.x
```

3. Keep it loopback-only (the installer's default `listen_addresses='localhost'`
   already is). Check that nothing else is listening:

```powershell
Select-String -Path "C:\Program Files\PostgreSQL\16\data\postgresql.conf" -Pattern '^listen_addresses'
# expected: listen_addresses = 'localhost'   (or commented out = localhost)
```

Rollback: uninstall from Apps & Features; nothing else on the box refers to it yet.

## 2. Create the database + schema

```powershell
cd C:\vyxtrader\repo
git fetch --all
git checkout main
git pull                                   # must contain "engine: market-data sink" (S1)
git log --oneline -1                       # note the hash for step 5

$env:PGPASSWORD = "<postgres superuser password from step 1>"
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE market_data;"
# pick the engine role's password now and put it in the SQL file's one CHANGE-ME line:
(Get-Content deploy\market_data.sql) -replace 'CHANGE-ME-BEFORE-RUNNING', '<engine role password>' | Set-Content $env:TEMP\market_data.sql
psql -U postgres -h 127.0.0.1 -d market_data -v ON_ERROR_STOP=1 -f $env:TEMP\market_data.sql
Remove-Item $env:TEMP\market_data.sql
```

Verify:

```powershell
psql -U engine -h 127.0.0.1 -d market_data -c '\dt'
# expected two rows: Candle, LivePrice
psql -U engine -h 127.0.0.1 -d market_data -c 'SELECT enum_range(NULL::"CandleTimeframe");'
# expected: {M1,M5,M15,M30,H1,H4,D1,W1,MN1,Y1}
```

(The SQL is idempotent — re-running it after a fix is safe.)

Rollback: `psql -U postgres -h 127.0.0.1 -c "DROP DATABASE market_data;"`

## 3. Copy the existing candles from Neon (one-time dump / restore)

```powershell
$NEON = "postgresql://neondb_owner:<password>@ep-flat-boat-b1wjz20p.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require"
mkdir C:\vyxtrader\backup -Force | Out-Null
pg_dump --data-only --no-owner --no-privileges -t '"Candle"' -t '"LivePrice"' $NEON > C:\vyxtrader\backup\candles-neon.sql
# a couple of minutes; expected size ~100 MB. If it says "server version mismatch" go back to step 1 and install the newer major.
psql -U postgres -h 127.0.0.1 -d market_data -v ON_ERROR_STOP=1 -q -f C:\vyxtrader\backup\candles-neon.sql
psql -U postgres -h 127.0.0.1 -d market_data -c 'ANALYZE "Candle"; ANALYZE "LivePrice";'
```

Verify — counts and newest bucket per timeframe must match on both sides
(the Neon numbers keep growing while the feed runs, so compare within a
minute of each other and expect the local side to be *behind by at most
the minutes since the dump*; the engine's own gap-fill closes that in step 5):

```powershell
$q = 'SELECT timeframe, count(*), max("bucketStart") FROM "Candle" GROUP BY 1 ORDER BY 1;'
psql $NEON -c $q
psql -U postgres -h 127.0.0.1 -d market_data -c $q
psql $NEON -c 'SELECT count(*) FROM "LivePrice";'
psql -U postgres -h 127.0.0.1 -d market_data -c 'SELECT count(*) FROM "LivePrice";'
```

Keep `candles-neon.sql` — it is the rollback for everything after this.

Rollback: `psql -U postgres -h 127.0.0.1 -d market_data -c 'TRUNCATE "Candle", "LivePrice";'`

## 4. Build the S1 engine

```powershell
cd C:\vyxtrader\repo\engine
cargo build --release -p server
# ends with "Finished `release` profile"; the exe is engine\target\release\trading-core-server.exe
```

Nothing running has changed yet — the service still runs the old exe until step 5.

## 5. Switch the engine to dual-write (`both`) and restart

Edit `C:\vyxtrader\scripts\start-engine.cmd` (back it up first) and add two
lines next to the existing `set DATABASE_URL=...`:

```powershell
Copy-Item C:\vyxtrader\scripts\start-engine.cmd C:\vyxtrader\backup\start-engine.cmd.pre-s2
notepad C:\vyxtrader\scripts\start-engine.cmd
```

```
set MARKET_DATA_DATABASE_URL=postgres://engine:<engine role password>@127.0.0.1:5432/market_data
set MARKET_DATA_WRITE=both
set MARKET_DATA_READ_SECRET=<the dedicated read-only secret Vercel holds as MARKET_DATA_READ_SECRET>
```

(`MARKET_DATA_READ_SECRET` is optional defense-in-depth: with it, the engine
itself accepts `X-Market-Data-Secret` on `/internal/candles` and
`/internal/prices` and nothing else -- so the web app never needs
`INTERNAL_SERVICE_SECRET` even if Caddy's own header check is bypassed.)

Then restart only the engine (the gateway keeps serving):

```powershell
nssm restart vyxtrader-engine
Start-Sleep 5
$H = @{ "x-internal-secret" = "<INTERNAL_SERVICE_SECRET from start-engine.cmd>" }
(Invoke-RestMethod http://127.0.0.1:8081/internal/feed-stats -Headers $H) | Select-Object market_data_write, market_data_reader, db_ok, db_fail, local_db_ok, local_db_fail, local_db_lag_ms, ticks_in
```

Expected within the first minute: `market_data_write both`, `market_data_reader local`,
`local_db_ok` climbing at the same rate as `db_ok`, `local_db_fail 0`,
`local_db_lag_ms` single digits (Neon's `db_lag_ms` is ~30–60).

Read back through the new endpoint and compare with Neon:

```powershell
(Invoke-RestMethod "http://127.0.0.1:8081/internal/candles?symbol=XAUUSD&tf=M1&limit=3" -Headers $H) | Format-Table symbol, timeframe, bucketStart, open, high, low, close
psql $NEON -c 'SELECT "bucketStart", open, high, low, close FROM "Candle" WHERE symbol=''XAUUSD'' AND timeframe=''M1'' ORDER BY 1 DESC LIMIT 3;'
(Invoke-RestMethod "http://127.0.0.1:8081/internal/prices/XAUUSD" -Headers $H)
```

The rows must match; the price row's `ageMs` must be small (< 5000) during
market hours.

Rollback (seconds): set `MARKET_DATA_WRITE=neon` (or delete both lines),
`nssm restart vyxtrader-engine`. The local database is simply left behind.

## 6. Soak (24 h) — the gate for S3

Run `deploy\market-data-verify.ps1` a few times over the day (see the file;
it prints the feed-stats trios and a Neon-vs-local count/max table). Move to
S3 when, after 24 h: `local_db_fail` stayed 0 (or only moved during a known
restart), every timeframe's count differs by at most the retention pass
(M1/M5 are trimmed nightly on both sides, so equal), and `max("bucketStart")`
is identical on both sides for every timeframe.

Also check disk once: `psql -U postgres -h 127.0.0.1 -d market_data -c "SELECT pg_size_pretty(pg_database_size('market_data'));"` — expect a few hundred MB.

## 7. Nightly backup (do before S5, can be done now)

```powershell
# C:\vyxtrader\scripts\backup-market-data.cmd
@echo off
set PGPASSWORD=<postgres superuser password>
"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U postgres -h 127.0.0.1 -Fc market_data > "C:\vyxtrader\backup\market_data-%date:~-4%%date:~4,2%%date:~7,2%.dump"
forfiles /p C:\vyxtrader\backup /m market_data-*.dump /d -7 /c "cmd /c del @path"
```

Register it: `schtasks /Create /SC DAILY /ST 03:30 /TN VyxMarketDataBackup /TR C:\vyxtrader\scripts\backup-market-data.cmd /RU SYSTEM`.

---

What I (main-repo session) do in parallel once step 5 is green: S3 —
`lib/market-data-client.ts` + `/api/trade/candles` reading the engine for
the symbols in `MARKET_DATA_VPS_SYMBOLS` (you set that var in Vercel, starting
with `EURUSD`). Neon keeps every write until S5.

---

## S4 on the VPS — gateway reads LivePrice from the local store

The gateway's positions summary (`services/api-gateway/src/db.ts`) is the one
VPS-side reader of `LivePrice`. Once the web app is on `MARKET_DATA_PRICES=vps`:

```powershell
cd C:yxtraderepo
git pull                                              # must contain "web: live prices from the engine (S4)"
cd servicespi-gateway
npm ci; npm run build
Copy-Item C:yxtrader\scripts\start-gateway.cmd C:yxtraderackup\start-gateway.cmd.pre-s4
notepad C:yxtrader\scripts\start-gateway.cmd    # add, next to DATABASE_URL:
#   set MARKET_DATA_DATABASE_URL=postgres://engine:<engine role password>@127.0.0.1:5432/market_data
nssm restart vyxtrader-gateway
Invoke-WebRequest https://feed.vyxtrader.com/health -UseBasicParsing | Select-Object StatusCode   # 200
```

Verify: the terminal's account panel (equity / floating P&L, which come from
this query) still moves with the price on an open position. Rollback:
remove the line, restart the gateway.

S5 (`MARKET_DATA_WRITE=local` in start-engine.cmd, restart engine) is safe
only after: `x-market-data-source: vps` on `/api/trade/prices` AND on
`/api/trade/candles` for every symbol, a real market order filled on zzzqa
with the flag on, and this gateway step done. Until then Neon's LivePrice is
still read by something.

## Where the engine reads its secrets (2026-09-26)

The engine takes every secret from its **process environment** only, via `std::env::var` in
`engine/server/src/main.rs` (`MARKET_DATA_READ_SECRET` at ~l.1291, `INTERNAL_SERVICE_SECRET` and
`PRICE_FEED_SECRET` just above). It reads no `.env` file. On the VPS that environment comes from the
`set NAME=value` lines in **`C:\vyxtrader\scripts\start-engine.cmd`**, the script the `vyxtrader-engine`
nssm service runs (deploy/contabo-deploy.ps1 backs it up to `C:\vyxtrader\backup\start-engine.cmd`). A
search for `.env` files, or of the nssm service's own environment, will not find it.

```powershell
findstr /i /c:"MARKET_DATA_READ_SECRET" /c:"INTERNAL_SERVICE_SECRET" C:\vyxtrader\scripts\start-engine.cmd
```

- `MARKET_DATA_READ_SECRET` is **optional** (§5). When it is not set, the engine logs
  "MARKET_DATA_READ_SECRET not set -- /internal/candles and /internal/prices accept the internal secret only",
  and those two read routes accept `x-internal-secret: <INTERNAL_SERVICE_SECRET>` only.
- The web app sends only `X-Market-Data-Secret` (lib/market-data-client.ts). With the engine's copy unset, the
  web's VPS reads are accepted only if Caddy's own check on feed.vyxtrader.com forwards them.

Read-only check that works either way: use the internal secret against localhost. For example, the XAUUSD M1
candles after Friday's close, to confirm that no flat bars were stored:

```powershell
$S = (findstr /i "INTERNAL_SERVICE_SECRET" C:\vyxtrader\scripts\start-engine.cmd).Split("=",2)[1].Trim()
$H = @{ "x-internal-secret" = $S }
Invoke-RestMethod "http://127.0.0.1:8081/internal/candles?symbol=XAUUSD&tf=M1&limit=900" -Headers $H |
  ? { $_.bucketStart -ge '2026-09-25T20:40' } | ft bucketStart,open,high,low,close,updatedAt
Invoke-RestMethod "http://127.0.0.1:8081/internal/prices/XAUUSD" -Headers $H   # tickAt = the last real tick
```

A flat bar has open = high = low = close. The engine writes a candle only for a tick whose own time (tick_ms) falls
inside trading hours (engine/market-data/src/ingest.rs), so no rows are expected after the Friday close.
