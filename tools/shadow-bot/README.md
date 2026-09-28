# Shadow bot (zzshadowbot, synthetic symbols)

Drives the shadow-bot tenant to trigger each risk path on demand: it moves the synthetic `v*` prices (price driver)
and trades the `4999xxxx` accounts through the web trade API (trade driver). Runs on a **separate machine**, never on
the VPS.

## Safety
- **Hard guards** in `src/guards.ts`, which the config can only narrow:
  - hosts: `https://zzshadowbot.vyxtrader.com` and `https://feed.vyxtrader.com/internal/synth-feed`;
  - tenant: `zzshadowbot`;
  - accounts: `49990001`–`49990013`. The broker hedge account `49990099` is never signed into;
  - symbols: `vGOLD vEUR vGBP vJPY vIDX` (the `v` prefix constant from `lib/synthetic-symbols.ts`).
- **Limits:**
  - at most 4 accounts with open positions at once;
  - about 1 tick per second per symbol in use, and silence between scenarios so the engine's idle gate closes;
  - ramps at most 0.2%/s; a single jump only in S2, at most 5%.
- **After every scenario** (also after a failure): it flattens the scenario's accounts, stops ticking, then **settles
  for 90 s**, so the shadow pass (4 s) and the reconciler (60 s) record this scenario before the next one. The wait is
  journaled.

## Secrets
Never logged; only read from the environment:
- `SHADOWBOT_PASSWORD`: the trader password of the seeded accounts;
- `SYNTH_FEED_SECRET_FILE`: the path of the copied `synth-feed-secret.txt` (48 hex).

## Run
```
npx tsx tools/shadow-bot/bot.ts list
npx tsx tools/shadow-bot/bot.ts run s1-single-stopout --dry-run   # offline: simulated backend, nothing is sent
npx tsx tools/shadow-bot/bot.ts run s1-single-stopout             # LIVE
npx tsx tools/shadow-bot/bot.ts status 49990008                   # LIVE, read-only
```
- A live run refuses to start when a scenario account already holds positions; add `--flatten-first` to close them.
- Ctrl+C stops the ticks and leaves positions open; use `status`, then run again with `--flatten-first`.

## Journal
`logs/run-<UTC>.jsonl`: one event per line.
- Every line has UTC time and a monotonic ms.
- Events include scenario and step, and every tick level set.
- Orders carry their order ID, position ID and idempotency key; there are also bot margin estimates and inferred
  stop-outs.
- The settle window is recorded too.

Line these up against `shadow_pair` by time and position ID.

## What the bot can and cannot confirm
- **Stop-outs:** inferred from the trader side. The server closed the position, the bot did not, and no SL/TP was set.
  The authoritative reason is the ledger note and `shadow_pair`.
- **Negative-balance write-off:** read from the trader's own transactions.
- **Copy rules:** read from the target accounts, which are ordinary bot accounts.
- **S5 (hedge onto 49990099):** needs the read-only staff observer, and is refused live until it exists.
- **Dry run:** does not simulate group markups, commissions, swaps, copy rules or the server's write-off. Those steps
  are live only.
