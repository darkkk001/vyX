"use client";

import { useEffect, useState } from "react";
import styles from "./PortalAuth.module.css";

// "Resend verification e-mail" (owner 2026-10-05): shown on the register page
// when the address already exists unverified (409), and on the login page when
// login is refused for an unverified address or the link has expired. The API
// answers the same for every address, so the line below never says whether
// the address is registered.
const COOLDOWN_SECONDS = 60;

export default function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "limited" | "invalid">("idle");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function resend() {
    const address = email.trim();
    if (!address.includes("@")) {
      setState("invalid");
      return;
    }
    setState("sending");
    const response = await fetch("/api/portal/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: address }),
    }).catch(() => null);
    if (response?.status === 429) {
      setState("limited");
    } else {
      setState("sent");
    }
    setCooldown(COOLDOWN_SECONDS);
  }

  const busy = state === "sending" || cooldown > 0;
  return (
    <div className={styles.resendBox}>
      <button type="button" className={styles.linkBtn} onClick={resend} disabled={busy}>
        {cooldown > 0 ? `Resend verification e-mail (${cooldown} s)` : "Resend verification e-mail"}
      </button>
      {state === "sent" ? <div className={styles.formNotice}>If an unverified account exists for that address, we&apos;ve sent a new link.</div> : null}
      {state === "limited" ? <div className={styles.formError}>Too many attempts, try again later.</div> : null}
      {state === "invalid" ? <div className={styles.formError}>Enter your e-mail address above first.</div> : null}
    </div>
  );
}
