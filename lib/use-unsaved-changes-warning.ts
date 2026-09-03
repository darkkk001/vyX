"use client";

import { useEffect } from "react";

// VYX-BASICS-AUDIT.md category 6 "unsaved-changes warning" -- scoped
// deliberately to what's actually achievable: the browser's native
// `beforeunload` covers tab close, refresh, and typing a new URL (the
// cases that actually lose work silently). Next.js App Router has no
// clean built-in "block this in-app navigation" API the way the old
// Pages Router's router.events did (App Router's client-side
// navigation doesn't fire a cancelable event) -- intercepting every
// <Link>/router.push() call app-wide to fake that would be a much
// larger, more fragile change for a rarer case (a dealer in this
// backoffice mid-edit clicking a different sidebar item, not
// accidentally closing the tab), so this is the real, working half of
// the checkbox rather than an over-built fake of the other half.
export function useUnsavedChangesWarning(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Chrome ignores any custom string and shows its own generic
      // wording -- e.returnValue still has to be set (a legacy
      // requirement some browsers still check) for the prompt to fire
      // at all.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);
}
