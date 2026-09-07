import ComingSoonPanel from "@/components/portal/ComingSoonPanel";

export default function PortalAccountsPage() {
  return (
    <ComingSoonPanel
      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>}
      title="Trading Accounts"
      description="Open a Demo account instantly, or request a Live account (subject to KYC approval). Manage every account you own from here."
      stageNote="Arrives in Stage 4: Create Demo, Request Live, and the backoffice approval queue."
    />
  );
}
