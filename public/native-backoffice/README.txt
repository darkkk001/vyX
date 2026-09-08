VyXTrader Native Backoffice -- v0.5.0 (29 screens, deep web-parity pass)

This is a genuinely native Windows app (egui/eframe, no webview, no
browser) that talks directly to the same live /api/manage/* endpoints
the real web backoffice uses. It is NOT code-signed, so Windows will
show a SmartScreen warning on first run:
  "Windows protected your PC" -> click "More info" -> "Run anyway"
This is expected for an unsigned build, not a sign of a problem with
the file.

There is no installer -- this is the raw .exe. Just double-click it to
run; nothing is installed to your system, and deleting the file removes
it completely.

On launch:
  1. Enter a broker's own subdomain (e.g. "futurixglobal.vyxtrader.com")
     in the "Broker host" field.
  2. Log in with a real MANAGER or BROKER_ADMIN account for that broker.
  3. The sidebar matches the real web's own navGroups exactly (Overview
     / Clients / Finance / Trading / Liquidity / Organization) and
     reaches all 29 screens.
  4. The app applies the logged-in broker's own name, logo, and brand
     color automatically. A sun/moon toggle switches the whole app
     between the web's real dark and light palettes, persisted the same
     way the web does.
  5. Every screen refreshes itself automatically every 5 seconds --
     there's no manual Refresh button, matching the web (which stays
     current off a live event stream this app has no equivalent of;
     polling is the closest honest substitute).

What's new in v0.5.0 (six UI bugs fixed, three more screens made fully
functional):
  - Unified header: the app used to show two stacked bars (a window
    drag/controls strip, then a separate title/email/logout bar right
    below it) -- now one bar carries branding, the current screen title,
    and the signed-in admin's controls, still fully draggable.
  - Dashboard: matches the web's real 5-card stat layout (with the same
    delta annotations -- "+N this week", "across N clients", etc.)
    instead of 7 uneven cards; the cards now span the panel's full width
    evenly (was leaving ~40% empty on the right); Recent activity is now
    in its own bordered card with row separators and hover highlighting,
    matching the stat cards' own container style.
  - Every "Refresh" button removed app-wide and replaced with real
    5-second auto-refresh of whichever screen is open -- matches "data
    should be live" instead of just deleting the button and leaving
    screens stale until the app restarts.
  - Symbols: fully editable now (was read-only) -- enabled, trading
    mode, default book type, spread markup, min/max lot, lot step, swap
    long/short, commission/lot, max exposure, each row with its own
    Save, plus a Sessions button opening the trading-windows modal
    (add/remove day + open/close time windows).
  - Payment methods: fully editable now (was read-only) -- enabled,
    min/max amount, fee %/fixed, wallet address (crypto types) or a
    bank-details hint, instructions, per-row Save.
  - Deposits & withdrawals (Funds): the real two-person withdrawal
    approval flow is now wired -- a first admin "Mark for approval," a
    DIFFERENT admin must "Confirm (2nd approval)" before any balance
    moves, and the marking admin can "Cancel mark." Was a plain single-
    click Approve/Reject that didn't match the real maker-checker gate
    at all.
  - Internal transfers: the transfer form actually works now (From/To
    account, amount, note) -- was read-only, history only.
  - Audit log: added search (by order or account number), the Order
    column (symbol/side/lots/order# and account -- dispute-resolution
    evidence, shown inline), and click-to-expand diff lines. Was a bare
    4-column list with no search and no way to see what changed.
  - Client KYC: suitability questionnaire (income, source of funds,
    experience, employment, risk tolerance) behind a View/Hide toggle.
  - Live Account Requests: now shows the rejection reason on rejected
    rows and the resulting account number on approved ones, plus phone/
    country -- was missing all four.
  - Margin monitoring: added the real Status column (OK/MARGIN CALL/
    STOP-OUT/NO FEED) computed from each account's own thresholds --
    was a hardcoded 100%/200% guess.
  - Reports: added the 6 CSV export buttons (trading/financial/client/
    IB/risk/LP) -- this app has no browser to click the web's own
    download links in, so it fetches each CSV itself and saves it
    straight to your Downloads folder.
  - Wallets: added the search box and Total balance/Total credit summary
    line, plus the Status column -- was missing all three.
  - Two whole screens added in the previous pass, still in this build:
    "KYC review" (identity documents, in-app viewer) and "Risk rules"
    (dealing-mode master switch, Smart Dealer %, exposure limits).
  - Client groups: real list columns (margin call/stop out/max lot/
    restriction/routing badge) and the actual 5-field pricing editor
    (spread markup or target spread, commission, swap long/short).
  - Trading Accounts: full 13-column table, inline Type/Group editing,
    full Add-account form, working balance Adjust + maker-checker
    pending approvals queue.
  - Live Exposure's exposure-by-symbol table/filters/activity feed and
    Dealing's Dealer ON/OFF toggle/Requote/resting orders/activity feed
    (from an earlier pass) are unchanged in this build.

2FA-enabled admin accounts are not supported yet -- use the web
backoffice for those, or disable 2FA on the test account first.

Known gaps (disclosed, not silent): Groups' own Create/Edit/Delete
modal (routing-type selector, margin levels, restriction) isn't
ported -- the list and pricing tab are; Symbols' omni-search "?symbol="
deep-link isn't ported; Live Exposure's IB filter and the web's maker-
checker "pending approvals" queue for position actions aren't ported;
the per-account drill-down detail page isn't ported (Accounts is the
list only); column resize/visibility/virtualized scrolling and bulk
multi-select aren't ported; Security shows account identity only, not
2FA setup (this app can't complete a 2FA login challenge yet, so
building a setup flow here would actively lock an admin out); Feed
Health reflects the Rust trading core/gateway, usually not deployed
yet, so "not reachable" there is expected. Not yet re-diffed line-by-
line against their web components this pass: Team, IB, Leads, Deals,
Liquidity, Liquidity Routing, Feed Health, Emergency, Risk Radar --
built in an earlier pass, functional against the real backend.
