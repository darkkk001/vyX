# Latency fixes 1 + 2: server ↔ terminal contract (2026-09-26)

Source: latency-breakdown.md. Goal: the terminal draws and plays the sound from whichever arrives first, the 2xx body or
the trading-stream event, with no refetch after its own action.

## PositionDto
The same shape as one item of `GET /api/trade/positions`:
- every Position column: id, ticket, side, volume, openPrice, slPrice, tpPrice, commission, swap, status, openedAt, closedAt, closePrice, realizedPnl, bookType, …
- `symbol: { name, digits, contractSize }`
- `originOrder: { source }`
- `closePendingOrder: null`

## Responses
| Route | 2xx body (additions in bold) |
|---|---|
| `POST /api/trade/orders`, MARKET immediate fill (201) | `{ order, position: **PositionDto**, **balance** }`. This includes the Smart Dealer auto-accept, which used to return `position: { id }` only. |
| `POST /api/trade/positions/{id}/close`, executed (200) | `{ position, transaction, partial, **balance** }`. `position` is the post-close row plus `symbol{name,digits,contractSize}`: `status: "CLOSED"` for a full close, `"OPEN"` with the reduced `volume` for a partial one. |
| `PATCH /api/trade/positions/{id}` (SL/TP, 200) | the updated Position row, now also with `symbol{name,digits,contractSize}` |

`balance` is the account balance after the action, as an absolute decimal string. On a close it is always present (the realized P/L is already credited). On an open it is present only when a commission was charged (already debited); when it is absent, the balance did not change.

Every one of these responses carries `Server-Timing: app;dur=<ms>`, the time spent inside the route.

## Events (trader stream), published right after COMMIT
| type | new fields |
|---|---|
| `OrderFilled` | `position_id`, `position` (PositionDto), `balance` |
| `PositionClosed` | `partial`, `close_volume`, `close_price`, `realized_pnl`, `position` (post-close row as above), `balance` |
| `PositionModified` | `position` (updated row) |

The same event types published by the Rust engine or by other paths (SL/TP/stop-out closes, dealer fills) do NOT carry `position`.

## Client rules
- **A `position` payload is present** (body or event): apply it locally, with no refetch.
  - The action is idempotent: a new id adds the row; a known id merges the fields; `status: "CLOSED"` removes the row.
  - `balance` is absolute, so setting it twice is harmless.
- **No `position` payload:** refetch as before, debounced.
- **Order of arrival:** the response and the event may arrive in either order. Whichever comes first draws; the second is a no-op.
- **Sound:** plays once per action, on the first arrival.
  - A fill is keyed by the order id.
  - A close is keyed by position id + transaction id (event: position id + `close_volume` + `realized_pnl`).
  - A modify has no sound, as today.
- **Journal**, MT5 style: `market buy 0.01 XAUUSD at 4456.73 done in 412 ms (server 95 ms)`, i.e. click → first arrival, plus `Server-Timing` when the response carried it.
