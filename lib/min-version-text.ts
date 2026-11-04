// Mandatory-update policy (owner 2026-10-29): the sentence the Super Admin types to confirm a minimum version. Shared by the route and the dialog.
export function confirmSentence(minVersion: string) {
  return `Clients below v${minVersion} must update before they can trade.`;
}
