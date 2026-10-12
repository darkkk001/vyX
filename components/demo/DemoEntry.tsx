"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_BANNER_TEXT } from "@/lib/demo-policy";

// The QoreTrader demo's front door. Opening the demo host (the root, or /trade without a session) lands here: the page makes
// ONE request, POST /api/demo/guest, which creates a throwaway demo account and signs the visitor in, then goes to the terminal.
// It runs in the browser only, so a crawler that does not run scripts creates no account.
export default function DemoEntry({ brokerName, logoUrl }: { brokerName: string; logoUrl: string }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const enter = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/demo/guest", { method: "POST", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "The demo is not available right now. Try again in a moment.");
        return;
      }
      window.location.replace("/trade");
    } catch {
      setError("Could not reach the demo. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void enter();
  }, [enter]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: "0 16px",
        textAlign: "center",
        background: "radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--brand-primary, #7A1A3A) 35%, #0b0508), #0b0508 70%)",
        color: "#f3e9ec",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      }}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={brokerName} style={{ height: 56, maxWidth: "80vw", objectFit: "contain" }} />
      ) : (
        <div style={{ fontSize: 22, fontWeight: 600 }}>{brokerName}</div>
      )}
      {error ? (
        <>
          <p style={{ margin: 0, maxWidth: 420, fontSize: 15, lineHeight: 1.5 }}>{error}</p>
          <button
            type="button"
            onClick={() => void enter()}
            style={{ border: "1px solid var(--brand-accent, #B06A52)", background: "transparent", color: "inherit", padding: "9px 20px", borderRadius: 8, fontSize: 14, cursor: "pointer" }}
          >
            Try again
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 15, opacity: 0.85 }}>Opening your demo account</p>
      )}
      <p style={{ position: "absolute", bottom: 14, margin: 0, padding: "0 16px", fontSize: 11, opacity: 0.55, maxWidth: 520 }}>{DEMO_BANNER_TEXT}</p>
    </main>
  );
}
