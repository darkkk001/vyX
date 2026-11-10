// The platform a client trades on is the broker's own brand (owner 2026-11-10): never the technology's name. Settings shows
// the tenant's full name (Broker.name, e.g. "Futurix Global"); the account card's chip its short brand, the first word
// ("Futurix"). A one-word name stays whole ("TradeNext").
export type PlatformBrand = { name: string; short: string };

export function platformBrand(brokerName: string): PlatformBrand {
  const name = brokerName.trim().replace(/\s+/g, " ");
  return { name, short: name.split(" ")[0] ?? name };
}
