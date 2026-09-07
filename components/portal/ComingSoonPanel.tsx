import styles from "./PortalShell.module.css";

// Shared by every Stage-3 placeholder tab (Trading Accounts, Funds, KYC,
// Profile, WebTrader) -- the sidebar route exists and navigates correctly
// today; the functional page behind it lands in a later stage. Each
// caller passes its own icon/copy so this reads as "not built yet,
// specifically," not a generic 404-shaped dead end.
export default function ComingSoonPanel({
  icon,
  title,
  description,
  stageNote,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  stageNote: string;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>{icon}</div>
        <h2 className={styles.panelTitle} style={{ marginBottom: 8 }}>
          {title}
          <span className={styles.comingSoon}>Coming soon</span>
        </h2>
        <p className={styles.panelText}>{description}</p>
        <p className={styles.panelText} style={{ color: "var(--text-3)", marginTop: 10, fontSize: 12 }}>{stageNote}</p>
      </div>
    </div>
  );
}
