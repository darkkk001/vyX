//+------------------------------------------------------------------+
//|                                          VyXTraderPriceFeed.mq5   |
//| Pushes live bid/ask from this MT5 terminal to VyXTrader so the    |
//| WebTrader chart shows real prices instead of the simulator.       |
//| Temporary bridge — Phase 5 replaces this with a real LP feed;     |
//| nothing downstream changes since it only ever reads the           |
//| LivePrice table this EA feeds.                                    |
//+------------------------------------------------------------------+
#property strict
#property version   "1.33"

input string ServerUrl            = "https://www.vyxtrader.com/api/internal/price-feed";
// No default -- this file is committed to a public-ish repo. A real
// secret used to sit here in plaintext (the same value anyone with repo
// access could read); type the actual value into this EA's Inputs tab
// on the terminal instead. Empty means "not configured yet" and OnTick/
// OnTimer both refuse to push until it's set (see the guard below).
input string ApiSecret            = "";
// No longer used to drive OnInit's timer (see EventSetMillisecondTimer
// below, now keyed off PushMinIntervalMs instead) -- left declared,
// unused, rather than removed, so an already-configured EA instance's
// saved Inputs don't shift underneath it on the next recompile.
input int    PushIntervalSeconds  = 1;
// Push-on-tick mode (Contabo audit, 2026-08-29): when true, OnTick below
// pushes immediately on a tick of this chart's own symbol instead of
// waiting for the timer, capped to at most one push per PushMinIntervalMs
// so a burst of ticks coalesces into one request. When false, OnTick is a
// no-op and everything runs off the timer alone.
//
// MQL5's OnTick() only fires for the symbol THIS CHART is showing, not
// every symbol in ActiveBrokerSymbols below -- on its own, that would mean a
// quiet chart-symbol with other symbols still moving wouldn't push until
// the next chart-symbol tick. OnInit now runs the timer at
// PushMinIntervalMs itself (EventSetMillisecondTimer, not the old 1s
// EventSetTimer), so every symbol -- chart-driven or not -- is bounded at
// the same PushMinIntervalMs floor regardless of PushOnEveryTick. OnTick
// existing on top of that just means the chart's own symbol *can* push
// slightly sooner than the next timer firing; it no longer carries the
// "otherwise other symbols go stale" responsibility by itself.
input bool   PushOnEveryTick      = true;
input int    PushMinIntervalMs    = 50;

// Direct mode — talks straight to the Rust Trading Core's Market Data
// Core (engine/server's POST /internal/price-feed), skipping the Next.js
// proxy hop entirely. OFF by default: engine/server has no public
// deployment yet (see docs/market-data.md §5's "Transport — unchanged
// for the EA, by design"), so flipping this on before that exists just
// points the EA at nothing. Once engine/server is deployed somewhere
// reachable, set UseDirectMode=true and DirectServerUrl to its base URL
// (e.g. "https://api.vyxtrader.com") — no other code change needed.
// Uses the same ApiSecret as the proxy path (one shared secret across
// both transports, per market-data.md §1).
input bool   UseDirectMode        = false;
input string DirectServerUrl      = "";
// Clock-sync handshake (Contabo audit follow-up, replaces the old
// TimeGMT()/GetTickCount() t0 filler entirely): only meaningful in direct
// mode, since GET /internal/time lives on the Rust engine itself, not the
// Next.js proxy. See SyncClockOffset below.
input int    ClockSyncIntervalSec = 60;

// History backfill (fix/realtime-sync §4) -- repairs gaps/holes in the
// engine's Candle history (a quiet period with no ticks, or any bucket
// lost to a past write failure) with this terminal's own real OHLC bars,
// which the engine treats as authoritative over its own tick-aggregated
// ones (POST /internal/history -- see engine/server/src/main.rs's
// ingest_history and db.rs's upsert_candle_authoritative). Direct-mode
// only, same reasoning as SyncClockOffset: this route lives on
// engine/server itself, not the Next.js proxy. Runs once on init and
// every HistoryBackfillIntervalSec after that (see OnTimer) -- NOT tied
// to PushMinIntervalMs the way tick pushes are, since a bar backfill is
// maintenance, not a live-latency-sensitive push.
input int    HistoryBackfillIntervalSec = 900;

// Where the list of symbols to push comes from (second Contabo-audit
// follow-up). MARKET_WATCH auto-discovers whatever's selected in this
// terminal's Market Watch, refreshed on init and every 30s -- no source
// file edit needed to add/remove a symbol, just change what's selected in
// Market Watch. LIST is the old hardcoded-array behavior, now a single
// comma-separated input instead of two parallel arrays.
enum ENUM_SYMBOL_SOURCE
{
   SYMBOL_SOURCE_MARKET_WATCH,
   SYMBOL_SOURCE_LIST
};
input ENUM_SYMBOL_SOURCE SymbolSource = SYMBOL_SOURCE_MARKET_WATCH;
// LIST mode only -- broker-native symbol names exactly as they appear in
// Market Watch (e.g. "EURUSDm", "XAUUSDm" if this account suffixes
// symbols), comma-separated. Ignored in MARKET_WATCH mode.
input string SymbolList = "XAUUSD,EURUSD,GBPUSD,BTCUSD,US30,USDJPY,AUDUSD,XAGUSD,ETHUSD,NAS100";
// Optional, either mode -- renames a broker-native symbol name to a
// canonical one before it's sent, e.g. "US30.a=US30,NAS100.a=NAS100".
// A broker symbol not listed here is sent under its own name unchanged --
// the engine/gateway accept any symbol now (see main.rs/ws.ts), so a
// canonical rename is a cosmetic convenience, not a requirement.
input string SymbolMap = "";
// MARKET_WATCH mode only -- a broker with an unusually large Market Watch
// selected would otherwise silently push a very large payload every
// PushMinIntervalMs; this only warns (Experts log), it does not truncate
// the symbol list.
input int    MaxSymbolsWarning = 150;

// GetTickCount() (uint, 32-bit ms uptime) is enough for a same-run
// debounce window -- it only ever needs to compare against a value set
// earlier in this same terminal session, never persisted or compared
// across a restart, so its ~49-day wraparound doesn't matter here.
uint lastPushMs = 0;

// Change-detection state (Contabo audit follow-up: Contabo was seeing
// ~208 ticks_in/s because every push resent every symbol's current price
// regardless of whether it had actually moved since the last push). One
// slot per symbol, looked up by name (not position) so a MARKET_WATCH
// refresh reordering/adding/removing symbols can't misalign this against
// stale data the way parallel arrays indexed by ActiveBrokerSymbols'
// position would. TrackedTimeMsc[i] == 0 means "never sent" (a real
// bid/ask/time_msc is never exactly zero), used to force-send a symbol's
// first observation regardless of the heartbeat timer.
string TrackedSymbols[];
double TrackedBid[];
double TrackedAsk[];
long   TrackedTimeMsc[];
int    TrackedCount = 0;

// A full snapshot (every active symbol, regardless of change) goes out
// every HEARTBEAT_INTERVAL_MS so the engine can tell "this symbol hasn't
// moved" apart from "this symbol stopped reporting entirely" -- change-
// only pushing otherwise has no way to signal the latter.
const int HEARTBEAT_INTERVAL_MS = 5000;
uint lastHeartbeatMs = 0;

// Clock-sync handshake state -- see SyncClockOffset. ClockOffsetMs stays
// 0 (uncorrected) until the first successful sync; t0 computed from that
// uncorrected offset is a small uptime-based number wildly outside a
// plausible UTC-epoch range, which the engine's own t0_invalid clamp
// (engine/market-data/src/ingest.rs) correctly flags as garbage rather
// than a real (if imprecise) latency reading -- a deliberately safer
// failure mode than the old TimeGMT() filler's "always produces some
// plausible-looking number even when wrong."
long ClockOffsetMs = 0;
long LastRttMs = 0;
bool HasClockSync = false;
uint lastClockSyncMs = 0;

// History backfill state. lastHistoryBackfillMs == 0 means "never run
// yet" -- OnInit's own call handles the "on init" half of the schedule,
// this is only for the "every HistoryBackfillIntervalSec" half.
uint lastHistoryBackfillMs = 0;

// Only the engine's actual configured fixed-duration timeframes
// (engine/market-data/src/lib.rs's TIMEFRAMES / fixed_ms) -- W1/Mn1/Y1
// are calendar-based and excluded from gap-filling there too, so
// backfilling them isn't worth the extra CopyRates/WebRequest calls.
// NOTE: the spec this feature was built from also listed "M15", but no
// M15 timeframe has ever existed in this engine or its Postgres
// CandleTimeframe enum (only M1/M5/M30) -- sending it would just get
// silently skipped by ingest_history's own timeframe_from_str (see that
// function's doc comment), so it's left out here rather than sent for
// nothing.
ENUM_TIMEFRAMES HistoryBackfillPeriods[] = { PERIOD_M1, PERIOD_M5, PERIOD_M30, PERIOD_H1, PERIOD_H4, PERIOD_D1 };
string HistoryBackfillPeriodNames[]     = { "M1",      "M5",      "M30",      "H1",      "H4",      "D1"     };
// Was 500 -- Contabo found 27% of history requests failing with MT5 error
// 1003 (WebRequest timeout): a 500-bar upsert took 3-6s against the old
// 5000ms HISTORY_WEBREQUEST_TIMEOUT_MS below, and Neon's per-row round
// trip (engine/server's ingest_history upserts one row at a time inside a
// single transaction, not one batched multi-row statement -- see that
// function's own comment) doesn't leave much margin. 200 bars is still
// more than enough to repair any real gap this backfill exists for.
const int HISTORY_BACKFILL_BAR_COUNT = 200;
// Split from the tick-push timeout below on purpose -- a history backfill
// runs on the same OnTimer callback as tick pushes (MQL5 has one thread
// per EA, no async WebRequest), so whatever this is set to is how long a
// slow/hanging history request can freeze this EA's live tick pushes for.
// 30s is a deliberate trade (a rare, bounded freeze beats a 27%-of-requests
// failure rate) -- do not reuse this constant for SendViaProxy/SendDirect.
const int HISTORY_WEBREQUEST_TIMEOUT_MS = 30000;
// Ticks are latency-sensitive and small; keep this short so a genuinely
// unreachable server fails fast instead of stalling the push loop.
const int TICK_WEBREQUEST_TIMEOUT_MS = 5000;

// Refreshed by RefreshActiveSymbols() -- the actual broker-native symbol
// names read via SymbolInfoTick each push, regardless of SymbolSource.
string ActiveBrokerSymbols[];
uint lastSymbolRefreshMs = 0;
const int SYMBOL_REFRESH_INTERVAL_MS = 30000;

// Parsed once from SymbolMap in OnInit -- BrokerSymbol -> CanonicalName
// pairs. Linear-scan lookup (CanonicalFor below) is fine at this scale
// (tens, not thousands, of mapped symbols).
string MapFromSymbols[];
string MapToSymbols[];
int MapCount = 0;

// Splits a comma-separated string into `out`, trimming surrounding
// whitespace from each piece (a human hand-editing an Inputs field is
// likely to leave stray spaces after commas). Returns the element count.
int SplitCsv(string csv, string &out[])
{
   if (StringLen(csv) == 0) { ArrayResize(out, 0); return 0; }
   int count = StringSplit(csv, ',', out);
   for (int i = 0; i < count; i++)
   {
      StringTrimLeft(out[i]);
      StringTrimRight(out[i]);
   }
   return count;
}

void ParseSymbolMap()
{
   string pairs[];
   int n = SplitCsv(SymbolMap, pairs);
   ArrayResize(MapFromSymbols, n);
   ArrayResize(MapToSymbols, n);
   MapCount = 0;
   for (int i = 0; i < n; i++)
   {
      if (StringLen(pairs[i]) == 0) continue;
      int eq = StringFind(pairs[i], "=");
      if (eq < 0) continue;
      MapFromSymbols[MapCount] = StringSubstr(pairs[i], 0, eq);
      MapToSymbols[MapCount]   = StringSubstr(pairs[i], eq + 1);
      MapCount++;
   }
}

string CanonicalFor(string brokerSymbol)
{
   for (int i = 0; i < MapCount; i++)
      if (MapFromSymbols[i] == brokerSymbol) return MapToSymbols[i];
   return brokerSymbol; // no mapping entry -- send under its own name
}

void RefreshActiveSymbols()
{
   if (SymbolSource == SYMBOL_SOURCE_LIST)
   {
      SplitCsv(SymbolList, ActiveBrokerSymbols);
   }
   else // SYMBOL_SOURCE_MARKET_WATCH
   {
      int total = SymbolsTotal(true); // true = only symbols selected in Market Watch
      ArrayResize(ActiveBrokerSymbols, total);
      for (int i = 0; i < total; i++) ActiveBrokerSymbols[i] = SymbolName(i, true);
      if (total > MaxSymbolsWarning)
         Print("VyXTraderPriceFeed: WARNING -- ", total, " symbols selected in Market Watch (warning threshold ",
               MaxSymbolsWarning, "). All are still being pushed; trim Market Watch if this is unintentional.");
   }
   lastSymbolRefreshMs = GetTickCount();
}

// Finds (or creates, growing the tracking arrays 32 at a time) the
// change-detection slot for a symbol. Linear scan -- fine at this scale
// (tens to low hundreds of symbols, refreshed at most every 30s).
int GetOrCreateTrackedIndex(string symbol)
{
   for (int i = 0; i < TrackedCount; i++)
      if (TrackedSymbols[i] == symbol) return i;

   int idx = TrackedCount;
   if (idx >= ArraySize(TrackedSymbols))
   {
      int newSize = ArraySize(TrackedSymbols) + 32;
      ArrayResize(TrackedSymbols, newSize);
      ArrayResize(TrackedBid, newSize);
      ArrayResize(TrackedAsk, newSize);
      ArrayResize(TrackedTimeMsc, newSize);
   }
   TrackedSymbols[idx]  = symbol;
   TrackedBid[idx]      = 0;
   TrackedAsk[idx]      = 0;
   TrackedTimeMsc[idx]  = 0;
   TrackedCount++;
   return idx;
}

// Pulls a JSON integer field's value out of a tiny, known-shape response
// body ({"server_utc_ms":1234567890123}) by hand -- MQL5 has no built-in
// JSON parser and pulling in a library for one field isn't worth it.
// Returns 0 if the key isn't found or has no digits following it.
long ExtractJsonLong(string json, string key)
{
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if (pos < 0) return 0;
   int start = pos + StringLen(needle);
   int len = StringLen(json);
   int end = start;
   while (end < len)
   {
      ushort c = StringGetCharacter(json, end);
      if ((c < '0' || c > '9') && c != '-') break;
      end++;
   }
   if (end <= start) return 0;
   return StringToInteger(StringSubstr(json, start, end - start));
}

// NTP-style handshake against the Rust engine's own clock -- only
// reachable in direct mode (GET /internal/time exists on engine/server,
// not the Next.js proxy). Brackets the HTTP call with GetMicrosecondCount()
// (this terminal's own monotonic clock) to derive round-trip time and
// this engine's UTC offset from this terminal's local clock, replacing
// the old TimeGMT()/GetTickCount() approximation entirely -- that only
// ever fixed the whole-second component and a broker-local-vs-UTC
// mismatch; this corrects against the engine's actual clock instead of
// assuming this terminal's clock (even in UTC) agrees with it.
void SyncClockOffset()
{
   if (!UseDirectMode || StringLen(DirectServerUrl) == 0)
   {
      lastClockSyncMs = GetTickCount(); // don't retry every cycle in proxy mode
      return;
   }

   string url = DirectServerUrl + "/internal/time";
   uchar noData[];
   uchar result[];
   string resultHeaders;

   // GetMicrosecondCount() returns ulong; explicit (long) casts here and
   // at every other call site avoid an implicit narrowing conversion the
   // compiler otherwise warns on.
   long monoBeforeUs = (long)GetMicrosecondCount();
   ResetLastError();
   int res = WebRequest("GET", url, "", 5000, noData, result, resultHeaders);
   long monoAfterUs = (long)GetMicrosecondCount();
   lastClockSyncMs = GetTickCount();

   if (res != 200)
   {
      int err = GetLastError();
      if (res == -1 && err == 4060)
         Print("VyXTraderPriceFeed: clock sync failed -- add ", DirectServerUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL");
      else
         Print("VyXTraderPriceFeed: clock sync failed, WebRequest returned ", res, res == -1 ? StringFormat(" (error %d)", err) : "");
      return;
   }

   long serverUtcMs = ExtractJsonLong(CharArrayToString(result), "server_utc_ms");
   if (serverUtcMs <= 0)
   {
      Print("VyXTraderPriceFeed: clock sync response missing a valid server_utc_ms: ", CharArrayToString(result));
      return;
   }

   long monoBeforeMs = monoBeforeUs / 1000;
   long rttMs = (monoAfterUs - monoBeforeUs) / 1000;
   ClockOffsetMs = serverUtcMs - (monoBeforeMs + rttMs / 2);
   LastRttMs = rttMs;
   HasClockSync = true;
}

int OnInit()
{
   ParseSymbolMap();
   RefreshActiveSymbols();
   SyncClockOffset();
   SendHistoryBackfill(); // fix/realtime-sync §4 -- "on init" half of the schedule
   // Millisecond timer, not EventSetTimer's 1s-resolution one -- keyed
   // off the same PushMinIntervalMs OnTick's own debounce uses, so every
   // symbol (not just this chart's own) is bounded at that floor
   // regardless of PushOnEveryTick. See that input's own comment.
   EventSetMillisecondTimer(PushMinIntervalMs);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTick()
{
   if (!PushOnEveryTick) return;
   if (GetTickCount() - lastPushMs < (uint)PushMinIntervalMs) return;
   BuildAndSend();
}

string Base64UrlEncode(string src)
{
   int len = StringLen(src); // payload is pure ASCII (hex secret + JSON), 1 char = 1 byte
   uchar bytes[];
   StringToCharArray(src, bytes, 0, len, CP_UTF8);

   string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
   string result = "";
   int i;
   for (i = 0; i + 2 < len; i += 3)
   {
      int n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      result += StringSubstr(alphabet, (n >> 18) & 63, 1);
      result += StringSubstr(alphabet, (n >> 12) & 63, 1);
      result += StringSubstr(alphabet, (n >> 6) & 63, 1);
      result += StringSubstr(alphabet, n & 63, 1);
   }
   int rem = len - i;
   if (rem == 1)
   {
      int n = bytes[i] << 16;
      result += StringSubstr(alphabet, (n >> 18) & 63, 1);
      result += StringSubstr(alphabet, (n >> 12) & 63, 1);
   }
   else if (rem == 2)
   {
      int n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      result += StringSubstr(alphabet, (n >> 18) & 63, 1);
      result += StringSubstr(alphabet, (n >> 12) & 63, 1);
      result += StringSubstr(alphabet, (n >> 6) & 63, 1);
   }

   StringReplace(result, "+", "-");
   StringReplace(result, "/", "_");
   return result;
}

// GET with the base64url-path workaround, to the Next.js proxy — the
// live, unchanged-since-forever transport. secret + ticks travel
// base64url-encoded in the URL PATH, not the query string — some network
// paths between broker MT5 terminals and the server strip query strings
// entirely (confirmed via the server echoing back what it received:
// secret/data both arrived null), so nothing after "?" survives. A path
// segment isn't touched by that.
void SendViaProxy(string ticksJson)
{
   string payload = "{\"secret\":\"" + ApiSecret + "\",\"ticks\":" + ticksJson + "}";
   string url = ServerUrl + "/" + Base64UrlEncode(payload);

   uchar noData[];
   uchar result[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("GET", url, "", TICK_WEBREQUEST_TIMEOUT_MS, noData, result, resultHeaders);
   if (res == -1)
   {
      int err = GetLastError();
      if (err == 4060)
         Print("VyXTraderPriceFeed: add ", ServerUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL, then re-attach this EA");
      else
         Print("VyXTraderPriceFeed: WebRequest failed, error ", err);
   }
   else if (res != 200)
   {
      Print("VyXTraderPriceFeed: server responded ", res, " — ", CharArrayToString(result));
   }
}

// POST straight to engine/server's own route (see the UseDirectMode doc
// comment above) — plain JSON array body, shared secret in a header, no
// base64/path workaround. That workaround exists specifically for
// whatever strips query strings between a broker's MT5 terminal and
// Vercel; engine/server is a different deployment target entirely, so
// this transport is untested against the same network path and should
// be watched (via the Print() below) after first enabling it, same as
// any new production transport would be.
void SendDirect(string ticksJson)
{
   string url = DirectServerUrl + "/internal/price-feed";
   string headers = "Content-Type: application/json\r\nx-price-feed-secret: " + ApiSecret + "\r\n";

   uchar body[];
   StringToCharArray(ticksJson, body, 0, StringLen(ticksJson), CP_UTF8);
   // StringToCharArray appends a trailing null terminator; WebRequest
   // would otherwise send it as a stray extra byte, so the array is
   // trimmed back to the actual JSON length before the request.
   ArrayResize(body, StringLen(ticksJson));

   uchar result[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("POST", url, headers, TICK_WEBREQUEST_TIMEOUT_MS, body, result, resultHeaders);
   if (res == -1)
   {
      int err = GetLastError();
      if (err == 4060)
         Print("VyXTraderPriceFeed (direct): add ", DirectServerUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL, then re-attach this EA");
      else
         Print("VyXTraderPriceFeed (direct): WebRequest failed, error ", err);
   }
   else if (res != 200)
   {
      Print("VyXTraderPriceFeed (direct): server responded ", res, " — ", CharArrayToString(result));
   }
}

// POST one symbol+timeframe's last HISTORY_BACKFILL_BAR_COUNT bars to
// engine/server's /internal/history (fix/realtime-sync §4). Same auth
// header convention as SendDirect. Blocking, like every WebRequest call
// in this file -- MQL5 has no async HTTP -- so a full backfill cycle
// (every configured symbol x every HistoryBackfillPeriods entry) pauses
// this EA's own tick pushes for however long that many sequential
// requests take. Only runs every HistoryBackfillIntervalSec (15 min by
// default), not every tick, so this is a periodic brief pause, not a
// standing latency cost -- a real, known tradeoff of a single-threaded
// EA with no async HTTP, not something this fix works around.
void SendHistoryBars(string canonicalSymbol, string brokerSymbol, ENUM_TIMEFRAMES period, string timeframeName)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(brokerSymbol, period, 0, HISTORY_BACKFILL_BAR_COUNT, rates);
   if (copied <= 0) return; // no history available yet for this symbol/period -- nothing to send

   string bars = "[";
   for (int i = 0; i < copied; i++)
   {
      if (i > 0) bars += ",";
      long bucketStartMs = (long)rates[i].time * 1000;
      bars += StringFormat(
         "{\"bucket_start_ms\":%I64d,\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f}",
         bucketStartMs, rates[i].open, rates[i].high, rates[i].low, rates[i].close
      );
   }
   bars += "]";

   string json = "{\"symbol\":\"" + canonicalSymbol + "\",\"timeframe\":\"" + timeframeName + "\",\"bars\":" + bars + "}";
   string url = DirectServerUrl + "/internal/history";
   string headers = "Content-Type: application/json\r\nx-price-feed-secret: " + ApiSecret + "\r\n";

   uchar body[];
   StringToCharArray(json, body, 0, StringLen(json), CP_UTF8);
   ArrayResize(body, StringLen(json)); // trim StringToCharArray's trailing null, same as SendDirect

   uchar result[];
   string resultHeaders;
   ResetLastError();
   int res = WebRequest("POST", url, headers, HISTORY_WEBREQUEST_TIMEOUT_MS, body, result, resultHeaders);
   if (res == -1)
   {
      int err = GetLastError();
      if (err == 4060)
         Print("VyXTraderPriceFeed (history backfill): add ", DirectServerUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL");
      else
         Print("VyXTraderPriceFeed (history backfill): WebRequest failed for ", canonicalSymbol, " ", timeframeName, ", error ", err);
   }
   else if (res != 200)
   {
      Print("VyXTraderPriceFeed (history backfill): server responded ", res, " for ", canonicalSymbol, " ", timeframeName, " — ", CharArrayToString(result));
   }
}

// Iterates every active symbol x every configured timeframe. See this
// function's own input/state doc comments for scheduling and the
// direct-mode-only gate.
void SendHistoryBackfill()
{
   if (!UseDirectMode || StringLen(DirectServerUrl) == 0)
   {
      lastHistoryBackfillMs = GetTickCount(); // don't retry every cycle in proxy mode, same as SyncClockOffset
      return;
   }
   if (StringLen(ApiSecret) == 0) return; // BuildAndSend already warns about this; avoid a duplicate log line here

   for (int i = 0; i < ArraySize(ActiveBrokerSymbols); i++)
   {
      string brokerSymbol = ActiveBrokerSymbols[i];
      if (StringLen(brokerSymbol) == 0) continue;
      string canonicalSymbol = CanonicalFor(brokerSymbol);
      for (int p = 0; p < ArraySize(HistoryBackfillPeriods); p++)
         SendHistoryBars(canonicalSymbol, brokerSymbol, HistoryBackfillPeriods[p], HistoryBackfillPeriodNames[p]);
   }

   lastHistoryBackfillMs = GetTickCount();
}

// Shared by OnTick and OnTimer. Unlike before, this does NOT always push
// every configured symbol -- only ones whose (bid, ask, time_msc) changed
// since the last push, plus a full snapshot every HEARTBEAT_INTERVAL_MS
// (Contabo audit follow-up: resending every symbol's unchanged price on
// every 50ms cycle was producing ~208 ticks_in/s against a real market
// tick rate of ~20-40/s).
void BuildAndSend()
{
   if (StringLen(ApiSecret) == 0)
   {
      Print("VyXTraderPriceFeed: ApiSecret is empty -- set it in this EA's Inputs tab before it will push anything");
      return;
   }

   if (GetTickCount() - lastClockSyncMs >= (uint)(ClockSyncIntervalSec * 1000))
      SyncClockOffset();

   // Origin timestamp for the latency audit -- MUST be UTC epoch ms.
   // Replaces the old TimeGMT()/GetTickCount() approximation entirely:
   // that only corrected this terminal's own clock to UTC (and even then,
   // only to whole-second resolution), which still assumed this
   // terminal's UTC clock agrees with the engine's. This instead measures
   // this terminal's actual offset from the ENGINE's own clock via
   // SyncClockOffset's handshake, with real sub-second precision from
   // GetMicrosecondCount(). Before the first successful sync (or in proxy
   // mode, where the handshake never runs), ClockOffsetMs stays 0 and t0
   // is just a small uptime-based number -- the engine's t0_invalid clamp
   // correctly rejects that as implausible rather than trusting it.
   long t0 = (long)GetMicrosecondCount() / 1000 + ClockOffsetMs;

   // Re-discovers Market Watch's current selection every 30s (LIST mode
   // just re-parses the same static SymbolList -- harmless, kept
   // unconditional rather than mode-branching the refresh timing too).
   if (GetTickCount() - lastSymbolRefreshMs >= (uint)SYMBOL_REFRESH_INTERVAL_MS)
      RefreshActiveSymbols();

   bool forceFullSnapshot = (GetTickCount() - lastHeartbeatMs >= (uint)HEARTBEAT_INTERVAL_MS);

   string json = "[";
   bool first = true;
   for (int i = 0; i < ArraySize(ActiveBrokerSymbols); i++)
   {
      string brokerSymbol = ActiveBrokerSymbols[i];
      if (StringLen(brokerSymbol) == 0) continue;

      MqlTick tick;
      if (!SymbolInfoTick(brokerSymbol, tick)) continue; // not in Market Watch / wrong name
      if (tick.bid <= 0 || tick.ask <= 0) continue;

      int idx = GetOrCreateTrackedIndex(brokerSymbol);
      bool isNew = (TrackedTimeMsc[idx] == 0); // a real time_msc is never exactly 0
      bool changed = (tick.bid != TrackedBid[idx] || tick.ask != TrackedAsk[idx] || tick.time_msc != TrackedTimeMsc[idx]);
      if (!isNew && !changed && !forceFullSnapshot) continue; // nothing new to report this cycle

      TrackedBid[idx]     = tick.bid;
      TrackedAsk[idx]     = tick.ask;
      TrackedTimeMsc[idx] = tick.time_msc;

      if (!first) json += ",";
      // %I64d, not %d -- t0 is a 64-bit long (ms since epoch); %d is
      // MQL5's 32-bit specifier and silently truncates it, corrupting
      // every downstream latency measurement (confirmed live: the VPS
      // deployment's /internal/feed-stats showed t0 collapsing to a tiny
      // leftover value once real Exness ticks started flowing).
      json += StringFormat("{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,\"t0\":%I64d", CanonicalFor(brokerSymbol), tick.bid, tick.ask, t0);
      // clock_offset_ms/rtt_ms are omitted entirely (not sent as 0) until
      // the first real handshake succeeds -- matches protocol::Tick's
      // Option<i64> fields on the Rust side, which skip serializing when
      // absent; sending a fake 0 here would misreport an unmeasured
      // offset as a measured one in /internal/feed-stats.
      if (HasClockSync)
         json += StringFormat(",\"clock_offset_ms\":%I64d,\"rtt_ms\":%I64d", ClockOffsetMs, LastRttMs);
      json += "}";
      first = false;
   }
   json += "]";
   if (first) return; // nothing changed and no heartbeat due -- nothing to push

   if (forceFullSnapshot) lastHeartbeatMs = GetTickCount();
   lastPushMs = GetTickCount();

   if (UseDirectMode)
   {
      if (StringLen(DirectServerUrl) == 0)
      {
         Print("VyXTraderPriceFeed: UseDirectMode is on but DirectServerUrl is empty, skipping push");
         return;
      }
      SendDirect(json);
   }
   else
   {
      SendViaProxy(json);
   }
}

void OnTimer()
{
   BuildAndSend();
   // fix/realtime-sync §4 -- "every 15 min" half of the backfill schedule.
   // Checked on the same timer as tick pushes rather than a second MQL5
   // timer (an EA only gets one via EventSetTimer/EventSetMillisecondTimer),
   // same pattern BuildAndSend already uses for ClockSyncIntervalSec.
   if (GetTickCount() - lastHistoryBackfillMs >= (uint)(HistoryBackfillIntervalSec * 1000))
      SendHistoryBackfill();
}
//+------------------------------------------------------------------+
