"use client";

import { useState } from "react";
import DealingQueueManager from "./DealingQueueManager";
import MirrorRulesManager from "./MirrorRulesManager";
import DealingDeskPanel from "@/components/admin/DealingDeskPanel";

const TABS = [
  { id: "queue", label: "Dealing queue" },
  { id: "mirror", label: "Mirror" },
] as const;

// Plain useState tab switcher -- no Tabs primitive exists anywhere in this
// codebase yet (checked), and WebTrader.tsx's own internal tabs use the
// same plain-useState approach rather than a shared component.
//
// Layout fix (2026-09-04): the dealer-activity panel (resting orders +
// feed) used to live behind its own separate "Activity" tab. Everything a
// dealer needs is now on one screen under "Dealing queue" instead --
// DealingDeskPanel renders directly below DealingQueueManager's own
// tables (orders awaiting review, then "Awaiting client confirmation"),
// same stacked-sections pattern, no tab switch required to see both.
export default function DealingTabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("queue");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              tab === t.id
                ? "border-[var(--accent)] text-[var(--text-1)]"
                : "border-transparent text-[var(--text-3)] hover:text-[var(--text-1)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "queue" ? (
        <div className="flex flex-col gap-6">
          <DealingQueueManager />
          <DealingDeskPanel />
        </div>
      ) : (
        <MirrorRulesManager />
      )}
    </div>
  );
}
