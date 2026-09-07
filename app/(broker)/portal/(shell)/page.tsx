import Link from "next/link";
import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import styles from "@/components/portal/PortalShell.module.css";

// Real summary once Stage 4 (Trading Accounts) and Stage 5 (client-level
// KYC) exist -- both queries already return the correct shape today,
// they just find nothing yet for a freshly-registered client, since
// self-service account-claiming and Live-account creation aren't built
// yet. No changes needed here once they are; this page already reads
// live data, not a placeholder.
export default async function PortalDashboardPage() {
  const session = await getClientSession(); // layout.tsx already redirected if this were null
  const [accounts, kyc] = await Promise.all([
    prisma.account.findMany({
      where: { clientId: session!.clientId },
      select: { accountNumber: true, accountMode: true, currency: true, balance: true },
      orderBy: { accountNumber: "asc" },
    }),
    prisma.clientKycRecord.findUnique({ where: { clientId: session!.clientId }, select: { status: true } }),
  ]);

  const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.balance.toString()), 0);
  const liveCount = accounts.filter((a) => a.accountMode === "LIVE").length;
  const demoCount = accounts.filter((a) => a.accountMode === "DEMO").length;

  return (
    <div>
      <div className={styles.cardGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Linked accounts</div>
          <div className={styles.statValue}>{accounts.length}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Live / Demo</div>
          <div className={styles.statValue}>{liveCount} / {demoCount}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Total balance (all accounts)</div>
          <div className={styles.statValue}>{totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>KYC status</div>
          <div className={styles.statValue} style={{ fontSize: 15 }}>
            {kyc?.status === "APPROVED" ? "Approved" : kyc?.status === "REJECTED" ? "Rejected" : kyc ? "Pending review" : "Not submitted"}
          </div>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
            </div>
            <p className={styles.panelText}>You don&apos;t have any trading accounts linked yet.</p>
            <Link href="/portal/accounts" className={styles.btnPrimary}>Go to Trading Accounts</Link>
          </div>
        </div>
      ) : (
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Your accounts</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 14, fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Account</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Mode</th>
                <th style={{ paddingBottom: 8, fontWeight: 600 }}>Currency</th>
                <th style={{ paddingBottom: 8, fontWeight: 600, textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.accountNumber} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 0", fontFamily: "monospace" }}>{a.accountNumber}</td>
                  <td style={{ padding: "10px 0" }}>{a.accountMode}</td>
                  <td style={{ padding: "10px 0" }}>{a.currency}</td>
                  <td style={{ padding: "10px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{parseFloat(a.balance.toString()).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
