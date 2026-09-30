// Step 2 (owner 2026-09-30): the web addresses a broker is reached at -- the typed-confirm value for broker-wide
// actions (EMG Sign out all clients). The subdomain host first (what the backoffice shows), then the custom domain.
export function brokerHosts(broker: { subdomain: string; customDomain: string | null }): string[] {
  const root = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0].toLowerCase();
  const hosts = [`${broker.subdomain}.${root}`.toLowerCase()];
  if (broker.customDomain) {
    const bare = broker.customDomain.toLowerCase().replace(/^www\./, "");
    hosts.push(bare, `www.${bare}`);
  }
  return hosts;
}
