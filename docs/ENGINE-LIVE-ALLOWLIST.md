# Engine live allowlist — the shared contract (DORMANT)

Owner, 2026-11-11 (live cutover, web layer and shared contract). **Dormant**: both new columns default to `false`, nothing turns them on,
no account is enabled, nothing is deployed with this change. Enabling accounts and deploying each need the owner's separate, explicit go.

## The single source: two database columns

| Column | Table | Type | Default | Meaning |
|---|---|---|---|---|
| `"engineLiveAllowlistOn"` | `"Broker"` | `BOOLEAN NOT NULL` | `false` | The feature flag. While `false`, no LIVE account of this broker is engine-enabled, whatever its entry says. |
| `"engineLiveEnabled"` | `"Account"` | `BOOLEAN NOT NULL` | `false` | The allowlist entry: this LIVE account may take the engine path. Counts only while its broker's flag is `true`. |

Migration: `prisma/migrations/20261111140000_engine_live_allowlist/migration.sql` (additive, two `ADD COLUMN ... NOT NULL DEFAULT false`).
The engine, the gateway and the web read **these two columns and nothing else** for this decision. The environment list
(`ENGINE_INGRESS_ACCOUNTS` / `ingress::restrict_to`) stays what it is today: the trial *scope*; it never makes a LIVE account eligible.

## The one rule (all three implementations)

```
engine_live_allowed(account) =
    account."accountMode" = 'LIVE'
    AND broker."engineLiveAllowlistOn" = true
    AND account."engineLiveEnabled"   = true

mode_allowed(account) = !restricted() || account."accountMode" = 'DEMO' || engine_live_allowed(account)      -- the engine's order path
risk owner            = RUST when broker."riskAuthority" = 'RUST' AND mode in (DEMO, LIVE)
                        AND (NOT demo-only OR mode = DEMO OR engine_live_allowed(account))                     -- risk authority
```

Anything missing, `NULL`, unknown or `false` = not allowed (fail-closed). With the flag off or no entry set, `engine_live_allowed` is always
false and both rules are **exactly today's** (`mode_allowed = !restricted() || account_mode == "DEMO"` and the demo-only owner rule).

## Read paths

- **Web** (done, branch `feat/engine-live-allowlist`): `lib/risk-authority.ts` `engineLiveAllowed()` / `riskOwnerOf()` / `effectiveRiskOwner()`;
  `lib/risk-owner.ts` selects `b."engineLiveAllowlistOn"` and `a."engineLiveEnabled"` in both reads (`loadRiskOwners`, `assertRiskActorInTx`).
- **Engine** (VPS session): add both columns to the account-gate read the order path already does on the database's answer
  (`db.rs`, the query that fills `snap.gates.account_mode`) — `JOIN "Broker" b ON b.id = a."brokerId"`, select `b."engineLiveAllowlistOn"`
  and `a."engineLiveEnabled"` — and change `ingress::mode_allowed(account_mode)` to
  `mode_allowed(account_mode, allowlist_on, engine_live_enabled)` = the rule above, at **every** call site (lib.rs 291, 1198, 1389).
  `authority.rs`: `risk_owner_of` and `RUST_OWNED_SQL` gain the same `OR (a."accountMode" = 'LIVE' AND b."engineLiveAllowlistOn" AND a."engineLiveEnabled")`
  inside the demo-only clause.
- **Gateway** (VPS session): wherever it decides an account may use the engine path, read the same two columns in the same query as the
  account's mode (never an env list, never a cache older than the request).
- **Case matrix**: `lib/engine-live-allowlist-cases.json` (324 cases: authority × demo-only × flag × mode × entry → `modeAllowed`, `owner`).
  The web is tested on it (`lib/engine-live-allowlist.test.ts`); the engine and gateway tests must read the **same file** and agree on every row.

## Setting an entry

`PATCH /api/manage/accounts/{id}/engine-live` `{ "enabled": true|false, "reason": "..." }` — BROKER_ADMIN only, LIVE accounts only (409 for DEMO),
audited as `ENGINE_LIVE_ALLOWLIST_SET` (old / new value, reason, the flag's state). `GET` shows the entry and the broker's flag.
The route never changes `Broker.engineLiveAllowlistOn`: the flag is turned on only by the owner, separately.

## Before any account is enabled (not part of this dormant change)

1. Engine and gateway implement the rule above on these columns, tested on the shared case matrix.
2. Done: `lib/amount-sltp.ts` `amountRefusedForAuthority` now passes the entry (all three callers read `Account.engineLiveEnabled` and the flag), so an
   allowlisted LIVE account is judged as engine-owned. Proof: `lib/amount-sltp-allowlist.test.ts` (flag off / no entry identical to the previous rule).
3. The backoffice toggle (native backoffice) calls the route above.
4. Owner's explicit go for the flag, for each account, and for the deploy.

## Proof that flag-off / empty-list is unchanged

`lib/engine-live-allowlist.test.ts`: the pre-change rule (verbatim from main 541ca98) vs the new one over every combination of authority,
demo-only, mode, engine liveness, flag and entry (including null / missing / unknown values): identical for flag off (2,304 combinations),
identical for flag on with the account not on the list, identical for every caller that passes no allowlist input; the only differing
combinations are flag on + entry on + LIVE + RUST demo-only broker + engine alive. The database path (`app/api/manage/accounts/[id]/engine-live/route.test.ts`)
shows an entry set ON with the flag OFF still gives today's owners.
