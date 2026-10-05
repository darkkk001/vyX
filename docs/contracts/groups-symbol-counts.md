# Groups: symbol counts (owner 2026-10-05)

`GET /api/manage/groups` (MANAGER / BROKER_ADMIN, the session's broker, unchanged auth) adds three fields to every group
object, for the backoffice Groups screen's SYMBOLS column ("All 30" / "5 of 30"):

| Field | Type | Meaning |
|---|---|---|
| `restrictSymbols` | boolean | `Group.restrictSymbols`: the group trades only its allow-list |
| `enabledSymbolCount` | number | The broker's `BrokerSymbol` rows with `enabled = true`; the same for every group. Synthetic `v*` symbols are not counted for any broker but the shadow-bot tenant (the same rule as `GET /api/manage/symbols`) |
| `allowedSymbolCount` | number | `restrictSymbols` ? the group's `GroupSymbol` rows whose symbol the broker has enabled : `enabledSymbolCount` |

- An allow-list row whose symbol is disabled for the broker does not count (the trader can't trade it either).
- `restrictSymbols = false` always gives `allowedSymbolCount = enabledSymbolCount`, even if old allow-list rows remain.
- Cost: two extra queries for the whole list (enabled symbols, one grouped count), never one per group.
- Display: `allowedSymbolCount == enabledSymbolCount && !restrictSymbols` reads "All {n}"; otherwise "{allowed} of {n}".
- Editing stays on `GET` / `PUT /api/manage/groups/{id}/symbols` (unchanged: audited `GROUP_SYMBOLS_UPDATED`, ConfigChanged
  "groups" and AccountUpdated to the group's accounts, so terminals refresh live).
- An older server lacks the fields: the client shows the column empty and keeps the editor working.
