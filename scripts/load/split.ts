// Stage 6 split harness -- who owns what in a seeded world (docs/STAGE6-PLAN.md, "the split proof").
//
// ONE rule, lib/risk-authority.ts riskOwnerOf, applied to the broker flags and the account modes this file assigns
// deterministically from the world. Used by the seeder (writes the flags and modes), by the checker (what each action's
// actor should have been), and by the drill.
//
// Variants:
//   web        every broker WEB (the engine runs, owns nothing, must act on nothing)
//   rust-demo  every broker RUST + demo-only: DEMO accounts are the engine's, LIVE the web's
//   rust-all   every broker RUST, all accounts: the web owns nothing and must act on nothing
//   mixed      brokers alternate WEB / RUST demo-only / RUST all (the three at once, in one database)
//   cross      like rust-demo, but in the bulk brokers every client is DEMO and every master / coverage account is LIVE:
//              each client's mirror close and coverage close is a DEMO account's effect landing on a LIVE account
//   cross-topo like rust-demo with the cascade topologies split per ACCOUNT (a chain whose hops belong to different sides).
//              The ORDER of a cascade across two concurrent actors is not the web's id order, so the end state is not
//              compared with the web reference here: only the invariants are (exactly once, no double action, none by the
//              wrong side, nothing left undone that the rule gives to a side that ran).
// Topologies are one broker each and, except in cross-topo, one MODE each: a cascade then stays on one side and its result is
// the web's, comparable id by id. The bulk brokers' accounts are mixed per account in every variant but web (the effects that
// cross sides there are single-hop, which commute).
import { riskOwnerOf, type RiskOwner } from "@/lib/risk-authority";
import type { World } from "./generate";

export type SplitVariant = "web" | "rust-demo" | "rust-all" | "mixed" | "cross" | "cross-topo";
export const SPLIT_VARIANTS: SplitVariant[] = ["web", "rust-demo", "rust-all", "mixed", "cross", "cross-topo"];

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

export type BrokerFlags = { riskAuthority: "WEB" | "RUST"; riskAuthorityDemoOnly: boolean };

export function brokerFlags(variant: SplitVariant, brokerIndex: number): BrokerFlags {
  switch (variant) {
    case "web":
      return { riskAuthority: "WEB", riskAuthorityDemoOnly: true };
    case "rust-all":
      return { riskAuthority: "RUST", riskAuthorityDemoOnly: false };
    case "mixed":
      return [
        { riskAuthority: "WEB" as const, riskAuthorityDemoOnly: true },
        { riskAuthority: "RUST" as const, riskAuthorityDemoOnly: true },
        { riskAuthority: "RUST" as const, riskAuthorityDemoOnly: false },
      ][brokerIndex % 3];
    default:
      return { riskAuthority: "RUST", riskAuthorityDemoOnly: true };
  }
}

export function accountMode(variant: SplitVariant, account: World["accounts"][number]): "DEMO" | "LIVE" {
  const topology = account.broker.startsWith("t-");
  if (topology) return hash(variant === "cross-topo" ? account.id : account.broker) % 2 === 0 ? "DEMO" : "LIVE";
  if (variant === "cross") return account.role === "master" || account.role === "coverage" ? "LIVE" : "DEMO";
  return hash(account.id) % 2 === 0 ? "DEMO" : "LIVE";
}

/** Who owns each account under `variant`, by the one rule. */
export function ownersOf(world: World, variant: SplitVariant): Map<string, RiskOwner> {
  const index = new Map(world.brokers.map((b, i) => [b.id, i] as const));
  return new Map(world.accounts.map((a) => [a.id, riskOwnerOf(brokerFlags(variant, index.get(a.broker) ?? 0), accountMode(variant, a))] as const));
}

export function isSplitVariant(v: string | undefined): v is SplitVariant {
  return !!v && (SPLIT_VARIANTS as string[]).includes(v);
}
