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

## Web changes queued for the next web deploy

Not blocking any screen (each works today with an extra read); ship them with the next web deploy.

| Route | Change | Why | Decided |
|---|---|---|---|
| `GET /api/manage/mirror-rules` | Add `targetCurrency` per rule (the copied-into account's currency) | MIR reads the accounts list a second time to find it | 2026-09-30, owner: "bundle with the next web deploy" |
| `GET /api/manage/funds-requests` | Add `currency` per request (the account's) | DEP reads the accounts list a second time for CCY | 2026-09-30, owner |
| `GET /api/manage/balance-adjustment-requests` | Add `currency` per request | Same, for APR | 2026-09-30, owner |
| `GET /api/manage/transfers` | Add `currency` per entry | Same, for TRX history | 2026-09-30, owner |
| funds view KPIs (DEP) | Totals per currency instead of one sum | The DEP tiles add all currencies together today (noted MIXED CCY) | 2026-09-30, owner |
| `GET /api/manage/symbols` | Add `sessionCount` per symbol | SYM's trading-hours summary ("Custom" / "Default week" / "24/7") reads each symbol's sessions separately (6 at a time) | suggested 2026-09-29, not yet decided |
