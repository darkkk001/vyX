"use client";

import { useEffect, useState } from "react";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import TwoPanelAuthShell, { twoPanelAuthShellStyles as styles } from "@/components/admin/TwoPanelAuthShell";

type PublicBroker = { name: string; subdomain: string; logoUrl: string | null };

// Root-domain "pick your broker" screen for the Manager (backoffice)
// desktop app -- the generic, not-baked-to-one-broker build. Same role
// as app/launch/page.tsx (the Client/Trading terminal's own picker),
// except this one only picks a broker -- the actual sign-in happens on
// that broker's own /manage/login once we navigate there (already
// rebuilt against the same reference design -- see
// ManagerLoginForm.tsx), so there's no credential form here and no need
// for /launch's cross-site POST trick.
//
// The broker list is real, not a static/fake one -- /api/public/brokers
// only ever returns brokers actually registered with vyXTrader (see
// that route's own prisma.broker.findMany), so there's nothing extra to
// filter here.
export default function ManageLaunchPage() {
  const [brokers, setBrokers] = useState<PublicBroker[] | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rootHost, setRootHost] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setRootHost(window.location.hostname.replace(/^www\./, ""));
    setIsDesktop(!!window.vyxDesktop?.isDesktop);
    fetch("/api/public/brokers")
      .then((r) => r.json())
      .then((list: PublicBroker[]) => {
        setBrokers(list);
        if (list.length > 0) setSubdomain(list[0].subdomain);
      })
      .catch(() => setError("Could not load broker list"));
  }, []);

  function handleContinue() {
    if (!subdomain || !rootHost) {
      setError("Select a broker");
      return;
    }
    const hostname = `${subdomain}.${rootHost}`;
    // Skips the picker on next launch, same "remember unless told
    // otherwise" default as WebTrader.tsx's own rememberBroker call --
    // there's no password step here to gate it behind, so it fires as
    // soon as a broker is actually chosen.
    if (isDesktop) {
      window.vyxDesktop?.rememberBroker?.(hostname);
    }
    window.location.href = `https://${hostname}/manage/login`;
  }

  return (
    <TwoPanelAuthShell brandName="vyX Manager" brandSubtitle="Broker backoffice access">
      <div className={styles.step}>
        <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Sign in to your backoffice</h1>
        <p className="mb-7 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--text-3)]">
          Choose which broker&apos;s backoffice you want to manage.
        </p>

        {error ? (
          <div className="mb-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="mb-6">
          <FormField label="Broker">
            <Select value={subdomain} onChange={(e) => setSubdomain(e.target.value)} disabled={!brokers || brokers.length === 0}>
              {brokers === null ? (
                <option value="">Loading...</option>
              ) : brokers.length === 0 ? (
                <option value="">No brokers registered yet</option>
              ) : (
                brokers.map((b) => (
                  <option key={b.subdomain} value={b.subdomain}>
                    {b.name}
                  </option>
                ))
              )}
            </Select>
          </FormField>
        </div>

        <Button variant="primary" disabled={!brokers || brokers.length === 0} onClick={handleContinue} className="w-full">
          Continue
        </Button>
      </div>
    </TwoPanelAuthShell>
  );
}
