//+------------------------------------------------------------------+
//|                                          VyXTraderPriceFeed.mq5   |
//| Pushes live bid/ask from this MT5 terminal to VyXTrader so the    |
//| WebTrader chart shows real prices instead of the simulator.       |
//| Temporary bridge — Phase 5 replaces this with a real LP feed;     |
//| nothing downstream changes since it only ever reads the           |
//| LivePrice table this EA feeds.                                    |
//+------------------------------------------------------------------+
#property strict
#property version   "1.44"

input string ServerUrl            = "https://www.vyxtrader.com/api/internal/price-feed";
// No default -- this file is committed to a public-ish repo. A real
// secret used to sit here in plaintext (the same value anyone with repo
// access could read); type the actual value into this EA's Inputs tab
// on the terminal instead. Empty means "not configured yet" and OnTick/
// OnTimer both refuse to push until it's set (see the guard below).
input string ApiSecret            = "";
// v1.42 -- when ApiSecret is left EMPTY, OnInit reads the secret from the shared terminal data folder:
// %APPDATA%\MetaQuotes\Terminal\Common\Files\vyx_secret.txt (one line, the secret, nothing else). That
// is what lets the EA come back after a VPS reboot with nothing typed into it: the startup .set / profile
// never has to carry the secret, and rotating it is one file edit + EA reinit. A non-empty ApiSecret
// input still wins, exactly as before.
const string API_SECRET_FILE = "vyx_secret.txt";
string g_apiSecret = "";          // what every push actually sends -- see LoadApiSecret
string g_apiSecretSource = "";    // "Inputs" / the file / "" (for the log only; the value is never printed)
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
// engine/server itself, not the Next.js proxy.
//
// v1.35 splits this into two shapes (see StartDeepBackfill/
// RunShallowHistoryBackfill below): a one-time, STAGED deep pass (the
// full HistoryBackfillBarCounts[] per timeframe, ~30 days each) the first
// time this EA ever runs on this terminal, then flat, unstaged
// HISTORY_BACKFILL_SHALLOW_BAR_COUNT-bar steady-state cycles every
// HistoryBackfillIntervalSec after that -- outage repair only, since the
// live tick feed already keeps recent history current on its own.
input int    HistoryBackfillIntervalSec = 300;
// Manual escape hatch: forces the full staged deep pass to run again on
// the next reinit (any Properties change reinitializes a running EA in
// MT5, not just a literal remove-and-reattach) even though it already
// completed once. MQL5 can't reset an input from code, so remember to
// flip this back to false afterward -- left true, every future reinit
// (including an unrelated properties tweak, or a terminal restart) forces
// another ~6-minutes-of-requests deep pass, not just the one you meant.
input bool   ForceDeepBackfill    = false;
// Full-history mode (fix/deep-backfill-full-history, v1.40). The quick
// deep pass above sends one HistoryBackfillBarCounts[]-sized request per
// symbol x timeframe -- for M1 that is ~1 day, M5 ~5 days, M15 ~15 days --
// which is the right size for a fresh install but cannot repair a store
// whose ENTIRE tick-built history is wrong (b0d3967: until 2026-09-18
// every stored bar was a ~1 Hz point sample of flush-window opens --
// understated high/low, wrong close -- for every bar the EA's own
// backfill had not yet overwritten, i.e. everything older than the quick
// pass reaches). With this true AND ForceDeepBackfill true, the deep pass
// instead pages each symbol x timeframe BACKWARDS from now in
// HistoryBackfillBarCounts[]-sized CopyRates chunks until it reaches
// DeepBackfillFromDate or the broker has no older bars, one request per
// timer step exactly like the quick pass (see StepDeepBackfill), so a
// 3-hour pass still never freezes the tick push for longer than one
// request. Every page goes through the same /internal/history
// authoritative overwrite, so the result is the broker's own OHLC for
// every bucket from that date to now, on every timeframe.
//
// Deliberately gated on ForceDeepBackfill too: a fresh install (no
// DeepBackfillDone global variable yet) still gets the quick pass, so
// leaving this true in a saved Inputs set can never turn an ordinary
// reattach into hours of requests. The full pass is a one-off repair you
// ask for explicitly; set both back to false when it has logged
// "deep pass complete".
input bool   DeepBackfillFullHistory = false;
// UTC. Default = the day this store first received a bar (052de3a,
// 2026-08-12, the first EA build). Going further back than the store's
// oldest row is harmless (the engine just gains history it never had) but
// costs requests; note the engine's nightly M1/M5 retention
// (engine/market-data/src/retention.rs, 30/180 days) trims whatever M1
// lands older than that the following night regardless.
input datetime DeepBackfillFromDate  = D'2026.08.12 00:00';
// Floor between one full-history page and the next, replacing
// DEEP_BACKFILL_STAGE_SPACING_MS's 2s for the full pass only. Each page
// request blocks the tick push for its own duration (measured 1.3-10s),
// so at 2s spacing a multi-hour pass would keep the live feed frozen
// ~80% of the time; 5s makes it ~50% and costs ~40% more wall-clock.
// On a weekend (no ticks to starve) drop it to 500 and let it run flat
// out.
input int    DeepBackfillFullSpacingMs = 5000;
// v1.41 -- narrow a full-history pass to a few cells instead of the whole symbol x timeframe grid, to
// repair one gap (e.g. XAUUSD M15) without re-sending everything. Comma-separated; blank = all.
// Symbols are the CANONICAL names (what the platform stores, after SymbolMap), timeframes are
// M1,M5,M15,M30,H1,H4,D1,W1,MN1. Only the full-history pass honours them.
input string DeepBackfillSymbols    = "";
input string DeepBackfillTimeframes = "";

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

// Broker-server-time to UTC offset, in seconds (Pepperstone: +10800, i.e.
// UTC+3). CopyRates fills MqlRates.time with the TRADE SERVER's local
// time, not UTC -- so a bar sent straight from it lands in the engine's
// Candle table shifted by this much. That was live on Contabo: the newest
// stored bucketStart read 2026-08-31 13:53Z while UTC was 11:04Z, 2.81h
// ahead, and 3,915 rows sat in the future.
//
// The damage was on the chart, not just in the table. History bars came
// back at broker time while the live tick path computed its bucket in
// real UTC, so klinecharts' updateData was handed a timestamp ~3h older
// than the last history bar and dropped it -- the last candle simply
// stopped moving until a timeframe switch refetched history. Both halves
// were internally consistent, which is exactly why unit tests never
// caught it.
//
// Recomputed on every clock sync, not just at init: brokers shift this by
// an hour at DST boundaries, and a long-running terminal would otherwise
// keep writing bars an hour out from the moment that happened.
long BrokerOffsetSec = 0;

void RefreshBrokerOffset()
{
   // TimeTradeServer() is the broker's clock, TimeGMT() the terminal
   // host's idea of UTC. Both are datetime (seconds); their difference is
   // the offset to subtract from every CopyRates timestamp.
   //
   // Rounded to the whole minute: the two reads are one after the other,
   // so a second boundary falling between them yields 10799/10801 instead
   // of 10800 -- and that value then stays in force until the next clock
   // sync. Every bar of every history pass in between would be sent at
   // hh:mm:01 / hh:mm:59, i.e. one second beside the real bucket, and the
   // engine (which now also refuses off-grid bars, see
   // market_data::bucket_is_aligned) would never get the overwrite this
   // backfill exists for. No real broker offset has a seconds component
   // (whole hours, at worst :30), so rounding loses nothing.
   long raw = (long)TimeTradeServer() - (long)TimeGMT();
   long sign = raw < 0 ? -1 : 1;
   BrokerOffsetSec = sign * (((sign * raw) + 30) / 60) * 60;
}

// Steady-state shallow-backfill state. lastHistoryBackfillMs == 0 means
// "never run yet" -- OnInit's own call (StartDeepBackfill or
// RunShallowHistoryBackfill, see v1.35's OnInit) handles the "on init"
// half of the schedule; this is only for the "every
// HistoryBackfillIntervalSec" half, reset by both RunShallowHistoryBackfill
// and FinishDeepBackfill so the interval always counts from whichever
// backfill (deep or shallow) most recently finished.
uint lastHistoryBackfillMs = 0;

// fix/candle-gaps -- engine-restart recovery. An engine-only restart (MT5
// stays up) drops direct pushes while it's down; the engine's own flat-fill
// (d9b02ca) keeps the series contiguous, but those FLAT bars would then wait
// up to HistoryBackfillIntervalSec for the next shallow pass to become real
// OHLC. This detects the recover edge -- a run of failed direct pushes then
// a success -- and asks OnTimer to run a shallow backfill at once instead.
int  gSendFailStreak          = 0;
bool gRecoveryBackfillPending = false;
const int RECOVERY_BACKFILL_FAIL_THRESHOLD = 2; // 2 consecutive failed direct pushes = a real outage, not a one-off blip

// Every engine-configured timeframe (engine/market-data/src/lib.rs's
// TIMEFRAMES) that MT5's own CopyRates can actually serve. That's
// everything except Y1 -- MT5 has no native PERIOD_Y1 at all, so a
// yearly bar has no CopyRates call to make; see docs/ or the server-side
// migration note for how Y1 history gets populated instead (rolled up
// from D1, not backfilled from the terminal).
//
// 2026-09-08: M15 added (previously left out entirely -- no M15
// timeframe existed anywhere in the engine or its Postgres
// CandleTimeframe enum before now, so sending it would've just been
// silently skipped by ingest_history's own timeframe_from_str). W1 and
// MN1 added too -- these ARE natively CopyRates-able (PERIOD_W1/
// PERIOD_MN1 are standard MQL5 periods), they simply hadn't been added
// here yet; before this, W1/MN1/Y1 candles only ever came from the live
// tick-aggregation path, one bucket at a time, as real weeks/months
// actually elapsed -- which is why a freshly-started deployment's W1/MN1
// charts showed almost nothing.
//
// IMPORTANT: adding a period here does NOT retroactively backfill it on
// an EA that's already past its one-time deep pass (see
// DEEP_BACKFILL_DONE_GVAR / StartDeepBackfill's own doc comment) -- an
// already-running install needs ForceDeepBackfill set once (or that
// global variable cleared) after upgrading to this EA build, or it'll
// only start accumulating W1/M15/MN1 history live, going forward, same
// as before.
ENUM_TIMEFRAMES HistoryBackfillPeriods[] = { PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30, PERIOD_H1, PERIOD_H4, PERIOD_D1, PERIOD_W1, PERIOD_MN1 };
string HistoryBackfillPeriodNames[]     = { "M1",      "M5",      "M15",      "M30",      "H1",      "H4",      "D1",      "W1",      "MN1"      };
// Per timeframe, not one number for all of them (v1.34). A single count
// means the window this backfill can actually repair scales with the
// timeframe: at the previous flat 200, M30 reached only 4.2 days back, so
// a 30-day gap check on XAUUSD M30 still reported 446 missing buckets on
// Contabo while H1/H4/D1 all read zero. These target ~30 days each,
// capped where the payload/time budget says stop:
//
//   M1  1500 -> ~1 day     (30d would be 43,200 bars -- far past budget)
//   M5  1500 -> ~5 days    (30d would be 8,640)
//   M15 1500 -> ~15 days   (30d would be 2,880)
//   M30 1500 -> ~31 days   full window
//   H1   750 -> ~31 days   full window
//   H4   200 -> ~33 days   full window already
//   D1   200 -> 200 days   full window already
//   W1   200 -> ~3.8 years full window already
//   MN1  200 -> ~16.6 years full window already
//
// M1/M5/M15 stay deliberately short of 30 days: they are the timeframes a
// live feed refills fastest anyway, and going further (43,200 bars for a
// full 30d of M1) would blow both the payload size and
// HISTORY_WEBREQUEST_TIMEOUT_MS below. W1/MN1 need no such cap -- 200
// bars is already years of history at those periods, comfortably inside
// budget.
// Index-aligned with HistoryBackfillPeriods/HistoryBackfillPeriodNames
// above -- keep all three arrays in the same order.
//
// v1.35: only the STAGED deep pass (StartDeepBackfill/StepDeepBackfill)
// uses these counts now. Steady-state cycles use the much smaller flat
// HISTORY_BACKFILL_SHALLOW_BAR_COUNT below instead (see
// RunShallowHistoryBackfill) -- these deep counts are worth their ~37s-
// per-symbol cost exactly once, not every 15 minutes forever.
int HistoryBackfillBarCounts[]          = { 1500,      1500,      1500,      1500,      750,       200,       200,       200,       200      };
// Steady-state-only (see above) -- outage repair, not a full refill: the
// live tick feed already keeps recent history current, this just catches
// whatever gap happened while this EA/terminal wasn't running.
//
// fix/candle-gaps: per-timeframe now (was a flat 200), so the SHORT-window
// timeframes get deep enough coverage to self-heal a long outage without
// bloating the (blocking) shallow pass on the higher ones. 600 M1 bars =
// a 10-hour outage self-heals with real OHLC; M5 400 (~33h), M15 300
// (~75h); M30..MN1 already span days-to-years at 200. Index-aligned with
// HistoryBackfillPeriods / HistoryBackfillPeriodNames -- keep in order.
int HistoryBackfillShallowCounts[] = { 600, 400, 300, 200, 200, 200, 200, 200, 200 };
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

// v1.35 staged deep pass -- see StartDeepBackfill/StepDeepBackfill/
// FinishDeepBackfill. Walks the ActiveBrokerSymbols x HistoryBackfillPeriods
// grid as one flat cursor (symIdx = step / tfCount, tfIdx = step % tfCount)
// so it's a single number to persist and advance, not two nested ones.
// GlobalVariable (terminal-wide, survives EA reinit and, if the terminal
// shuts down cleanly, a restart too) remembers whether the deep pass has
// ever completed, so a plain reattach doesn't redo it -- ForceDeepBackfill
// above is the override.
const string DEEP_BACKFILL_DONE_GVAR = "VyXTraderPriceFeed_DeepBackfillDone";
// v1.43 -- one feed per terminal. Two instances (a stale chart left in the profile next to the real one)
// each pushed every symbol, each ran its own backfill passes, and one carried an old secret and got 401s.
// A TEMPORARY global variable (GlobalVariableTemp: never written to disk, gone when the terminal closes or
// crashes) holds the chart id of the instance that owns the feed; any other instance refuses to start.
const string INSTANCE_LOCK_GVAR = "VyXTraderPriceFeed_Instance";
bool g_ownsInstanceLock = false;
// v1.43 -- live-quote health: a terminal that is not connected to the trade server still serves CopyRates
// from its local history cache, so backfills "work" while no live tick ever arrives. Logged, not silent.
bool g_lastConnected = true;
uint g_lastConnectionCheckMs = 0;
uint g_lastDisconnectedLogMs = 0;
// Floor between one staged step and the next -- long enough that OnTick's
// own tick-driven pushes (and the next OnTimer's plain BuildAndSend) get a
// real gap to run in when a step finishes fast (H4/D1, ~1.3s measured).
// A slow step (M1/M5/M30, ~9-10s measured) already exceeds this on its
// own, so the next step fires as soon as that step's request returns --
// this floor only ever adds idle time for the fast steps, never stacks on
// top of a slow one.
const int DEEP_BACKFILL_STAGE_SPACING_MS = 2000;
bool DeepBackfillActive     = false;
int  DeepBackfillStep       = 0;
int  DeepBackfillTotalSteps = 0;
uint DeepBackfillStartMs    = 0;
uint lastDeepBackfillStepMs = 0;

// Full-history pass state (v1.40, see DeepBackfillFullHistory). The flat
// step cursor above still walks the symbol x timeframe grid; within one
// cell, DeepBackfillPage walks CopyRates backwards (start_pos = page x
// page size) and the cell only advances when a page proves there is
// nothing older worth sending (see StepDeepBackfill). Written once per
// finished pass into DEEP_BACKFILL_FULL_DONE_GVAR (the UTC time it
// completed), next to the plain done flag, so the Experts log / Global
// Variables window can show WHEN the store was last fully repaired.
const string DEEP_BACKFILL_FULL_DONE_GVAR = "VyXTraderPriceFeed_DeepBackfillFullDoneUtc";
// A page that comes back short is retried this many timer steps before
// the cell is declared finished: CopyRates for history the terminal has
// not loaded yet returns fewer bars (or -1 / error 4401) and starts a
// background download, so the same start_pos asked again a few seconds
// later returns the real page. 5 x DeepBackfillFullSpacingMs (25s at the
// default) is plenty for a download that is going to succeed at all; a
// broker that genuinely has no older bars just costs these few extra
// idempotent requests per symbol x timeframe.
//
// v1.41: 12 retries, at least DEEP_BACKFILL_RETRY_MIN_MS apart whatever the page spacing is. v1.40 retried
// on the page spacing itself, so at the 500 ms weekend setting its five retries were over in 2.5 s --
// far too soon for the terminal to have built the older M15 series -- and the cell then ended early.
const int  DEEP_BACKFILL_PAGE_RETRIES = 12;
const uint DEEP_BACKFILL_RETRY_MIN_MS = 5000;
uint DeepBackfillRetryAtMs     = 0;
bool DeepBackfillFull          = false;
long DeepBackfillFromUtc       = 0;
int  DeepBackfillPage          = 0;
int  DeepBackfillPageRetries   = 0;
int  DeepBackfillCellPages     = 0;   // pages sent for the current symbol x timeframe (summary line)
long DeepBackfillCellBars      = 0;
long DeepBackfillCellOldestUtc = 0;
int  DeepBackfillRequests      = 0;   // whole-pass totals for the final summary
int  DeepBackfillFailed        = 0;
long DeepBackfillBars          = 0;

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

   // Same cadence as the clock sync itself so a DST shift on the broker's
   // side is picked up within ClockSyncIntervalSec instead of at the next
   // terminal restart.
   RefreshBrokerOffset();
}

// v1.42 -- resolves the secret once per init: the ApiSecret input if set, else the first line of
// Common\Files\vyx_secret.txt (FILE_COMMON, so every terminal on the box shares it and a portable install
// finds it too). Surrounding whitespace, the line break and a UTF-8 BOM are stripped. Logs only WHERE the
// secret came from and its length, never the value.
void LoadApiSecret()
{
   g_apiSecret = ApiSecret;
   StringTrimLeft(g_apiSecret);
   StringTrimRight(g_apiSecret);
   if (StringLen(g_apiSecret) > 0)
   {
      g_apiSecretSource = "Inputs";
   }
   else
   {
      g_apiSecretSource = "";
      ResetLastError();
      int h = FileOpen(API_SECRET_FILE, FILE_READ | FILE_TXT | FILE_COMMON | FILE_ANSI);
      if (h == INVALID_HANDLE)
      {
         Print("VyXTraderPriceFeed: ApiSecret input is empty and Common\\Files\\", API_SECRET_FILE, " could not be opened (error ", GetLastError(), ")");
      }
      else
      {
         string line = FileIsEnding(h) ? "" : FileReadString(h);
         FileClose(h);
         if (StringLen(line) > 0 && StringGetCharacter(line, 0) == 0xFEFF) line = StringSubstr(line, 1);
         if (StringLen(line) >= 3 && StringGetCharacter(line, 0) == 0xEF && StringGetCharacter(line, 1) == 0xBB && StringGetCharacter(line, 2) == 0xBF)
            line = StringSubstr(line, 3); // a UTF-8 BOM read through FILE_ANSI
         StringTrimLeft(line);
         StringTrimRight(line);
         g_apiSecret = line;
         if (StringLen(g_apiSecret) > 0) g_apiSecretSource = "Common\\Files\\" + API_SECRET_FILE;
         else Print("VyXTraderPriceFeed: Common\\Files\\", API_SECRET_FILE, " is empty");
      }
   }
   if (StringLen(g_apiSecret) > 0)
      Print("VyXTraderPriceFeed: secret loaded from ", g_apiSecretSource, " (", StringLen(g_apiSecret), " chars)");
}

// True when this chart owns (or has just claimed) the feed. A holder whose chart no longer exists is stale
// (its EA was removed without OnDeinit, or the chart was closed) and is taken over.
bool ClaimSingleInstance()
{
   long me = ChartID();
   if (!GlobalVariableCheck(INSTANCE_LOCK_GVAR)) GlobalVariableTemp(INSTANCE_LOCK_GVAR);
   double holder = GlobalVariableGet(INSTANCE_LOCK_GVAR);
   if ((long)holder == me) return true;
   if (holder != 0 && ChartSymbol((long)holder) != "")
   {
      Print("VyXTraderPriceFeed: another instance already runs the feed on chart ", (long)holder, " (", ChartSymbol((long)holder),
            ") -- this one on chart ", me, " (", _Symbol, ") will not start. Close this chart, or remove the EA from it, so the profile keeps ONE feed.");
      return false;
   }
   return GlobalVariableSetOnCondition(INSTANCE_LOCK_GVAR, (double)me, holder);
}

int OnInit()
{
   // v1.43 -- one feed per terminal (see INSTANCE_LOCK_GVAR). Refusing here removes the EA from this chart,
   // so the next profile save drops the duplicate by itself.
   if (!ClaimSingleInstance()) return(INIT_FAILED);
   g_ownsInstanceLock = true;
   LoadApiSecret();
   ParseSymbolMap();
   // Before SyncClockOffset so a first backfill can't fire with a zero
   // offset if the handshake is slow or fails; SyncClockOffset refreshes
   // it again on every successful sync.
   RefreshBrokerOffset();
   RefreshActiveSymbols();
   SyncClockOffset();

   // v1.35 -- the staged deep pass runs at most once per terminal (see
   // DEEP_BACKFILL_DONE_GVAR's own comment), unless ForceDeepBackfill
   // overrides that. A plain reinit that isn't a deep pass still gets an
   // immediate shallow outage-repair pass, same as every version before
   // this one always did.
   bool deepAlreadyDone = GlobalVariableCheck(DEEP_BACKFILL_DONE_GVAR) && GlobalVariableGet(DEEP_BACKFILL_DONE_GVAR) > 0;
   // v1.40 -- the full-history pass needs BOTH inputs (see
   // DeepBackfillFullHistory's own comment for why a fresh install still
   // gets the quick pass); say so once rather than silently running the
   // quick one when someone set only half of it.
   if (DeepBackfillFullHistory && !ForceDeepBackfill)
      Print("VyXTraderPriceFeed (history backfill): DeepBackfillFullHistory=true is ignored without ForceDeepBackfill=true -- set both to run the full-history pass");
   // v1.43 -- say which history pass this init runs and why, so an unexpected full pass after a restart is
   // explained in the log (a chart whose saved inputs still say ForceDeepBackfill=true, or a done flag that
   // was never written because the terminal crashed mid-pass).
   Print("VyXTraderPriceFeed (history backfill) on init: ",
         ForceDeepBackfill ? (DeepBackfillFullHistory ? "FULL-HISTORY pass (ForceDeepBackfill=true, DeepBackfillFullHistory=true)" : "deep pass (ForceDeepBackfill=true)")
                           : (!deepAlreadyDone ? "deep pass (first run on this terminal: done flag not set)" : "shallow outage-repair pass only"),
         "; done flag ", deepAlreadyDone ? "set" : "NOT set");
   if (ForceDeepBackfill || !deepAlreadyDone)
      StartDeepBackfill();
   else
      RunShallowHistoryBackfill();

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
   if (g_ownsInstanceLock && GlobalVariableCheck(INSTANCE_LOCK_GVAR) && (long)GlobalVariableGet(INSTANCE_LOCK_GVAR) == ChartID())
      GlobalVariableSet(INSTANCE_LOCK_GVAR, 0);
   g_ownsInstanceLock = false;
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
   string payload = "{\"secret\":\"" + g_apiSecret + "\",\"ticks\":" + ticksJson + "}";
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
bool SendDirect(string ticksJson)
{
   string url = DirectServerUrl + "/internal/price-feed";
   string headers = "Content-Type: application/json\r\nx-price-feed-secret: " + g_apiSecret + "\r\n";

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
      return false;
   }
   else if (res != 200)
   {
      Print("VyXTraderPriceFeed (direct): server responded ", res, " — ", CharArrayToString(result));
      return false;
   }
   return true;
}

// fix/candle-open-seed (v1.40) -- the broker's OWN forming bar per
// timeframe, as of the tick being pushed, for the engine to seed each
// bucket's open (and widen high/low) from instead of from the first tick
// it happens to receive. BuildAndSend below reads SymbolInfoTick once per
// PushMinIntervalMs and only ever sees the LATEST tick of that window --
// so the first tick the engine gets after a minute boundary is not the
// tick MT5 opened the bar with, and the engine's insert-only "open = first
// tick seen" disagreed with this terminal's chart by however far the price
// moved inside that window (worse across the blocking history
// WebRequests, when nothing is pushed for seconds). This terminal already
// holds the true bar: CopyRates(sym, period, 0, 1) is bar 0 -- the same
// series the shallow backfill sends as authoritative every 300s, just read
// on every push so the forming candle is right NOW, not at the next pass.
//
// One object per HistoryBackfillPeriods entry (M1..MN1 -- everything the
// engine buckets except Y1, which MT5 has no period for), each with the
// bar's open time converted to UTC ms exactly as SendHistoryBars converts
// MqlRates.time (the engine only applies a bar whose time equals the
// bucket it computes for the tick itself, and counts a mismatch in
// /internal/feed-stats' broker_bars_mismatch_total). A period whose
// timeseries this terminal hasn't built yet (CopyRates < 1, or a zeroed
// bar) is simply left out of that push; the engine falls back to its
// sampled open for that timeframe until the next push carries it.
// Close is deliberately not sent -- the tick's own bid IS bar 0's close.
// Terse keys (tf/t/o/h/l): this rides on every tick, nine times over.
string BrokerBarsJson(string brokerSymbol)
{
   string out = "";
   MqlRates r[];
   for (int p = 0; p < ArraySize(HistoryBackfillPeriods); p++)
   {
      if (CopyRates(brokerSymbol, HistoryBackfillPeriods[p], 0, 1, r) < 1) continue;
      if (r[0].open <= 0 || r[0].low <= 0 || r[0].high < r[0].low) continue;
      if (StringLen(out) > 0) out += ",";
      out += StringFormat("{\"tf\":\"%s\",\"t\":%I64d,\"o\":%.5f,\"h\":%.5f,\"l\":%.5f}",
                          HistoryBackfillPeriodNames[p], ((long)r[0].time - BrokerOffsetSec) * 1000,
                          r[0].open, r[0].high, r[0].low);
   }
   return out;
}

// One /internal/history request's outcome, for the full-history pager
// (StepDeepBackfill) to decide whether there is an older page worth
// asking for. The quick pass and the shallow cycles ignore it.
struct HistoryPageResult
{
   int  copied;     // bars CopyRates returned at this start_pos (<= 0: none loaded there yet, or none exist)
   int  sent;       // bars in the request after the DeepBackfillFromDate trim (0 = no request was made)
   long oldestUtc;  // UTC epoch seconds of the oldest bar CopyRates returned, 0 if none
   bool failed;     // a request was made and did not return 200
};

// POST one symbol+timeframe's bars to engine/server's /internal/history
// (fix/realtime-sync §4): `barCount` bars starting `startPos` bars back
// from the newest (CopyRates' own start_pos/count -- 0/N is "the last N
// bars", the only shape this took before v1.40's full-history pager),
// dropping any bar older than `minUtcSec` (0 = keep all). Same auth
// header convention as SendDirect. Blocking, like every WebRequest call
// in this file -- MQL5 has no async HTTP -- so every call here pauses
// this EA's own tick pushes for however long this one request takes
// (measured ~1.3-10s depending on barCount, see the WebRequest call
// below). Callers control how many of these happen back to back:
// RunShallowHistoryBackfill loops every symbol x timeframe unstaged
// (cheap at HISTORY_BACKFILL_SHALLOW_BAR_COUNT), while StepDeepBackfill
// (v1.35) calls this at most once per stage spacing specifically so the
// deep pass's much larger HistoryBackfillBarCounts never compound into
// one long freeze.
void SendHistoryPage(string canonicalSymbol, string brokerSymbol, ENUM_TIMEFRAMES period, string timeframeName, int startPos, int barCount, long minUtcSec, HistoryPageResult &out)
{
   out.copied = 0; out.sent = 0; out.oldestUtc = 0; out.failed = false;

   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(brokerSymbol, period, startPos, barCount, rates);
   out.copied = copied;
   if (copied <= 0) return; // no history available (yet) for this symbol/period at this position -- nothing to send

   // rates[] is a series: [0] newest, [copied-1] oldest.
   out.oldestUtc = (long)rates[copied - 1].time - BrokerOffsetSec;

   string bars = "[";
   int sent = 0;
   for (int i = 0; i < copied; i++)
   {
      // -BrokerOffsetSec converts the trade server's local bar time to
      // UTC, which is what Candle.bucketStart is defined as everywhere
      // else in this system (the live tick path, the gap-fill tracker,
      // candle-gaps.ts's market-hours math). Sending it unconverted is
      // the bug this whole hotfix exists for -- see BrokerOffsetSec.
      long bucketStartSec = (long)rates[i].time - BrokerOffsetSec;
      if (minUtcSec > 0 && bucketStartSec < minUtcSec) continue; // older than the full-history floor -- the pager stops after this page anyway
      if (sent > 0) bars += ",";
      bars += StringFormat(
         "{\"bucket_start_ms\":%I64d,\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f}",
         bucketStartSec * 1000, rates[i].open, rates[i].high, rates[i].low, rates[i].close
      );
      sent++;
   }
   bars += "]";
   out.sent = sent;
   if (sent == 0) return; // every bar in this page predates minUtcSec

   // server_offset_sec travels with the payload so the engine can assert
   // the conversion actually happened rather than trusting it: a bar
   // batch whose newest bucket still sits ~offset seconds in the future
   // means an EA that didn't convert (an old build, most likely), and the
   // engine can say so loudly instead of silently storing broker time
   // again. Sent as the offset the EA USED, not as an instruction -- the
   // engine never applies it, it only checks the arithmetic.
   string json = "{\"symbol\":\"" + canonicalSymbol + "\",\"timeframe\":\"" + timeframeName
      + "\",\"server_offset_sec\":" + IntegerToString(BrokerOffsetSec)
      + ",\"bars\":" + bars + "}";
   string url = DirectServerUrl + "/internal/history";
   string headers = "Content-Type: application/json\r\nx-price-feed-secret: " + g_apiSecret + "\r\n";

   uchar body[];
   StringToCharArray(json, body, 0, StringLen(json), CP_UTF8);
   ArrayResize(body, StringLen(json)); // trim StringToCharArray's trailing null, same as SendDirect

   uchar result[];
   string resultHeaders;
   ResetLastError();
   // Bracketed with GetMicrosecondCount() so the Experts log carries the
   // real per-request duration. The bar counts above were sized off a
   // measurement taken on Contabo (~3-6s per 500 bars against Neon), which
   // puts a 1500-bar request at a projected ~9-18s -- inside the 30s
   // timeout, but with little enough margin that this needs to be
   // observable rather than assumed. If these lines start reading near
   // 30s, cut the counts before the timeouts come back.
   long beforeUs = (long)GetMicrosecondCount();
   int res = WebRequest("POST", url, headers, HISTORY_WEBREQUEST_TIMEOUT_MS, body, result, resultHeaders);
   long elapsedMs = ((long)GetMicrosecondCount() - beforeUs) / 1000;
   // "page N" only during the full-history pass so the quick/shallow
   // lines read exactly as they always have.
   string where = DeepBackfillFull ? StringFormat(" page %d (pos %d)", startPos / MathMax(barCount, 1), startPos) : "";
   if (res == -1)
   {
      out.failed = true;
      int err = GetLastError();
      if (err == 4060)
         Print("VyXTraderPriceFeed (history backfill): add ", DirectServerUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL");
      else
         Print("VyXTraderPriceFeed (history backfill): WebRequest failed for ", canonicalSymbol, " ", timeframeName, where, " after ", elapsedMs, "ms, error ", err);
   }
   else if (res != 200)
   {
      out.failed = true;
      Print("VyXTraderPriceFeed (history backfill): server responded ", res, " for ", canonicalSymbol, " ", timeframeName, where, " after ", elapsedMs, "ms — ", CharArrayToString(result));
   }
   else
   {
      // v1.44 -- a 200 is not proof anything was stored. The engine answers 200
      // {"ok":true,"upserted":0,"skipped_unrecognized_timeframe":true} for a timeframe
      // its build does not know (an engine older than 2026-09-08 did not know M15),
      // and this line used to call that a success: a whole M15 pass "succeeded"
      // while nothing reached the store. The engine's own count is logged now, and
      // a skipped timeframe is a loud warning and a failed page.
      string reply = CharArrayToString(result);
      int upserted = -1;
      int k = StringFind(reply, "\"upserted\":");
      if (k >= 0) upserted = (int)StringToInteger(StringSubstr(reply, k + 11));
      if (StringFind(reply, "\"skipped_unrecognized_timeframe\":true") >= 0)
      {
         out.failed = true;
         Print("VyXTraderPriceFeed (history backfill): ENGINE SKIPPED ", canonicalSymbol, " ", timeframeName, where,
               " -- its build does not recognise timeframe ", timeframeName, ", nothing was stored. Deploy a current engine, then rerun this timeframe.");
      }
      else
      {
         // Logged on success too, unlike every other call in this file: these
         // durations are the only evidence that the per-timeframe counts
         // above are still inside budget, and a backfill cycle is 60 lines
         // every 15 minutes, not per-tick spam.
         Print("VyXTraderPriceFeed (history backfill): ", canonicalSymbol, " ", timeframeName, where, " ", sent, " bars in ", elapsedMs, "ms",
               upserted >= 0 ? StringFormat(", engine stored %d", upserted) : "",
               where == "" ? "" : ", oldest " + TimeToString((datetime)out.oldestUtc, TIME_DATE | TIME_MINUTES) + " UTC");
      }
   }
}

// The pre-v1.40 shape: the last `barCount` bars, no floor. Quick deep
// pass and shallow cycles call this; only the full-history pager needs
// SendHistoryPage's extra arguments and result.
void SendHistoryBars(string canonicalSymbol, string brokerSymbol, ENUM_TIMEFRAMES period, string timeframeName, int barCount)
{
   HistoryPageResult ignored;
   SendHistoryPage(canonicalSymbol, brokerSymbol, period, timeframeName, 0, barCount, 0, ignored);
}

// Kicks off the staged deep pass (OnInit only, when it hasn't completed
// before or ForceDeepBackfill overrides that) -- just resets the cursor
// and marks it active; OnTimer's own check drives it one step at a time
// via StepDeepBackfill, never all at once.
void StartDeepBackfill()
{
   if (!UseDirectMode || StringLen(DirectServerUrl) == 0 || StringLen(g_apiSecret) == 0)
   {
      lastHistoryBackfillMs = GetTickCount(); // proxy mode / not configured -- same early-out convention as before
      return;
   }

   DeepBackfillTotalSteps = ArraySize(ActiveBrokerSymbols) * ArraySize(HistoryBackfillPeriods);
   if (DeepBackfillTotalSteps <= 0)
   {
      lastHistoryBackfillMs = GetTickCount();
      return;
   }

   DeepBackfillStep = 0;
   DeepBackfillStartMs = GetTickCount();
   lastDeepBackfillStepMs = 0; // fire the first step on the very next OnTimer, no initial 2s wait
   DeepBackfillActive = true;

   // v1.40 -- full-history mode (see DeepBackfillFullHistory). Same cursor,
   // same per-step pacing; the difference is inside StepDeepBackfill.
   DeepBackfillFull = (ForceDeepBackfill && DeepBackfillFullHistory);
   DeepBackfillFromUtc = (long)DeepBackfillFromDate;
   DeepBackfillPage = 0;
   DeepBackfillPageRetries = 0;
   DeepBackfillCellPages = 0;
   DeepBackfillCellBars = 0;
   DeepBackfillCellOldestUtc = 0;
   DeepBackfillRequests = 0;
   DeepBackfillFailed = 0;
   DeepBackfillBars = 0;
   if (DeepBackfillFull)
   {
      // The plan, up front, so the Experts log shows what was asked for and
      // roughly how long to expect before the first page line appears.
      // Pages are an estimate from the M1 span (the dominant cost): a
      // 5-day trading week is ~7,200 M1 bars, so weeks x 7200 / 1500.
      long spanSec = (long)TimeGMT() - DeepBackfillFromUtc;
      double weeks = spanSec / (7.0 * 86400.0);
      int m1Pages = (int)MathCeil(weeks * 7200.0 / HistoryBackfillBarCounts[0]);
      long maxBars = TerminalInfoInteger(TERMINAL_MAXBARS);
      Print("VyXTraderPriceFeed (history backfill): FULL-HISTORY deep pass from ",
            TimeToString((datetime)DeepBackfillFromUtc, TIME_DATE | TIME_MINUTES), " UTC (",
            DoubleToString(weeks, 1), " weeks): ", ArraySize(ActiveBrokerSymbols), " symbols x ",
            ArraySize(HistoryBackfillPeriods), " timeframes, ~", m1Pages, " M1 pages of ",
            HistoryBackfillBarCounts[0], " bars per symbol, ", DeepBackfillFullSpacingMs,
            "ms between pages; terminal max bars per chart = ", maxBars,
            (maxBars > 0 && maxBars < weeks * 7200.0) ? " -- TOO LOW for the M1 span, raise Tools > Options > Charts > Max bars in chart" : "",
            StringLen(DeepBackfillSymbols) + StringLen(DeepBackfillTimeframes) > 0
               ? "; ONLY symbols [" + (StringLen(DeepBackfillSymbols) > 0 ? DeepBackfillSymbols : "all") + "] x timeframes [" + (StringLen(DeepBackfillTimeframes) > 0 ? DeepBackfillTimeframes : "all") + "]"
               : "");
   }
}

void FinishDeepBackfill()
{
   DeepBackfillActive = false;
   lastHistoryBackfillMs = GetTickCount(); // steady-state interval starts counting from now, not from before the deep pass
   double elapsedSec = (GetTickCount() - DeepBackfillStartMs) / 1000.0;
   if (DeepBackfillFull)
   {
      Print("VyXTraderPriceFeed (history backfill): FULL-HISTORY deep pass complete in ", DoubleToString(elapsedSec, 1),
            "s -- ", DeepBackfillRequests, " requests (", DeepBackfillFailed, " failed), ", DeepBackfillBars,
            " bars sent, from ", TimeToString((datetime)DeepBackfillFromUtc, TIME_DATE | TIME_MINUTES), " UTC");
      // Evidence of WHEN the store was last fully repaired, readable from
      // the terminal's Global Variables window (F3) without the log.
      GlobalVariableSet(DEEP_BACKFILL_FULL_DONE_GVAR, (double)(long)TimeGMT());
      DeepBackfillFull = false;
   }
   else
   {
      Print("VyXTraderPriceFeed (history backfill): deep pass complete in ", DoubleToString(elapsedSec, 1), "s");
   }
   GlobalVariableSet(DEEP_BACKFILL_DONE_GVAR, 1);
   // v1.43 -- written to disk NOW: MT5 saves global variables only on a clean shutdown, so after an
   // "Abnormal termination" the flag was lost and the next start ran the whole deep pass again.
   GlobalVariablesFlush();
   // MQL5 cannot reset an input from code (see ForceDeepBackfill's own
   // comment) -- every future reinit repeats this pass until someone does.
   if (ForceDeepBackfill)
      Print("VyXTraderPriceFeed (history backfill): ForceDeepBackfill is still true -- set it (and DeepBackfillFullHistory) back to false in the Inputs tab, or the next reinit runs this whole pass again");
}

// One symbol x timeframe request per call, called from OnTimer at most
// once every DEEP_BACKFILL_STAGE_SPACING_MS -- see that constant's own
// comment. The longest continuous freeze the deep pass can cause is a
// single SendHistoryBars call (measured ~1.3-10s), never the whole grid
// back to back the way a flat loop would.
// True when `csv` is blank or lists `item` (case-insensitive) -- DeepBackfillSymbols / DeepBackfillTimeframes.
bool CsvContains(string csv, string item)
{
   string parts[];
   int n = SplitCsv(csv, parts);
   if (n == 0) return true;
   string want = item;
   StringToUpper(want);
   for (int i = 0; i < n; i++)
   {
      string p = parts[i];
      StringToUpper(p);
      if (p == want) return true;
   }
   return false;
}

// v1.41: whether the full-history pass works on this grid cell (DeepBackfillSymbols / DeepBackfillTimeframes).
bool DeepBackfillCellSelected(int step)
{
   if (!DeepBackfillFull) return true;
   int tfCount = ArraySize(HistoryBackfillPeriods);
   int symIdx = step / tfCount;
   if (symIdx >= ArraySize(ActiveBrokerSymbols)) return true; // out of range: let StepDeepBackfill finish
   return CsvContains(DeepBackfillSymbols, CanonicalFor(ActiveBrokerSymbols[symIdx]))
       && CsvContains(DeepBackfillTimeframes, HistoryBackfillPeriodNames[step % tfCount]);
}

void StepDeepBackfill()
{
   // skip the cells a narrowed full pass does not cover, without a request or a spacing wait each
   while (DeepBackfillStep < DeepBackfillTotalSteps && !DeepBackfillCellSelected(DeepBackfillStep))
      DeepBackfillStep++;
   if (DeepBackfillStep >= DeepBackfillTotalSteps)
   {
      FinishDeepBackfill();
      return;
   }

   int tfCount = ArraySize(HistoryBackfillPeriods);
   int symCount = ArraySize(ActiveBrokerSymbols);
   int symIdx = DeepBackfillStep / tfCount;
   int tfIdx  = DeepBackfillStep % tfCount;

   // ActiveBrokerSymbols can shrink mid-pass (RefreshActiveSymbols runs
   // every 30s off BuildAndSend) -- finish cleanly rather than an
   // out-of-range array access if it does.
   if (symIdx >= symCount)
   {
      FinishDeepBackfill();
      return;
   }

   string brokerSymbol = ActiveBrokerSymbols[symIdx];
   if (StringLen(brokerSymbol) > 0)
   {
      string canonicalSymbol = CanonicalFor(brokerSymbol);
      if (DeepBackfillFull)
      {
         // v1.40 full-history mode: one PAGE per step, same cell until it
         // is exhausted. See StepDeepBackfillFullPage for the stop rules.
         if (!StepDeepBackfillFullPage(canonicalSymbol, brokerSymbol, tfIdx))
         {
            lastDeepBackfillStepMs = GetTickCount();
            return; // more pages in this symbol x timeframe -- the cursor stays put
         }
      }
      else
      {
         SendHistoryBars(canonicalSymbol, brokerSymbol, HistoryBackfillPeriods[tfIdx], HistoryBackfillPeriodNames[tfIdx], HistoryBackfillBarCounts[tfIdx]);
      }
   }

   lastDeepBackfillStepMs = GetTickCount();
   DeepBackfillStep++;
   if (DeepBackfillStep >= DeepBackfillTotalSteps)
      FinishDeepBackfill();
}

// One page of the full-history pass for the current symbol x timeframe.
// Returns true when this cell is finished (the cursor may advance), false
// when the same cell has another page (or a retry) pending.
//
// Stop rules for a cell, in order:
//   * the page's oldest bar is at/before DeepBackfillFromDate -- reached
//     the floor (for pages after the first, the trim inside
//     SendHistoryPage already dropped anything older; page 0 is sent whole,
//     see below);
//   * a short page (fewer bars than asked, including 0) while the terminal
//     reports the series synchronized -- the broker has no older bars;
//   * a short page while NOT synchronized (the terminal is still pulling
//     that history from the broker), or a failed request: retry the same
//     page next step, up to DEEP_BACKFILL_PAGE_RETRIES, then give up on
//     the cell and say so. Re-sending a page is idempotent (authoritative
//     upsert), so a retry can only ever cost a request, never a wrong row.
bool StepDeepBackfillFullPage(string canonicalSymbol, string brokerSymbol, int tfIdx)
{
   ENUM_TIMEFRAMES period = HistoryBackfillPeriods[tfIdx];
   string tfName = HistoryBackfillPeriodNames[tfIdx];
   int pageSize = HistoryBackfillBarCounts[tfIdx];

   // A retry waits for the terminal's background download, not just for the page spacing (v1.41).
   if (DeepBackfillPageRetries > 0 && GetTickCount() - DeepBackfillRetryAtMs < DEEP_BACKFILL_RETRY_MIN_MS)
      return false; // same page, not yet -- no request this step

   // Page 0 is exactly the request the quick pass makes (the newest
   // HistoryBackfillBarCounts[] bars) and is never trimmed to the floor, so
   // a full pass is always a superset of a quick one -- D1/W1/MN1, whose
   // single 200-bar page reaches 200 days / ~4 years / ~16 years, keep that
   // depth instead of being cut to the few weeks since DeepBackfillFromDate.
   // Only the deeper pages honour the floor.
   HistoryPageResult r;
   SendHistoryPage(canonicalSymbol, brokerSymbol, period, tfName, DeepBackfillPage * pageSize, pageSize, DeepBackfillPage == 0 ? 0 : DeepBackfillFromUtc, r);
   if (r.sent > 0)
   {
      DeepBackfillRequests++;
      if (r.failed) DeepBackfillFailed++;
      else { DeepBackfillBars += r.sent; DeepBackfillCellBars += r.sent; DeepBackfillCellPages++; }
   }
   if (r.oldestUtc > 0 && (DeepBackfillCellOldestUtc == 0 || r.oldestUtc < DeepBackfillCellOldestUtc))
      DeepBackfillCellOldestUtc = r.oldestUtc;

   bool reachedFloor = (r.copied > 0 && r.oldestUtc <= DeepBackfillFromUtc);
   bool copyError    = (r.copied < 0); // CopyRates -1 (e.g. 4401 history not loaded): a failure, never "no older bars"
   bool shortPage    = (r.copied < pageSize);
   bool synced       = (bool)SeriesInfoInteger(brokerSymbol, period, SERIES_SYNCHRONIZED);

   // v1.41 -- a short page is the END of history only when that is proven, not merely because the series
   // reports SERIES_SYNCHRONIZED. v1.40 stopped on "short + synced", but the terminal builds a higher
   // timeframe's series lazily: CopyRates returns only the bars built so far (or -1) while the flag can
   // already be true, so XAUUSD M15 ended after ~16 days as "broker has no older bars" while M30 and H1
   // went back months. Proven = the terminal holds no bars past this page AND the oldest bar we got is
   // (within two bars of) the server's own first date for this series.
   int  terminalBars  = Bars(brokerSymbol, period);
   bool terminalMore  = terminalBars > DeepBackfillPage * pageSize + MathMax(r.copied, 0);
   long serverFirst   = (long)SeriesInfoInteger(brokerSymbol, period, SERIES_SERVER_FIRSTDATE); // broker time
   long oldestBroker  = r.oldestUtc > 0 ? r.oldestUtc + BrokerOffsetSec : 0;
   bool serverOlder   = serverFirst > 0 && (oldestBroker == 0 || oldestBroker - serverFirst > 2 * PeriodSeconds(period));
   bool provenEnd     = synced && !terminalMore && !serverOlder;
   bool needRetry     = r.failed || copyError || (shortPage && !reachedFloor && !provenEnd);

   if (needRetry && DeepBackfillPageRetries < DEEP_BACKFILL_PAGE_RETRIES)
   {
      DeepBackfillPageRetries++;
      DeepBackfillRetryAtMs = GetTickCount();
      Print("VyXTraderPriceFeed (history backfill): ", canonicalSymbol, " ", tfName, " page ", DeepBackfillPage,
            r.failed ? " failed" : copyError ? StringFormat(" CopyRates error %d", GetLastError()) : " short (terminal still loading history)",
            " -- retry ", DeepBackfillPageRetries, "/", DEEP_BACKFILL_PAGE_RETRIES,
            " [got ", r.copied, "/", pageSize, ", terminal bars ", terminalBars, ", server first ",
            serverFirst > 0 ? TimeToString((datetime)serverFirst, TIME_DATE | TIME_MINUTES) : "?", " broker time]");
      return false; // same page again once DEEP_BACKFILL_RETRY_MIN_MS has passed
   }
   if (needRetry)
   {
      long maxBars = TerminalInfoInteger(TERMINAL_MAXBARS);
      Print("VyXTraderPriceFeed (history backfill): ", canonicalSymbol, " ", tfName, " page ", DeepBackfillPage,
            " gave up after ", DEEP_BACKFILL_PAGE_RETRIES, " retries -- older history for this timeframe was NOT sent (terminal bars ",
            terminalBars, ", max bars per chart ", maxBars, (maxBars > 0 && terminalBars >= maxBars) ? " -- the limit, raise it" : "",
            "); rerun with DeepBackfillSymbols=", canonicalSymbol, " DeepBackfillTimeframes=", tfName);
   }

   bool cellDone = needRetry || reachedFloor || shortPage;
   if (!cellDone)
   {
      DeepBackfillPage++;
      DeepBackfillPageRetries = 0;
      return false;
   }

   Print("VyXTraderPriceFeed (history backfill): ", canonicalSymbol, " ", tfName, " full history done -- ",
         DeepBackfillCellPages, " pages, ", DeepBackfillCellBars, " bars, oldest ",
         DeepBackfillCellOldestUtc > 0 ? TimeToString((datetime)DeepBackfillCellOldestUtc, TIME_DATE | TIME_MINUTES) + " UTC" : "(none)",
         reachedFloor ? " (reached DeepBackfillFromDate)" : needRetry ? " (INCOMPLETE, see the line above)" : " (broker has no older bars)");
   DeepBackfillPage = 0;
   DeepBackfillPageRetries = 0;
   DeepBackfillCellPages = 0;
   DeepBackfillCellBars = 0;
   DeepBackfillCellOldestUtc = 0;
   return true;
}

// Unstaged, flat HISTORY_BACKFILL_SHALLOW_BAR_COUNT across every active
// symbol x every configured timeframe -- outage repair only (see that
// constant's own comment). Cheap enough (H4/D1-sized requests, ~1.3s
// each measured) not to need staging: runs immediately on a plain,
// non-deep init and every HistoryBackfillIntervalSec after that (see
// OnTimer), same direct-mode-only gate the deep pass uses.
void RunShallowHistoryBackfill()
{
   if (!UseDirectMode || StringLen(DirectServerUrl) == 0)
   {
      lastHistoryBackfillMs = GetTickCount(); // don't retry every cycle in proxy mode, same as SyncClockOffset
      return;
   }
   if (StringLen(g_apiSecret) == 0) return; // BuildAndSend already warns about this; avoid a duplicate log line here

   for (int i = 0; i < ArraySize(ActiveBrokerSymbols); i++)
   {
      string brokerSymbol = ActiveBrokerSymbols[i];
      if (StringLen(brokerSymbol) == 0) continue;
      string canonicalSymbol = CanonicalFor(brokerSymbol);
      for (int p = 0; p < ArraySize(HistoryBackfillPeriods); p++)
         SendHistoryBars(canonicalSymbol, brokerSymbol, HistoryBackfillPeriods[p], HistoryBackfillPeriodNames[p], HistoryBackfillShallowCounts[p]);
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
   if (StringLen(g_apiSecret) == 0)
   {
      Print("VyXTraderPriceFeed: no secret -- set ApiSecret in the Inputs tab, or put it in Common\\Files\\", API_SECRET_FILE, " and reinit; nothing is pushed until then");
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

      // v1.37 staleness fix -- tick_ms is the REAL last-tick time (unlike
      // t0 above, which is this send's own wall-clock time and gets
      // recomputed fresh on every heartbeat resend regardless of whether
      // the underlying price actually moved). tick.time_msc is the trade
      // SERVER's own clock (same as MqlRates.time, the reason
      // BrokerOffsetSec exists at all -- see that variable's own comment),
      // so it needs the identical correction applied to convert it to
      // real UTC ms before the engine can compare it against its own
      // clock. On a heartbeat resend of an unchanged price this is
      // unchanged from the last real send (TrackedTimeMsc[idx] just got
      // reassigned its own current value above, a no-op when nothing
      // moved) -- exactly what lets a frozen weekend/outage price be told
      // apart from a live one server-side (LivePrice.tickAt).
      long tickMs = tick.time_msc - (BrokerOffsetSec * 1000);

      if (!first) json += ",";
      // %I64d, not %d -- t0 is a 64-bit long (ms since epoch); %d is
      // MQL5's 32-bit specifier and silently truncates it, corrupting
      // every downstream latency measurement (confirmed live: the VPS
      // deployment's /internal/feed-stats showed t0 collapsing to a tiny
      // leftover value once real Exness ticks started flowing).
      // broker_offset_sec travels on every tick now, not just
      // /internal/history's backfill bars (hotfix/history-broker-time) --
      // the live tick-aggregation path needs it too, to bucket D1/W1/MN1/
      // Y1 candles at the broker's own day boundary instead of naive UTC
      // midnight (see market_data::bucket_start's own doc comment for the
      // duplicate-D1-bar bug this fixes). Always sent, not conditional
      // like clock_offset_ms below -- BrokerOffsetSec is computed at
      // OnInit and refreshed on every clock sync (RefreshBrokerOffset),
      // so unlike the clock-sync handshake it's never "not yet measured."
      json += StringFormat("{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,\"t0\":%I64d,\"tick_ms\":%I64d,\"broker_offset_sec\":%I64d", CanonicalFor(brokerSymbol), tick.bid, tick.ask, t0, tickMs, BrokerOffsetSec);
      // clock_offset_ms/rtt_ms are omitted entirely (not sent as 0) until
      // the first real handshake succeeds -- matches protocol::Tick's
      // Option<i64> fields on the Rust side, which skip serializing when
      // absent; sending a fake 0 here would misreport an unmeasured
      // offset as a measured one in /internal/feed-stats.
      if (HasClockSync)
         json += StringFormat(",\"clock_offset_ms\":%I64d,\"rtt_ms\":%I64d", ClockOffsetMs, LastRttMs);
      // fix/candle-open-seed (v1.40) -- this terminal's own forming bars,
      // read in the same pass as the tick (see BrokerBarsJson). Omitted
      // entirely (not sent as []) when nothing could be read, matching
      // protocol::Tick's serde default on the engine side.
      string bars = BrokerBarsJson(brokerSymbol);
      if (StringLen(bars) > 0)
         json += ",\"bars\":[" + bars + "]";
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
      // fix/candle-gaps -- watch for the engine-restart recover edge (see
      // gRecoveryBackfillPending's own comment): a run of failed direct
      // pushes then a success means the engine was down and is back, so ask
      // OnTimer to repair the outage gap with a prompt shallow backfill.
      bool sendOk = SendDirect(json);
      if (sendOk)
      {
         if (gSendFailStreak >= RECOVERY_BACKFILL_FAIL_THRESHOLD)
            gRecoveryBackfillPending = true;
         gSendFailStreak = 0;
      }
      else
      {
         gSendFailStreak++;
      }
   }
   else
   {
      SendViaProxy(json);
   }
}

// v1.43 -- every 5 s: is the terminal connected to the trade server? Logs the change both ways, and a
// reminder once a minute while it stays down (history keeps flowing from the local cache; live ticks do not).
void CheckConnection()
{
   uint now = GetTickCount();
   if (now - g_lastConnectionCheckMs < 5000) return;
   g_lastConnectionCheckMs = now;
   bool connected = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   if (connected && !g_lastConnected)
      Print("VyXTraderPriceFeed: terminal reconnected to the trade server -- live quotes flowing again");
   if (!connected && (g_lastConnected || now - g_lastDisconnectedLogMs >= 60000))
   {
      Print("VyXTraderPriceFeed: terminal is NOT connected to the trade server -- no live quotes, only cached history. Check the account login (Journal: 'authorized on ...') and the connection status bottom-right.");
      g_lastDisconnectedLogMs = now;
   }
   g_lastConnected = connected;
}

void OnTimer()
{
   CheckConnection();
   BuildAndSend();

   // v1.35 -- while the staged deep pass is in flight, it owns this
   // timer's backfill slot entirely (one step at a time, see
   // StepDeepBackfill's own comment); the steady-state interval check
   // below doesn't run again until FinishDeepBackfill resets
   // lastHistoryBackfillMs.
   if (DeepBackfillActive)
   {
      // v1.40: the full-history pass paces itself off its own input (see
      // DeepBackfillFullSpacingMs) -- a multi-hour pass at the quick pass's
      // 2s would keep the tick push frozen most of the time.
      int spacingMs = DeepBackfillFull ? MathMax(DeepBackfillFullSpacingMs, 0) : DEEP_BACKFILL_STAGE_SPACING_MS;
      if (GetTickCount() - lastDeepBackfillStepMs >= (uint)spacingMs)
         StepDeepBackfill();
      return;
   }

   // fix/candle-gaps -- the engine just recovered from an outage (see
   // BuildAndSend): repair its gap NOW rather than waiting for the interval
   // below. Runs here on OnTimer, not OnTick, because the backfill
   // WebRequests block the EA thread.
   if (gRecoveryBackfillPending)
   {
      gRecoveryBackfillPending = false;
      Print("VyXTraderPriceFeed: direct feed recovered after an outage -- running a shallow backfill to fill the gap with real OHLC");
      RunShallowHistoryBackfill();
      return; // RunShallowHistoryBackfill reset lastHistoryBackfillMs; skip the interval check this cycle
   }

   // fix/realtime-sync §4 -- "every 15 min" half of the backfill schedule.
   // Checked on the same timer as tick pushes rather than a second MQL5
   // timer (an EA only gets one via EventSetTimer/EventSetMillisecondTimer),
   // same pattern BuildAndSend already uses for ClockSyncIntervalSec.
   if (GetTickCount() - lastHistoryBackfillMs >= (uint)(HistoryBackfillIntervalSec * 1000))
      RunShallowHistoryBackfill();
}
//+------------------------------------------------------------------+
