# VyXTrader Desktop

A thin Electron shell around a broker's own WebTrader (`https://<subdomain>/trade`) — same app as the browser version, just a native window with no browser chrome. There is no local server or database here; it only points at the already-deployed site.

## Per-broker branding

Everything broker-specific lives in two places:

- `broker.config.json` — `{ "brokerName": "...", "subdomain": "acmefx.vyxtrader.com" }`
- `build/icon.ico` — the app/taskbar icon (must be `.ico`; convert the broker's logo first if it's a PNG/JPG)

To produce a broker's installer:

```bash
npm install                                        # once
node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" --icon "path\to\acmefx.ico"
npm run build
```

The installer lands in `release/<Broker Name> Setup <version>.exe`. Hand that file (or its link, once hosted somewhere) to the broker.

## Local dev

```bash
npm start          # runs against whatever's currently in broker.config.json
```
