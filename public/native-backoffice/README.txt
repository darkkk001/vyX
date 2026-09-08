VyXTrader Native Backoffice -- v0.4.0 (29 screens, deep web-parity pass)

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
  3. The sidebar now matches the real web's own navGroups exactly
     (Overview / Clients / Finance / Trading / Liquidity / Organization,
     same labels, same grouping) and reaches all 29 screens: Dashboard,
     Notifications, Trading Accounts, Leads, KYC review, Client KYC,
     Live Account Requests, Deposits & withdrawals, Payment methods,
     Internal transfers, Wallets, IB & affiliates, Live Exposure,
     Dealing queue, Feed health, Deals, Symbols, Client groups, Margin
     monitoring, Risk Radar, Risk rules, Emergency controls, LPs,
     Routing, Reports, Staff & roles, Audit log, Security, System
     settings.
  4. The app applies the logged-in broker's own name, logo, and brand
     color automatically (per-tenant, same as the web backoffice). A
     sun/moon toggle next to Log out switches the whole app between the
     web's real dark and light palettes (exact hex values from
     admin-theme.css), persisted server-side the same way the web does
     (PATCH /api/manage/theme).

What's new in v0.4.0 (deep parity pass -- read/compared every web
screen's own component source, closed real gaps found that way):
  - Trading Accounts: full 13-column table (was 9) -- Type and Group are
    now inline-editable dropdowns, added Country/KYC status/Credit/Max
    daily loss/Swap-free (tri-state)/mirrored+custom-pricing badges. "Add
    account" now has every real field (type, currency, group, leverage,
    starting balance, country, phone, DOB), and shows the new account
    number/password once after creation, matching the web. Balance
    "Adjust" now actually works (was missing entirely) with a real
    Credit/Debit modal, and a maker-checker "Pending balance adjustments"
    Approve/Reject queue is now shown, matching the web's own gate.
  - Two whole screens that didn't exist in the native app at all:
    "KYC review" (identity document submissions -- separate model/route
    from Client KYC, with in-app Front/Back document viewing since an
    OS-browser link can't carry this app's session cookie) and "Risk
    rules" (the broker-wide Dealing-mode master switch, Smart Dealer
    auto-accept/reject %, exposure/position limits, and the same
    open-exposure/floating-P&L/accounts-at-risk stat grid the web
    derives from Margin).
  - Client KYC now shows the suitability questionnaire (annual income,
    source of funds, trading experience, employment status, risk
    tolerance) behind a "View suitability" toggle, plus phone and the
    rejection reason on rejected rows -- all present on the web, missing
    here before.
  - Client groups: the list now shows every real column (margin call %,
    stop out %, max lot, trading restriction, a computed routing badge --
    A-Book/B-Book/Dealing/Reverse Mirror, swap-free, default), and the
    per-symbol pricing tab is now the real 5-field editor (spread markup
    OR target total spread, mutually exclusive via a mode toggle;
    commission/lot; swap long; swap short), each with the same "inherits:
    X" hint the web shows on a blank field. Was: 2 fields, no mode, no
    swap rates.
  - Notifications: unread count in "Mark all read (N)", accent-highlighted
    unread cards, and real per-row actions -- "Reset password" for a
    password-reset request (generates + shows a new password once, same
    as the web) and "View" for every notification type the web
    click-through-navigates for (dealing queue, KYC, leads, funds),
    which also marks it read. Was a plain one-line list with no actions.
  - Margin monitoring: added the Status column (OK/MARGIN CALL/STOP-OUT/
    NO FEED) computed from each account's own real thresholds -- the
    native app was showing a hardcoded 100%/200% guess instead of the
    real per-account marginCallLevel/stopOutLevel the API returns.
  - Global theme toggle (see above) and the sidebar's Notifications item
    now shows a live unread-count badge, matching the web's own.

Carried over from the previous pass (still in this build): Live
Exposure's exposure-by-symbol table, filters, and live activity feed;
Dealing's Dealer ON/OFF toggle, Requote, resting orders, and activity
feed; reworked sidebar icons.

2FA-enabled admin accounts are not supported yet -- use the web
backoffice for those, or disable 2FA on the test account first.

Known gaps in this pass (each disclosed in-app or here, not silent):
Groups' own Create/Edit/Delete modal (routing-type selector, margin
levels, restriction) isn't ported -- the list and pricing tab are;
Live Exposure's IB filter and the web's maker-checker "pending
approvals" queue for position actions aren't ported; the per-account
drill-down detail page isn't ported (Accounts is the list only); column
resize/visibility/virtualized scrolling and bulk multi-select (present
on some web tables) aren't ported; Symbols, Transfers, and Payment
Methods are read-only; Security shows account identity only; Feed
Health reflects the Rust trading core/gateway, usually not deployed
yet, so "not reachable" there is expected. Screens not yet re-verified
against the web in this pass: Dashboard, Live Account Requests, Reports,
Symbols, Team, Transfers, Wallets, IB, Leads, Deals, Audit, Security,
Funds, Payment Methods, Liquidity, Liquidity Routing, Feed Health,
Emergency, Risk Radar -- built in an earlier pass, functional against
the real backend, but not yet re-diffed line-by-line against their web
components the way the screens above were this pass.
