"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

type PublicBroker = { name: string; subdomain: string; logoUrl: string | null };

// Root-domain "pick your broker" screen for the Manager (backoffice)
// desktop app -- the generic, not-baked-to-one-broker build. Same role
// as app/launch/page.tsx (the Client/Trading terminal's own picker),
// except this one only picks a broker -- the actual sign-in happens on
// that broker's own /manage/login once we navigate there, so there's no
// credential form here and no need for /launch's cross-site POST trick.
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
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-[var(--text-1)]">vyX Manager</h1>
          <p className="mt-1 text-sm text-[var(--text-3)]">Select which broker&apos;s backoffice to sign in to.</p>
        </div>

        <div className="flex flex-col gap-4">
          <FormField label="Broker">
            <Select value={subdomain} onChange={(e) => setSubdomain(e.target.value)} disabled={!brokers || brokers.length === 0}>
              {brokers === null ? (
                <option value="">Loading...</option>
              ) : brokers.length === 0 ? (
                <option value="">No brokers available</option>
              ) : (
                brokers.map((b) => (
                  <option key={b.subdomain} value={b.subdomain}>
                    {b.name}
                  </option>
                ))
              )}
            </Select>
          </FormField>

          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Button variant="primary" disabled={!brokers || brokers.length === 0} onClick={handleContinue} className="w-full">
            Continue
          </Button>
        </div>
      </Card>
    </main>
  );
}
