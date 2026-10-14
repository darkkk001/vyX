// Backoffice 1.0.72 (owner): a group the PLATFORM created is a system group: editable (pricing, spread, leverage) but never deletable.
// The platform marks them with data that already exists, no new column: the hedge group (category COVERAGE, lib/coverage.ts) and the
// starter "Dealing" group (category DEALING, lib/starter-state.ts). A DEALING-category group a broker made under another name is the
// broker's own and stays deletable. The native backoffice (Vyx.Shared.Backoffice.GroupMenu.IsSystem) applies the same rule.
export const STARTER_DEALING_GROUP_NAME = "Dealing";

export function isSystemGroup(g: { category: string; name: string }): boolean {
  return g.category === "COVERAGE" || (g.category === "DEALING" && g.name === STARTER_DEALING_GROUP_NAME);
}

// "This group has 12 accounts. Move them first." (the one wording the backoffice shows)
export function groupHasAccountsMessage(accountCount: number): string {
  return `This group has ${accountCount} account${accountCount === 1 ? "" : "s"}. Move ${accountCount === 1 ? "it" : "them"} first.`;
}
