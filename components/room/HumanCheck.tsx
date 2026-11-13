"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Cloudflare Turnstile (the widget is Invisible, set in Cloudflare). A token is single use: raise `round` after each try
// to get a new one.
type Turnstile = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void };
declare global { interface Window { turnstile?: Turnstile } }

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;
function load(): Promise<void> {
  return (loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error("turnstile script")); };
    document.head.appendChild(s);
  }));
}

export default function HumanCheck({ siteKey, round, onToken }: { siteKey: string; round: number; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const report = useRef(onToken);
  report.current = onToken;

  useEffect(() => {
    let gone = false;
    load().then(() => {
      if (gone || !box.current || !window.turnstile) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey,
        callback: (t: string) => report.current(t),
        "expired-callback": () => report.current(""),
        "error-callback": () => report.current(""),
      });
    }).catch(() => report.current(""));
    return () => {
      gone = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (round > 0 && widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [round]);

  return <div ref={box} />;
}

// Out of the page flow: the widget is Invisible, so it adds no space where the form puts it.
const OFF_FLOW: CSSProperties = { position: "absolute", width: 0, height: 0, overflow: "hidden" };

/**
 * The human check for a form (owner 2026-11-13: every CRM sign-in form). `el` goes anywhere in the form; `take()` waits
 * (up to 15 s) for Cloudflare's token, hands it over and asks for a fresh one for the next try. No site key = "".
 */
export function useHumanCheck(siteKey: string | null): { el: ReactNode; take: () => Promise<string> } {
  const [round, setRound] = useState(0);
  const token = useRef("");
  const el = siteKey ? <div style={OFF_FLOW}><HumanCheck siteKey={siteKey} round={round} onToken={(t) => { token.current = t; }} /></div> : null;
  async function take(): Promise<string> {
    if (!siteKey) return "";
    for (let i = 0; i < 60 && !token.current; i++) await new Promise((r) => setTimeout(r, 250));
    const t = token.current;
    token.current = "";
    setRound((r) => r + 1);
    return t;
  }
  return { el, take };
}
