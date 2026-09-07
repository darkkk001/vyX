"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "@/components/portal/PortalShell.module.css";

type Account = {
  id: string;
  accountNumber: string;
  accountMode: "DEMO" | "LIVE";
  accountTypeName: string | null;
  currency: string;
  leverage: number;
  balance: string;
  status: string;
  createdAt: string;
};

type LiveRequest = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  rejectionReason: string | null;
  accountTypeName: string | null;
  createdAt: string;
};

type AccountTypeOption = { id: string; name: string; description: string | null; isDefault: boolean };

type RevealedCredentials = { accountNumber: string; password: string };

// Client Portal's Trading Accounts tab (Stage 6) -- self-fetches (same
// pattern as the backoffice managers, e.g. LiveAccountRequestsManager)
// rather than server-rendered initial props, specifically so the
// one-time credential reveal (a just-approved Live account's password,
// see lib/live-account-credentials.ts) is only ever consumed when the
// browser genuinely displays this page to the client, not during a
// speculative server-side render/prefetch.
export default function AccountsView() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [liveRequests, setLiveRequests] = useState<LiveRequest[] | null>(null);
  const [accountTypes, setAccountTypes] = useState<AccountTypeOption[]>([]);
  const [kycStatus, setKycStatus] = useState<string | null>(null);
  const [revealedCredentials, setRevealedCredentials] = useState<RevealedCredentials | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState<"DEMO" | "LIVE">("DEMO");
  const [selectedAccountTypeId, setSelectedAccountTypeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [newDemoCredentials, setNewDemoCredentials] = useState<RevealedCredentials | null>(null);
  const [liveRequestSubmitted, setLiveRequestSubmitted] = useState(false);

  function loadAll() {
    return Promise.all([
      fetch("/api/portal/accounts").then((r) => r.json()),
      fetch("/api/portal/live-account-requests").then((r) => r.json()),
      fetch("/api/portal/account-types").then((r) => r.json()),
      fetch("/api/portal/kyc").then((r) => r.json()),
    ]).then(([accountsBody, liveRequestsBody, accountTypesBody, kycBody]) => {
      setAccounts(accountsBody.accounts);
      if (accountsBody.revealedCredentials) {
        setRevealedCredentials(accountsBody.revealedCredentials);
      }
      setLiveRequests(liveRequestsBody);
      setAccountTypes(accountTypesBody);
      setKycStatus(kycBody?.status ?? null);
    });
  }

  useEffect(() => {
    loadAll().catch(() => {
      setAccounts([]);
      setLiveRequests([]);
    });
  }, []);

  function openCreateModal() {
    setTab("DEMO");
    setFormError(null);
    setNewDemoCredentials(null);
    setLiveRequestSubmitted(false);
    setSelectedAccountTypeId(accountTypes.find((t) => t.isDefault)?.id ?? "");
    setModalOpen(true);
  }

  async function submitDemo() {
    setSubmitting(true);
    setFormError(null);
    const response = await fetch("/api/portal/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountMode: "DEMO", accountTypeId: selectedAccountTypeId || undefined }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);
    if (!response.ok) {
      setFormError(body.error ?? "failed to create account");
      return;
    }
    setNewDemoCredentials({ accountNumber: body.accountNumber, password: body.password });
    loadAll().catch(() => {});
  }

  async function submitLiveRequest() {
    setSubmitting(true);
    setFormError(null);
    const response = await fetch("/api/portal/live-account-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountTypeId: selectedAccountTypeId || undefined }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);
    if (!response.ok) {
      setFormError(body.error ?? "failed to submit request");
      return;
    }
    setLiveRequestSubmitted(true);
    loadAll().catch(() => {});
  }

  if (accounts === null || liveRequests === null) {
    return <p style={{ color: "var(--text-3)", fontSize: 13 }}>Loading...</p>;
  }

  const pendingLiveRequest = liveRequests.find((r) => r.status === "PENDING");

  return (
    <div>
      {revealedCredentials ? (
        <div className={styles.panel} style={{ marginBottom: 20, borderColor: "var(--accent)" }}>
          <h2 className={styles.panelTitle}>Your Live account is ready</h2>
          <p className={styles.panelText} style={{ marginBottom: 10 }}>
            This password is shown once. It was also emailed to you.
          </p>
          <div className={styles.credentialBox}>
            <div className={styles.credentialRow}>
              <span className={styles.credentialLabel}>Account number</span>
              <span className={styles.credentialValue}>{revealedCredentials.accountNumber}</span>
            </div>
            <div className={styles.credentialRow}>
              <span className={styles.credentialLabel}>Password</span>
              <span className={styles.credentialValue}>{revealedCredentials.password}</span>
            </div>
          </div>
          <button type="button" className={styles.btnPrimary} onClick={() => setRevealedCredentials(null)}>
            Got it
          </button>
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 className={styles.panelTitle} style={{ margin: 0 }}>Your accounts</h2>
        <button type="button" className={styles.btnPrimary} style={{ margin: 0 }} onClick={openCreateModal}>
          + Create Account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
            </div>
            <p className={styles.panelText}>You don&apos;t have any trading accounts yet.</p>
            <button type="button" className={styles.btnPrimary} onClick={openCreateModal}>+ Create Account</button>
          </div>
        </div>
      ) : (
        <div className={styles.panel}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Account</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Mode</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Type</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Currency</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Status</th>
                <th style={{ paddingBottom: 8, fontWeight: 600, textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 0", fontFamily: "monospace" }}>{a.accountNumber}</td>
                  <td style={{ padding: "10px 0" }}>{a.accountMode}</td>
                  <td style={{ padding: "10px 0" }}>{a.accountTypeName ?? "-"}</td>
                  <td style={{ padding: "10px 0" }}>{a.currency}</td>
                  <td style={{ padding: "10px 0" }}>{a.status}</td>
                  <td style={{ padding: "10px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{parseFloat(a.balance).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {liveRequests.length > 0 ? (
        <div className={styles.panel} style={{ marginTop: 20 }}>
          <h2 className={styles.panelTitle} style={{ marginBottom: 12 }}>Live account requests</h2>
          {liveRequests.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
              <span>{r.accountTypeName ?? "Default"}</span>
              <span style={{ color: r.status === "APPROVED" ? "var(--accent)" : r.status === "REJECTED" ? "var(--sell, #EA3943)" : "var(--text-2)" }}>
                {r.status}
                {r.status === "REJECTED" && r.rejectionReason ? `: ${r.rejectionReason}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {modalOpen ? (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard}>
            {newDemoCredentials ? (
              <>
                <h3 className={styles.modalTitle}>Demo account created</h3>
                <p className={styles.panelText} style={{ marginBottom: 4 }}>This password is shown once. Save it now.</p>
                <div className={styles.credentialBox}>
                  <div className={styles.credentialRow}>
                    <span className={styles.credentialLabel}>Account number</span>
                    <span className={styles.credentialValue}>{newDemoCredentials.accountNumber}</span>
                  </div>
                  <div className={styles.credentialRow}>
                    <span className={styles.credentialLabel}>Password</span>
                    <span className={styles.credentialValue}>{newDemoCredentials.password}</span>
                  </div>
                </div>
                <button type="button" className={styles.btnPrimary} onClick={() => setModalOpen(false)}>Done</button>
              </>
            ) : liveRequestSubmitted ? (
              <>
                <h3 className={styles.modalTitle}>Request submitted</h3>
                <p className={styles.panelText}>Your Live account request is now pending review. You&apos;ll be notified once it&apos;s approved.</p>
                <button type="button" className={styles.btnPrimary} onClick={() => setModalOpen(false)}>Close</button>
              </>
            ) : (
              <>
                <h3 className={styles.modalTitle}>Create Account</h3>
                <div className={styles.modalTabs}>
                  <button type="button" className={`${styles.modalTab} ${tab === "DEMO" ? styles.modalTabActive : ""}`} onClick={() => { setTab("DEMO"); setFormError(null); }}>
                    Demo
                  </button>
                  <button type="button" className={`${styles.modalTab} ${tab === "LIVE" ? styles.modalTabActive : ""}`} onClick={() => { setTab("LIVE"); setFormError(null); }}>
                    Live
                  </button>
                </div>

                {tab === "DEMO" ? (
                  <>
                    <p className={styles.panelText} style={{ marginBottom: 14 }}>Created instantly, with virtual funds to practice trading.</p>
                    {accountTypes.length > 0 ? (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Account type</label>
                        <select className={styles.select} value={selectedAccountTypeId} onChange={(e) => setSelectedAccountTypeId(e.target.value)}>
                          {accountTypes.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {formError ? <div className={styles.formError}>{formError}</div> : null}
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button type="button" className={styles.btnPrimary} style={{ margin: 0, flex: 1 }} disabled={submitting} onClick={submitDemo}>
                        {submitting ? "Creating..." : "Create Demo Account"}
                      </button>
                      <button type="button" onClick={() => setModalOpen(false)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "0 16px", color: "var(--text-2)", cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : kycStatus !== "APPROVED" ? (
                  <>
                    <p className={styles.panelText} style={{ marginBottom: 14 }}>
                      A Live account requires identity verification first.
                    </p>
                    <div className={styles.formNotice}>
                      {kycStatus === "PENDING" ? "Your KYC submission is under review." : "Complete KYC verification to open a Live account."}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      {kycStatus !== "PENDING" ? (
                        <Link href="/portal/kyc" className={styles.btnPrimary} style={{ margin: 0, flex: 1, textAlign: "center", textDecoration: "none" }}>
                          Complete KYC
                        </Link>
                      ) : null}
                      <button type="button" onClick={() => setModalOpen(false)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "0 16px", color: "var(--text-2)", cursor: "pointer" }}>
                        Close
                      </button>
                    </div>
                  </>
                ) : pendingLiveRequest ? (
                  <>
                    <div className={styles.formNotice}>You already have a Live account request under review.</div>
                    <button type="button" onClick={() => setModalOpen(false)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 16px", color: "var(--text-2)", cursor: "pointer" }}>
                      Close
                    </button>
                  </>
                ) : (
                  <>
                    <p className={styles.panelText} style={{ marginBottom: 14 }}>
                      Submitted for backoffice review. Once approved, your account and credentials are created and emailed to you.
                    </p>
                    {accountTypes.length > 0 ? (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Account type</label>
                        <select className={styles.select} value={selectedAccountTypeId} onChange={(e) => setSelectedAccountTypeId(e.target.value)}>
                          {accountTypes.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {formError ? <div className={styles.formError}>{formError}</div> : null}
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button type="button" className={styles.btnPrimary} style={{ margin: 0, flex: 1 }} disabled={submitting} onClick={submitLiveRequest}>
                        {submitting ? "Submitting..." : "Request Live Account"}
                      </button>
                      <button type="button" onClick={() => setModalOpen(false)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "0 16px", color: "var(--text-2)", cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
