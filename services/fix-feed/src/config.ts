// Everything comes from the environment. ENV_FILE (optional) names a dotenv file loaded first; real environment
// variables win over it. No value read here is ever logged except the ones describeConfig() prints, and that
// never includes FIX_PASSWORD or FEED_SECRET.

import { brokerOffsetSec } from "./offset.ts";

// cTrader symbol name -> platform (canonical) name. The canonical names are the platform's Symbol.name values
// (lib/starter-state.ts); a cTrader name not listed here is sent under its own name, exactly as the MT5 EA does
// for a broker symbol missing from its SymbolMap. FIX_SYMBOL_MAP entries override these.
export const DEFAULT_SYMBOL_MAP: Readonly<Record<string, string>> = {
  USTEC: "NAS100",
  NAS100: "NAS100",
  US100: "NAS100",
  US30: "US30",
  DJ30: "US30",
  US500: "US500",
  SPX500: "US500",
  XTIUSD: "SpotCrude",
  USOIL: "SpotCrude",
  WTI: "SpotCrude",
  XBRUSD: "SpotBrent",
  UKOIL: "SpotBrent",
  BRENT: "SpotBrent",
};

// Same instruments as the MT5 EA's default SymbolList, in cTrader naming.
export const DEFAULT_SYMBOLS = "XAUUSD,EURUSD,GBPUSD,BTCUSD,US30,USDJPY,AUDUSD,XAGUSD,ETHUSD,USTEC";

export interface Config {
  host: string;
  port: number;
  ssl: boolean;
  senderCompId: string;
  targetCompId: string;
  senderSubId: string;
  targetSubId: string;
  username: string;
  password: string;
  heartbeatSec: number;
  maxLogonFailures: number;               // consecutive rejected/unanswered logons before giving up; 0 = never
  symbols: string[];                       // cTrader names to subscribe
  symbolIds: Record<string, string>;       // cTrader name -> numeric FIX Symbol(55), when set by hand
  symbolMap: Record<string, string>;       // cTrader name -> canonical name
  feedUrl: string;                         // engine base URL (EA's DirectServerUrl); "" = dry run, nothing is POSTed
  feedSecret: string;
  pushMinIntervalMs: number;
  heartbeatSnapshotMs: number;
  clockSyncIntervalSec: number;
  brokerOffset: () => number;
  jsonlPath: string;                       // every push batch appended here when set
  statsIntervalSec: number;
  gapAlertMs: number;
  runSeconds: number;                      // 0 = run until stopped
  summaryPath: string;
}

function pairs(csv: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of csv.split(",")) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return out;
}

function int(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} is not a number`);
  return n;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = (env[key] ?? "").trim();
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // loadEnvFile never overrides a variable already set in the environment.
  if (env === process.env && env.ENV_FILE) process.loadEnvFile(env.ENV_FILE);

  const senderCompId = required(env, "FIX_SENDER_COMP_ID");
  // cTrader's Username(553) is the trading account number, which is the last dot-separated part of the
  // SenderCompID (demo.<broker>.<login>).
  const username = (env.FIX_USERNAME ?? "").trim() || senderCompId.split(".").pop() || "";

  const offsetSetting = (env.BROKER_OFFSET_SEC ?? "ny-close").trim();
  const fixedOffset = offsetSetting === "ny-close" ? undefined : Number(offsetSetting);
  if (fixedOffset !== undefined && !Number.isInteger(fixedOffset)) throw new Error("BROKER_OFFSET_SEC must be an integer or ny-close");

  return {
    host: required(env, "FIX_HOST"),
    port: int(env, "FIX_PORT", 5211),
    ssl: !/^(0|false|no)$/i.test(env.FIX_SSL ?? "true"),
    senderCompId,
    targetCompId: env.FIX_TARGET_COMP_ID || env.TARGET || "cServer",
    senderSubId: env.FIX_SENDER_SUB_ID || "QUOTE",
    targetSubId: env.FIX_TARGET_SUB_ID || "QUOTE",
    username,
    password: required(env, "FIX_PASSWORD"),
    heartbeatSec: int(env, "FIX_HEARTBEAT_SEC", 30),
    maxLogonFailures: int(env, "FIX_MAX_LOGON_FAILURES", 3),
    symbols: (env.FIX_SYMBOLS || DEFAULT_SYMBOLS).split(",").map((s) => s.trim()).filter(Boolean),
    symbolIds: pairs(env.FIX_SYMBOL_IDS ?? ""),
    symbolMap: { ...DEFAULT_SYMBOL_MAP, ...pairs(env.FIX_SYMBOL_MAP ?? "") },
    feedUrl: (env.FEED_URL ?? "").replace(/\/+$/, ""),
    feedSecret: env.FEED_SECRET || env.PRICE_FEED_SECRET || "",
    pushMinIntervalMs: int(env, "FEED_PUSH_MIN_INTERVAL_MS", 50),
    heartbeatSnapshotMs: int(env, "FEED_SNAPSHOT_INTERVAL_MS", 5000),
    clockSyncIntervalSec: int(env, "FEED_CLOCK_SYNC_INTERVAL_SEC", 60),
    brokerOffset: fixedOffset === undefined ? () => brokerOffsetSec() : () => fixedOffset,
    jsonlPath: env.FEED_JSONL ?? "",
    statsIntervalSec: int(env, "STATS_INTERVAL_SEC", 60),
    gapAlertMs: int(env, "GAP_ALERT_MS", 10_000),
    runSeconds: int(env, "RUN_SECONDS", 0),
    summaryPath: env.SUMMARY_JSON ?? "",
  };
}

export function canonicalFor(cfg: Config, ctraderName: string): string {
  return cfg.symbolMap[ctraderName] ?? ctraderName;
}

export function describeConfig(cfg: Config): string {
  return [
    `fix ${cfg.ssl ? "ssl" : "tcp"}://${cfg.host}:${cfg.port} ${cfg.senderCompId}/${cfg.senderSubId} -> ${cfg.targetCompId}/${cfg.targetSubId}`,
    `symbols ${cfg.symbols.map((s) => (canonicalFor(cfg, s) === s ? s : `${s}->${canonicalFor(cfg, s)}`)).join(",")}`,
    `output ${cfg.feedUrl ? `${cfg.feedUrl}/internal/price-feed (secret ${cfg.feedSecret ? "set" : "MISSING"})` : "dry run (no HTTP)"}${cfg.jsonlPath ? `, jsonl ${cfg.jsonlPath}` : ""}`,
    `broker_offset_sec ${cfg.brokerOffset()}`,
  ].join("\n");
}
