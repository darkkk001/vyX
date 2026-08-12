//+------------------------------------------------------------------+
//|                                          VyXTraderPriceFeed.mq5   |
//| Pushes live bid/ask from this MT5 terminal to VyXTrader so the    |
//| WebTrader chart shows real prices instead of the simulator.       |
//| Temporary bridge — Phase 5 replaces this with a real LP feed;     |
//| nothing downstream changes since it only ever reads the           |
//| LivePrice table this EA feeds.                                    |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"

input string ServerUrl            = "https://www.vyxtrader.com/api/internal/price-feed";
input string ApiSecret            = "a572bf5ea373c634fb63c0c3b6b21db4b4ad8f0d50056d2a";
input int    PushIntervalSeconds  = 1;

// Map VyXTrader's canonical symbol name -> this broker's actual MT5 symbol
// name. Edit the right-hand column if your account suffixes symbols
// (e.g. "EURUSDm", "XAUUSDm") or names indices differently
// (e.g. "US30Cash", "NAS100Cash") — check your Market Watch for the exact
// spelling. Leave a row's right side blank ("") to skip that symbol.
string CanonicalNames[] = {"XAUUSD","EURUSD","GBPUSD","BTCUSD","US30","USDJPY","AUDUSD","XAGUSD","ETHUSD","NAS100"};
string BrokerNames[]    = {"XAUUSD","EURUSD","GBPUSD","BTCUSD","US30","USDJPY","AUDUSD","XAGUSD","ETHUSD","NAS100"};

int OnInit()
{
   EventSetTimer(PushIntervalSeconds);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
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

void OnTimer()
{
   string json = "[";
   bool first = true;
   for (int i = 0; i < ArraySize(CanonicalNames); i++)
   {
      if (StringLen(BrokerNames[i]) == 0) continue;
      double bid = SymbolInfoDouble(BrokerNames[i], SYMBOL_BID);
      double ask = SymbolInfoDouble(BrokerNames[i], SYMBOL_ASK);
      if (bid <= 0 || ask <= 0) continue; // not in Market Watch / wrong name
      if (!first) json += ",";
      json += StringFormat("{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f}", CanonicalNames[i], bid, ask);
      first = false;
   }
   json += "]";
   if (first) return; // nothing resolved, don't push an empty array

   // secret + ticks travel base64url-encoded in the URL PATH, not the query
   // string — some network paths between broker MT5 terminals and the
   // server strip query strings entirely (confirmed via the server echoing
   // back what it received: secret/data both arrived null), so nothing
   // after "?" survives. A path segment isn't touched by that.
   string payload = "{\"secret\":\"" + ApiSecret + "\",\"ticks\":" + json + "}";
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
//+------------------------------------------------------------------+
