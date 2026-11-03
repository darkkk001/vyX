# Backoffice "Registrations": portal sign-ups without a trading account (owner 2026-11-03)

A Client Portal sign-up creates a `Client` row (the portal login: e-mail + password). A trading account is a later,
separate step (the client opens a demo or asks for a live one after verifying). The backoffice Clients screen lists
trading accounts (`GET /api/manage/accounts`), so a sign-up that never opened an account was invisible to staff, while
signing up again with the same address said "an account with this email already exists".

## Request

`GET /api/manage/clients`, no query.

- Staff session of a broker: BROKER_ADMIN, MANAGER or SUPPORT (read-only). Own broker only.

## Response 200

```json
{
  "total": 279,
  "shown": 279,
  "registrations": [
    {
      "id": "cmt...",
      "email": "jane@example.com",
      "fullName": "Jane Trader",
      "status": "ACTIVE",
      "verified": false,
      "verifiedAt": null,
      "createdAt": "2026-10-27T10:02:59.000Z",
      "country": null,
      "phone": null
    }
  ]
}
```

- Only `Client` rows of the broker with NO `Account` (`accounts: none`); a sign-up that opens an account leaves the list
  and shows on the Clients screen instead.
- Newest first; at most 500 rows (`shown`); `total` is the full count.
- `verified` = `verifiedAt !== null`. `status` is `ClientStatus` (ACTIVE, SUSPENDED, CLOSED).

403 `{ "error": "forbidden" }`: no broker staff session.

## Action

"Resend verification" on an unverified, ACTIVE row is the existing
`POST /api/manage/clients/{id}/resend-verification` (docs/contracts/staff-resend-verification.md); SUPPORT is refused
there like every write.
