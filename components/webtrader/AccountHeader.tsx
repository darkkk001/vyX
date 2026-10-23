import { accountHeaderLines } from "@/lib/account-header";

/** The account header: plan name, client name, account number, one per line; nothing else. A line the server did not send is left out. */
export function AccountHeader({ plan, name, number }: { plan?: unknown; name?: string | null; number?: string | null }) {
  return (
    <span className="account-header">
      {accountHeaderLines(plan, name, number).map((l) => (
        <span key={l.kind} className={`account-header-${l.kind}${l.kind === "number" ? " mono" : ""}`}>{l.text}</span>
      ))}
    </span>
  );
}
