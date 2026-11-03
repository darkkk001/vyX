"use client";

import { useRef, useState } from "react";
import { OnboardingSteps } from "@/components/room/Onboarding";

// Personal details (PATCH /api/portal/me) -> documents (POST /api/portal/kyc, the same private upload and review as
// the portal) -> fund. The step strip above is drawn by the server page; this moves through the same steps.
type Init = { phone: string; country: string; dateOfBirth: string };
const OPTS = {
  employmentStatus: [["EMPLOYED", "Employed"], ["SELF_EMPLOYED", "Self-employed"], ["UNEMPLOYED", "Not employed"], ["STUDENT", "Student"], ["RETIRED", "Retired"]],
  annualIncome: [["UNDER_25K", "Under 25,000 USD"], ["RANGE_25K_50K", "25,000 to 50,000 USD"], ["RANGE_50K_100K", "50,000 to 100,000 USD"], ["RANGE_100K_250K", "100,000 to 250,000 USD"], ["OVER_250K", "Over 250,000 USD"]],
  sourceOfFunds: [["SALARY", "Salary"], ["BUSINESS_INCOME", "Business income"], ["SAVINGS", "Savings"], ["INVESTMENTS", "Investments"], ["INHERITANCE", "Inheritance"], ["OTHER", "Other"]],
  tradingExperience: [["NONE", "None"], ["UNDER_1_YEAR", "Under 1 year"], ["ONE_TO_3_YEARS", "1 to 3 years"], ["THREE_TO_5_YEARS", "3 to 5 years"], ["OVER_5_YEARS", "Over 5 years"]],
  riskTolerance: [["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"]],
} as const;
type SuitKey = keyof typeof OPTS;
const SUIT_LABEL: Record<SuitKey, string> = { employmentStatus: "Employment", annualIncome: "Annual income", sourceOfFunds: "Source of funds", tradingExperience: "Trading experience", riskTolerance: "Risk you accept" };
const DOC_TYPES = [["national_id", "National ID card"], ["passport", "Passport"], ["drivers_license", "Driving licence"]] as const;
const MAX = 8 * 1024 * 1024;

function Upload({ label, hint, file, onFile }: { label: string; hint: string; file: File | null; onFile: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div style={{ flex: "1 1 240px", border: file ? "1px solid var(--r-ok)" : "1px dashed var(--r-dash)", borderRadius: 8, padding: "26px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, background: "var(--r-card-2)", textAlign: "center" }}>
      {file
        ? <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="var(--r-ok)" strokeWidth="1.6" aria-hidden="true"><path d="m5 14 5.5 5.5L21 9" /></svg>
        : <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="var(--r-muted)" strokeWidth="1.4" aria-hidden="true"><path d="M6 3h10l4 4v16H6Z" /><path d="M16 3v4h4M9.5 12h7M9.5 15.5h7M9.5 19h4.5" /></svg>}
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div className={file ? "mono" : undefined} style={{ fontSize: 11.5, color: file ? "var(--r-ok)" : "var(--r-muted)" }}>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : hint}</div>
      <input ref={ref} type="file" accept="image/jpeg,image/png,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; onFile(f); }} />
      {file
        ? <button type="button" onClick={() => onFile(null)} style={{ background: "none", border: "none", color: "var(--r-loss)", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}>Remove</button>
        : <button type="button" className="r-btn-ghost" style={{ fontSize: 12.5, padding: "7px 16px" }} onClick={() => ref.current?.click()}>Choose file</button>}
    </div>
  );
}

export default function VerifyFlow({ initial, kyc, rejectionReason, countries }: { initial: Init; kyc: string | null; rejectionReason: string | null; countries: { code: string; name: string }[] }) {
  const [step, setStep] = useState<"details" | "docs" | "done">(kyc === "PENDING" || kyc === "APPROVED" ? "done" : "details");
  const [p, setP] = useState(initial);
  const [suit, setSuit] = useState<Record<SuitKey, string>>({ employmentStatus: "", annualIncome: "", sourceOfFunds: "", tradingExperience: "", riskTolerance: "" });
  const [docType, setDocType] = useState("national_id");
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [address, setAddress] = useState<File | null>(null);
  const [err, setErr] = useState(rejectionReason ? `Your documents were not accepted: ${rejectionReason}` : "");
  const [busy, setBusy] = useState(false);

  function pick(set: (f: File | null) => void) {
    return (f: File | null) => {
      if (f && f.size > MAX) { setErr("Files must be 8 MB or smaller."); return; }
      if (f && !/^(image\/(jpeg|png)|application\/pdf)$/.test(f.type)) { setErr("Use JPG, PNG or PDF."); return; }
      setErr("");
      set(f);
    };
  }

  async function saveDetails() {
    if (!p.country || !p.phone || !p.dateOfBirth) { setErr("Fill in country, phone and date of birth."); return; }
    if (Object.values(suit).some((v) => !v)) { setErr("Answer every question."); return; }
    setBusy(true); setErr("");
    const res = await fetch("/api/portal/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setErr(body?.error ? String(body.error).replace(/^./, (c: string) => c.toUpperCase()) : "Could not save."); return; }
    setStep("docs");
  }

  async function submitDocs() {
    if (!front || !back || !address) { setErr("Add both sides of your ID and a proof of address."); return; }
    setBusy(true); setErr("");
    const fd = new FormData();
    fd.set("documentType", docType);
    for (const [k, v] of Object.entries(suit)) fd.set(k, v);
    fd.set("front", front); fd.set("back", back); fd.set("addressProof", address);
    const res = await fetch("/api/portal/kyc", { method: "POST", body: fd });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setErr(res.status === 503 ? "Uploads are not available right now. Try again later." : body?.error ? String(body.error).replace(/^./, (c: string) => c.toUpperCase()) : "Upload failed."); return; }
    setStep("done");
  }

  const card = { padding: 24, display: "flex", flexDirection: "column", gap: 20 } as const;
  if (step === "done") {
    return (
      <>
        <OnboardingSteps step={3} />
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 24, fontWeight: 600 }}>Fund your account</h1>
          <div style={{ fontSize: 13.5, color: "var(--r-text-2)", marginTop: 8, lineHeight: 1.6 }}>{kyc === "APPROVED" ? "Your documents are approved." : "Your documents are with your broker for review."} Open a live account, then make your first deposit.</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a className="r-btn" href="/room/accounts#open">Open a live account</a>
          <a className="r-btn-ghost" href="/room/deposit">Deposit</a>
          <a className="r-btn-ghost" href="/room/downloads">Trade on demo</a>
        </div>
      </>
    );
  }

  if (step === "details") {
    return (
      <>
        <OnboardingSteps step={1} />
        <div>
          <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 24, fontWeight: 600 }}>Personal details</h1>
          <div style={{ fontSize: 13.5, color: "var(--r-text-2)", marginTop: 8, lineHeight: 1.6 }}>Your broker needs these before it can review your documents.</div>
        </div>
        <div className="r-card" style={card}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div className="r-field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="ctry">Country of residence</label>
              <select id="ctry" className="r-input" value={p.country} onChange={(e) => setP({ ...p, country: e.target.value })}>
                <option value="">Select</option>
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <div className="r-field" style={{ flex: "1 1 200px" }}><label htmlFor="ph">Phone</label><input id="ph" className="r-input mono" inputMode="tel" autoComplete="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></div>
            <div className="r-field" style={{ flex: "1 1 160px" }}><label htmlFor="dob">Date of birth</label><input id="dob" className="r-input mono" type="date" value={p.dateOfBirth} onChange={(e) => setP({ ...p, dateOfBirth: e.target.value })} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            {(Object.keys(OPTS) as SuitKey[]).map((k) => (
              <div key={k} className="r-field">
                <label htmlFor={k}>{SUIT_LABEL[k]}</label>
                <select id={k} className="r-input" value={suit[k]} onChange={(e) => setSuit({ ...suit, [k]: e.target.value })}>
                  <option value="">Select</option>
                  {OPTS[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
        {err ? <div className="r-error" role="alert">{err}</div> : null}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, color: "var(--r-muted)", maxWidth: 380, lineHeight: 1.6 }}>You can trade on a demo account right away. Verification is required before your first withdrawal.</div>
          <div style={{ display: "flex", gap: 10 }}>
            <a className="r-btn-ghost" href="/room" style={{ fontSize: 13 }}>Skip for now</a>
            <button type="button" className="r-btn" disabled={busy} onClick={saveDetails}>{busy ? "Saving…" : "Continue"}</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <OnboardingSteps step={2} />
      <div>
        <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 24, fontWeight: 600 }}>Verify your identity</h1>
        <div style={{ fontSize: 13.5, color: "var(--r-text-2)", marginTop: 8, lineHeight: 1.6 }}>Upload a government-issued ID and a recent proof of address. Your broker reviews documents within 24 hours.</div>
      </div>
      <div className="r-card" style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div className="r-label">Identity document</div>
          <select aria-label="Document type" className="r-input" style={{ width: "auto", fontSize: 12.5, padding: "7px 10px" }} value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Upload label={`${DOC_TYPES.find((d) => d[0] === docType)?.[1]}: front`} hint="JPG, PNG or PDF · max 8 MB" file={front} onFile={pick(setFront)} />
          <Upload label={`${DOC_TYPES.find((d) => d[0] === docType)?.[1]}: back`} hint="JPG, PNG or PDF · max 8 MB" file={back} onFile={pick(setBack)} />
        </div>
      </div>
      <div className="r-card" style={{ ...card, gap: 18 }}>
        <div className="r-label">Proof of address</div>
        <Upload label="Utility bill or bank statement" hint="Issued within the last 3 months, showing your name and address" file={address} onFile={pick(setAddress)} />
      </div>
      {err ? <div className="r-error" role="alert">{err}</div> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--r-muted)", maxWidth: 380, lineHeight: 1.6 }}>You can trade on a demo account right away. Verification is required before your first withdrawal.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <a className="r-btn-ghost" href="/room" style={{ fontSize: 13 }}>Skip for now</a>
          <button type="button" className="r-btn" disabled={busy} onClick={submitDocs}>{busy ? "Uploading…" : "Submit for review"}</button>
        </div>
      </div>
    </>
  );
}
