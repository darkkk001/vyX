"use client";

import { useState } from "react";
import styles from "@/components/portal/PortalShell.module.css";

type KycRecordView = {
  status: string;
  documentType: string;
  rejectionReason: string | null;
  annualIncome: string | null;
  sourceOfFunds: string | null;
  tradingExperience: string | null;
  employmentStatus: string | null;
  riskTolerance: string | null;
} | null;

const DOCUMENT_TYPE_OPTIONS = [
  { value: "passport", label: "Passport" },
  { value: "national_id", label: "National ID" },
  { value: "drivers_license", label: "Driver's license" },
];

const ANNUAL_INCOME_OPTIONS = [
  { value: "UNDER_25K", label: "Under $25,000" },
  { value: "RANGE_25K_50K", label: "$25,000 - $50,000" },
  { value: "RANGE_50K_100K", label: "$50,000 - $100,000" },
  { value: "RANGE_100K_250K", label: "$100,000 - $250,000" },
  { value: "OVER_250K", label: "Over $250,000" },
];

const SOURCE_OF_FUNDS_OPTIONS = [
  { value: "SALARY", label: "Salary / employment income" },
  { value: "BUSINESS_INCOME", label: "Business income" },
  { value: "SAVINGS", label: "Personal savings" },
  { value: "INVESTMENTS", label: "Investments" },
  { value: "INHERITANCE", label: "Inheritance" },
  { value: "OTHER", label: "Other" },
];

const TRADING_EXPERIENCE_OPTIONS = [
  { value: "NONE", label: "No experience" },
  { value: "UNDER_1_YEAR", label: "Under 1 year" },
  { value: "ONE_TO_3_YEARS", label: "1-3 years" },
  { value: "THREE_TO_5_YEARS", label: "3-5 years" },
  { value: "OVER_5_YEARS", label: "Over 5 years" },
];

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "EMPLOYED", label: "Employed" },
  { value: "SELF_EMPLOYED", label: "Self-employed" },
  { value: "UNEMPLOYED", label: "Unemployed" },
  { value: "STUDENT", label: "Student" },
  { value: "RETIRED", label: "Retired" },
];

const RISK_TOLERANCE_OPTIONS = [
  { value: "LOW", label: "Low -- I want to preserve capital" },
  { value: "MEDIUM", label: "Medium -- I can accept moderate losses" },
  { value: "HIGH", label: "High -- I can accept significant losses" },
];

// Client-level KYC submission (Stage 5) -- documents + the suitability
// questionnaire the registration route deliberately never collects (see
// that route's own comment). Mirrors WebTrader's own "Verify identity"
// modal (components/webtrader/WebTrader.tsx) for the document half, as a
// full page instead of a modal, plus the five suitability questions.
export default function KycForm({ initialRecord }: { initialRecord: KycRecordView }) {
  const [record, setRecord] = useState(initialRecord);
  const [documentType, setDocumentType] = useState("passport");
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [addressProof, setAddressProof] = useState<File | null>(null);
  const [annualIncome, setAnnualIncome] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState("");
  const [tradingExperience, setTradingExperience] = useState("");
  const [employmentStatus, setEmploymentStatus] = useState("");
  const [riskTolerance, setRiskTolerance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!front || !back) {
      setError("Both document sides are required");
      return;
    }
    if (!annualIncome || !sourceOfFunds || !tradingExperience || !employmentStatus || !riskTolerance) {
      setError("Please answer every question");
      return;
    }
    setSubmitting(true);
    const form = new FormData();
    form.set("documentType", documentType);
    form.set("front", front);
    form.set("back", back);
    if (addressProof) form.set("addressProof", addressProof);
    form.set("annualIncome", annualIncome);
    form.set("sourceOfFunds", sourceOfFunds);
    form.set("tradingExperience", tradingExperience);
    form.set("employmentStatus", employmentStatus);
    form.set("riskTolerance", riskTolerance);

    const response = await fetch("/api/portal/kyc", { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);
    if (!response.ok) {
      setError(body.error ?? "failed to submit");
      return;
    }
    setRecord({
      status: body.status,
      documentType,
      rejectionReason: null,
      annualIncome,
      sourceOfFunds,
      tradingExperience,
      employmentStatus,
      riskTolerance,
    });
  }

  return (
    <div className={styles.panel} style={{ maxWidth: 640 }}>
      {record && record.status !== "REJECTED" ? (
        <>
          <h2 className={styles.panelTitle}>Identity verification</h2>
          <p className={styles.panelText} style={{ marginBottom: 14 }}>
            {record.status === "PENDING"
              ? "Your documents are under review. This usually takes 1-2 business days."
              : "Your identity is verified. You can open a Live account any time."}
          </p>
          <span
            className={styles.statusBadge}
            style={{
              color: record.status === "APPROVED" ? "var(--accent)" : "var(--text-2)",
              background: record.status === "APPROVED" ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "var(--bg-2)",
            }}
          >
            {record.status}
          </span>
        </>
      ) : (
        <>
          <h2 className={styles.panelTitle}>Verify your identity</h2>
          <p className={styles.panelText} style={{ marginBottom: 18 }}>
            Submit your ID and a short suitability questionnaire once -- every Live account you go on to open inherits this approval.
          </p>
          {record?.status === "REJECTED" ? (
            <div className={styles.formError}>
              Previous submission rejected{record.rejectionReason ? `: ${record.rejectionReason}` : "."} Please resubmit below.
            </div>
          ) : null}
          <form onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Document type</label>
              <select className={styles.select} value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                {DOCUMENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.formGrid}>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Document front</label>
                <input className={styles.fileInput} type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFront(e.target.files?.[0] ?? null)} required />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Document back</label>
                <input className={styles.fileInput} type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setBack(e.target.files?.[0] ?? null)} required />
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Proof of address (optional)</label>
              <input className={styles.fileInput} type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setAddressProof(e.target.files?.[0] ?? null)} />
            </div>

            <p className={styles.panelText} style={{ margin: "18px 0 10px", fontWeight: 600, color: "var(--text-1)" }}>Suitability questionnaire</p>
            <div className={styles.formGrid}>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Annual income</label>
                <select className={styles.select} value={annualIncome} onChange={(e) => setAnnualIncome(e.target.value)} required>
                  <option value="" disabled>Select...</option>
                  {ANNUAL_INCOME_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Source of funds</label>
                <select className={styles.select} value={sourceOfFunds} onChange={(e) => setSourceOfFunds(e.target.value)} required>
                  <option value="" disabled>Select...</option>
                  {SOURCE_OF_FUNDS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Trading experience</label>
                <select className={styles.select} value={tradingExperience} onChange={(e) => setTradingExperience(e.target.value)} required>
                  <option value="" disabled>Select...</option>
                  {TRADING_EXPERIENCE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Employment status</label>
                <select className={styles.select} value={employmentStatus} onChange={(e) => setEmploymentStatus(e.target.value)} required>
                  <option value="" disabled>Select...</option>
                  {EMPLOYMENT_STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Risk tolerance</label>
                <select className={styles.select} value={riskTolerance} onChange={(e) => setRiskTolerance(e.target.value)} required>
                  <option value="" disabled>Select...</option>
                  {RISK_TOLERANCE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
            </div>

            {error ? <div className={styles.formError} style={{ marginTop: 14 }}>{error}</div> : null}
            <button type="submit" className={styles.btnPrimary} disabled={submitting} style={{ marginTop: 4 }}>
              {submitting ? "Submitting..." : "Submit for review"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
