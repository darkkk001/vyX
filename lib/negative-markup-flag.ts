// Owner 2026-11-10: negative markup (raw / zero-spread groups) ships behind a flag that is OFF by default, so no group can go negative before the
// engine and gateway with negative-markup support are live. The VPS session turns it on after that deploy: NEGATIVE_MARKUP_ENABLED=1 in the
// production environment, then a redeploy. While it is off:
//   - PATCH /api/manage/groups/{id}/pricing refuses a negative spreadMarkup ("Negative markup is not live yet."), like every other write path;
//   - quotes and fills treat any negative value exactly as before the feature (clamped to raw: never tighter), a second line of defence.
// Same pattern as SYMBOL_CLOSE_ONLY_ENABLED / SESSIONS_QUOTE_ENABLED.
export function negativeMarkupEnabled(): boolean {
  return process.env.NEGATIVE_MARKUP_ENABLED === "1";
}

export const NEGATIVE_MARKUP_NOT_YET = "Negative markup is not live yet.";
