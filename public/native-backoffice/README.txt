VyXTrader Native Backoffice -- v0.3.0 (all 27 core screens)

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
  3. The sidebar (grouped: Overview, Trading, Clients, Finance,
     Liquidity, Admin) reaches all 27 screens: Dashboard, Reports,
     Notifications, Live Exposure, Dealing, Deals, Symbols, Margin,
     Risk/Exposure, Clients/Accounts, Leads, IB, Client KYC, Live Account
     Requests, Wallets, Transfers, Funds, Payment Methods, Liquidity,
     Liquidity Routing, Feed Health, Groups, Team, Audit, Security,
     Emergency, and Settings.
  4. The app applies the logged-in broker's own name, logo, and brand
     color automatically (per-tenant, same as the web backoffice).

What's new in v0.3.0 (native/web parity pass):
  - "Positions" is renamed "Live Exposure" to match the web exactly
    (the web page's own title is literally "Live Exposure"), and now
    includes what the web's own Live Exposure has: an "Exposure by
    symbol" table (net exposure, net-side VWAP, client floating P&L,
    sortable by Symbol/Exposure/Risk), Symbol/Account/Group/Side/P&L
    filters, and a live broker-wide activity feed underneath. The flat
    "Open positions" table now also shows S/L, T/P, and has working
    Modify (SL/TP) and Close actions -- neither existed in the native
    app before this pass.
  - Dealing now matches the web's real dealing desk: a Dealer ON/OFF
    toggle at the top (same confirm-before-turning-off dialog as the
    web), a working Requote action (previously missing -- Accept/Reject
    only), an "Awaiting client confirmation" table for requotes not yet
    answered, a "Resting orders" table (active LIMIT/STOP orders on
    dealing-group accounts), and a dealing-group-scoped live activity
    feed, filterable by account.
  - Sidebar icons reworked -- several of the old glyphs (different
    "square with hatch pattern" characters) were visually
    indistinguishable from each other at sidebar size; replaced with a
    set of genuinely different silhouettes (circle/triangle/diamond/
    arrow/bar). Dashboard and Reports still fall back to a generic box
    on this font -- a font-coverage gap, not a missing feature.

2FA-enabled admin accounts are not supported yet -- use the web
backoffice for those, or disable 2FA on the test account first.

Known simplifications in this pass (each screen shows an in-app note
where relevant): Live Exposure's IB filter and the web's maker-checker
"pending approvals" queue for position actions aren't ported yet;
column resize/visibility/virtualized scrolling and bulk multi-select
(present on some web tables) aren't ported; Symbols, Transfers, and
Payment Methods are read-only (editing lives on the web, or on the
Groups pricing screen for per-symbol spread); Security shows account
identity only, not full 2FA/device management; Feed Health reflects the
Rust trading core/gateway, which are usually not deployed yet, so "not
reachable" there is expected, not a bug.
