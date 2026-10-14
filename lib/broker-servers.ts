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
