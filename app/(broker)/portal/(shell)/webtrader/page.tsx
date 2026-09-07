import ComingSoonPanel from "@/components/portal/ComingSoonPanel";

export default function PortalWebTraderPage() {
  return (
    <ComingSoonPanel
      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18.5 8 13 13.5l-3-3L5 16" /></svg>}
      title="WebTrader"
      description="Pick one of your linked accounts and launch the full trading terminal -- no account number or password to re-enter, you're already signed in."
      stageNote="Arrives in Stage 4: reuses the existing SSO handoff (lib/sso.ts) already built for this exact purpose."
    />
  );
}
