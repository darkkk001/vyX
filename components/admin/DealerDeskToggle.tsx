"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { useToast } from "@/lib/toast";

type ToggleState = { dealerOn: boolean } | null;

// Prominent Dealer ON/OFF switch at the top of the Dealing page
// (2026-09-04). ON (default): DEALING-group orders route to this queue
// for manual accept/reject/requote. OFF: they auto-fill at market
// instead, and flipping OFF immediately auto-fills whatever's already
// sitting in the queue too, so nothing is left waiting on a desk nobody's
// watching. See app/api/manage/dealing-desk-toggle/route.ts for the full
// design note and Broker.dealingDeskAutoFillAt's own schema comment.
export default function DealerDeskToggle() {
  const [state, setState] = useState<ToggleState>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const { showToast } = useToast();

  function load() {
    return fetch("/api/manage/dealing-desk-toggle")
      .then((r) => r.json())
      .then((d: { dealerOn: boolean }) => setState({ dealerOn: d.dealerOn }));
  }

  useEffect(() => {
    load().catch(() => setState({ dealerOn: true }));
  }, []);

  async function setDealer(dealerOn: boolean) {
    setBusy(true);
    const response = await fetch("/api/manage/dealing-desk-toggle", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealerOn }),
    });
    setBusy(false);
    if (!response.ok) {
      showToast("Could not change the dealer switch.", "danger");
      return;
    }
    const body = await response.json();
    setState({ dealerOn: body.dealerOn });
    if (!dealerOn) {
      const filled = (body.flushed ?? []).filter((f: { status: string }) => f.status === "filled").length;
      const skipped = (body.flushed ?? []).filter((f: { status: string }) => f.status === "skipped").length;
      if (filled > 0 || skipped > 0) {
        const parts = [];
        if (filled > 0) parts.push(`${filled} order${filled === 1 ? "" : "s"} filled at market`);
        if (skipped > 0) parts.push(`${skipped} left in the queue (couldn't fill safely)`);
        showToast(parts.join(", "), skipped > 0 ? "warning" : "success");
      } else {
        showToast("Dealer turned off. Orders will auto-fill at market from now on.", "success");
      }
    } else {
      showToast("Dealer turned on. Orders will queue for manual review.", "success");
    }
  }

  function handleToggleClick() {
    if (!state) return;
    if (state.dealerOn) {
      setConfirmOff(true);
    } else {
      setDealer(true);
    }
  }

  if (!state) {
    return null;
  }

  return (
    <>
      {/* Layout fix (2026-09-05) -- the previous CSS Grid attempt
          (`gridTemplateColumns: "48px 1fr"`) hardcoded the toggle's track
          width as a literal "48px" string kept in sync BY HAND with the
          button's own `w-12` Tailwind class (also 48px) -- two independent
          sources of truth for the same number, and still overlapping in
          production per a real screenshot despite matching today. Flexbox
          removes that duplication entirely: `shrink-0` sizes the toggle
          from its OWN rendered box (whatever `h-7 w-12` actually computes
          to, no separate guess to fall out of sync with it), `gap-5`
          reserves a hard 20px minimum space no sibling can ever occupy
          (a flex/grid gap track, unlike a plain margin, can't be collapsed
          or overlapped by content the way absolute positioning or a
          margin miscalculation could), and `min-w-0 flex-1` on the text
          block lets its two lines wrap and shrink to fit whatever room is
          left -- it can never push back into the toggle's reserved space,
          at any container width from a narrow mobile viewport up. Toggle
          and text are also each other's only flex siblings (no third
          item competing for space), so this holds regardless of theme or
          viewport. */}
      <div
        className={`flex items-center gap-5 rounded-xl border px-4 py-3 ${
          state.dealerOn ? "border-[var(--border)] bg-[var(--bg-1)]" : "border-[var(--warn)]/40 bg-[var(--warn-bg)]"
        }`}
      >
        <button
          type="button"
          role="switch"
          aria-checked={state.dealerOn}
          disabled={busy}
          onClick={handleToggleClick}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            state.dealerOn ? "bg-[var(--buy)]" : "bg-[var(--text-3)]"
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${
              state.dealerOn ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-1)]">
            {state.dealerOn ? "Dealer ON" : "Dealer OFF"}
          </p>
          <p className="text-xs text-[var(--text-3)]">
            {state.dealerOn
              ? "Orders from dealing-group accounts require manual review."
              : "Orders from dealing-group accounts auto-fill at market."}
          </p>
        </div>
      </div>

      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn dealer off?">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            Dealing-group orders will auto-fill at market instead of waiting for review. Anything currently sitting
            in the queue will be filled at market right now too, unless it fails a risk check, in which case it
            stays queued.
          </p>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirmOff(false);
                setDealer(false);
              }}
            >
              {busy ? "Working..." : "Turn dealer off"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </>
  );
}
