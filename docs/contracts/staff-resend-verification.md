# Staff "Resend verification e-mail" (owner 2026-10-05)

The backoffice action that re-sends a client-portal login's "verify your e-mail" message. Added after the 12-day
e-mail outage (2026-09-23 .. 2026-10-05) left portal sign-ups with no working link. The e-mail itself is the one
portal registration sends (`lib/email/verification-email.ts`, shared with `POST /api/portal/register` and
`POST /api/portal/resend-verification`).

## Request

`POST /api/manage/clients/{clientId}/resend-verification`, no body.

- Staff session of the client's own broker. Gate: `ANY_MANAGER` (BROKER_ADMIN or any MANAGER), the same gate as
  the client password reset. The read-only SUPPORT role is refused, like every write.

## Responses

| Status | Body | When |
|---|---|---|
| 200 | `{ "sent": true, "to": "z***@gmail.com" }` | Sent. `to` is the masked address. A fresh single-use link (24 h) was issued. |
| 403 | `{ "error": "forbidden" }` | Not staff of a broker, or SUPPORT. |
| 404 | `{ "error": "client not found", "code": "CLIENT_NOT_FOUND" }` | No such client, or it belongs to another broker. |
| 409 | `{ "error": "this client's e-mail is already verified", "code": "ALREADY_VERIFIED" }` | Nothing to do. |
| 409 | `{ "error": "this client is not active", "code": "CLIENT_NOT_ACTIVE" }` | Suspended or closed client. |
| 409 | `{ "error": "e-mail is not set up for this broker", "code": "EMAIL_NOT_CONFIGURED" }` | Broker e-mail off or no sender address. |
| 429 | `{ "error": "too many resends for this client, try again later", "code": "RATE_LIMITED" }` | More than 5 per client per hour. |
| 502 | `{ "error": "the e-mail could not be sent: <provider message>", "code": "SEND_FAILED" }` | The e-mail provider refused it (logged `[staff-resend-verification] email send failed`). |

Every 200 writes one AuditLog row: action `STAFF_VERIFICATION_RESENT`, `actorAdminId` = the staff member,
`entityType` `Client`, `entityId` = the client id, `newValue` `{ email }` (never the token). Refusals write nothing.

## Fields the backoffice reads to offer the action (all additive)

- `GET /api/manage/accounts`: every account row has
  `client: { id: string, email: string, emailVerified: boolean } | null` (null = no client-portal login behind the
  account, e.g. created by staff). Offer the action when `client` is set and `client.emailVerified` is false.
- `GET /api/manage/live-account-requests` rows: `clientId: string`, `clientEmailVerified: boolean`.
- `GET /api/manage/client-kyc-requests` rows: `clientId: string`, `clientEmailVerified: boolean`.

An older server has none of these fields: the backoffice hides the action (or shows it disabled with
"server update needed"), and a 404 from the route without a JSON `code` means the route does not exist yet.

## Wording (naming.md)

Action "Resend verification e-mail"; result "Verification e-mail sent to z***@gmail.com"; refusals:
"Already verified", "This client is not active", "E-mail is not set up for this broker", "Too many resends for this
client, try again in an hour", "The e-mail could not be sent: <reason>".
