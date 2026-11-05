"use client";

import { useEffect, useRef } from "react";

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
