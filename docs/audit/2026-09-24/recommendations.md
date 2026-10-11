# Recommendations (section 9; the only opinion file)

Brief. Every item points at the issue it answers (see `issues.md` and the screen file for evidence). Order within a group = suggested fix order.

## P0: money actively at risk / wrong today (fix before anything else)
1. **MIR hidden live rule.** Parse `{rows}` in the mirror-rules list call (ApiClient.ManageG1.cs:272). Then decide whether the enabled REVERSE rule → 50005702 stays on, since that target was moved to Standard B_BOOK on 2026-09-21. (bo-MIR, questions.md)
2. **ATY explicit zeros.** Create and edit account types with null (inherit) flat pricing, not 0. Then null out the existing 0s on Futurix ECN (the pricing flag is ON for Futurix, so today the 0 outranks the group's markup). (bo-ATY, config.md)
3. **DEAL settings wipe.** Stop the ⚙ requote-step save from sending `defaultMaxSlippagePips: null`: send only the changed field. (bo-DEAL)
4. **DEAL ACCEPT ALL.** Send the "at market" fillMode that the confirm text promises. Make requote presets respect IsClose (a close uses the opposite side). (bo-DEAL)
5. **Missing margin checks on alternative fill paths:**
   - dealer-queue accept;
   - desk-off auto-flush;
   - requote accept;
   - coverage/BOOK orders.

   Route all of them through `checkAccountPreTradeMargin`, as the normal order path does. (bo-DEAL, term-tabs)
6. **Pending LIMIT/STOP triggering.** Move triggering server-side (engine scanner or web cron). Today a pending order fills only while a client is connected, and a rejection re-POSTs on every tick. (term-ticket)
7. **Withdrawals / transfers / debits:**
   - add a free-margin check to withdrawal confirm, transfers and debit adjustments;
   - refuse transfers between accounts of different clients on the server;
   - put transfers and IB payouts behind the same maker-checker as balance adjustments. (bo-DEP, bo-TRX, bo-CLI, bo-IB)
8. **Futurix cannot pay out.** The withdrawal maker-checker needs 2 eligible admins and Futurix has 1. Either add a second admin, or add a per-broker single-approver setting with an audit trail. (bo-DEP, questions.md)
9. **CLI RISK LIMITS form wipes values.** Prefill the current daily-loss limit and the swap-free inherit state, and send only changed fields. (bo-CLI)
10. **Exposure units:**
    - label `Broker.totalExposureLimit` as lots everywhere (RISK/EXP), or change the enforcement to USD. Pick one.
    - the SYM/EXP maximum-exposure comparisons should use the same per-account gross measure that is enforced. (bo-RISK, bo-EXP, bo-SYM)

## P1: functional breaks with visible impact
11. **Terminal sign-out / switch closes the app:**
    - release the single-instance mutex before relaunching (or hand it over);
    - make "Switch account" keep a valid remember-me session. (term-session)
12. **Chart right-click orders at 0.01 lots:** read the live ticket volume, not `Vm.TicketVolume`. (term-chart)
13. **Terminal FX conversion.** Apply the quote→account rate the server already uses to P&L, equity, margin level and margin required. This matters before any non-USD-quoted symbol or non-USD account goes live. (term-account/positions/shell/ticket)
14. **Dead backoffice actions — send the required fields or wire the route:**
    - DEAL per-row REJECT/WITHDRAW (empty reason);
    - ATY enable/disable (missing name);
    - EXP CLOSE BY SYMBOL (null accountId);
    - DLS Void (only CLOSED rows);
    - DEAL RESTING CANCEL. (bo-DEAL, bo-ATY, bo-EXP, bo-DLS)
15. **Backoffice sign-out:** call the server logout, so the session token is revoked. Enforce `requireAdmin2fa` on the API login. (bo-SEC, endpoints)
16. **Role gaps:**
    - SUPPORT cannot open the backoffice, yet is the default invite role;
    - CFG/USR/LP/RPT-LP are shown to MANAGER and then return 403;
    - reject routes need less permission than approve routes.

    Align the nav visibility with the route permissions, and change the default invite role. (bo-USR, bo-SHELL, endpoints)
17. **DASH money tiles:**
    - fix the withdrawal sign in NET DEPOSITS / FLOW;
    - exclude demo and coverage accounts from B-book P/L. (bo-DASH)
18. **LP status "ACTIVE"** is not an enum value: match the real LpStatus. ROUTE rules are stored but never read: label them "not used yet" or remove the ENABLED toggle. (bo-LP, bo-ROUTE)
19. **Group save side effects:**
    - GRP save resets tier to STANDARD;
    - the only default group can be unset;
    - backoffice-created groups are never client-selectable.

    Send the full state and validate on the server. (bo-GRP)
20. **Live refresh gaps:**
    - BalanceChanged events match no backoffice topic;
    - no margin topic exists;
    - symbol config edits never reach open terminals;
    - terminal ORDERS/BALANCE/LOG tabs go stale. (cross-cutting, term-tabs)

## P2: ux / text / hygiene
21. Deep links: the symbol focus on EXP, AUD entityType casing, and NTF focus on the record.
22. The 200/500-row caps on DLS, DEP KPIs, AUD, KYC, LAR and Client 360 deals: add paging or date ranges.
23. Missing AuditLog rows: PSP changes, CFG settings, trading sessions, desk-flush actor.
24. Terminal: sound mute, alert-triggered sound/popup, F10 placeholder, RESET GRID SYMBOLS, the STM DISABLED switch not stopping armed rules.
25. Remaining text/ux items as listed in `issues.md`.

## Process
- Re-run this audit's DB fact checks (MIR rule, ATY zeros, admin count per tenant) after each fix; all read-only SELECTs, as in `questions.md`.
- Keep `issues.md` as the queue; close items by commit hash.
