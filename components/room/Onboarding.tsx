import type { ReactNode } from "react";
import RoomLogo from "./RoomLogo";
import type { WordmarkStyle } from "@/lib/room/wordmark";

// Artboard "Onboarding": the broker's brand line, the 4-step strip (Register, Personal details, Verification, Fund
// account) and the step's own content in a 680 px column.
export const ONBOARDING_STEPS = ["Register", "Personal details", "Verification", "Fund account"] as const;

function Step({ n, label, state }: { n: number; label: string; state: "done" | "now" | "next" }) {
  const ring = state === "done" ? { background: "var(--r-ok-tint)", border: "1px solid var(--r-ok)", color: "var(--r-ok)" }
    : state === "now" ? { background: "var(--r-gold-soft)", border: "1px solid var(--r-accent)", color: "var(--r-gold-text)" }
    : { border: "1px solid var(--r-btn)", color: "var(--r-muted)" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }} aria-current={state === "now" ? "step" : undefined}>
      <span className="mono" style={{ width: 24, height: 24, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 700, ...ring }}>
        {state === "done" ? <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m2.5 7.5 3 3 6-6" /></svg> : n}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: state === "now" ? "var(--r-gold-text)" : state === "done" ? "var(--r-text-2)" : "var(--r-muted)" }}>{label}</span>
    </div>
  );
}

/** The step strip; `step` is the 0-based current step. */
export function OnboardingSteps({ step }: { step: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 10 }}>
      {ONBOARDING_STEPS.map((label, i) => (
        <div key={label} style={{ display: "contents" }}>
          {i > 0 ? <span style={{ flex: 1, height: 1, background: "var(--r-btn)", margin: "0 12px", minWidth: 24 }} /> : null}
          <Step n={i + 1} label={label} state={i < step ? "done" : i === step ? "now" : "next"} />
        </div>
      ))}
    </div>
  );
}

/** `step` given = the strip is drawn here; left out = the page's own content draws it (it moves on the client). */
export default function Onboarding({ brokerName, logoUrl, wordmark = null, step, right, children }: { brokerName: string; logoUrl: string | null; wordmark?: WordmarkStyle | null; step?: number; right: ReactNode; children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "18px 40px", borderBottom: "1px solid var(--r-line)" }}>
        <a className="r-brand" href="/room" style={{ padding: 0 }}><RoomLogo name={brokerName} logoUrl={logoUrl} wordmark={wordmark} size="sm" /></a>
        <div style={{ fontSize: 13, color: "var(--r-text-2)" }}>{right}</div>
      </header>
      <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: "44px 24px" }}>
        <div style={{ width: "100%", maxWidth: 680, display: "flex", flexDirection: "column", gap: 30 }}>
          {step != null ? <OnboardingSteps step={step} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
