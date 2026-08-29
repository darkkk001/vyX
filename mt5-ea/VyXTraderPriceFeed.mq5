//+------------------------------------------------------------------+
//|                                          VyXTraderPriceFeed.mq5   |
//| Pushes live bid/ask from this MT5 terminal to VyXTrader so the    |
//| WebTrader chart shows real prices instead of the simulator.       |
//| Temporary bridge — Phase 5 replaces this with a real LP feed;     |
//| nothing downstream changes since it only ever reads the           |
//| LivePrice table this EA feeds.                                    |
//+------------------------------------------------------------------+
#property strict
#property version   "1.21"

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

// Refreshed by RefreshActiveSymbols() -- the actual broker-native symbol
// names read via SymbolInfoDouble each push, regardless of SymbolSource.
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

int OnInit()
{
   ParseSymbolMap();
   RefreshActiveSymbols();
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
   int res = WebRequest("GET", url, "", 5000, noData, result, resultHeaders);
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
   int res = WebRequest("POST", url, headers, 5000, body, result, resultHeaders);
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

// Shared by OnTick and OnTimer -- both push the exact same multi-symbol
// snapshot (current SymbolInfoDouble for every configured symbol), never
// a single symbol's delta, so there's nothing OnTick-specific to build
// differently from what OnTimer always sent.
void BuildAndSend()
{
   if (StringLen(ApiSecret) == 0)
   {
      Print("VyXTraderPriceFeed: ApiSecret is empty -- set it in this EA's Inputs tab before it will push anything");
      return;
   }

   // Origin timestamp for the latency audit -- MUST be UTC epoch ms, since
   // the engine computes latency as (its own UTC now) - t0. A real, live
   // bug: this used to use TimeCurrent() (the TRADE SERVER's local time,
   // not UTC -- Pepperstone runs UTC+3) instead of TimeGMT() (actual
   // UTC/GMT). That constant +3h offset alone produced a steady
   // -10,800,000ms p50 on Contabo once real Pepperstone ticks started
   // flowing -- not a latency measurement, a timezone bug wearing a
   // latency measurement's clothes. GetMicrosecondCount() was also wrong
   // for the sub-second component (a monotonic counter since terminal
   // start, uncorrelated with true wall-clock sub-second position) --
   // reverted to GetTickCount()%1000, which has the exact same
   // uncorrelated-with-wall-clock caveat but at least doesn't compound
   // it with a second, unrelated bug. Sub-second precision here is
   // genuinely only approximate either way; the engine now treats
   // anything outside a plausible latency range as garbage (t0_invalid)
   // rather than trusting it, which is the real fix for that half of it.
   long t0 = (long)TimeGMT() * 1000 + (long)(GetTickCount() % 1000);

   // Re-discovers Market Watch's current selection every 30s (LIST mode
   // just re-parses the same static SymbolList -- harmless, kept
   // unconditional rather than mode-branching the refresh timing too).
   if (GetTickCount() - lastSymbolRefreshMs >= (uint)SYMBOL_REFRESH_INTERVAL_MS)
      RefreshActiveSymbols();

   string json = "[";
   bool first = true;
   for (int i = 0; i < ArraySize(ActiveBrokerSymbols); i++)
   {
      string brokerSymbol = ActiveBrokerSymbols[i];
      if (StringLen(brokerSymbol) == 0) continue;
      double bid = SymbolInfoDouble(brokerSymbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(brokerSymbol, SYMBOL_ASK);
      if (bid <= 0 || ask <= 0) continue; // not in Market Watch / wrong name
      if (!first) json += ",";
      // %I64d, not %d -- t0 is a 64-bit long (ms since epoch); %d is
      // MQL5's 32-bit specifier and silently truncates it, corrupting
      // every downstream latency measurement (confirmed live: the VPS
      // deployment's /internal/feed-stats showed t0 collapsing to a tiny
      // leftover value once real Exness ticks started flowing).
      json += StringFormat("{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,\"t0\":%I64d}", CanonicalFor(brokerSymbol), bid, ask, t0);
      first = false;
   }
   json += "]";
   if (first) return; // nothing resolved, don't push an empty array

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
}
//+------------------------------------------------------------------+
