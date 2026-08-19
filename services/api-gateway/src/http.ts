// engine/server doesn't respond with JSON on every path -- its
// NotFound/InvalidStatus/ValidationFailed branches (cancel_order,
// modify_position_sl_tp -- see main.rs's doc comment on cancel_order)
// return a plain-text body via axum's `(StatusCode, String)` error type,
// unlike place_market_order/place_pending_order's outcomes, which are
// always a JSON-tagged enum even when rejected. Forwarding routes here
// call this instead of `response.json()` directly so a plain-text error
// becomes `{ error: "..." }` instead of crashing on JSON.parse.
export async function parseUpstreamJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text || `upstream returned ${response.status} with no body` };
  }
}
