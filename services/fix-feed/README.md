# fix-feed

A standalone tick feed that logs on to a cTrader FIX 4.4 QUOTE session. It pushes top-of-book prices to the
engine with the payload, endpoint and secret that the MT5 EA (`mt5-ea/VyXTraderPriceFeed.mq5`, direct mode) uses
today:

```
POST <FEED_URL>/internal/price-feed
x-price-feed-secret: <FEED_SECRET>
[{"symbol":"XAUUSD","bid":2650.11000,"ask":2650.31000,"t0":...,"tick_ms":...,"broker_offset_sec":10800}, ...]
```

The engine route (`engine/server/src/main.rs` `ingest_price_feed`, `protocol::Tick`) needs no change. The cadence
also matches the EA's: at most one push per 50 ms, only symbols that changed, a full snapshot every 5 s, and a
`GET /internal/time` clock sync every 60 s. `bars` is omitted because FIX has no broker bars; the engine then uses
its sampled open, as it did for EA builds before v1.40.

Nothing is POSTed unless `FEED_URL` is set.

## Run

Needs Node 23.6 or newer (it runs the `.ts` files directly). `npm install` is only for `npm run typecheck`.

```
ENV_FILE=C:\vyx-secrets\fix-demo.env FEED_JSONL=ticks.jsonl RUN_SECONDS=600 SUMMARY_JSON=summary.json node src/index.ts
```

Local end-to-end run against a stand-in engine that checks the contract:

```
MOCK_SECRET=test node tools/mock-engine.ts
FEED_URL=http://127.0.0.1:8091 FEED_SECRET=test ENV_FILE=... node src/index.ts
```

## Environment

| Variable | Default | |
|---|---|---|
| `FIX_HOST`, `FIX_PORT` | `-`, `5211` | 5211 = SSL quote port, 5201 = plain |
| `FIX_SSL` | `true` | |
| `FIX_SENDER_COMP_ID` | required | e.g. `demo.<broker>.<login>` |
| `FIX_USERNAME` | last part of SenderCompID | Username(553), the account number |
| `FIX_PASSWORD` | required | never logged (554 is redacted) |
| `FIX_TARGET_COMP_ID` (or `TARGET`) | `cServer` | |
| `FIX_SENDER_SUB_ID`, `FIX_TARGET_SUB_ID` | `QUOTE` | |
| `FIX_HEARTBEAT_SEC` | `30` | |
| `FIX_MAX_LOGON_FAILURES` | `3` | stop after this many failed logons in a row (account-lock protection); `0` = keep retrying |
| `FIX_SYMBOLS` | the EA's default list in cTrader names | cTrader symbol names |
| `FIX_SYMBOL_IDS` | from SecurityListRequest | `XAUUSD=41,...` when the server has no security list |
| `FIX_SYMBOL_MAP` | built-in table in `src/config.ts` | `cTraderName=OurName,...`, overrides the table |
| `FEED_URL`, `FEED_SECRET` (or `PRICE_FEED_SECRET`) | dry run | engine base URL, like the EA's `DirectServerUrl` |
| `BROKER_OFFSET_SEC` | `ny-close` | NY close = UTC+3 in US summer time, +2 in winter, like MT5 FX servers |
| `FEED_JSONL` | off | appends every push batch |
| `RUN_SECONDS`, `SUMMARY_JSON` | off | stop after N seconds and write per-symbol stats |
| `GAP_ALERT_MS` | `10000` | logs a gap when a symbol's price has not changed for this long |

## Session behaviour

- Logon has ResetSeqNumFlag=Y on every connect, so both sides start at 1.
- The client sends a Heartbeat when idle for HeartBtInt. After HeartBtInt+2 s of inbound silence it sends a
  TestRequest, and drops and reconnects if there is no answer within another HeartBtInt.
- An inbound sequence gap is logged and counted, and a ResendRequest is sent. A sequence number that is too low
  without PossDupFlag ends the session; the next Logon resets it. A server ResendRequest is answered with a
  SequenceReset-GapFill, because stale quote requests are never replayed. A server SequenceReset is applied.
- On reconnect the backoff is 1 s, 2 s, 4 s and so on, up to 60 s, with 20 % jitter. It goes back to 1 s after a
  session has stayed up for 60 s.
- Symbol names are resolved to cTrader's numeric Symbol(55) ids with SecurityListRequest (35=x).
  `FIX_SYMBOL_IDS` covers servers without one.
- There is one MarketDataRequest per symbol: 263=1, 264=1 (spot, top of book) and 265=1 (incremental). 35=W
  snapshots and 35=X incremental entries both update the book.

`tools/compare.ts` lines a run's `FEED_JSONL` up against an engine's `/internal/feed-stats` for the same minutes.
It reports ticks/sec, gaps and mid-price differences for each symbol, and it only reads.
