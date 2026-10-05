# Staff credentials and internal accounts (owner 2026-10-05, backoffice 1.0.61)

Four routes the backoffice's password card and the "Internal account" flag code against. All are `/api/manage/*`,
staff session of the account's own broker. Another broker's account is always `404 {"error":"account not found"}`.

## 1. Reset password (changed)

`POST /api/manage/accounts/{id}/reset-password`, no body. Gate: `ANY_MANAGER` (BROKER_ADMIN or any MANAGER;
SUPPORT 403). Generates a temporary password, revokes every session of the account, audits `ACCOUNT_PASSWORD_RESET`
(never the password).

200 response, ALWAYS this shape:

```json
{ "password": "Abc12345xyz", "emailed": true, "to": "client@example.com", "notEmailedReason": null }
{ "password": "Abc12345xyz", "emailed": false, "to": null, "notEmailedReason": "UNAVAILABLE" }
```

- `password`: always present. The card shows it masked; SHOW PASSWORD reveals it and calls route 2.
- `emailed`: true when the provider accepted the e-mail to the account's address.
- `to`: the address it was sent to (full address: staff already see it), else null.
- `notEmailedReason` (null when `emailed`):
  - `"INTERNAL_ACCOUNT"`: the account is flagged internal (route 4). Internal accounts are NEVER e-mailed.
  - `"NO_EMAIL"`: the account has no e-mail address.
  - `"UNAVAILABLE"`: the broker's e-mail is off / has no sender, or the provider refused the send.

Old fields `emailFallback` and the password-less `{emailed, to}` answer are gone (backoffice 1.0.60 and older read
`password` when present and `emailed` when true, so they keep working).

## 2. Password revealed (new)

`POST /api/manage/accounts/{id}/password-revealed`, no body. Gate: same as reset. The backoffice calls it when staff
click SHOW PASSWORD on the card (once per card). Audits `PASSWORD_REVEALED` (actor admin, entity Account,
`newValue {accountNumber}`; the time is the audit row's). 200 `{"ok":true}`. The password itself is never sent here.

## 3. Set password (new)

`POST /api/manage/accounts/{id}/set-password` body `{ "password": string, "emailToClient": boolean }`. Gate: same as
reset. Staff choose the password.

- Rule: at least 8 characters, with at least one letter and one digit, at most 128.
  Refused: `400 {"error":"Use at least 8 characters with letters and digits.","code":"WEAK_PASSWORD"}`.
  Missing/non-boolean fields: `400 {"error":"...","code":"INVALID_BODY"}`.
- Revokes every session of the account (like reset). Audits `ACCOUNT_PASSWORD_SET` (never the password).
- E-mail only when `emailToClient` is true; internal accounts are never e-mailed (`emailToClient` is ignored).
- 200 `{ "emailed": boolean, "to": string|null, "notEmailedReason": "UNAVAILABLE"|"INTERNAL_ACCOUNT"|"NO_EMAIL"|"NOT_REQUESTED"|null }`
  (`NOT_REQUESTED` = `emailToClient` was false). The password is not echoed back: staff typed it.

## 4. Internal account flag (new)

- Schema: `Account.isInternal Boolean @default(false)` (additive migration).
- `PATCH /api/manage/accounts/{id}` accepts `{ "isInternal": boolean }`. BROKER_ADMIN only (a MANAGER gets
  `403 {"error":"only a broker admin can change the internal flag","code":"BROKER_ADMIN_ONLY"}`). Audits
  `ACCOUNT_INTERNAL_FLAG_CHANGED` (`oldValue/newValue {isInternal}`). Can be combined with other PATCH fields.
- `GET /api/manage/accounts` rows and the PATCH response include `isInternal: boolean`.
- `GET /api/manage/positions` rows include `isInternal: boolean` (the account's flag), next to `isCoverageLeg`, so
  the exposure screen can leave internal accounts out the same way.
- Internal accounts are left out exactly like the broker's own system accounts (coverage account / COVERAGE groups):
  - Dashboard: client totals, `clients.byCurrency`, broker-book P/L today, `depositsSum30d`, `netDeposits7d` /
    `netDepositsPrior7d` and the deposits-vs-withdrawals chart;
  - the clients' total exposure limit (lib/risk.ts);
  - Risk radar (rows and same-IP clusters);
  - Reports: summary, financial, client.
- They still appear in Clients, can trade, and keep their own history; only the broker-wide figures ignore them.

## Wording (naming.md)

Card title PASSWORD RESET; "✓ New password sent to <email>"; SHOW PASSWORD; DONE; "Not e-mailed: e-mail is
unavailable"; "Internal account: not e-mailed"; "No e-mail address on this account"; "Set password…" with fields
New password / E-mail it to the client; WEAK_PASSWORD text "Use at least 8 characters with letters and digits.";
flag "Internal account" (menu item "Mark as internal account" / "Unmark internal account"); audit
"Password revealed".
