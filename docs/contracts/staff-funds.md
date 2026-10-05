# Staff deposits and withdrawals (DEP item, owner 2026-10-05)

Staff record a real deposit or withdrawal on a client's account from the backoffice: the Account menu MONEY section
(Deposit..., Withdraw..., Deposit & withdrawal history) and the DEP header (New deposit..., New withdrawal...).
Server: `app/api/manage/accounts/[id]/funds/route.ts`, rules in `lib/staff-funds.ts`.

The row is the same `DEPOSIT` / `WITHDRAWAL` Transaction a client request creates, so every deposit total
(dashboard, DEP tiles, reports) counts it. It is told apart by `createdByAdminId` and `pspAdapter = "STAFF"`.
Completion always runs `approveFundsRequest`, so ledger, audit, events and the trader's notification are identical
to an approved client request.

## Who may call

`FUNDS_APPROVAL`: a BROKER_ADMIN, or a MANAGER holding FUNDS_APPROVAL. SUPPORT and every other manager: 403
`FORBIDDEN`. An account of another broker: 404 `NOT_FOUND`.

## Who completes what (owner decisions 1 + 2)

| Entry | Recorded by | Result |
|---|---|---|
| Deposit | BROKER_ADMIN | Completed at once (200) |
| Deposit | MANAGER | Waiting (202, step `WAITING`); a different admin approves it on DEP |
| Withdrawal | BROKER_ADMIN, broker `withdrawalApproval = SINGLE` | Completed at once (200) |
| Withdrawal | anyone else | Waiting with the recorder as first approval (202, step `APPROVED_BY_FIRST_ADMIN`); a different admin completes it. A MANAGER never completes one alone |

The person who recorded an entry can never approve it: `PATCH /api/manage/funds-requests/{id}` with
`action: APPROVE` answers 403 `{code: "OWN_REQUEST"}`. They may still reject it.

A Waiting entry that no other staff member could ever approve is refused when filed: 409 `NO_APPROVER`.

## POST /api/manage/accounts/{id}/funds

```json
{
  "type": "DEPOSIT" | "WITHDRAWAL",
  "amount": "123.45",
  "paymentMethodId": "MANUAL" | "<PaymentMethod.id>",
  "reference": "WIRE-123",
  "note": "bank wire received 5 Oct",
  "idempotencyKey": "<uuid>"
}
```

- `amount`: positive, string or number, at most 2 decimals. No sign, no exponent.
- `paymentMethodId`: `"MANUAL"` is the built-in **Manual / Bank transfer** method, always accepted, also for a broker
  with no payment methods configured. Any other id must be one of this broker's enabled methods. The method's
  min/max are NOT enforced for staff; a breach comes back in `warnings` (`BELOW_METHOD_MIN`, `ABOVE_METHOD_MAX`).
- `reference`: optional, at most 100 characters, stored in `pspReference`.
- `note`: required, at most 500 characters. Shown as the row's Reason.
- `idempotencyKey`: required, at most 100 characters, unique per broker. A repeated key returns the ORIGINAL result
  (same `transactionId`), never a second row, even when sent concurrently.

Withdrawals: approved KYC is required (account KYC or its portal client's), and the balance after the withdrawal must
be at least 0 with the margin level staying above the group's margin-call level. Checked when filed (also for a
Waiting withdrawal) and again when completed.

### Responses

| Status | Body |
|---|---|
| 200 | `{status: "COMPLETED", transactionId, balanceAfter: "0.00", pending: false, warnings: []}` |
| 202 | `{status: "PENDING", transactionId, pending: true, step: "WAITING" \| "APPROVED_BY_FIRST_ADMIN", warnings: []}` |
| 200 (replay only) | `{status: "REJECTED" \| "CANCELLED", transactionId, pending: false, warnings: []}` when the original entry was since rejected |

Errors are `{error, code}`:

| Status | code |
|---|---|
| 400 | `TYPE_INVALID`, `AMOUNT_INVALID`, `NOTE_REQUIRED`, `NOTE_TOO_LONG`, `METHOD_INVALID`, `REFERENCE_TOO_LONG`, `IDEMPOTENCY_KEY_REQUIRED` |
| 403 | `FORBIDDEN`, `KYC_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `INSUFFICIENT_BALANCE`, `MARGIN_TOO_LOW`, `NO_CONVERSION_RATE` (an open position cannot be valued right now, try again), `ACCOUNT_NOT_ACTIVE`, `NO_APPROVER` |

Nothing is written when an error is returned.

## GET /api/manage/accounts/{id}/funds (form data)

Same permission. The payment-methods list endpoint (`GET /api/manage/payment-methods`) is BROKER_ADMIN only, so the
form reads its methods here instead.

```json
{
  "accountId": "...", "accountNumber": "12345", "accountFullName": "...", "currency": "USD", "status": "ACTIVE",
  "balance": "1000.00",
  "equity": "1000.00", "usedMargin": "0.00", "freeMargin": "1000.00",
  "marginLevel": null,
  "marginCallLevel": "100.00",
  "openPositions": 0,
  "kycApproved": true,
  "withdrawalApproval": "SINGLE",
  "depositCompletesAtOnce": true,
  "withdrawalCompletesAtOnce": true,
  "paymentMethods": [
    { "id": "MANUAL", "name": "Manual / Bank transfer", "type": null, "minAmount": null, "maxAmount": null },
    { "id": "...", "name": "Bank transfer", "type": "BANK_TRANSFER", "minAmount": "50.00", "maxAmount": "5000.00" }
  ]
}
```

- `marginLevel` is `null` with no open positions (show an empty cell, never `0%`).
- `equity` / `usedMargin` / `freeMargin` are `null` when an open position cannot be valued right now.
- `MANUAL` is always first.

## GET /api/manage/funds-requests?accountId={id}

The existing list, filtered on the server to one account (the Account menu's **Deposit & withdrawal history**). With
`accountId` the cap is 1000 rows instead of the broker-wide 200. Every row (with or without the filter) adds:

| Field | Value |
|---|---|
| `source` | `"STAFF"` for a staff-recorded entry, `"CLIENT"` for a client's own request |
| `createdByAdminName` | the recorder's sign-in email for `STAFF` rows (staff accounts have no display name), `null` for `CLIENT` |
| `paymentMethodName` | `"Manual / Bank transfer"` for MANUAL, the method's name otherwise, `null` when unknown |
| `reference` | `pspReference` (the staff reference, or the client request's generated reference) |
