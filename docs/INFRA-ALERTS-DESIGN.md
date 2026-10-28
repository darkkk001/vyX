# VPS infra alerts: closing the gap (owner 2026-10-28)

## The gap

On 2026-10-27 the zzzqa QoreBridge stopped at 07:13:39 UTC (LICENSE STOPPED, sticky until a restart) and stayed down for
about 17 h. The VPS task "VyX QoreBridge health" saw it on every run (LastTaskResult 1, `qb_license_state` 3) and its
reports reached the web (`/api/internal/infra-health` 200 all day), yet no e-mail went out. Two holes, both in
`lib/infra-health.ts`:

1. **FAIL -> FAIL never alerts.** One e-mail on OK -> FAIL, then silence while the state stays FAIL. A component that is
   already failing for one reason (on zzzqa, no LP FIX session) hides every later failure (the license stop).
2. **A check that stops reporting is only visible on Feed health (NO_REPORT).** Nothing e-mails it. Since 10-27
   21:34 UTC every infra-health report is refused with 401 (the VPS sends the rotated INTERNAL_SERVICE_SECRET, Vercel
   still has the old one): the same silence, for every component.

The cause of the stop itself was a Vercel automatic-mitigation challenge (403) on the VPS IP; that is fixed by the
firewall system bypass (deploy/market-data-vps-runbook.md, "Vercel firewall: the VPS IP bypass").

## The rule (web, lib/infra-health.ts)

- **Failure keys.** Every VPS check sends `checks.failing`: stable keys, one per kind of failure (below). A check that
  sends none falls back to its reasons text.
- **FAIL e-mail** when the component starts failing **and whenever a new key appears while it is failing** ("New
  failure: license_state"). A key that clears is forgotten, so it alerts again if it comes back.
- **Reminder**: one "STILL FAILING" e-mail every 6 h while it stays failing (a known, accepted failure can't hide for a
  day).
- **Recovery**: one e-mail when it is OK again after an e-mailed FAIL.
- **NOT REPORTING**: a component that has reported before (its state key exists) and sent nothing for 15 min gets one
  e-mail; one more when it reports again. Checked once a minute by the risk-fallback cron, before its market gates
  (Redis only, runs on weekends too). The text names the usual causes: task stopped, VPS down, 401 after a secret
  rotation, 403 from a firewall.
- **Daily break gate** (16:59-18:00 New York = 20:59-22:00 UTC in summer, 21:59-23:00 UTC in winter): no FAIL or NOT
  REPORTING e-mail inside it. A failure still there after the break alerts at the first report after it; one that
  recovers inside it never e-mails. A check silent through the break gets 15 min from the break's end. Recovery
  e-mails are not gated.
- Same path as before: OPS_ALERT_EMAIL, `[VyX ops]` subject, the component's runbook. A failed e-mail changes no state,
  so the next report (or minute) retries it. One decision per component at a time (a 15 s Redis lock).

## Failure keys (VPS scripts)

| Component | Script | Keys |
|---|---|---|
| qorebridge | deploy/vps/qorebridge-health-check.ps1 | `service`, `health_down` (bridge /health no 200), `health_status`, `health_components`, `metrics`, `license_state` (!= 1), `lp_sessions` |
| caddy | deploy/vps/caddy-health-check.ps1 | `process_count`, `orphan`, `service`, `bind_errors`, `feed_health` (feed /health down) |
| database | deploy/vps/db-health-check.ps1 (ops/db-health-probe) | `engine_db`, `gateway_db`, `web_db` |

The owner's four cases map to: bridge `license_state` != 1 -> `qorebridge/license_state`; bridge /health down ->
`qorebridge/health_down`; feed /health down -> `caddy/feed_health`; engine DB probe -> `database/engine_db`.

## Rollout

Branch `ops/infra-alerts` on top of `ops/db-health-probe` (needs its `database` component), in the next engine/web batch.

1. Web first (the batch deploy). Old VPS scripts keep working: no `checks.failing` = keys from the reasons text.
   Expected right after the deploy: a component that is failing now e-mails once (it was never alerted under the new
   rule), and every component whose reports are refused e-mails NOT REPORTING until INTERNAL_SERVICE_SECRET matches.
2. VPS: copy the three scripts to C:\vyxtrader\scripts (`git show <sha>:deploy/vps/<script>`); the tasks pick them up on
   their next run. No task change.
3. Drill (outside the break): stop the QoreBridge service for 6 min -> FAIL e-mail (`service`, `health_down`);
   start it -> recovery e-mail. Disable "VyX Caddy health" for 16 min -> NOT REPORTING e-mail; enable -> reporting
   again.

A component that is retired: delete its `infra-health:<component>:state` key, or it alerts NOT REPORTING once.
