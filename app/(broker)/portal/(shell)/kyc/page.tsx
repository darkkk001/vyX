import ComingSoonPanel from "@/components/portal/ComingSoonPanel";

export default function PortalKycPage() {
  return (
    <ComingSoonPanel
      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>}
      title="KYC Verification"
      description="Submit your ID and proof of address once -- every Live account you go on to open inherits this approval."
      stageNote="Arrives in Stage 5: client-level KYC submission and backoffice review queue."
    />
  );
}
