# Backend needed

The backoffice Phase 3 rollout shows these actions **disabled, marked "backend needed"**, because no server endpoint
does them yet. Each row is what the screen needs from the web API before the action can be switched on. Labels follow
`docs/audit/2026-09-24/naming.md`. Owner decisions are dated.

## Actions shown disabled

| Screen | Action | Needs | Since |
|---|---|---|---|
| CLI | Credit add / remove | Credit endpoint (built on `be/credit-rights`, held with the credit / trading-rights batch until after the Rust cutover) | 2026-09-28 |
| CLI | Trading rights (Full / Close-only / Read-only) | Same held batch (migration `20260928150000`, not applied) | 2026-09-28 |
| CLI | Force sign-out | An endpoint that revokes one account's sessions on request (suspending already revokes them, 2026-09-29) | 2026-09-28 |
| CLI | Reset client 2FA | An endpoint that clears a client's two-step sign-in, audited | 2026-09-28 |
| DLS | Void trade… | An endpoint that voids a closed trade (the old void was removed in Phase 2 batch 1) | 2026-09-29 |
| EMG | Sign out all clients | A broker-wide session revoke, audited | 2026-09-29 |
| EMG | Incident log | An incident record / timeline | 2026-09-29 |
| MIR | Delete copy rule… | `DELETE /api/manage/mirror-rules/{id}` (today rules can only be disabled) | 2026-09-30, owner |
| CRM | Assign to staff… | A lead owner field + endpoint to set it | 2026-09-30, owner |
| IB | Suspend partner… | An endpoint that suspends a partner (stops new referrals / pay), audited | 2026-09-30, owner |
| IB | Per-partner stats: active clients, volume this month, net deposits this month, partner pay this month | Per-partner aggregates on `GET /api/manage/ib-relationships` (the columns are not drawn until then) | 2026-09-30, owner |
| IB | Sub-partners, referral link, pay schedule, referral funnel | Partner hierarchy, referral links, a payout schedule and funnel counts | 2026-09-30, owner |
| KYC | Sanctions / PEP and duplicate-identity screening ("not available yet") | A screening provider or an internal duplicate check on the ID check | 2026-09-30, owner |
| LP | Connect (FIX session)… | The LP bridge: a real session to a provider (status, heartbeat) | 2026-09-30, owner |
| LP | Delete provider… | `DELETE /api/manage/liquidity-providers/{id}` (records can only be edited today) | 2026-09-30, owner |
| LP | Status "Connected" | Set by the LP bridge when a session is live, not by hand | 2026-09-30, owner |
| LP | Routing rules (add / delete / priority; hidden) | The LP bridge reading `lp-routing`; until then rules are saved but never read | 2026-09-30, owner |
| FEED | Restart price feed | An audited endpoint that restarts the MT5 price-feed program on the server (will later live in VyX Connect's Feed Manager) | 2026-09-30, owner |
| USR | Reset two-step sign-in (2FA)… | A broker-level, audited endpoint that resets a staff member's 2FA (today only the platform administrator can) | 2026-09-30, owner |
| USR | Sign out everywhere… | An endpoint that revokes one staff member's sessions on request (role change, password reset and disable already do) | 2026-09-30, owner |

## Web changes queued for the next web deploy

Not blocking any screen (each works today with an extra read); ship them with the next web deploy.

| Route | Change | Why | Decided |
|---|---|---|---|
| `GET /api/manage/mirror-rules` | Add `targetCurrency` per rule (the copied-into account's currency) | MIR reads the accounts list a second time to find it | 2026-09-30, owner: "bundle with the next web deploy" |
| `GET /api/manage/funds-requests` | Add `currency` per request (the account's) | DEP reads the accounts list a second time for CCY | 2026-09-30, owner |
| `GET /api/manage/balance-adjustment-requests` | Add `currency` per request | Same, for APR | 2026-09-30, owner |
| `GET /api/manage/transfers` | Add `currency` per entry | Same, for TRX history | 2026-09-30, owner |
| funds view KPIs (DEP) | Totals per currency instead of one sum | The DEP tiles add all currencies together today (noted MIXED CCY) | 2026-09-30, owner |
| `GET /api/manage/ib-relationships` | Add `currency` per row (the partner account's) | IB reads the accounts list a second time for CCY | 2026-09-30, owner |
| `GET /api/manage/symbols` | Add `sessionCount` per symbol | SYM's trading-hours summary ("Custom" / "Default week" / "24/7") reads each symbol's sessions separately (6 at a time) | suggested 2026-09-29, not yet decided |
| `GET /api/manage/audit` | Add `actorKind` (staff / system / client / direct database change) and `source` per row | The server sends "system" for every row with no staff member, so AUD cannot tell a client's own change from an automatic one; the direct-change source is read from the change lines today | 2026-09-30, owner |
| `GET /api/manage/audit` (entity labels) | A screen or a label for "Client" (portal profile) records | Those rows have no screen to open (Open is disabled "no related screen") and no readable record label | 2026-09-30, owner |
| `/manager/login`, `/manage/login` | The page `<title>` says the broker's name, not "VyXTrader" | Seen on futurixglobal.com and the futurixglobal subdomain | 2026-09-30, owner: "goes in the next web deploy" |

## D4 (Account types removal): open item

- 2026-09-30, owner: the backoffice approve form for a live account application no longer has an Account type field (the group is the tier). The web route still applies the type the client asked for (`accountTypeId: chosenTypeId ?? existing.accountTypeId` in `app/api/manage/live-account-requests/[id]/route.ts`).
- DONE 2026-09-30 (owner-approved live write on ep-morning-glade, one transaction, 15 audit rows with newValue.source "owner-approved direct write 2026-09-30…"): Futurix Standard / Pro / Zero `AccountType.swapFree` true -> NULL (inherit); groups Dealing and Reverse Trading `swapFree` true -> false; their 10 accounts' own `swapFree` false -> NULL. The group is now the swap-free source. Effective swap-free changed for one account only (50005708, true -> false, no open positions); the other 15 touched accounts were and stay not swap-free.
