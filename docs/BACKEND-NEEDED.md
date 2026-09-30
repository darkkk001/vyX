# Backend needed

The backoffice Phase 3 rollout shows these actions **disabled, marked "backend needed"**, because no server endpoint
does them yet. Each row is what the screen needs from the web API before the action can be switched on. Labels follow
`docs/audit/2026-09-24/naming.md`. Owner decisions are dated.

## Actions shown disabled

| Screen | Action | Needs | Since |
|---|---|---|---|
| CLI | Credit add / remove | Credit endpoint (built on `be/credit-rights`, held with the credit / trading-rights batch until after the Rust cutover) | 2026-09-28 |
| CLI | Trading rights (Full / Close-only / Read-only) | Same held batch (migration `20260928150000`, not applied) | 2026-09-28 |
| DLS | Void trade… | An endpoint that voids a closed trade (the old void was removed in Phase 2 batch 1) | 2026-09-29 |
| EMG | Incident log | An incident record / timeline | 2026-09-29 |
| IB | Per-partner stats: active clients, volume this month, net deposits this month, partner pay this month | Per-partner aggregates on `GET /api/manage/ib-relationships` (the columns are not drawn until then) | 2026-09-30, owner |
| IB | Sub-partners, referral link, pay schedule, referral funnel | Partner hierarchy, referral links, a payout schedule and funnel counts | 2026-09-30, owner |
| KYC | Sanctions / PEP and duplicate-identity screening ("not available yet") | A screening provider or an internal duplicate check on the ID check | 2026-09-30, owner |
| LP | Connect (FIX session)… | The LP bridge: a real session to a provider (status, heartbeat) | 2026-09-30, owner |
| LP | Status "Connected" | Set by the LP bridge when a session is live, not by hand | 2026-09-30, owner |
| LP | Routing rules (add / delete / priority; hidden) | The LP bridge reading `lp-routing`; until then rules are saved but never read | 2026-09-30, owner |
| FEED | Restart price feed | An audited endpoint that restarts the MT5 price-feed program on the server (will later live in VyX Connect's Feed Manager) | 2026-09-30, owner |

## Web changes queued for the next web deploy

Not blocking any screen (each works today with an extra read); ship them with the next web deploy.

| Route | Change | Why | Decided |
|---|---|---|---|
| symbol disable | Gate disabling one symbol behind the emergency-controls permission | issues.md 117/198 | 2026-09-30, owner: web deploy after step 2 |
| notifications read | Mark read per staff member (not for everyone) + an audit row | issues.md 324 | 2026-09-30, owner |
| trading sessions | Sessions that cross midnight | issues.md 335/343 | 2026-09-30, owner |
| live refresh | Halt, copy-rule kill and symbol-limit changes publish a live event | issues.md 347/348/349 | 2026-09-30, owner |
| risk radar | Compute the news-trader flag | issues.md 151 | 2026-09-30, owner |
| `lib/chart-settings.ts` | Accept `slTpTagPnlAlways` (terminal: P/L on SL/TP tags) | Terminal stores it locally until then | proposed 2026-09-30 (terminal batch A) |

## D4 (Account types removal): open item

- 2026-09-30, owner: the backoffice approve form for a live account application no longer has an Account type field (the group is the tier). The web route still applies the type the client asked for (`accountTypeId: chosenTypeId ?? existing.accountTypeId` in `app/api/manage/live-account-requests/[id]/route.ts`).
- DONE 2026-09-30 (owner-approved live write on ep-morning-glade, one transaction, 15 audit rows with newValue.source "owner-approved direct write 2026-09-30…"): Futurix Standard / Pro / Zero `AccountType.swapFree` true -> NULL (inherit); groups Dealing and Reverse Trading `swapFree` true -> false; their 10 accounts' own `swapFree` false -> NULL. The group is now the swap-free source. Effective swap-free changed for one account only (50005708, true -> false, no open positions); the other 15 touched accounts were and stay not swap-free.

## Shipped in the step 2 web deploy (2026-09-30, web `88752c2`, migration `20261001090000_lead_assignee_and_partner_suspend` applied to ep-morning-glade)

The server side is live; the backoffice still shows these disabled until backoffice 1.0.57 switches them on (owner: screenshots first).

| Screen | Action | Route |
|---|---|---|
| CLI | Force sign-out | `POST /api/manage/accounts/{id}/sign-out` |
| CLI | Reset client 2FA | `POST /api/manage/accounts/{id}/reset-2fa` |
| EMG | Sign out all clients | `POST /api/manage/emergency/sign-out-clients {confirm: host}` |
| MIR | Delete copy rule… | `DELETE /api/manage/mirror-rules/{id} (disabled rules with no open copied positions)` |
| CRM | Assign to staff… | `PATCH /api/manage/leads/{id} {assignedAdminId}` |
| IB | Suspend partner… | `POST /api/manage/ib-partners/{ibAccountId}/suspend | resume | release-owed` |
| LP | Delete provider… | `DELETE /api/manage/liquidity-providers/{id} (refused while routing rules point at it)` |
| USR | Reset two-step sign-in (2FA)… | `POST /api/manage/admins/{id}/reset-2fa` |
| USR | Sign out everywhere… | `POST /api/manage/admins/{id}/sign-out` |

Also shipped: IB payouts refused (409) when the partner account is not ACTIVE or the partner is suspended, on every payout path (single, pay-all, release-owed, and approval of a queued request): issues.md line 34 (money).

Queued web changes shipped in the same deploy (additive read fields; the backoffice can drop its second reads in 1.0.57):
- `GET /api/manage/accounts`
- `GET /api/manage/dashboard`
- `/manager/login`, `/manage/login`
- `GET /api/manage/audit` (entity labels)
- `GET /api/manage/audit`
- `GET /api/manage/symbols`
- `GET /api/manage/ib-relationships`
- funds view KPIs (DEP)
- `GET /api/manage/transfers`
- `GET /api/manage/balance-adjustment-requests`
- `GET /api/manage/funds-requests`
- `GET /api/manage/mirror-rules`
