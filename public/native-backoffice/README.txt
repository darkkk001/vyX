VyXTrader Native Backoffice -- v0.1.2 (proof-of-concept)

This is a genuinely native Windows app (egui/eframe, no webview, no
browser) that talks directly to the same live /api/manage/* endpoints
the real web backoffice uses. It is NOT code-signed, so Windows will
show a SmartScreen warning on first run:
  "Windows protected your PC" -> click "More info" -> "Run anyway"
This is expected for an unsigned proof-of-concept binary, not a sign of
a problem with the file.

There is no installer -- this is the raw .exe. Just double-click it to
run; nothing is installed to your system, and deleting the file removes
it completely.

On launch:
  1. Enter a broker's own subdomain (e.g. "futurixglobal.vyxtrader.com")
     in the "Broker host" field.
  2. Log in with a real MANAGER or BROKER_ADMIN account for that broker.
  3. Use the sidebar to reach Dashboard, Positions, Clients/Accounts,
     Dealing, Groups, Client KYC, Live Account Requests, Notifications,
     Risk/Exposure, and Settings.

2FA-enabled admin accounts are not supported yet -- use the web
backoffice for those, or disable 2FA on the test account first.

This build is a proof-of-concept, not a finished product: some actions
are intentionally simplified (see the in-app hints on the Dealing and
Groups pricing screens for specifics).
