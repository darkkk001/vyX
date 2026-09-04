import { ReactNode } from "react";
import styles from "./TwoPanelAuthShell.module.css";

// Shared two-panel layout for app/manage/login (a specific broker's own
// sign-in, broker-branded) and app/manage-launch (the root-domain broker
// picker, generically vyX-branded, no logoUrl/broker yet) -- pulled out
// once the same reference design (vyx-backoffice-login.html) needed to
// apply to both, rather than duplicating the mesh/grid backdrop and
// panel split twice. The right-panel content is entirely up to the
// caller (a sign-in form vs. a broker picker), so it's just `children`.
export default function TwoPanelAuthShell({
  logoUrl,
  brandName,
  brandSubtitle,
  quote = "Every deposit, withdrawal and dealing decision — logged, auditable, and never one click away from a mistake.",
  quoteAttribution = "Built for teams who manage real client money.",
  children,
}: {
  logoUrl?: string | null;
  brandName: string;
  brandSubtitle: string;
  quote?: string;
  quoteAttribution?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.brandPanel}>
        <div className={styles.brandMesh} />
        <div className={styles.brandGrid} />

        <div className={styles.brokerId}>
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-[38px] w-[38px] shrink-0 rounded-[10px] object-cover" />
          ) : (
            <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent)] text-[15px] font-bold text-[var(--accent-fg)]">
              {brandName.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <div className="text-[16px] font-bold text-[var(--text-1)]">{brandName}</div>
            <div className="mt-px text-[11.5px] text-[var(--text-3)]">{brandSubtitle}</div>
          </div>
        </div>

        <div className={styles.brandQuote}>
          <div className={styles.brandQuoteMark}>&ldquo;</div>
          <div className="text-[19px] font-medium leading-[1.5] text-[var(--text-1)]">{quote}</div>
          <div className="mt-4 text-xs text-[var(--text-3)]">{quoteAttribution}</div>
        </div>

        <div className={styles.brandFooter}>
          <div className={styles.vyxMark} />
          Powered by vyXTrader
        </div>
      </div>

      <div className={styles.formPanel}>
        <div className={styles.formBox}>{children}</div>
      </div>
    </div>
  );
}

export { styles as twoPanelAuthShellStyles };
