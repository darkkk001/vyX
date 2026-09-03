# VyXTrader — Basic Hygiene Audit (vs MT5/cTrader standard)

Yeh Feature Spec se ALAG hai — wahan "kya feature hona chahiye" tha, yahan "jo bana hua hai
wo BASIC PLATFORM QUALITY se milta hai ya nahi". Har cheez har professional terminal mein
hoti hai, chahe broker koi bhi ho. PC ko in-order diya jayega.

## 1. Layout consistency (abhi ka bug isi category mein hai)
- [ ] Har tab (Positions/Net/Pending/Orders/History/Analytics/Logs) SAME table shell use kare —
      column widths, alignment, padding identical chahe data ho ya empty-state
- [ ] Empty state hamesha center, same message style, same icon/illustration position
- [ ] Panel resize kisi bhi tab pe ho, sab tabs ka layout theek rahe (state leak nahi)
- [ ] Switching tabs se koi horizontal shift/jump na ho
- [ ] Zoom 90%–125% pe layout na toote (browser zoom test)
- [ ] Window resize (narrow to wide) har breakpoint pe theek

## 2. Tables (universal — terminal + backoffice)
- [ ] Fixed-height scroll container, sticky header, in-panel scrollbar — QUEUED, not done
- [ ] Column sort (click header) — click par ascending/descending, arrow indicator
- [ ] Column resize (drag border) — MT5 mein hota hai
- [ ] Column show/hide (right-click header) — "Right-click for more columns" text hai, verify kaam karta hai
- [ ] Row hover highlight
- [ ] Row right-click context menu (relevant actions: close, modify, copy ID)
- [ ] Multi-select (checkbox) → bulk action bar appears
- [ ] Loading skeleton while fetching (not blank/flash)
- [ ] Empty vs Error vs Loading — teeno alag visual state, kabhi confuse na ho

## 3. Forms & inputs (order ticket, dialogs, backoffice forms)
- [ ] Every numeric input: min/max/step enforced, invalid input shows inline error not silent clamp
- [ ] Tab order logical (keyboard-only user form fill kar sake)
- [ ] Enter submits, Esc cancels — every dialog
- [ ] Disabled states have a reason (tooltip), never just greyed with no explanation
- [ ] Loading state on submit buttons (spinner, disabled during request) — double-submit prevention
- [ ] Confirmation dialogs for destructive actions (close, delete, cancel) — consistent wording

## 4. Feedback & states
- [ ] Every action gives feedback within 300ms (optimistic UI or spinner) — no "did it work?" silence
- [ ] Toasts: consistent position, auto-dismiss timing, stack properly (don't overlap)
- [ ] Network error → clear message + retry action, never a silent blank screen
- [ ] 404/permission-denied pages exist and are styled (not raw Next.js error)
- [ ] Session-expiry → clean redirect to login with a message, not a broken blank app

## 5. Numbers & formatting (trading-specific basics)
- [ ] Every price respects symbol digits everywhere (ticket, table, chart, tooltip) — audit ALL surfaces, not just chart (chart was fixed; ticket/tables not yet re-verified)
- [ ] P/L color convention consistent (green profit/red loss) — every table, every page
- [ ] Currency/number thousands separators consistent (10,000.00 not 10000)
- [ ] Percentages: consistent decimal places, sign shown (+/-)
- [ ] Dates/times: one consistent format across the whole app, user's timezone OR explicit UTC label — audit for mixed formats

## 6. Navigation & wayfinding
- [ ] Every page has a clear title/breadcrumb (where am I)
- [ ] Back button (browser) behaves sanely, doesn't break app state
- [ ] Deep links work (paste a URL to a specific account/order, loads correctly on fresh load)
- [ ] Unsaved-changes warning when navigating away from a dirty form

## 7. Accessibility basics (also just good UX)
- [ ] Every icon-only button has a tooltip/aria-label (the unlabeled "0/04" badge is this bug)
- [ ] Focus states visible (keyboard nav shows where you are)
- [ ] Color is never the ONLY signal (icons/text alongside color-coded status)

## 8. Performance basics
- [ ] No layout shift after data loads (skeleton matches final layout size)
- [ ] Large tables (500+ rows) don't freeze the tab — virtualization if needed
- [ ] Chart stays smooth with multiple indicators + live ticks

---
## Delivery instruction for PC
Go through this list top to bottom against the live production app (not just code review —
click every checkbox). For each ❌ found, fix it. This takes priority over new features until
this document is fully checked off, because these are foundation-level bugs that undermine
trust in everything built on top. Report progress in batches of ~10 checked items, not all
at once.
