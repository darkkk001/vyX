# QoreBridgeFeed alert runbook

The monitor is the nssm service `VyXFeedAlert` on the VPS (`deploy/vps/feed-alert-monitor.ps1`, installed by
`deploy/vps/install-feed-alert-service.ps1`). It reads the feed's own API (`127.0.0.1:8096` `/metrics` and `/health`)
and its events CSV every 5 s. It never restarts or changes the feed.

- **Push:** ntfy. The topic is in `C:\vyx-secrets\ntfy-feed-alert-topic.txt`.
- **E-mail:** the platform (`/api/internal/infra-health`, component `qorebridge-feed`) sends it to `OPS_ALERT_EMAIL`
  when the state changes.
- **Status file:** `C:\vyxtrader\status\feed-alert.json`.
- **Log:** `C:\vyxtrader\status\feed-alert-YYYY-MM-DD.log`.
- **Thresholds:** `C:\vyxtrader\config\feed-alert.json`. The monitor reloads the file when it changes, so no restart
  is needed.

## Alerts

| Alert | Severity | Meaning | First checks |
|---|---|---|---|
| `stall` | CRITICAL | No market data on ANY symbol for more than `stall_secs`. | Is `QoreBridgeFeed` running? `curl 127.0.0.1:8096/health` for `feed:session`. Check the feed's FIX log tail. Was it the daily 17:00 New York rollover outside its quiet window? |
| `session` | CRITICAL | The FIX QUOTE session is not ok, or it disconnected. | FIX log: the 35=5 Logout text. Check `qb_feed_reconnect_ms_last`. |
| `logon_reject` | CRITICAL | The LP refused the logon. | **Do not restart in a loop**: three failed logons can lock the cTrader account. Check the password file first. |
| `mapping` | CRITICAL | A symbol is held by the mapping guard, or a `mismatch` event occurred. That symbol stops feeding. | Compare the venue SecurityList against `[[feed.symbol]]` (id, name, digits). |
| `feed_down` | CRITICAL | The feed API did not answer. | `nssm status QoreBridgeFeed`, plus the service logs. |
| `stale` | WARNING | Many symbols are stale at once. | Is it a market close (it is suppressed in the quiet windows), or the session? |
| `drops` | WARNING | Spike in dropped quotes, log lines or post errors. | `qb_feed_dropped` = crossed or zero quotes. `qb_feed_log_dropped` = the shadow log queue was full. |
| `engine` | WARNING | The feed cannot read the engine for more than `engine_warn_secs`. | An engine restart or deploy. |
| `restart` | WARNING | The feed process restarted. | Was it planned? |

CRITICAL alerts repeat every `remind_minutes` while they last. Each alert ends with one RESOLVED push.

## Quiet windows

`quiet_windows` are in New York time, so they follow DST:

- **Daily rollover:** 16:55–17:10 NY. On 2026-10-28 there was a 120 s gap on every symbol here.
- **Weekend:** Friday 16:55 NY to Sunday 17:10 NY.

Only the conditions listed in a window's `suppress` are muted. Session, logon, mapping and feed_down alerts are never
muted.

## Testing

- **Test push:** `powershell -File C:\vyxtrader\scripts\feed-alert-monitor.ps1 -TestPush`
- **One poll, printed:** `powershell -File C:\vyxtrader\scripts\feed-alert-monitor.ps1 -Once`
