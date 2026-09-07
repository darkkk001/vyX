import Link from "next/link";
import styles from "./BrokerLandingPage.module.css";

// Generic, per-tenant marketing landing page -- rendered at every broker's
// domain root (subdomain or customDomain, see middleware.ts). Copy is
// deliberately broker-agnostic (no claims about regulation/segregated
// funds, which vary per broker and aren't ours to assert) -- only the
// name, logo and accent color are tenant-specific, read from the Broker
// row by app/(broker)/page.tsx and passed in as props. This is a Phase 1
// "get something live" build: no registration/portal yet, just a
// Client Login entry point into the existing WebTrader login flow.
export default function BrokerLandingPage({
  brokerName,
  brokerLogoUrl,
  supportEmail,
}: {
  brokerName: string;
  brokerLogoUrl: string | null;
  supportEmail: string | null;
}) {
  const year = new Date().getFullYear();

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.brand}>
          {brokerLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brokerLogoUrl} alt={`${brokerName} logo`} className={styles.logo} />
          ) : null}
          <span className={styles.brandName}>{brokerName}</span>
        </div>
        <Link href="/trade/login" className={styles.loginBtn}>
          Client Login
        </Link>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroMesh} />
        <div className={styles.heroInner}>
          <h1 className={styles.heroTitle}>{brokerName}</h1>
          <p className={styles.heroSubtitle}>
            Trade forex, metals, indices and crypto CFDs on a fast, reliable
            platform built for serious traders.
          </p>
          <div className={styles.heroActions}>
            <Link href="/trade/login" className={styles.heroPrimaryBtn}>
              Client Login
            </Link>
            {supportEmail ? (
              <a href={`mailto:${supportEmail}`} className={styles.heroSecondaryBtn}>
                Contact Us
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <p className={styles.sectionLabel}>What We Offer</p>
          <h2 className={styles.sectionTitle}>Markets to trade</h2>
          <div className={styles.cardGrid}>
            <div className={styles.card}>
              <div className={styles.cardIcon}>
                <IconChart />
              </div>
              <h3 className={styles.cardTitle}>Forex &amp; Metals</h3>
              <p className={styles.cardText}>
                Major, minor and exotic currency pairs alongside gold and
                silver, with competitive spreads.
              </p>
            </div>
            <div className={styles.card}>
              <div className={styles.cardIcon}>
                <IconBars />
              </div>
              <h3 className={styles.cardTitle}>Indices &amp; Commodities</h3>
              <p className={styles.cardText}>
                Trade the world&apos;s major stock indices and commodities as
                CFDs, all from one account.
              </p>
            </div>
            <div className={styles.card}>
              <div className={styles.cardIcon}>
                <IconCoin />
              </div>
              <h3 className={styles.cardTitle}>Crypto CFDs</h3>
              <p className={styles.cardText}>
                Get exposure to Bitcoin, Ethereum and other major crypto
                assets without holding the underlying coin.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <p className={styles.sectionLabel}>How You Trade</p>
          <h2 className={styles.sectionTitle}>Platforms</h2>
          <div className={styles.cardGrid}>
            <div className={styles.card}>
              <div className={styles.cardIcon}>
                <IconGlobe />
              </div>
              <h3 className={styles.cardTitle}>WebTrader</h3>
              <p className={styles.cardText}>
                Trade directly from your browser -- real-time pricing,
                charting and order management, no installation required.
              </p>
            </div>
            <div className={styles.card}>
              <div className={styles.cardIcon}>
                <IconDesktop />
              </div>
              <h3 className={styles.cardTitle}>Desktop Terminal</h3>
              <p className={styles.cardText}>
                A full-featured trading terminal for your desktop, built for
                fast execution and in-depth analysis.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <p className={styles.sectionLabel}>Why {brokerName}</p>
          <h2 className={styles.sectionTitle}>Built for traders</h2>
          <ul className={styles.whyList}>
            <li className={styles.whyItem}>
              <span className={styles.whyCheck}>
                <IconCheck />
              </span>
              <span className={styles.whyText}>
                <strong>Fast execution</strong> across every account type, on
                every device.
              </span>
            </li>
            <li className={styles.whyItem}>
              <span className={styles.whyCheck}>
                <IconCheck />
              </span>
              <span className={styles.whyText}>
                <strong>Flexible account types</strong> to match your
                trading style and experience level.
              </span>
            </li>
            <li className={styles.whyItem}>
              <span className={styles.whyCheck}>
                <IconCheck />
              </span>
              <span className={styles.whyText}>
                <strong>Simple deposits &amp; withdrawals</strong>, handled
                promptly through your client portal.
              </span>
            </li>
            <li className={styles.whyItem}>
              <span className={styles.whyCheck}>
                <IconCheck />
              </span>
              <span className={styles.whyText}>
                <strong>Real support</strong> from a team that responds when
                you need it.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className={styles.ctaSection}>
        <h2 className={styles.ctaTitle}>Ready to trade?</h2>
        <p className={styles.ctaSubtitle}>
          Log in to your {brokerName} account to get started.
        </p>
        <Link href="/trade/login" className={styles.heroPrimaryBtn}>
          Client Login
        </Link>
      </section>

      <footer className={styles.footer}>
        <span>
          &copy; {year} {brokerName}. All rights reserved.
        </span>
        {supportEmail ? (
          <a href={`mailto:${supportEmail}`} className={styles.footerLink}>
            {supportEmail}
          </a>
        ) : null}
      </footer>
    </div>
  );
}

function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18.5 8 13 13.5l-3-3L5 16" />
    </svg>
  );
}

function IconBars() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <path d="M6 21V10M12 21V6M18 21v-8" />
    </svg>
  );
}

function IconCoin() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7c0 2.3-5 1.3-5 3.6 0 1 1 1.7 2.5 1.7s2.5-.5 2.5-1.5" />
      <path d="M12 6.5v11" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 4 6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-6-4-9s1.5-6.4 4-9z" />
    </svg>
  );
}

function IconDesktop() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
