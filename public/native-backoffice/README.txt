VyXTrader Native Backoffice -- v0.2.0 (all 27 core screens)

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
     Notifications, Positions, Dealing, Deals, Symbols, Margin,
     Risk/Exposure, Clients/Accounts, Leads, IB, Client KYC, Live Account
     Requests, Wallets, Transfers, Funds, Payment Methods, Liquidity,
     Liquidity Routing, Feed Health, Groups, Team, Audit, Security,
     Emergency, and Settings.
  4. The app applies the logged-in broker's own name, logo, and brand
     color automatically (per-tenant, same as the web backoffice).

2FA-enabled admin accounts are not supported yet -- use the web
backoffice for those, or disable 2FA on the test account first.

Known simplifications in this pass (each screen shows an in-app note
where relevant): Dealing has no Requote action (Accept/Reject only);
Symbols, Transfers, and Payment Methods are read-only (editing lives on
the web, or on the Groups pricing screen for per-symbol spread);
Security shows account identity only, not full 2FA/device management;
Feed Health reflects the Rust trading core/gateway, which are usually
not deployed yet, so "not reachable" there is expected, not a bug.
