# Backoffice badges: one request for every sidebar count (2026-10-05)

Replaces the nine list loads the native backoffice's `RefreshBadgesAsync`
(E:\vyxtrader, `src/Vyx.Backoffice.App/Views/MainWindow.axaml.cs`) made on every refresh (after any admin event, at
most every 5 s per window, and every 60 s): shell-info, kyc-requests, client-kyc-requests, live-account-requests,
funds-requests, risk-radar, balance-adjustment-requests, position-action-requests and dealing-queue, each counted
client-side. Live Neon was overloaded; Vercel showed `/api/manage/*` at 6.3 req/s for one broker, in bursts.

## Request

`GET /api/manage/badges`, admin session cookie, no parameters. Same gate as `GET /api/manage/shell-info`: any broker
staff role (BROKER_ADMIN, MANAGER, SUPPORT), scoped to the session's broker. No session, another role, or no broker:
`403 { "error": "forbidden" }`. A staff member who has not enrolled 2FA gets the usual
`403 { error, code: "TWO_FACTOR_SETUP_REQUIRED" }` (lib/auth.ts).

## Response

```
200 { "deal": int|null, "apr": int|null, "rdr": int|null, "kyc": int|null, "lar": int|null, "dep": int|null,
      "unread": int, "computedAt": ISO-8601 }
```

| Field | Screen | Counts (exactly what that screen's own list shows) |
|---|---|---|
| `deal` | DEAL | PENDING MARKET orders awaiting a dealer (dealing-queue `rows`, the backoffice's `Pending`; REQUOTED orders are not counted) |
| `apr` | APR | PENDING balance-adjustment requests + PENDING position-action requests |
| `rdr` | RDR | risk-radar rows with any flag set (scalp, martingale, latency arbitrage, news trading; the backoffice's `FlagCount > 0`) + same-IP clusters |
| `kyc` | KYC | PENDING account KYC records + PENDING client KYC records |
| `lar` | LAR | PENDING live-account requests |
| `dep` | DEP | PENDING DEPOSIT and WITHDRAWAL transactions (funds-requests) |
| `unread` | NTF | the signed-in person's unread staff notifications, the same number as shell-info's `unreadNotifications` |
| `computedAt` | | when the response was built (UTC) |

- **null** = this staff member may not open that screen. The rule is shell-info's `screens` list
  (lib/backoffice-screens.ts: role + delegated permissions, read fresh on every call), so a badge is null exactly when
  its screen is not in the menu. Today: MANAGER without KYC_REVIEW gets `kyc` / `lar` null, without FUNDS_APPROVAL
  `dep` null; SUPPORT gets `deal`, `apr`, `rdr` and `lar` null. Show no badge for null; do not show 0.
- Counts are uncapped. The old lists cap some queues at 200 rows; these are the true queue lengths.
- `deal`, `apr`, `kyc`, `lar`, `dep` and `unread` are live on every call. `rdr` comes from the risk radar's 5-minute
  server cache (lib/risk-radar-cache.ts, the same cache `GET /api/manage/risk-radar` serves), so it can lag by up to
  5 minutes, as before.
- `unread` is never null (every staff role may open NTF).

## Cost

One SQL statement of COUNT sub-selects (with a MANAGER's delegated permissions in the same statement), plus the
radar from its cache, run in parallel. A count the role alone rules out (SUPPORT) is not run at all. No list is
loaded. Before: nine requests, each a full list read (several with joins and up to 200 rows per list), plus
the radar.

## Client guidance

Call it where `RefreshBadgesAsync` loaded the lists (after an admin event, throttled, and on the 60 s timer).
shell-info is still the source of identity, theme, permissions and `screens`; it does not need to be re-read on
every badge refresh. The DEAL screen may keep setting its own badge from the queue it already holds.
