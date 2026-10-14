// The server list a broker's sign-in card offers (owner 2026-10-14). Named like MT5 servers: "<BrokerName>Live" and
// "<BrokerName>Demo" (FuturixGlobalLive, FuturixGlobalDemo). The list always comes from the server, never from the build,
// so a broker that later runs several live nodes (FuturixGlobalLive-1 … -4) gets them without a new desktop build. Until
// multi-node exists (a per-broker server table, Settings → Servers) the list is derived from the broker's name.

export type ServerKind = "LIVE" | "DEMO";
export type BrokerServer = { name: string; kind: ServerKind };

/** "Futurix Global" -> "FuturixGlobal": letters and digits only, each word's first letter kept as typed. */
export function compactBrokerName(name: string): string {
  const compact = name.replace(/[^A-Za-z0-9]/g, "");
  return compact || "VyXTrader";
}

export function brokerServers(brokerName: string): BrokerServer[] {
  const base = compactBrokerName(brokerName);
  return [
    { name: `${base}Live`, kind: "LIVE" },
    { name: `${base}Demo`, kind: "DEMO" },
  ];
}

/** "This account belongs to the Demo server" / "...Live server": the one-line refusal when the chosen server's kind is not the account's. */
export function mismatchText(actual: ServerKind): string {
  return `This account belongs to the ${actual === "LIVE" ? "Live" : "Demo"} server`;
}

/** The kind the server's own refusal names ("this is a Demo account, select the Demo server and try again", POST /api/trade/login
 *  with a wrong accountMode); null when the text is not that refusal. */
export function kindFromRefusal(error: string | null | undefined): ServerKind | null {
  const e = (error ?? "").toLowerCase();
  if (e.includes("this is a demo account")) return "DEMO";
  if (e.includes("this is a live account")) return "LIVE";
  return null;
}

/** True when the chosen server can sign this account in. `accountMode` is the account's own flag from the login answer; a flag the
 *  server did not send (an older server) is not a mismatch. */
export function serverMatches(chosen: ServerKind, accountMode: string | null | undefined): boolean {
  const a = (accountMode ?? "").trim().toUpperCase();
  if (a !== "LIVE" && a !== "DEMO") return true;
  return chosen === a;
}

/** The entry of the account's real kind (for the automatic switch after a refusal): the preferred name when it has that kind, else the first. */
export function serverForKind(servers: readonly BrokerServer[], kind: ServerKind, preferName?: string): BrokerServer | null {
  const ofKind = servers.filter((s) => s.kind === kind);
  return ofKind.find((s) => s.name === preferName) ?? ofKind[0] ?? null;
}
