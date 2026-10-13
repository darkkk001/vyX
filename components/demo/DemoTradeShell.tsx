"use client";

import { useState } from "react";
import WebTrader from "@/components/webtrader/WebTrader";
import { installDemoClient } from "@/lib/demo-client";

// The WebTrader for the QoreTrader demo tenant: the same terminal, with the demo's browser transport installed first
// (local quotes and chart history, display names without the q prefix) and the demo switches on.
export default function DemoTradeShell({
  brokerName,
  brokerLogoUrl,
  supportEmail,
  serverNowMs,
}: {
  brokerName: string;
  brokerLogoUrl: string;
  supportEmail: string | null;
  /** the server's clock when this page was rendered: the browser's first estimate of server time */
  serverNowMs: number;
}) {
  // installed during the first render, before any effect of the terminal asks for a price; browser only
  useState(() => {
    if (typeof window !== "undefined") installDemoClient(serverNowMs);
    return null;
  });
  return <WebTrader brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} supportEmail={supportEmail} demo />;
}
