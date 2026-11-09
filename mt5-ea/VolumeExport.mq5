//+------------------------------------------------------------------+
//| VolumeExport.mq5 - READ-ONLY script (owner 2026-11-09)           |
//| For the volume-only backfill (scripts/volume-backfill): exports  |
//| MqlRates.tick_volume per symbol, timeframe and bar between From  |
//| and To (MT5 server time) to MQL5\Files\volume_export.csv as      |
//|   symbol,timeframe,server_time,tick_volume                       |
//| No orders, no chart changes, no global variables: it only reads  |
//| history and writes one CSV file. Export a few days past the gaps |
//| too: those bars (with our own counts) give the tool its scale.   |
//+------------------------------------------------------------------+
#property script_show_inputs
input string   Symbols    = "XAUUSD,EURUSD,GBPUSD,USDJPY,BTCUSD,US30";
input string   Timeframes = "M1,M5,M15,M30,H1,H4,D1,W1,MN1";
input datetime From       = D'2015.01.01 00:00';
input datetime To         = D'2026.11.12 00:00';

ENUM_TIMEFRAMES Tf(string s)
{
   if(s == "M1") return PERIOD_M1;   if(s == "M5") return PERIOD_M5;   if(s == "M15") return PERIOD_M15;
   if(s == "M30") return PERIOD_M30; if(s == "H1") return PERIOD_H1;   if(s == "H4") return PERIOD_H4;
   if(s == "D1") return PERIOD_D1;   if(s == "W1") return PERIOD_W1;   if(s == "MN1") return PERIOD_MN1;
   return PERIOD_CURRENT;
}

int OnStart()
{
   string syms[], tfs[];
   int ns = StringSplit(Symbols, ',', syms), nt = StringSplit(Timeframes, ',', tfs);
   int fh = FileOpen("volume_export.csv", FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
   if(fh == INVALID_HANDLE) { Print("VolumeExport: cannot open the CSV"); return 1; }
   FileWrite(fh, "symbol", "timeframe", "server_time", "tick_volume");
   long total = 0;
   for(int s = 0; s < ns; s++)
   {
      string sym = syms[s]; StringTrimLeft(sym); StringTrimRight(sym);
      if(!SymbolSelect(sym, true)) { Print("VolumeExport: no symbol ", sym); continue; }
      for(int t = 0; t < nt; t++)
      {
         string tfn = tfs[t]; StringTrimLeft(tfn); StringTrimRight(tfn);
         ENUM_TIMEFRAMES tf = Tf(tfn);
         if(tf == PERIOD_CURRENT) { Print("VolumeExport: unknown timeframe ", tfn); continue; }
         MqlRates r[]; int n = CopyRates(sym, tf, From, To, r);
         if(n <= 0) { Print("VolumeExport: ", sym, " ", tfn, ": no bars (", GetLastError(), ")"); continue; }
         for(int i = 0; i < n; i++) FileWrite(fh, sym, tfn, TimeToString(r[i].time, TIME_DATE | TIME_MINUTES), (long)r[i].tick_volume);
         total += n;
         Print("VolumeExport: ", sym, " ", tfn, ": ", n, " bars from ", TimeToString(r[0].time), " to ", TimeToString(r[n - 1].time));
      }
   }
   FileClose(fh);
   Print("VolumeExport: done, ", total, " bars");
   return 0;
}
