"use client";

import { useEffect, useState } from "react";
import styles from "@/components/portal/PortalShell.module.css";
import { formatMoney } from "@/lib/format";

type Account = {
  id: string;
  accountNumber: string;
  accountMode: "DEMO" | "LIVE";
  accountTypeName: string | null;
  currency: string;
  balance: string;
  status: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  missing_account: "Pick an account to launch.",
  invalid_account: "That account couldn't be opened.",
};

// Stage 7 -- the near-zero-build item: the SSO handoff already exists
// (lib/sso.ts, app/(broker)/trade/sso/route.ts, previously only called by
// a broker's own EXTERNAL portal via app/api/trade/sso/token). The
// portal becomes a second caller of the exact same mechanism through
// app/api/portal/webtrader-sso, a real navigation (not fetch) so a click
// here ends in one browser hop through /trade/sso, fully logged into
// WebTrader for the picked account -- no account number/password re-entry.
export default function WebTraderLauncher() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setErrorCode(params.get("error"));

    fetch("/api/portal/accounts")
      .then((r) => r.json())
      .then((body: { accounts: Account[] }) => {
        const active = body.accounts.filter((a) => a.status === "ACTIVE");
        setAccounts(active);
        if (active.length > 0) setSelectedId(active[0].id);
      })
      .catch(() => setAccounts([]));
  }, []);

  if (accounts === null) {
    // the shape of the panel while the accounts load, not a bare "Loading..." line
    return (
      <div className={styles.panel} style={{ maxWidth: 480 }} aria-busy="true" aria-label="Loading your accounts">
        <div className={styles.skeletonLine} style={{ width: 120, height: 16, marginBottom: 18 }} />
        <div className={styles.skeletonLine} style={{ height: 52, marginBottom: 8 }} />
        <div className={styles.skeletonLine} style={{ height: 52, marginBottom: 18 }} />
        <div className={styles.skeletonLine} style={{ width: 150, height: 38 }} />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18.5 8 13 13.5l-3-3L5 16" /></svg>
          </div>
          <p className={styles.panelText}>You don&apos;t have any active trading accounts to launch yet.</p>
          <a href="/portal/accounts" className={styles.btnPrimary}>Go to Trading Accounts</a>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} style={{ maxWidth: 480 }}>
      <h2 className={styles.panelTitle}>WebTrader</h2>

      {errorCode ? <div className={styles.formError}>{ERROR_MESSAGES[errorCode] ?? "Couldn't open WebTrader for that account."}</div> : null}

      <div className={styles.field}>
        <span className={styles.fieldLabel} id="wt-launch-account">Account</span>
        <div className={styles.launchList} role="radiogroup" aria-labelledby="wt-launch-account">
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={a.id === selectedId}
              className={`${styles.launchItem}${a.id === selectedId ? ` ${styles.launchItemActive}` : ""}`}
              onClick={() => setSelectedId(a.id)}
            >
              <span className={styles.launchMain}>
                <span className={styles.launchNumber}>{a.accountNumber}</span>
                <span className={`${styles.modeBadge}${a.accountMode === "LIVE" ? ` ${styles.modeBadgeLive}` : ""}`}>{a.accountMode}</span>
                {a.accountTypeName ? <span className={styles.launchType}>{a.accountTypeName}</span> : null}
              </span>
              <span className={styles.launchBalance}>{formatMoney(a.balance)} {a.currency}</span>
            </button>
          ))}
        </div>
      </div>

      <a
        href={selectedId ? `/api/portal/webtrader-sso?accountId=${selectedId}` : undefined}
        className={styles.btnPrimary}
        style={{ display: "inline-flex", textDecoration: "none", opacity: selectedId ? 1 : 0.5, pointerEvents: selectedId ? "auto" : "none" }}
      >
        Open WebTrader
      </a>
    </div>
  );
}
