"use client";

import { useEffect, useState } from "react";
import { money } from "./format";
import { clock, durationWords } from "@/lib/room/processing-time";

// The Deposit confirmation card (owner 2026-11-10): replaces the form after a request is sent and follows it live. Waiting
// (spinner, time since it was sent), approved (green check, amount, the account's new balance), rejected (red mark, the
// broker's reason when given). The page re-reads the request on every room event (~1 s after the broker decides).
export type DepositView = {
  id: string; state: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; amount: string; currency: string; accountNumber: string;
  method: string; reference: string | null; sentAt: string; decidedAt: string | null; reason: string | null; balance: string | null;
  maxSeconds: number | null; // the method's maximum processing time: the waiting card counts down from sentAt
};

export function sentAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "Sent just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `Sent ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `Sent ${h} h ago` : `Sent ${Math.floor(h / 24)} d ago`;
}

const Spinner = () => <span className="r-spin" role="img" aria-label="Waiting" />;
const Check = () => (
  <svg width="34" height="34" viewBox="0 0 34 34" role="img" aria-label="Approved"><circle cx="17" cy="17" r="16" fill="none" stroke="var(--r-ok)" strokeWidth="1.6" /><path d="m10.5 17.5 4.5 4.5 8.5-9" fill="none" stroke="var(--r-ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Cross = () => (
  <svg width="34" height="34" viewBox="0 0 34 34" role="img" aria-label="Rejected"><circle cx="17" cy="17" r="16" fill="none" stroke="var(--r-loss)" strokeWidth="1.6" /><path d="m12 12 10 10M22 12 12 22" fill="none" stroke="var(--r-loss)" strokeWidth="2" strokeLinecap="round" /></svg>
);

export default function DepositStatus({ v, onAgain }: { v: DepositView; onAgain: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (v.state !== "PENDING") return;
    const t = setInterval(() => setNow(Date.now()), v.maxSeconds ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [v.state, v.maxSeconds]);
  // owner 2026-11-10: a live countdown to the method's maximum processing time, from when the request was sent
  const left = v.maxSeconds ? v.maxSeconds - (now - new Date(v.sentAt).getTime()) / 1000 : null;
  const amount = <span className="mono" style={{ color: "var(--r-text)" }}>{money(v.amount)} {v.currency}</span>;
  return (
    <div className="r-card r-funds-done" role="status" aria-live="polite" data-state={v.state}>
      {v.state === "PENDING" ? <Spinner /> : v.state === "APPROVED" ? <Check /> : <Cross />}
      <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>
        {v.state === "PENDING" ? "Waiting for confirmation" : v.state === "APPROVED" ? "Your deposit has been approved" : v.state === "REJECTED" ? "Your deposit was rejected" : "Your deposit request was cancelled"}
      </div>
      <div style={{ fontSize: 13, color: "var(--r-text-2)", lineHeight: 1.7 }}>
        <div>Amount {amount}{v.method ? ` · ${v.method}` : ""}</div>
        {v.reference ? <div>Reference <span className="mono" style={{ color: "var(--r-gold-text)", fontWeight: 600 }}>{v.reference}</span></div> : null}
        {v.state === "PENDING" && left !== null ? (
          left > 0
            ? <div data-countdown><span className="mono r-deposit-clock" aria-label="Time left">{clock(left)}</span><div>Usually confirmed within {durationWords(v.maxSeconds!)}.</div></div>
            : <div data-countdown="over">Taking a little longer than usual. This page updates as soon as it&apos;s confirmed.</div>
        ) : null}
        {v.state === "PENDING" && left === null ? <div>{sentAgo(v.sentAt, now)}.</div> : null}
        {v.state === "APPROVED" && v.balance != null ? <div>New balance of {v.accountNumber} <span className="mono" style={{ color: "var(--r-text)", fontWeight: 600 }}>{money(v.balance)} {v.currency}</span></div> : null}
        {v.state === "REJECTED" && v.reason ? <div>Reason: <span style={{ color: "var(--r-text)" }}>{v.reason}</span></div> : null}
      </div>
      <button type="button" className="r-btn-ghost" style={{ padding: "10px 20px" }} onClick={onAgain}>New deposit request</button>
    </div>
  );
}
