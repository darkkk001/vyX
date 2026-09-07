import ComingSoonPanel from "@/components/portal/ComingSoonPanel";

export default function PortalFundsPage() {
  return (
    <ComingSoonPanel
      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
      title="Deposits & Withdrawals"
      description="Deposit into or withdraw from any of your trading accounts, and track your request history."
      stageNote="Arrives in Stage 4: extracted from WebTrader's own Funds modal, reused here per account."
    />
  );
}
