"use client";

import React from "react";
import { Button } from "@/components/ui/Button";

// Engine actions (owner 2026-11-14): placeholders only. Every button is disabled and nothing here calls the server: there is no API route
// behind any of them yet, their backend comes with the engine packaging. engines/EngineActions.test.ts proves both.
//
// Licensing is two-tier: one license for the engine itself (app = engine) and one per broker it runs.
// The kill switch follows the license states:
//   Suspend  -> SUSPENDED: no new orders; risk stays ON (SL / TP, stop-out and margin calls keep running on the engine).
//   Resume   -> ACTIVE again.
//   Revoke   -> STOPPED: the engine stops; risk is handed off to the web.

export type EngineAction = { key: string; label: string; detail: string; tone: "secondary" | "danger" | "success" };

export const ENGINE_ACTION_GROUPS: { title: string; note: string; actions: EngineAction[] }[] = [
  {
    title: "Licenses",
    note: "Two tiers: the engine's own license, and one per broker it runs.",
    actions: [
      { key: "license-engine", label: "Issue engine license", detail: "app = engine, for this engine id", tone: "secondary" },
      { key: "license-broker", label: "Issue broker license", detail: "one per broker on this engine", tone: "secondary" },
    ],
  },
  {
    title: "Kill switch",
    note: "Follows the license state.",
    actions: [
      { key: "suspend", label: "Suspend", detail: "Suspended: no new orders, risk stays ON", tone: "danger" },
      { key: "resume", label: "Resume", detail: "Back to active", tone: "success" },
      { key: "revoke", label: "Revoke", detail: "Stopped: risk hands off to the web", tone: "danger" },
    ],
  },
  {
    title: "Deploy",
    note: "Ships a build to this engine's host.",
    actions: [{ key: "deploy", label: "Deploy engine", detail: "a packaged engine build", tone: "secondary" }],
  },
];

export default function EngineActions({ engineId }: { engineId: string }) {
  return (
    <section aria-label={`Actions for ${engineId}`} className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--text-1)]">Engine actions</h3>
        <p className="text-xs text-[var(--text-3)]">Coming with the engine packaging. Not available yet.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {ENGINE_ACTION_GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">{g.title}</p>
            <p className="text-xs text-[var(--text-3)]">{g.note}</p>
            {g.actions.map((a) => (
              <div key={a.key} className="flex flex-col gap-0.5">
                <Button size="sm" variant={a.tone} disabled data-action={a.key} title="Not available yet">
                  {a.label}
                </Button>
                <span className="text-[11px] text-[var(--text-3)]">{a.detail}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
