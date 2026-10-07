// Owner decision 2026-10-07: one word everywhere, "KYC", with the values Not verified / Pending / Verified / Rejected.
// "ID check", "Identity verification" and "Not started" / "Not submitted" are gone from every user-visible string
// (backoffice, terminal, WebTrader, client portal, staff and client route messages, e-mails). Raw database statuses
// (NONE, PENDING, APPROVED, REJECTED) never reach a screen as they are.
export type KycWord = "Not verified" | "Pending" | "Verified" | "Rejected";

export function kycWord(status: string | null | undefined): KycWord {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "APPROVED":
    case "VERIFIED":
      return "Verified";
    case "REJECTED":
      return "Rejected";
    default:
      return "Not verified";
  }
}

// E-mail wording for the KYC decision mails (built later, owner 2026-10-07); templates must use these.
export const KYC_EMAIL = {
  subjectApproved: "Your KYC is approved",
  subjectRejected: "Your KYC needs new documents",
  headingApproved: "KYC approved",
  headingRejected: "KYC not approved",
} as const;
