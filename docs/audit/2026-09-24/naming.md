# Naming pass: backoffice + terminal (document only)

> **Approved 2026-09-25 by the owner. This file is the source for every label in Phase 4** (backoffice screens, then the terminal). Owner fixes applied: broker-wide limit = Max open volume (lots); "today" = since trading day start; broker-wide max slippage keeps its label until the stored value is converted from pips to points; every points tooltip says 10 points = 1 pip.

The labels come from `ui-map.md` (the bo-* and term-* sections). They were checked read-only against the source: `DealingScreen.cs`, `ClientsScreen.cs`, `Vyx.Backoffice.App\Screens\*.cs`, `Controls\PricingPanel.cs`, `Vyx.Trader.App` and `Vyx.Shared.Ui\Charting`. The first drafts are in `_naming-part1.md` to `_naming-part3.md` and `_naming-glossary.md`. This file merges them and adds one consistency pass across every screen. The rules: plain broker words with no internal codes (RAW, INHERIT, SOURCE, MODE, B_BOOK, COV, SDM, MU, NBP, APR, LAR, PSP, and KYC, LP or IB on their own). Every quantity carries its unit in the name: ($), (lots), (points), (%), ($ per lot), (UTC). Leverage is written 1:N. Screen codes are never the main label. One concept always gets one word (see Glossary). Names are in sentence case. **1788 rows** in total (1340 backoffice, 448 terminal): **455 keep** and **1333 renamed**. The renamed count includes 11 fixture or internal labels marked `remove` and 1 cross-reference row. The consistency pass made 39 decisions. They are listed at the end.

## Number rules (owner 2026-10-05 / 2026-10-06)

One shared formatter in every app (backoffice, terminal, WebTrader, statements, CSV):
- **Never "-0.00".** A negative zero shows `0.00`.
- **Signs:** positive values carry "+", negative values "−"; zero shows `0.00` with no sign. Colour: profit green, loss red, zero neutral.
- **Volume** always 2 decimals (`1.00`, `0.50`, `0.02`).
- **Prices** in each symbol's own digits (XAUUSD `4139.80`, EURUSD `1.08425`, ETHUSD `2703.00`).
- **Whose view:** the backoffice always shows the **broker's view**: commission and swap are revenue (positive), client withdrawals are negative, deposits positive, Book P/L is the broker's side. The terminal and the account statement show the **client's view**: commission and swap are negative charges and profit is the client's.
- **Per-trade tables** (Closed trades, positions, history, statements): default column order Account · Client · Group · Ticket · Symbol · Type · Volume · Open time · Open price · SL · TP · Close time · Close price · Commission · Swap · Profit (a client statement leaves out the Account / Client / Group columns it never shows); text left-aligned, numbers right-aligned; default sort close time, newest first; the Columns menu may hide columns but never reorders them. Aggregate tables: identifier first, then time, then amounts.

## Empty and zero values (owner 2026-10-05)

This rule applies to every app (backoffice, terminal, WebTrader) and every CSV export. It overrides any row below that shows a dash as a value.

- **Never show a dash as a placeholder value.** No "—", "–", "-" or "--" standing in for a value. It reads as machine output.
- **A money value that is zero shows `0.00`** (in the field's own decimals), never blank and never a dash. Example: Floating P/L on the Dashboard "Needs attention" list for an account with no open trades shows `0.00`.
- **A value that does not exist shows an empty cell.** Examples:
  - Margin level (%) with no open positions: empty. Never `0%`, which reads as a stop-out.
  - Stop loss / Take profit that is not set: empty.
  - Close time of a trade that is still open: empty.
  - Any other field with nothing to show (no reason given, no reviewer yet, no payment method): empty.
- **CSV exports follow the same rule:** zero money is `0.00`, a value that does not exist is an empty field.
- In this document's tables, the "—" in the Unit column only means "no unit". It is never a value shown in an app.

## Column widths (owner 2026-10-05)

Every table in every app: a column's default width fits its full header text and its content. Headers and cells are
never clipped and never overlap. When the panel is too narrow for all columns, the table scrolls horizontally.

## Short dialogs (owner 2026-10-05)

Every dialog, toast and confirm in every app (backoffice, terminal, WebTrader, portal) is short and direct: one line
where possible. Say what happened or what will happen, nothing else. Longer text only when something went wrong and
the user must act, and then say exactly what to do.

## Owner decisions D1 to D6 (2026-10-05)

These override every row below that still shows the older wording.

- **D1 Book.** "Broker book (B-book)" is **Book** everywhere ("Book P/L ($)", "Book positions (lots)", "Market book / Book"). "Broker hedge account" is **Hedge account**.
- **D2 For all clients.** "broker-wide" is **for all clients** (or dropped where the sentence is already clear).
- **D3 Company.** The firm-name label is **Company** (SEC, CFG "This company"). The top bar has **no label**: it shows only the firm name.
- **D4 No actor in install refusals.** "...retired by your broker", "Contact VyxTrader support" lose the actor: "This installation has been retired. Install the latest version." Trader-facing text keeps "your broker" where it means the client's broker.
- **D5 Staff note.** "Broker note" / "BROKER: {review}" on Deposits & withdrawals is **Staff note**.
- **D6 Same as dealing switch.** "Same as broker dealing switch" is **Same as dealing switch**.

## Plain errors and infrastructure (owner 2026-10-06)

Brokers and traders never see infrastructure: no MT5, Caddy, engine, gateway, NATS, Neon, database, timeouts, "ms"
latencies (execution time is the one exception), HTTP codes, endpoint paths, counters, raw error text, internal ids or
restart controls. The upstream price source is the **Source feed**. The one infrastructure line a broker sees is a
plain "liquidity provider is disconnected". On the web, every error a broker or trader reads goes through
`lib/plain-error.ts` (one table of plain sentences; unknown text becomes a plain fallback and goes to the log), and
every number through `lib/format.ts`. CSV exports follow the number rules but keep numbers machine-readable (ASCII
"-", no "+", no thousands separators) so a spreadsheet can add them up.

## Glossary

| Concept | Word | Unit | Never use |
|---|---|---|---|
| Money deposited, before open positions | Balance ($) | $ | BAL |
| Balance + credit + floating P/L | Equity ($) | $ | EQ, NAV |
| Bonus money the broker lends to trade with | Credit ($) | $ | "Credit" for a deposit or balance change |
| Manual change of a client's balance by staff | Add funds / Deduct funds (ledger rows: Funds added / Funds deducted) | $ | Credit / debit, CREDIT, DEBIT |
| Balance change request waiting for a second admin | Balance change | $ | balance adjustment, BAL |
| Profit/loss of open positions | Floating P/L ($) | $ | FLOAT, UPNL, open P/L, unrealized |
| Profit/loss of closed trades | Closed P/L ($) | $ | REALIZED, RPL, Trade P/L |
| Closed P/L since trading day start (or trading week start) plus floating P/L | Today's P/L ($) / This week's P/L ($) | $ | DAY P/L, WEEK P/L |
| Margin held by open positions | Used margin ($) | $ | MRG, margin used, MARGIN USED |
| Used margin as a share of equity | Used margin (% of equity) | % | MARGIN n% |
| Equity minus used margin | Free margin ($) | $ | FREE |
| Equity ÷ used margin × 100 | Margin level (%) | % | MARGIN LVL, ML, LVL, MARGIN % |
| Level that triggers the warning | Margin call level (%) | % | MC, Margin call % |
| Level that auto-closes positions | Stop-out level (%) | % | SO, Stop out %, threshold |
| Margin an order will hold | Margin needed ($) | $ | MARGIN REQ |
| Margin held for one lot | Margin for 1 lot ($) | $ | Margin / 1 lot |
| Margin charged on opposite positions | Hedged margin (%) | % | HEDGED MARGIN % |
| Leverage | Leverage (written 1:N) | — | LEV |
| A trade that is open | Position | — | trade (for open), deal |
| A closed position in history | Closed trade (screen: Closed trades) | — | deal, DLS, Trade history |
| Limit/stop order not filled yet | Pending order | — | resting order, RESTING |
| Request waiting for a staff decision (money, ID check, application, approval) | Waiting | — | Pending, PENDING, WAIT, AWAITING |
| Time since a request or order arrived | Waiting time | — | AGE |
| Order waiting for a dealer's decision | Order waiting for dealer / Waiting for dealer | — | queued, QUEUE, awaiting dealer, DEALER QUEUE |
| Dealer panel with dealer, client-offer and pending rows | Waiting orders | — | PENDING QUEUE |
| Dealer action: offer a new price | Offer new price | — | requote, REQUOTE |
| State / log entry after a new price was offered | New price offered | — | REQUOTED, REQUOTE, New price |
| New price offered, client has not answered | Waiting for client | — | AWAITING CLIENT |
| Cancel an offered new price | Withdraw offer | — | WITHDRAW alone |
| Size of one new-price step | New-price step (points) | points | Requote step |
| Size of a trade | Volume (lots) | lots | VOL, LOT, LOTS, size |
| Total volume of open positions (account or broker) | Open volume (lots) | lots | Exposure (lots), EXPOSURE |
| Client buy / sell volume | Buy volume (lots) / Sell volume (lots) | lots | LONG, SHORT, Long (lots), Short (lots) |
| Buy minus sell volume | Net volume (lots) | lots | NET, Net (lots) |
| Value of buy minus sell volume | Net exposure ($) | $ | NOTIONAL, NET $ EXP |
| Value of all open client volume | Exposure ($) | $ | OPEN EXPOSURE |
| Most lots one account may hold open in a symbol (enforced per account, total of its buys and sells) | Max lots per account (lots) | lots | NET LIMIT, MAXIMUM EXPOSURE, max exposure |
| Most lots all clients may hold open together (enforced in lots, D7) | Max open volume (lots) | lots | TOTAL EXPOSURE, Exposure limit ($), exposure in USD |
| Trade size limits | Min volume (lots) / Max volume (lots) / Volume step (lots) | lots | Min lot, Max lot, Lot step, STEP |
| Symbol | Symbol | — | instrument, SYM |
| Symbol category (metals, FX…) | Asset class | — | CATEGORY (for symbols) |
| Decimals in a price | Price digits | — | DIGITS |
| Smallest price step | Point size | — | Tick size |
| Money per 1-point move | Point value ($) / Point value ($ per lot) | $ | Pip value, PIP VALUE |
| Price distance unit | points (1 point = last price digit) | points | pips, pts, ticks |
| Spread the client sees | Client spread (points) | points | SPRD, Spread alone, raw spread |
| Spread from the price feed before markup | Market spread (points) | points | RAW, raw spread, LP spread |
| Extra spread the broker adds | Spread markup (points) | points | MU, markup (without unit) |
| Total client spread set whatever the market spread | Fixed spread (points) | points | TARGET |
| How a spread is set | Spread setting | — | MODE, pricing mode |
| Overnight fee | Swap long (per lot) / Swap short (per lot); per trade: Swap ($) | per lot (account currency) | rollover, Swap Long / Swap Short without unit |
| Fee per trade | Commission (per lot); per trade: Commission ($) | per lot (account currency) | COMM |
| Price change limit on fill | Max slippage (points) (value for all clients: after the pips → points conversion) | points | SLIP, deviation, pips |
| Automatic accept/reject by slippage | Auto-accept slippage (%) / Auto-reject slippage (%) | % | Smart dealer, Auto accept / reject |
| Stop loss / take profit | Stop loss / Take profit (SL / TP only in narrow table headers) | — | S/L, T/P |
| Minimum SL/TP distance | Min stop distance (points) | points | stop level |
| Setting that takes the group's value | Same as group | — | INHERIT, inherit, GROUP DEFAULT, per group |
| Setting that takes the symbol's value | Same as symbol (exception: the GRP Pricing column says Source, owner 2026-10-05) | — | INHERIT |
| Group setting that follows the dealing switch | Same as dealing switch | — | BROKER DEFAULT, DESK-CONTROLLED, Same as broker switch |
| Group ignores the broker dealing switch | Ignore broker dealing switch | — | Force dealer mode, FORCED |
| Broker keeps the client's risk | Book | — | B_BOOK, BOOK, B-BOOK alone, dealing-group |
| Trades passed to a liquidity provider | Market book (A-book) on first use, then Market book | — | A_BOOK, LP book |
| Group whose trades are reversed into a master account | Reverse trading | — | REVERSAL, MIR |
| How a group's (or a row's) trades are handled | Trade handling | — | CATEGORY, ROUTING, TYPE, groupType, Book, Handling |
| Mirror / copy rule | Copy rule (Copy / Reverse) | — | mirror rule, MIR |
| Account/group a copy rule copies from / into | Copied from / Copied into | — | SOURCE, TARGET |
| Copy volume factor | Volume multiplier | — | MULTIPLIER alone |
| Copy rule stopped by its own limit | Stopped by limit | — | KILLED |
| Price a copied trade fills at | Original price / Current price | — | SOURCE PRICE, MARKET |
| Broker's own hedge account | Hedge account | — | coverage account, COV, COVERAGE |
| Place / undo a hedge for a client position | Hedge / Remove hedge | — | BOOK, UNBOOK, cover |
| Book volume hedged / not hedged | Hedged (lots) / Unhedged (lots) | lots | COVERED, OPEN RISK, BOOKED, UNBOOKED |
| Hedge / unhedge panel | Hedge manager | — | SDM, Smart dealer manager |
| P/L of the hedge account | Hedge account P/L ($) (open part: Hedge account floating P/L ($)) | $ | COVERAGE P/L, Hedge P/L |
| P/L of Book positions, broker's side | Book P/L ($) | $ | DEALING-GROUP P/L, Dealer P/L (for this) |
| Book P/L + hedge account P/L | Dealer P/L ($) | $ | DEALER NET P/L, Net P/L |
| Hedge automatically on every fill | Auto-hedge | — | (AUTO-HEDGE in caps is fine as a switch label) |
| Dealer reviews every order / orders fill automatically | Manual dealing / Automatic dealing | — | DEALER ON, desk on, AUTO-FILL, desk off |
| The dealing setting for all clients or for one group | Dealing | — | Dealing mode, DEALER MODE, Execution, MODE |
| Groups with manual dealing | Manual-dealing groups | — | DEALING GROUP, dealing-group |
| Stop all new trading (control, screen) | Trading halt | — | HALT, kill, Emergency, PANIC |
| State after a halt | Trading halted | — | HALTED alone, Trading halt (as a state) |
| Only closing allowed | Close-only | — | CLOSE_ONLY |
| Which sides may open | Allowed sides | — | TRADING MODE, TRADING |
| When a symbol can trade | Trading hours (UTC) | UTC | SESSIONS (for symbol hours) |
| Client group (pricing + leverage tier) | Group | — | tier, category (for the group itself) |
| Negative balance protection | Negative balance protection | — | NBP, Neg-bal protect |
| Know-your-customer check | ID check (KYC) on first use, then ID check | — | KYC alone, KYC WAIT |
| ID check level / number | ID check level / Check # | — | LEVEL, KYC L1, ID |
| Live account application | Live account application | — | LAR, account request |
| Deposit/withdrawal method | Payment method | — | PSP |
| Introducing broker | Partner (IB) on first use, then Partner | — | IB alone, introducing broker |
| Clients a partner brought in | Referred clients / Referred client | — | IB (chip), Partner clients |
| What a partner earns | Partner pay / Partner pay owed ($) / Partner pay rate (per lot or %) | $ | COMMISSION (for IB), PENDING COMMISSION, PAYABLE, Owed alone |
| Lead that became a client / where a lead came from | Became client / Came from | — | CONVERTED, SOURCE |
| Maker-checker queue | Approvals (needs a second admin) | — | APR, maker-checker |
| Maker-checker steps | Approve (first admin) / Confirm (second admin) / Approved by (first admin) | — | MARK, MARKED BY |
| Dashboard money-request panel | Deposits & withdrawals waiting | — | Pending deposits & withdrawals, APPROVALS QUEUE |
| Balance-after-transaction chart | Balance history ($) | $ | BALANCE CURVE, EQ |
| Staff user | Staff | — | admin user, USR, team member, Team |
| Latest staff actions on the dashboard | Staff activity | — | ACTIVITY |
| Tenant / tenant tier | Company (Company name) / Plan | — | tenant, TENANT, Tier |
| 2FA | Two-step sign-in (2FA) | — | 2-step login, Two-factor |
| Signing in / list of sign-ins | Sign-in / Sign-in history | — | login, LOGIN, SESSIONS |
| Finance rights | Can approve money | — | finance rights |
| Audit/notification entity and actor | Record / Record type / Done by | — | ENTITY, ACTOR |
| Price feed | Price feed | — | FEED, ticks |
| One price update / its delay | Price update / Price delay (ms, typical / slow) | ms | tick, p50, p95 |
| Symbol with no recent price | Stale price | — | stale symbol |
| Trading core / API gateway | Trading server / Client connection server | — | CORE, GATEWAY, GW, NATS |
| Where a price comes from | Price origin | — | SOURCE |
| Liquidity provider | Liquidity provider (Providers in counts) | — | LP alone |
| How a provider connects | Connection type | — | PROTOCOL |
| Per-symbol provider rules | Routing rules | — | Liquidity routing, ROUTE |
| Smart trade manager | Trade assistant | — | STM, Smart Trade Manager, smart rules |
| One-click trading | One-click trading / One-click trading panel | — | 1-CLICK, ONE-CLICK, one-click panel |
| Ticket number (orders, positions, trades) | Ticket # | — | TKT, ID |
| Open / close price | Open price / Close price | — | OPEN / CLOSE alone |
| Current price | Current price | — | CMP, LAST, Market (as a price) |
| Market-order confirm | {Buy/Sell} {symbol} at market | — | AT MARKET (caps), at current price |
| Today's high / low | Day high / Day low | — | HIGH, LOW, Daily high |
| Change since the day opened | Change (%) | % | CHG, CHG% |
| Symbol contract sheet | Symbol details | — | Specification |
| Watched-symbol panel | Market Watch | — | watchlist, Market watch, MARKET MONITOR |
| Candle timeframes | M1 M5 M15 M30 H1 H4 D1 W1 | — | 1M 5M 1H D W |
| Price updates in a candle | Tick volume | — | VOL |
| Chart grid controls | Chart layout / Single chart / 2×2 grid / Link crosshair across grid | — | Grid 2×2, Crosshair sync |
| Remove a chart drawing | Delete drawing | — | Remove drawing |
| Pending order from the chart | Buy limit at {price} (etc.) | — | @ |
| Price alert from the chart | Alert when price falls to / rises to {price} | — | Alert below / above |
| Colour theme | Dark theme / Light theme | — | THEME ☀ / ☾ alone |
| Statement file | Save statement (as CSV) | — | Statement CSV, Export statement, Download statement |
| Balances screen / per-client view | Account balances / Account balance | — | Wallets, Wallet |
| Money between two accounts | Internal transfers | — | Transfers, TRX |
| Open the client page | Open client | — | Open client 360 |
| Live exposure filtered | Live exposure for this symbol / for this account | — | Live exposure · this symbol |
| New client account | Add account | — | + ACCOUNT, New account (as a button) |
| Broker-wide settings screen | Broker settings | — | Settings alone, CFG |
| Share of equity risked at the stop loss | Risk (% of equity) | % | RISK % |
| Loss at SL / profit at TP / ratio | Risk ($) / Reward ($) / Reward : risk | $ | R:R |
| Price move of a position since open | Move (points) | points | PTS, pips |
| Why a trade closed | Closed by | — | REASON (history) |
| Why money moved | Reason | — | Comment (for balance rows) |
| Terminal tabs | Pending orders / Order history / Closed trades / Deposits & withdrawals / Journal | — | PENDING, ORDERS, HISTORY, BALANCE, LOG |
| Time a position has been open | Time open | — | DURATION |
| Pending order good until cancelled | Until cancelled | — | GTC |
| Who wrote a journal line | From | — | SRC, Source |
| Trade assistant switch state | On / Off | — | ENABLED / DISABLED, ARMED |
| Live event + price stream status | Live updates | — | STREAM |
| Account live/demo | Live / Demo | — | ACCOUNT MODE, MODE |
| Cancel a closed trade's result / how it filled | Void / Fill details | — | Replay |
| Risk-radar patterns | Scalping / Martingale / Latency arbitrage / News trading / Shared IP groups | — | SCALP, LATENCY ARB, SAME-IP |
| Clock time | (UTC) in the label | UTC | time without zone |
| Screen codes (DASH, CLI, EXP…) | Never the main label; screen name only | — | "1) MIR" style titles |
| Label casing | Sentence case ("Margin level (%)"); proper names keep capitals (Market Watch, Trading halt screen) | — | Title Case Per Word |

## Backoffice

### Shell (SHELL)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SHELL | {BrokerName} Backoffice (window title) | keep | — | Broker name and app name. |
| SHELL | BACKOFFICE (brand tile) | keep | — | This is the broker's back office. |
| SHELL | search · Ctrl+K | Search (Ctrl+K) | — | Find a client, order, position, transaction, symbol or screen. |
| SHELL | BROKER | remove (no label: the cell shows only the firm name) | — | The firm you are signed in to (owner D3 2026-10-05). |
| SHELL | LIVE (badge by broker name) | Signed in | — | You are signed in to this broker's server. |
| SHELL | SERVER | keep | — | Server address this app is connected to. |
| SHELL | OK (server state) | Connected | — | The server answered the last check. |
| SHELL | STREAM | Live updates | — | Live prices and events from the server, the same ones the terminal gets. |
| SHELL | ROLE | keep | — | Your staff role; it decides what you may change. |
| SHELL | USER ({e-mail} ▾) | keep | — | Your staff login; click for security, switch or sign out. |
| SHELL | ☾ DARK / ☀ LIGHT | Dark theme / Light theme | — | Switch the colour theme. |
| SHELL | 🔔 (bell + count) | Notifications | — | Unread notifications. |
| SHELL | OVERVIEW (nav group) | keep | — | Summary screens. |
| SHELL | TRADING (nav group) | keep | — | Positions, dealing and trading setup. |
| SHELL | RISK (nav group) | keep | — | Risk checks and trading halt. |
| SHELL | LIQUIDITY (nav group) | keep | — | Liquidity providers and price feed. |
| SHELL | CLIENTS (nav group) | keep | — | Clients, leads, partners and ID checks. |
| SHELL | FINANCE (nav group) | keep | — | Money in and out of client accounts. |
| SHELL | SYSTEM (nav group) | keep | — | Staff, audit log and settings. |
| SHELL | Nav codes (DASH, RPT, NTF, EXP, DEAL…) | remove (show on hover only) | — | — |
| SHELL | Dashboard | keep | — | Broker summary at a glance. |
| SHELL | Reports | keep | — | Money and trading reports. |
| SHELL | Notifications | keep | — | Messages sent to staff. |
| SHELL | Live exposure | keep | — | Every open position, by symbol and account. |
| SHELL | Dealing | keep | — | Orders waiting for dealer, hedging, and manual or automatic dealing. |
| SHELL | Trade history | Closed trades | — | Closed trades for all clients. |
| SHELL | Symbols | keep | — | Symbol settings. |
| SHELL | Groups | keep | — | Client groups: pricing, leverage and trade handling. |
| SHELL | Account types | removed (D4, owner 2026-10-01) | — | The Account types screen and its sidebar entry are gone: the group is the tier. |
| SHELL | Mirror rules | Copy rules | — | Rules that copy or reverse trades into another account. |
| SHELL | Risk | keep | — | Risk settings. |
| SHELL | Risk radar | keep | — | Accounts and IP addresses flagged as risky. |
| SHELL | Trading halt | keep | — | Stop all trading or allow close-only. |
| SHELL | Margin | keep | — | Accounts near margin call or stop-out. |
| SHELL | Liquidity | Liquidity providers | — | Liquidity provider records and how orders fill today; no provider is connected until an LP bridge exists (owner 2026-09-30). |
| SHELL | Liquidity routing | remove | — | Merged into Liquidity providers and hidden until an LP bridge exists; no nav entry (owner 2026-09-30). |
| SHELL | Feed health | Price feed health | — | Is the price feed live, per symbol (owner 2026-09-30). |
| SHELL | Clients | keep | — | All client accounts. |
| SHELL | Leads | keep | — | Prospects not yet clients. |
| SHELL | IB partners | Partners (IB) | — | Introducing brokers and their clients. |
| SHELL | KYC review | ID checks (KYC) | — | Client ID documents waiting for review. |
| SHELL | Account requests | Live account applications | — | Requests to open a live account. |
| SHELL | Deposits · withdrawals | Deposits & withdrawals | — | Client deposit and withdrawal requests. |
| SHELL | Approvals | Approvals (needs a second admin) | — | Changes waiting for a second admin to approve. |
| SHELL | Payment methods | keep | — | Deposit and withdrawal methods. |
| SHELL | Transfers | Internal transfers | — | Move money between two accounts. |
| SHELL | Wallets | Account balances | — | Balance, credit and equity of every account. |
| SHELL | Team | Staff | — | Staff logins and roles (owner 2026-09-30). |
| SHELL | Audit log | keep | — | Every staff action, who and when. |
| SHELL | Security | keep | — | Staff sign-in protection and two-step sign-in. |
| SHELL | Settings | Broker settings | — | Broker-wide settings (owner 2026-09-30). |
| SHELL | Nav badge (count) | keep | — | Items waiting on that screen. |
| SHELL | TENANT {host} | Broker server {host} | — | Server you are signed in to. |
| SHELL | NOT SIGNED IN | keep | — | — |
| SHELL | {HOST} · {ROLE} (status bar) | keep | — | Server and your role. |
| SHELL | F1 HELP | keep | — | Help. |
| SHELL | F2 CLIENTS | keep | — | Go to Clients. |
| SHELL | F3 EXPOSURE | F3 Live exposure | — | Go to Live exposure. |
| SHELL | F4 DEPOSITS | F4 Deposits & withdrawals | — | Go to Deposits & withdrawals. |
| SHELL | F5 DEALING | keep | — | Go to Dealing. |
| SHELL | F6 KYC | F6 ID checks | — | Go to ID checks. |
| SHELL | F7 IB | F7 Partners | — | Go to Partners. |
| SHELL | F8 SYMBOLS | keep | — | Go to Symbols. |
| SHELL | F9 RISK | keep | — | Go to Risk. |
| SHELL | F10 REPORTS | keep | — | Go to Reports. |
| SHELL | F11 AUDIT | F11 Audit log | — | Go to Audit log. |
| SHELL | F12 SETTINGS | keep (F12 SETTINGS) | — | Go to Broker settings; "BROKER SETTINGS" is cut off at 1366, the nav says Broker settings (owner 2026-09-30). |
| SHELL | HH:mm:ss UTC (clock) | keep | UTC | Server time. |
| SHELL | SEARCH (popover header) | keep | — | — |
| SHELL | searching… / {n} results / no match | keep | — | — |
| SHELL | NAV (result kind) | Screen | — | A screen of this app. |
| SHELL | CLI (result kind) | Client | — | A client account. |
| SHELL | ORD (result kind) | Order | — | An order. |
| SHELL | POS (result kind) | Position | — | An open position. |
| SHELL | TRX (result kind) | Transaction | — | A deposit, withdrawal or other money movement. |
| SHELL | SYM (result kind) | Symbol | — | A symbol. |
| SHELL | {email} · {ROLE} (user menu header) | keep | — | — |
| SHELL | Security… | keep | — | Your password and two-step sign-in (2FA). |
| SHELL | Switch account… | Sign in as another staff user… | — | Sign in with a different staff login. |
| SHELL | Sign out | keep | — | — |
| SHELL | NEW DEALING REQUEST · F5 (toast) | Order waiting for dealer · F5 | — | A client order needs your decision on the Dealing screen. |
| SHELL | BROKER SERVER (login) | keep | — | Address of your broker's server. |
| SHELL | ADMIN E-MAIL (login) | Staff e-mail | — | Your staff login e-mail. |
| SHELL | PASSWORD (login) | keep | — | — |
| SHELL | AUTHENTICATOR CODE (login) | keep | — | 6-digit code from your authenticator app. |
| SHELL | Remember me | keep | — | Keep the server and e-mail for next time. |
| SHELL | Forgot password? | keep | — | Ask an admin to reset your password. |
| SHELL | CANCEL (login) | keep | — | — |
| SHELL | SIGN IN | keep | — | — |
| SHELL | VERIFY | keep | — | Check the authenticator code. |
| SHELL | RESET YOUR PASSWORD | keep | — | — |
| SHELL | NOTE (OPTIONAL) | keep | — | Message for the admin who resets it. |
| SHELL | Reset request sent. | keep | — | — |
| SHELL | ← Back to sign in | keep | — | — |
| SHELL | SEND REQUEST | keep | — | — |
| SHELL | BACKOFFICE · SIGN IN TO START · {date} UTC | keep | UTC | — |

### Dashboard (DASH)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DASH | NET DEPOSITS · 7D | Net deposits, 7 days ($) | $ | Deposits minus withdrawals in the last 7 days. |
| DASH | DEPOSITS · 30D | Deposits, 30 days ($) | $ | Completed deposits in the last 30 days. |
| DASH | WITHDRAWALS · PENDING | Withdrawals waiting ($) | $ | Withdrawal requests waiting for a decision. |
| DASH | ACTIVE TRADERS | keep | — | Accounts with at least one open position. |
| DASH | OPEN VOLUME | Open volume (lots) | lots | Total volume of all open positions. |
| DASH | B-BOOK P/L · FLOATING | Book floating P/L ($) | $ | Floating P/L of positions the broker keeps, seen from the broker's side. |
| DASH | MARGIN CALLS | keep | — | Accounts at or below the margin call level. |
| DASH | NEW CLIENTS · 7D | New clients, 7 days | — | Accounts opened in the last 7 days. |
| DASH | DEALER QUEUE | Orders waiting for dealer | — | Orders that need a dealer's decision now. |
| DASH | 1) CLI  CLIENTS | Clients | — | All client accounts. |
| DASH | {n} TOTAL | keep | — | Number of accounts. |
| DASH | 2) EXP  OPEN BOOK | Live exposure | — | Open positions by symbol. |
| DASH | A / B BOOK (stat) | Market book / Book (lots) | lots | Open volume passed to a liquidity provider vs kept by the broker. |
| DASH | NET $ EXP (stat) | Net exposure ($) | $ | Value of client longs minus shorts across all symbols. |
| DASH | 3) APPR  APPROVALS QUEUE | Deposits & withdrawals waiting | — | Deposit and withdrawal requests waiting for a decision. |
| DASH | dep / wdr (stat) | Deposits / withdrawals | — | Count of each waiting. |
| DASH | 4) FLOW  DEPOSITS VS WITHDRAWALS · 7D | Deposits vs withdrawals, 7 days ($) | $ | Daily money in and out. |
| DASH | DEP / WDR / NET (legend) | Deposits / Withdrawals / Net | $ | — |
| DASH | 5) ACT  ACTIVITY | Staff activity | — | Latest staff actions from the audit log. |
| DASH | ALL STAFF | keep | — | Shows every staff member's actions. |
| DASH | ALL (chip) | keep | — | — |
| DASH | LIVE (chip) | keep | — | Live accounts only. |
| DASH | DEMO (chip) | keep | — | Demo accounts only. |
| DASH | KYC WAIT (chip) | ID check waiting | — | Accounts whose ID check is waiting for review. |
| DASH | SUSPENDED (chip) | Suspended or closed | — | Accounts that are not active. |
| DASH | IB (chip) | Referred clients | — | Clients brought in by a partner (IB). |
| DASH | ID (column) | Account | — | Account number. |
| DASH | CLIENT | keep | — | Client name. |
| DASH | COUNTRY | keep | — | — |
| DASH | KYC (column) | ID check | — | ID check status. |
| DASH | CATEGORY | Trade handling | — | Book, Market book or Reverse trading, set by the group. |
| DASH | GROUP | keep | — | — |
| DASH | BALANCE | Balance ($) | $ | — |
| DASH | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| DASH | LOTS | Open volume (lots) | lots | Volume of this account's open positions. |
| DASH | MARGIN % | Margin level (%) | % | Equity ÷ used margin × 100. |
| DASH | INTRODUCING BROKER | Partner | — | Partner (IB) who brought this client. |
| DASH | STATUS | keep | — | — |
| DASH | ACTIONS | Open | — | Click the row to open the client. |
| DASH | OK / WAIT / REJ / FLAG (ID check chip) | Verified / Waiting / Rejected / Flagged | — | — |
| DASH | SUSP / CLSD (status chip) | Suspended / Closed | — | — |
| DASH | OPEN (row action) | keep | — | Open this client. |
| DASH | Open client 360 | Open client | — | Open the client's account page. |
| DASH | Live exposure (menu) | keep | — | This client's open positions. |
| DASH | Deposits · withdrawals (menu) | Deposits & withdrawals | — | This client's deposit and withdrawal requests. |
| DASH | Wallet | Account balance | — | This client's balance, credit and equity. |
| DASH | SYMBOL | keep | — | — |
| DASH | LONG | Buy volume (lots) | lots | Client buy volume. |
| DASH | SHORT | Sell volume (lots) | lots | Client sell volume. |
| DASH | NET | Net volume (lots) | lots | Buy minus sell volume. |
| DASH | PROFIT / LOSS (exposure) | Floating P/L ($) | $ | Clients' floating P/L on this symbol. |
| DASH | A / B POS | Market book / Book positions | — | Number of positions in each book. |
| DASH | Live exposure · this symbol | Live exposure for this symbol | — | Open Live exposure filtered to this symbol. |
| DASH | Symbol settings | keep | — | — |
| DASH | TYPE | keep | — | Deposit or withdrawal. |
| DASH | AMOUNT | Amount ($) | $ | — |
| DASH | NOTE | keep | — | Client's note. |
| DASH | AGE | Waiting time | — | How long the request has waited. |
| DASH | DEP / WDR (type chip) | Deposit / Withdrawal | — | — |
| DASH | MARKED (status chip) | Client marked sent | — | Client says the money has been sent. |
| DASH | WAITING (status chip) | keep | — | Waiting for a staff decision. |
| DASH | Open in Deposits · withdrawals (approve / reject) | Open in Deposits & withdrawals (approve / reject) | — | — |
| DASH | COLUMNS (header menu) | keep | — | Show or hide columns. |
| DASH | Reset columns | keep | — | — |
| DASH | KPI tiles (layout, new) | Net deposits · 7D / Deposits · 30D / Withdrawals waiting / Active traders / Open volume / Book P/L / Margin calls / New clients · 7D / Waiting for dealer / Risk flags | — | Short labels; the full naming.md words are each tile's tooltip; ten tiles in one row from 1600 px, two rows of five below; every tile opens its screen (DEP, DEP, DEP, CLI, EXP, EXP, MRG, CLI, DEAL, RDR) and ends in "›" (owner 2026-09-30). |
| DASH | KPI money notes (new) | {CCY} · … / MIXED CCY · … | — | The server's money totals add currencies together: a tile names the one currency, or says MIXED CCY; never "($)" (owner 2026-09-30). |
| DASH | 1) CLI  CLIENTS (panel) | remove | — | The full client list is replaced by 1) ATT Needs attention; the Clients screen holds the full list (owner 2026-09-30). |
| DASH | 1) ATT  NEEDS ATTENTION (panel, new) | Needs attention | — | Live client accounts with a reason; header link "All clients in CLI ›"; each row carries the Clients Account menu (owner 2026-09-30). |
| DASH | Needs attention chips (new) | All / Margin / Risk flags / ID check / New 7D / Largest open | — | Filters, with counts (owner 2026-09-30). |
| DASH | Needs attention columns (new) | Account / Client / Group (hidden by default) / Balance / Equity / Open (lots) / Floating P/L / Ccy / Margin level (%) / Why | — | Money in the account's currency (the Ccy column) (owner 2026-09-30). |
| DASH | WHY tag (new) | Stop-out / Margin call / Martingale / Scalping / Latency arbitrage / News trading / ID check waiting / New 7D / Largest open; "{reason} +{n} more" | — | The tag's tooltip lists every reason: "Why: Margin call · Martingale · Largest open" (owner 2026-09-30). |
| DASH | 2) EXP  OPEN BOOK (panel) | Open book | — | Client exposure per symbol and account currency; stat "Lots · Book {x}%" (owner 2026-09-30). |
| DASH | Open book columns (new) | Symbol / Buy / Sell / Net / Client P/L / Ccy | lots in the panel stat | "(lots)" is in the panel stat, not each header, to fit 1366 (owner 2026-09-30). |
| DASH | Open book facts (new) | Nearest stop-out / Market book (A-book): 0.00 lots · no liquidity provider connected / Totals: hedge account excluded | — | Nothing implies a connected LP (owner 2026-09-30). |
| DASH | 3) APR  APPROVALS (panel) | Approvals | — | Waiting deposits and withdrawals; header link "APR ›"; one line "Nothing waiting for approval." when empty (owner 2026-09-30). |
| DASH | MARKED (status chip) | Marked sent | — | Short form of "Client marked sent"; the Waiting column is hidden by default (owner 2026-09-30). |
| DASH | 4) FLOW  DEPOSITS VS WITHDRAWALS · 7D | keep | — | Header link "DEP ›"; one line "No deposits or withdrawals in the last 7 days." when empty; day labels "24 Sep" (invariant, UTC) (owner 2026-09-30). |
| DASH | 5) ACT  STAFF ACTIVITY (panel) | Staff activity | — | Chips STAFF (default: staff actions and direct database changes) / ALL (adds the system's fills, stop-outs, client actions); header link "AUD ›"; a row opens the entry in the Audit log (owner 2026-09-30). |
| DASH | Activity kind tags (new) | Settings / Withdraw / Deposit / Funds / Account / Trade / Stop-out / ID check / Apply / Lead / Partner / Client / Staff | — | By the kind of record changed: any broker / group / symbol / pricing / approval-mode / routing change is Settings; Withdraw and Deposit only for money requests and payouts (owner 2026-09-30). |
| DASH | Empty panels (new) | one line: Nothing needs attention. / No open client positions. / Nothing waiting for approval. / No deposits or withdrawals in the last 7 days. / No staff activity yet. | — | An empty panel collapses to its header and one line (owner 2026-09-30). |
| DASH | System accounts (new) | hedge account excluded | — | The hedge account is left out of every DASH tile, list and total (owner 2026-09-30). |

### Reports (RPT)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RPT | 1) RPT  REPORTS | Reports | — | Downloadable broker reports for a date range. |
| RPT | TRADING VOLUME (KPI) | Trading volume (lots) | lots | Total lots of closed trades in the chosen range. |
| RPT | COMMISSION REVENUE (KPI) | Commission earned ($) | $ | Commission charged to clients in the range. |
| RPT | NET DEPOSITS (KPI) | Net deposits ($) | $ | Completed deposits minus completed withdrawals in the range. |
| RPT | NEW CLIENTS (KPI) | New clients | — | Accounts created in the range. |
| RPT | SAVE CSV | Save as CSV | — | Download the report shown as a spreadsheet file. |
| RPT | TRADING (chip) | Trading | — | Closed trades report. |
| RPT | FINANCIAL (chip) | Deposits & withdrawals | — | Money in/out report. |
| RPT | CLIENT (chip) | Clients | — | Client account list. |
| RPT | IB (chip) | Partners (IB) | — | Partner and referred-client commissions. |
| RPT | LP (chip) | Liquidity providers | — | Liquidity provider records. |
| RPT | RISK (chip) | Risk | — | Open risk per account right now. |
| RPT | RANGE | Date range (UTC) | UTC | Start and end date of the report. |
| RPT | from / to | From (UTC) / To (UTC) | UTC | First and last day included. |
| RPT | 1D · 1W · 30D (chips) | Today · 7 days · 30 days | — | Quick date ranges. |
| RPT | CLOSED AT | Closed (UTC) | UTC | When the trade closed. |
| RPT | ACCOUNT | keep | — | Client account number. |
| RPT | SYMBOL | keep | — | Traded symbol. |
| RPT | SIDE | keep | — | Buy or sell. |
| RPT | VOLUME | Volume (lots) | lots | Size of the trade. |
| RPT | OPEN PRICE | keep | — | Price the position opened at. |
| RPT | CLOSE PRICE | keep | — | Price the position closed at. |
| RPT | COMMISSION | Commission ($) | $ | Commission charged on this trade. |
| RPT | SWAP | Swap ($) | $ | Overnight fees charged or paid on this trade. |
| RPT | REALIZED P&L | Closed P/L ($) | $ | Profit or loss of the closed trade. |
| RPT | DATE | Date (UTC) | UTC | When the request was made. |
| RPT | TYPE | keep | — | Deposit, withdrawal or adjustment. |
| RPT | STATUS | keep | — | Current state of the record. |
| RPT | AMOUNT | Amount ($) | $ | Money amount of the request. |
| RPT | NOTE | keep | — | Staff note. |
| RPT | FULL NAME | Client name | — | Client's full name. |
| RPT | EMAIL | E-mail | — | Client's e-mail address. |
| RPT | MODE | Live / Demo | — | Whether the account is live or demo. |
| RPT | CURRENCY | keep | — | Account currency. |
| RPT | BALANCE | Balance ($) | $ | Deposited money, not counting open positions. |
| RPT | GROUP | keep | — | Client group (pricing and leverage). |
| RPT | CREATED AT | Created (UTC) | UTC | When the account was created. |
| RPT | IB ACCOUNT | Partner account | — | Partner's (IB) own account number. |
| RPT | CLIENT ACCOUNT | Referred client | — | Account the partner brought in. |
| RPT | COMMISSION TYPE | Partner pay type | — | per lot, or % of commission. |
| RPT | COMMISSION RATE | Partner pay rate (per lot or %) | per lot / % | Amount per lot, or percent when the type is %. |
| RPT | PENDING COMMISSION | Partner pay owed ($) | $ | Earned by the partner and not paid yet. |
| RPT | LAST PAYOUT AT | Last paid (UTC) | UTC | When the partner was last paid. |
| RPT | NAME | Provider | — | Liquidity provider name. |
| RPT | PROTOCOL | Connection type | — | How the provider connects (FIX, REST…). |
| RPT | CONTACT NAME / CONTACT EMAIL / CONTACT PHONE | Contact / Contact e-mail / Contact phone | — | Person at the provider. |
| RPT | ROUTING RULES | keep | — | Number of symbol routing rules using this provider. |
| RPT | ADDED AT | Added (UTC) | UTC | When the provider was added. |
| RPT | OPEN POSITIONS | Positions | — | Number of open positions on the account. |
| RPT | EXPOSURE (LOTS) | Open volume (lots) | lots | Total volume of the account's open positions. |
| RPT | FLOATING P&L | Floating P/L ($) | $ | Profit/loss of open positions now. |
| RPT | MARGIN LEVEL % | Margin level (%) | % | Equity ÷ used margin × 100. |
| RPT | MARGIN CALL THRESHOLD % | Margin call level (%) | % | Margin level that triggers the warning. |
| RPT | STOP-OUT THRESHOLD % | Stop-out level (%) | % | Margin level that auto-closes positions. |
| RPT | COLUMNS (header menu) | Columns | — | Show or hide table columns. |
| RPT | Reset columns | keep | — | Restore the default columns. |
| RPT | PICK A REPORT | Pick a report | — | Empty state before a report is chosen. |
| RPT | {n} rows (stat) | {n} rows | — | Rows in the loaded report. |

### Notifications (NTF)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| NTF | 1) NTF  NOTIFICATIONS | Notifications | — | Alerts raised by the system for staff. |
| NTF | {n} UNREAD · {n} TOTAL | {n} unread · {n} total | — | Unread and total notifications. |
| NTF | MARK ALL READ | Mark all read | — | Mark every notification as read. |
| NTF | ALL (chip) | keep | — | Show every notification. |
| NTF | UNREAD (chip) | keep | — | Show only unread notifications. |
| NTF | search "title · body · type" | Search | — | Search title, text and type. |
| NTF | READ | Read | — | Shows UNREAD when not opened yet. |
| NTF | UNREAD (chip in row) | Unread | — | Not opened yet. |
| NTF | WHEN | When | — | How long ago it arrived. |
| NTF | TYPE | keep | — | Kind of notification. |
| NTF | TITLE | keep | — | Short headline. |
| NTF | BODY | Message | — | Full notification text. |
| NTF | ENTITY | Related record | — | The account/request it is about; hidden by default so the table fits at 1366 (in Columns and the side panel) (owner 2026-09-30). |
| NTF | Open the record | Open {record} | — | One label naming the record (Open client, Open closed trade, Review ID check …) in the menu, right-click and side panel; "Open the record" only as the disabled item when there is no screen (owner 2026-09-30). |
| NTF | Mark read | keep | — | Mark this notification as read; disabled "already read" when read (owner 2026-09-30). |
| NTF | Reset trader password… | Reset client password… | — | Generate a new password for the client (shown once). |
| NTF | 2) DETAIL  NOTIFICATION | Notification | — | The selected notification. |
| NTF | state · type · entity · created | Status · Type · Related record · Received (UTC) | UTC | Details of the notification. |
| NTF | OPEN {CODE} | Open {record} | — | Same label as the menu item (owner 2026-09-30). |
| NTF | REVIEW KYC | Review ID check | — | Open the ID check (KYC) for this client. |
| NTF | MARK READ | Mark read | — | Mark this notification as read. |
| NTF | RESET PASSWORD | Reset client password | — | Generate a new client password. |
| NTF | NO LINKED SCREEN | no related screen | — | Reason on the disabled "Open the record" item (owner 2026-09-30). |
| NTF | SELECT A NOTIFICATION | keep | — | Empty detail state. |
| NTF | MARK ALL READ (confirm) | Mark all read | — | Confirm dialog title. |
| NTF | MARK ALL (button) | Mark all read | — | Confirm button. |
| NTF | RESET TRADER PASSWORD (confirm) | Reset client password | — | Confirm dialog title. |
| NTF | RESET (button) | Reset password | — | Confirm button. |
| NTF | NEW PASSWORD · SHOWN ONCE | NEW PASSWORD (SHOWN ONCE) | — | Dialog title, upper case like every dialog title; copy it now, it cannot be shown again (owner 2026-09-30). |
| NTF | MESSAGE (side panel section, new) | Message | — | The full notification text (owner 2026-09-30). |
| NTF | MARK SELECTED READ (selection bar, new) | Mark selected read | — | Marks the ticked unread notifications read; read ones are skipped and counted (owner 2026-09-30). |
| NTF | already read (reason, new) | keep | — | Why Mark read is disabled (owner 2026-09-30). |
| NTF | Copy ▸ (new) | Copy: Title / Message / Related record | — | Row menu, right-click, side panel (owner 2026-09-30). |

### Live exposure (EXP)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| EXP | 1) EXP  EXPOSURE BY SYMBOL | Exposure by symbol | — | Open client volume per symbol, for all clients. |
| EXP | <n> POSITIONS · <lots> LOTS · CLIENT P/L ±x | {n} positions · {x} lots · Floating P/L ($) | lots / $ | Totals for everything shown. |
| EXP | BOOK (label) | Trade handling | — | Filter by how the positions are handled. |
| EXP | ALL · A-BOOK · B-BOOK | All · Market book (A-book) · Book | — | Show all, market-book or book positions. |
| EXP | GROUP (label) + group chips | Group | — | Filter by client group. |
| EXP | SYMBOL | keep | — | Symbol. |
| EXP | POSITIONS | keep | — | Number of open positions. |
| EXP | BUY VOLUME | Buy volume (lots) | lots | Total lots clients hold long. |
| EXP | SELL VOLUME | Sell volume (lots) | lots | Total lots clients hold short. |
| EXP | NET | Net volume (lots) | lots | Buy minus sell volume; the broker's exposure. |
| EXP | NOTIONAL | Net exposure ($) | $ | Net volume × contract size × current price. |
| EXP | A / B POS | Market book / Book positions | — | Number of positions in each book. |
| EXP | AVERAGE OPEN | Average open price | — | Volume-weighted open price of the net volume. |
| EXP | CLIENT PROFIT / LOSS | Floating P/L ($) | $ | Clients' profit/loss on open positions now. |
| EXP | PRICE | Current price | — | Latest price of the symbol. |
| EXP | MAXIMUM EXPOSURE | Largest account / max lots per account (lots) | lots | The most lots any one account holds in this symbol, against the per-account limit. |
| EXP | Filter positions to this symbol | keep | — | Show only this symbol in Open Positions. |
| EXP | Close every position on this symbol… | Close all positions on this symbol… | — | Close all clients' positions on the symbol at market. |
| EXP | Symbol settings | keep | — | Open this symbol's settings. |
| EXP | 2) LIM  RISK LIMITS | Risk limits | — | For all clients limits from the Risk screen. |
| EXP | EDIT ON RISK | Edit on Risk screen | — | Change these limits on the Risk screen. |
| EXP | TOTAL EXPOSURE | Max open volume (lots) | lots | Client open volume against the most lots all clients may hold open together. |
| EXP | MAX POSITIONS / ACCOUNT | Max positions per account | — | Open-position cap per account. |
| EXP | DEALING MODE | Dealing | — | Manual dealing or Automatic dealing. |
| EXP | TRADING (OPEN / CLOSE-ONLY / HALTED) | Trading (Open / Close-only / Trading halted) | — | For all clients trading state. |
| EXP | RISK SETTINGS UNAVAILABLE | keep | — | Limits could not be loaded. |
| EXP | 3) POS  OPEN POSITIONS · DEALER VIEW | Open positions | — | Every client position, with dealer actions. |
| EXP | <shown> SHOWN OF <total> | {n} shown of {m} | — | Positions matching the filters. |
| EXP | CLOSE BY SYMBOL | Close all shown positions | — | Close every position in the list at market. |
| EXP | SYMBOL (label) + chips | Symbol | — | Filter positions by symbol. |
| EXP | search "account · client" | Search account or client | — | Search box. |
| EXP | TICKET | Ticket # | — | Position number. |
| EXP | ACCOUNT | keep | — | Client account number. |
| EXP | CLIENT | keep | — | Client name. |
| EXP | GROUP | keep | — | Client group. |
| EXP | SIDE | keep | — | Buy or sell. |
| EXP | LOTS | Volume (lots) | lots | Size of the position. |
| EXP | OPEN | Open price | — | Price the position opened at. |
| EXP | S/L | SL | — | Stop loss price. |
| EXP | T/P | TP | — | Take profit price. |
| EXP | PROFIT / LOSS | Floating P/L ($) | $ | Profit/loss of the position now. |
| EXP | BOOK ("A"/"B") | Trade handling | — | Market book (A) or Book (B). |
| EXP | OPENED | Opened (UTC) | UTC | When the position opened. |
| EXP | ACTIONS | keep | — | Row actions. |
| EXP | Modify SL / TP… | Change stop loss / take profit… | — | Set new SL/TP prices. |
| EXP | Close at market… | keep | — | Close the whole position at the current price. |
| EXP | Close part… | Close part of position… | — | Close some of the lots. |
| EXP | Close by | keep | — | Close against an opposite position of the same client. |
| EXP | Close by… (no opposite <SYM> position) | keep | — | Disabled: no opposite position to close against. |
| EXP | Reverse… | Reverse position… | — | Flip the position to the other side. |
| EXP | Open client <acc> | keep | — | Open the client's account page. |
| EXP | MODIFY POSITION (dialog) | Change stop loss / take profit | — | Dialog title. |
| EXP | CLOSE POSITION (dialog) | Close position | — | Confirm dialog title. |
| EXP | CLOSE (button) | Close position | — | Confirm button. |
| EXP | CLOSE BY (dialog) | Close by | — | Confirm dialog title. |
| EXP | CLOSE PART (dialog) | Close part of position | — | Confirm dialog title. |
| EXP | LOTS (input) | Volume to close (lots) | lots | How many lots to close. |
| EXP | REVERSE POSITION (dialog) | Reverse position | — | Dialog title. |
| EXP | How | Reverse method | — | Flip in place, or close and reopen opposite. |
| EXP | FLIP IN PLACE / CLOSE + REOPEN OPPOSITE | Flip in place / Close and reopen opposite | — | Reverse options. |
| EXP | CLOSE ALL POSITIONS / CLOSE BY SYMBOL (dialog) | Close all shown positions | — | Confirm dialog title. |
| EXP | CLOSE ALL (button) | Close all | — | Confirm button. |
| EXP | 4) FEED  LIVE ACTIVITY · BROKER-WIDE | Live activity | — | Latest order events across the broker. |
| EXP | REQUOTE (log action) | New price offered | — | A new price was offered to the client. |
| EXP | FILL / ACCEPT / REJECT / STOP / MODIF | Filled / Accepted / Rejected / Stopped / Modified | — | Order event types. |
| EXP | NO ACTIVITY | No activity | — | Empty state. |

### Dealing (DEAL)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DEAL | 1) MW  MARKET WATCH | Market Watch | — | — |
| DEAL | 2) QUEUE  PENDING QUEUE | Waiting orders | — | Orders waiting for dealer, offers waiting for client, and pending orders. |
| DEAL | 3) ACT  DEALING ACTIVITY | Dealing activity | — | Latest dealing events. |
| DEAL | 4) chart | Chart | — | Hedge account legs are drawn on it. |
| DEAL | 5) COV  COVERAGE ACCOUNT | Hedge account | — | The broker's own account for hedges. |
| DEAL | 6) MODE  DEALER MODE | Dealing | — | Manual or automatic dealing, for all clients. |
| DEAL | 7) GRP  DEALING-GROUP | Book positions | — | Every open Book position. |
| DEAL | 8) TICKET  ORDER TICKET | Hedge order | — | Order on the hedge account. |
| DEAL | 9) PANIC  EMERGENCY · DEALING GROUP | Trading halt · manual-dealing groups | — | — |
| DEAL | 10) SDM  SMART DEALER MANAGER | Hedge manager | — | Hedge or unhedge Book positions and see dealer P/L. |
| DEAL | TOTAL "n · L lot" (net strip) | Book positions (lots) | lots | — |
| DEAL | COVERED | Hedged (lots) | lots | — |
| DEAL | OPEN RISK | Unhedged (lots) | lots | Book volume not hedged. |
| DEAL | NET (net strip) | Net volume (lots) | lots | Client buy minus sell volume. |
| DEAL | DEALING-GROUP P/L | Book P/L ($) | $ | — |
| DEAL | COVERAGE P/L | Hedge account P/L ($) | $ | — |
| DEAL | DEALER NET P/L | Dealer P/L ($) | $ | Book P/L plus hedge account P/L. |
| DEAL | search symbols… | keep | — | — |
| DEAL | + ADD | Add symbol | — | — |
| DEAL | ADD SYMBOL | keep | — | — |
| DEAL | search… | keep | — | — |
| DEAL | SYMBOL | keep | — | — |
| DEAL | BID / ASK | keep | — | — |
| DEAL | SPRD | Client spread (points) | points | (10 points = 1 pip) |
| DEAL | HIGH · LOW | Day high / Day low | — | — |
| DEAL | CHG% | Change (%) | % | Change since the day's open. |
| DEAL | NO FEED | No price | — | No price received for this symbol yet. |
| DEAL | Open chart, X | Open chart · X | — | — |
| DEAL | New order, X | New order · X | — | — |
| DEAL | Specification, X… | Symbol details · X… | — | Contract size, volume limits, spread. |
| DEAL | Add symbol… | keep | — | — |
| DEAL | Remove X from watchlist | Remove X from Market Watch | — | — |
| DEAL | Columns ▸ | keep | — | — |
| DEAL | Change % | Change (%) | % | — |
| DEAL | Spread (column toggle) | Client spread (points) | points | (10 points = 1 pip) |
| DEAL | Daily High / Low | Day high / low | — | — |
| DEAL | 0 AWAITING DEALER | 0 waiting for dealer | — | — |
| DEAL | N AWAITING · OLDEST 12S | N waiting · oldest 12 s | — | — |
| DEAL | ⚙ Dealer settings | keep | — | — |
| DEAL | ACCEPT ALL | keep | — | Fill every order waiting for dealer at current price. |
| DEAL | REJECT ALL | keep | — | — |
| DEAL | STATUS | keep | — | — |
| DEAL | KIND | Type | — | — |
| DEAL | ACCOUNT | keep | — | — |
| DEAL | CLIENT | keep | — | — |
| DEAL | SIDE | keep | — | — |
| DEAL | LOTS / LOT | Volume (lots) | lots | — |
| DEAL | PRICE | Requested price | — | — |
| DEAL | AGE | Waiting time | — | How long the order has waited. |
| DEAL | ACT | Actions | — | — |
| DEAL | AWAITING DEALER | Waiting for dealer | — | — |
| DEAL | AWAITING CLIENT | Waiting for client | — | New price offered, client has not answered. |
| DEAL | RESTING | Pending order | — | — |
| DEAL | ACCEPT ▾ | keep | — | — |
| DEAL | ACCEPT AT / CLOSE AT | keep | — | — |
| DEAL | Requested · <price> | keep | — | Fill at the price the client asked. |
| DEAL | Market · <price> | Current price · <price> | — | Fill at the current price. |
| DEAL | REQUOTE ▾ | Offer new price ▾ | — | — |
| DEAL | REQUOTE SYM SIDE VOL · step N pts | Offer new price SYM SIDE VOL · step N points | points | (10 points = 1 pip) |
| DEAL | +1 / +2 / +3 | +1 / +2 / +3 steps | points | Each step moves the offered price one new-price step (points) from the current price. (10 points = 1 pip) |
| DEAL | custom price | keep | — | — |
| DEAL | REJECT | keep | — | — |
| DEAL | WITHDRAW | Withdraw offer | — | Cancel the new price offered to the client. |
| DEAL | CANCEL | Cancel pending order | — | — |
| DEAL | Open client 360 / Live exposure (menus) | Open client / Live exposure | — | — |
| DEAL | DEALER SETTINGS (form) | keep | — | — |
| DEAL | Requote step (points) | New-price step (points) | points | Size of each +1 step when offering a new price. (10 points = 1 pip) |
| DEAL | SAVE | keep | — | — |
| DEAL | ACCEPT ALL / REJECT ALL (confirm) | keep | — | — |
| DEAL | REASON (AUDIT TRAIL) | Reason (saved to audit log) | — | — |
| DEAL | CLOSE / OPEN / PLACED / MODIFY / CANCEL / TRIGGER (activity kind) | keep | — | — |
| DEAL | CHART LAYOUT / Single / Grid 2×2 / Crosshair sync (grid) | Chart layout / Single chart / 2×2 grid / Link crosshair across grid | — | — |
| DEAL | LAST | Current price | — | — |
| DEAL | CHG | Change (%) | % | Change since the day's open. |
| DEAL | O · H · L | Open / High / Low | — | Open, high, low of the bar. |
| DEAL | VOL (chart header) | Tick volume | — | Number of price updates in the bar. |
| DEAL | 1M 5M 15M 30M 1H 4H D W | M1 M5 M15 M30 H1 H4 D1 W1 | — | Candle timeframe. |
| DEAL | INDICATORS | keep | — | — |
| DEAL | CHART / Sessions / EMA 20/50 / VWAP / SESSIONS | keep | — | — |
| DEAL | One-click panel | One-click trading panel | — | — |
| DEAL | DRAWING TOOLS / Trend line / Horizontal line / Ray / Rectangle / Fibonacci retracement | keep | — | — |
| DEAL | Chart settings… | keep | — | — |
| DEAL | FIB / OB / FVG | Fibonacci / Order blocks / Fair value gaps | — | — |
| DEAL | SELL / BUY | keep | — | — |
| DEAL | lots (one-click) | Volume (lots) | lots | — |
| DEAL | <price> · below/above market | keep | — | — |
| DEAL | Buy Limit / Sell Stop / Sell Limit / Buy Stop @ P | Buy limit / Sell stop / Sell limit / Buy stop at P | — | Pending order on the hedge account. |
| DEAL | Set SL P | Set stop loss at P | — | — |
| DEAL | Set TP P | Set take profit at P | — | — |
| DEAL | Alert below/above P | Alert when price falls to P / rises to P | — | — |
| DEAL | Collapse / Expand one-click panel | Hide / Show one-click trading panel | — | — |
| DEAL | <Kind> settings… / Remove drawing / Clear all drawings (n) | <Kind> settings… / Delete drawing / Clear all drawings (n) | — | — |
| DEAL | Reset view / Maximize | keep | — | — |
| DEAL | {SIDE} {SYM} AT MARKET (confirm) | {Buy/Sell} {SYM} at market | — | — |
| DEAL | PLACE ORDER / MODIFY | Place order / Save change | — | — |
| DEAL | TRADES (chip) | Positions | — | — |
| DEAL | EXPOSURE (chip) | keep | — | — |
| DEAL | HISTORY (chip) | Closed trades | — | — |
| DEAL | TICKET | Ticket # | — | — |
| DEAL | OPENED | Opened (UTC) | UTC | — |
| DEAL | OPENING / OPEN (column) | Open price | — | — |
| DEAL | CMP / CURRENT PRICE | Current price | — | — |
| DEAL | P/L (hedge positions) | Floating P/L ($) | $ | — |
| DEAL | ✕ "Close coverage position" | Close hedge position | — | — |
| DEAL | ACCOUNT · BALANCE · EQUITY (hedge strip) | Account · Balance ($) · Equity ($) | $ | — |
| DEAL | FLOATING | Floating P/L ($) | $ | — |
| DEAL | FREE | Free margin ($) | $ | — |
| DEAL | MARGIN LVL | Margin level (%) | % | — |
| DEAL | none used | No margin used | — | — |
| DEAL | UNFUNDED: any loss stops out | No funds: any loss triggers stop-out | — | — |
| DEAL | LONG / SHORT / NET | Buy volume (lots) / Sell volume (lots) / Net volume (lots) | lots | — |
| DEAL | PROFIT / LOSS | Floating P/L ($) on Positions/Exposure; Closed P/L ($) on Closed trades | $ | — |
| DEAL | FROM / TO | From (UTC) / To (UTC) | UTC | — |
| DEAL | APPLY | keep | — | — |
| DEAL | REALIZED | Closed P/L ($) | $ | — |
| DEAL | CLOSED / TIME (history) | Closed (UTC) | UTC | — |
| DEAL | CLOSE (column) | Close price | — | — |
| DEAL | P/L (GRP history stat) | Closed P/L ($) | $ | — |
| DEAL | ACC · SYM (menu header) | keep | — | — |
| DEAL | Execution | Dealing | — | — |
| DEAL | DEALER ON | Manual dealing | — | Dealer reviews every market order. |
| DEAL | AUTO-FILL | Automatic dealing | — | Market orders fill at the current price with no dealer. |
| DEAL | SWITCH TO AUTO-FILL / SWITCH TO DEALER ON | Switch to automatic dealing / Switch to manual dealing | — | — |
| DEAL | AUTO-FILL / DEALER ON (confirm) | Automatic dealing / Manual dealing | — | — |
| DEAL | Auto-hedge | keep | — | Hedge every Book fill on the hedge account. |
| DEAL | TURN AUTO-HEDGE ON / OFF | Turn auto-hedge on / off | — | — |
| DEAL | AUTO-HEDGE ON / OFF (confirm) | keep | — | — |
| DEAL | Dealing-group accounts | Accounts in manual-dealing groups | — | — |
| DEAL | Smart dealer | Auto-accept / auto-reject slippage (%) | % | Accept or reject orders automatically by how far the price moved. |
| DEAL | accept ≤ a% · reject ≥ r% | keep | % | — |
| DEAL | MAX SLIPPAGE | Max slippage (points) | points | Largest price change allowed on fill, for all clients; "unlimited" when no cap is set (stored in points since 2026-10-01). |
| DEAL | EDIT | keep | — | — |
| DEAL | MAX SLIPPAGE (form) · "Pips (blank = platform default…, 0 = reject any slippage)" | Max slippage (points) · "above 0 · blank = unlimited (no broker cap)" | points | No "platform default" text anywhere (issues.md 424 / 466 / 472; owner 2026-10-01). |
| DEAL | COVERAGE ACCOUNT (section / form) / Coverage account | Hedge account | — | — |
| DEAL | not set | keep | — | — |
| DEAL | SET / CHANGE COVERAGE ACCOUNT | Set / Change hedge account | — | — |
| DEAL | SET | keep | — | — |
| DEAL | Symbol ▾ / SYMBOL (menu header) | keep | — | — |
| DEAL | MKT / LIMIT / STOP | Market / Limit / Stop | — | — |
| DEAL | Volume | Volume (lots) | lots | — |
| DEAL | Take profit / Stop loss | keep | — | — |
| DEAL | SELL LIMIT / BUY STOP (captions) | keep | — | — |
| DEAL | Fills on the coverage account at the live price. | Fills on the hedge account at the current price. | — | — |
| DEAL | Limit and stop need the coverage bridge. | Limit and stop orders are not available yet. | — | — |
| DEAL | no dealing groups | No manual-dealing groups | — | — |
| DEAL | h/N HALTED | h/N halted | — | — |
| DEAL | c/N CLOSE-ONLY | c/N close-only | — | — |
| DEAL | TRADING | keep | — | Manual-dealing groups trade normally. |
| DEAL | Dealing group only. Broker-wide: Trading-halt. | Manual-dealing groups only. For all groups use Trading halt. | — | — |
| DEAL | HALT DEALING GROUP (button / confirm) | Halt manual-dealing groups | — | New orders refused; open positions stay open. |
| DEAL | HALT (confirm button) | keep | — | — |
| DEAL | CLOSE-ONLY (button / confirm) | Close-only | — | Clients can close but not open. |
| DEAL | RESUME (button / confirm) | keep | — | Lift halt and close-only. |
| DEAL | P/L (filter label) | Dealer P/L ($) | $ | — |
| DEAL | 1D / 5D / 7D / 1M | 1 day / 5 days / 7 days / 1 month | — | — |
| DEAL | DEALER P/L · 1D | Dealer P/L ($), 1 day | $ | Book P/L plus hedge account P/L. |
| DEAL | open … · booked … · closed … (1D) | open … · hedged … · closed … (1 day) | $ | — |
| DEAL | UNBOOKED · n | Not hedged · n | — | — |
| DEAL | BOOK ALL · n | Hedge all · n | — | Hedge every unhedged Book position on the hedge account. |
| DEAL | CLIENT / DEALER P&L | Client P/L ($) / Book P/L ($) | $ | — |
| DEAL | BOOK | Hedge | — | — |
| DEAL | BOOKED · n | Hedged · n | — | — |
| DEAL | COVERAGE (P/L) | Hedge account P/L ($) | $ | — |
| DEAL | NET (SDM P/L) | Dealer P/L ($) | $ | Book P/L plus hedge account P/L. |
| DEAL | UNBOOK | Remove hedge | — | — |
| DEAL | hedge leg not found on the coverage account | Hedge not found on the hedge account | — | — |
| DEAL | CLOSED · n / CLOSED MM-DD HH:mm | Closed · n / Closed MM-DD HH:mm (UTC) | UTC | — |
| DEAL | COVERAGE (OPEN) | Hedge account floating P/L ($) | $ | — |
| DEAL | AWAITING DEALER · close the coverage leg | Waiting for dealer · close the hedge | — | — |
| DEAL | ORPHAN · auto-hedged leg did not close | Hedge left open · auto-hedge did not close it | — | — |
| DEAL | CLOSE (SDM button) | Close hedge | — | — |
| DEAL | BOOK NOW (confirm) | Hedge now | — | Client position stays open. |
| DEAL | BOOK ALL (confirm) | Hedge all | — | — |
| DEAL | CLOSE COVERAGE (confirm) / CLOSE | Close hedge / Close | — | — |
| DEAL | COLUMNS / Reset columns | keep | — | — |

### Closed trades (DLS)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DLS | 1) DLS  TRADE HISTORY | Closed trades | — | Every closed trade, newest first. |
| DLS | N SHOWN OF M · NET ±x | {n} shown of {m} · Closed P/L ($) | $ | Count and total profit/loss of the shown trades. |
| DLS | ALL · PROFIT · LOSS · VOIDED · TODAY | All · Profit · Loss · Voided · Today | — | Quick filters. |
| DLS | search "account · client · symbol" | Search account, client or symbol | — | Search box. |
| DLS | TICKET | Ticket # | — | Trade number. |
| DLS | ACCOUNT | keep | — | Client account number. |
| DLS | CLIENT | keep | — | Client name. |
| DLS | SYMBOL | keep | — | Symbol. |
| DLS | SIDE | keep | — | Buy or sell. |
| DLS | VOLUME | Volume (lots) | lots | Size of the trade. |
| DLS | OPEN | Open price | — | Price it opened at. |
| DLS | CLOSE | Close price | — | Price it closed at. |
| DLS | COMMISSION | Commission ($) | $ | Commission charged. |
| DLS | SWAP | Swap ($) | $ | Overnight fees charged or paid. |
| DLS | PROFIT / LOSS | Closed P/L ($) | $ | Profit/loss of the trade. |
| DLS | CLOSED | Closed (UTC) | UTC | When it closed. |
| DLS | STATUS | keep | — | Closed, voided or delete pending. |
| DLS | CLOSED (chip) | keep | — | Normal closed trade. |
| DLS | VOIDED (chip) | keep | — | Result reversed on the account. |
| DLS | DELETE PENDING (chip) | Delete waiting for approval | — | Delete needs a second admin. |
| DLS | ACTIONS / DELETE | Actions / Delete | — | Row actions. |
| DLS | Open client | keep | — | Open the client's account page. |
| DLS | Replay fill… | Show fill details… | — | How the trade was filled, step by step. |
| DLS | Void deal… | Void trade… | — | Cancel the trade's result on the account. |
| DLS | Delete deal… | Delete trade… | — | Remove the trade (needs a second admin). |
| DLS | VOID DEAL (dialog) | Void closed trade | — | Confirm dialog title. |
| DLS | VOID (button) | Void trade | — | Confirm button. |
| DLS | REPLAY · <ticket> (dialog) | Fill details · Ticket # | — | Dialog title. |
| DLS | DELETE DEAL (dialog) | Delete closed trade | — | Confirm dialog title. |
| DLS | DELETE (button) | Delete trade | — | Confirm button. |
| DLS | REASON | Reason | — | Why the trade is deleted (kept in the audit log). |

### Symbols (SYM)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SYM | 1) LIM  EXPOSURE LIMITS · NET LOTS PER SYMBOL | Lot limits per symbol | — | Each symbol's per-account lot limit and the largest single account against it. |
| SYM | SYMBOL | keep | — | Symbol. |
| SYM | NET LIMIT | Max lots per account (lots) | lots | The most lots one account may hold open in this symbol. |
| SYM | NOW | Largest account (lots) | lots | The largest single account's open lots in this symbol (audit fix D7; owner 2026-09-29: naming follows the screen). |
| SYM | STATUS (OK / NEAR LIMIT / AT LIMIT / NO LIMIT) | keep | — | How the largest account compares with the limit (owner 2026-09-29: AT LIMIT, as on screen). |
| SYM | 2) SYM  SYMBOLS · SPREADS · SESSIONS | Symbols | — | Symbol pricing, sizes and trading hours. |
| SYM | <n> ENABLED · <n> TOTAL | {n} enabled · {n} total | — | Symbols clients can trade. |
| SYM | <n> SYMBOL(S) CHANGED · NOT SAVED | {n} symbols changed, not saved | — | Unsaved edits. |
| SYM | DISCARD | Discard changes | — | Throw away unsaved edits. |
| SYM | SAVE CHANGES | Save changes | — | Save all edited rows. |
| SYM | ALL · <CATEGORY> · ENABLED · DISABLED (chips) | keep | — | Filter symbols. |
| SYM | CATEGORY | Asset class | — | Metals, FX, indices… |
| SYM | DIGITS | Price digits | — | Decimals in the price; 1 point = the last digit. |
| SYM | MARKUP | Your markup (points) | points | Extra spread the broker adds, shown as "+N" (e.g. +1.2), matching the pricing panel (owner 2026-09-29). (10 points = 1 pip) |
| SYM | COMMISSION / LOT | Commission (per lot) | per lot (account currency) | Fee per lot traded. |
| SYM | SWAP LONG | Swap long (per lot) | per lot (account currency) | Overnight fee for buy positions. |
| SYM | SWAP SHORT | Swap short (per lot) | per lot (account currency) | Overnight fee for sell positions. |
| SYM | (note under the filters) | Commission and swap are charged in each account's currency. | — | No "$" on per-lot money (owner 2026-10-01). |
| SYM | MINIMUM LOT | Min volume (lots) | lots | Smallest trade size. |
| SYM | MAXIMUM LOT | Max volume (lots) | lots | Largest trade size. |
| SYM | STEP | Volume step (lots) | lots | Size increment. |
| SYM | MAXIMUM EXPOSURE | Max lots per account (lots) | lots | The most lots one account may hold open in this symbol (buys and sells added up). |
| SYM | HEDGED MARGIN % | Hedged margin (%) | % | Margin charged on opposite positions. |
| SYM | TRADING MODE | Allowed sides | — | Both sides, buy only or sell only. |
| SYM | SESSIONS / EDIT… | Trading hours (UTC) | UTC | Cell is a plain summary: "Custom" (own sessions), "Default week" (no own sessions: the FX week, closed at weekends) or "24/7" (crypto); editing only from the row menu (Trading hours…) (owner 2026-09-29). |
| SYM | ENABLED (ON/OFF) | keep | — | Whether clients can trade it. |
| SYM | STOP LVL | Stop level (points) | points | Minimum distance of SL / TP from the price (owner 2026-09-29). (10 points = 1 pip) |
| SYM | SAVE STATUS (column) | Save status | — | Holds the Not saved chip for rows with unsaved edits (owner 2026-09-29). |
| SYM | CHANGED (chip) | Not saved | — | Row has unsaved edits. |
| SYM | Trading sessions… | Trading hours… | — | Edit the trading hours. |
| SYM | Disable (stage) / Enable (stage) | Disable / Enable (unsaved) | — | Marks the change; save to apply. |
| SYM | Revert this row | Undo changes on this row | — | Discard this row's edits. |
| SYM | HEDGED MARGIN x% ON <SYM> (dialog) | Hedged margin (%) · <symbol> | % | Confirm dialog title. |
| SYM | SAVE SYMBOL CHANGES (dialog) | Save symbol changes | — | Confirm dialog title. |
| SYM | TRADING SESSIONS · <SYM> (dialog) | Trading hours (UTC) · <symbol> | UTC | Dialog title. |
| SYM | SESSIONS (input) | Trading hours (UTC) | UTC | e.g. MON 00:00-23:59; empty = 24/7. |
| SYM | SAVE SESSIONS | Save trading hours | — | Confirm button. |

### Groups (GRP)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| GRP | 1) GRP  GROUPS | Groups | — | Client groups: pricing, leverage and handling. |
| GRP | <n> GROUPS · <n> HALTED | {n} groups · {n} trading halted | — | Group totals. |
| GRP | DESK <state> | Dealing: Manual / Automatic | — | For all clients dealing switch. |
| GRP | + GROUP | Add group | — | Create a new group. |
| GRP | NAME | keep | — | Group name. |
| GRP | ROUTING | Trade handling | — | Book, Market book or Reverse trading. |
| GRP | A-BOOK · LP | Market book (A-book) | — | Trades passed to a liquidity provider. |
| GRP | B-BOOK | Book | — | The broker keeps the client's risk. |
| GRP | DEALING DESK | Book · Manual dealing | — | Book where a dealer reviews every order. |
| GRP | REVERSAL | Reverse trading | — | Trades reversed into a master account. |
| GRP | COVERAGE · SYS | Hedge account | — | Group holding the own hedge account. |
| GRP | PRICING ("Source" / "Custom (n symbols)") | Pricing ("Source" / "Custom · n symbols") | — | Whether the group has its own spreads. Owner 2026-10-05 (broker tester): "Source" when the group uses the symbol settings, "Custom · 1 symbol" / "Custom · 5 symbols" otherwise. |
| GRP | SYMBOLS (column, new) | Symbols ("All 30" / "5 of 30") | — | How many of the broker's enabled symbols the group trades; click opens the group's pricing panel, where each row has Show (owner 2026-10-05). |
| GRP | Allowed symbols (side panel) | removed | — | Superseded by the Show column in Group pricing (owner 2026-10-05). |
| GRP | DEALER | Dealing | — | How this group's orders are filled. |
| GRP | AUTO-FILL | Automatic dealing | — | Orders fill automatically. |
| GRP | MANUAL | Manual dealing | — | Dealer reviews every order. |
| GRP | BROKER DEFAULT | Same as dealing switch | — | Follows the dealing switch. |
| GRP | · FORCED | · Forced | — | Group ignores the broker switch. |
| GRP | · MIRROR | · Copy rule | — | Group has a copy rule. |
| GRP | TRADING (BOTH SIDES / BUY ONLY / SELL ONLY) | Allowed sides | — | Which sides the group may open. |
| GRP | DEFAULT | Default group | — | New accounts join this group. |
| GRP | STATUS (TRADING / HALTED) | Status (Trading / Trading halted) | — | Whether the group can open trades. |
| GRP | Edit group… | keep | — | Change group settings. |
| GRP | Allowed symbols… | keep | — | Choose which symbols the group trades. |
| GRP | Delete group… | keep | — | Delete (only when empty). |
| GRP | Halt trading… / Resume trading… | Halt group trading… / Resume group trading… | — | Stop or restart new trades for this group. |
| GRP | Add new group… | Add group… | — | Create a new group. |
| GRP | 2) PRC  PRICING OVERRIDES | Group pricing | — | Which symbols this group trades, and its spreads, commission and swaps. |
| GRP | Group pricing column order (new) | Show · Symbol · Source spread (points) · Your markup (points) · Commission (per lot) · Swap long (per lot) · Swap short (per lot) · Set by · Client spread (points) | — | Client spread is the last column and visually emphasised: the result the group's traders get (owner 2026-10-05). |
| GRP | Show (column, new) | Show | — | Per-row toggle, first column: on = this group's traders see and trade the symbol; hidden rows are dimmed. Writes the group's allowed symbols (audited, live to terminals) (owner 2026-10-05). |
| GRP | Show all / Hide all (panel header, new) | Show all / Hide all | — | Turn Show on or off for every row; hiding every symbol is refused (owner 2026-10-05). |
| GRP | precedence text line | Who decides the client spread | — | Order: account › this group › symbol (no account-type level: D4, owner 2026-10-01). |
| GRP | (note after the precedence line) | Commission and swap are charged in each account's currency. | — | No "$" on per-lot money (owner 2026-10-01). |
| GRP | RAW + PTS | Source spread (points) | points | Spread from the price feed before your markup. (10 points = 1 pip) (owner 2026-09-29, was Market spread) |
| GRP | MODE (TARGET / MARKUP / INHERIT) + VALUE + PTS | Your markup (points) | points | ONE column (owner 2026-09-29): "+N" = spread markup, "Fixed N" = fixed spread. Shows the effective value: the symbol's value dimmed when inherited (owner 2026-10-05, was blank). |
| GRP | VALUE + PTS | merged into Your markup (points) | — | See the row above. |
| GRP | CLIENT SPREAD + PTS | Client spread (points) | points | Spread the client sees. (10 points = 1 pip) |
| GRP | SOURCE (THIS GROUP / BROKER SYMBOL) | Set by (This group / Symbol) | — | Which level decides the spread. |
| GRP | COMMISSION / LOT | Commission (per lot) | per lot (account currency) | Fee per lot. Always the effective value: dimmed when it comes from the symbol, highlighted when this group sets it; zero shows 0.00 (owner 2026-10-05). |
| GRP | SWAP LONG / SWAP SHORT | Swap long (per lot) / Swap short (per lot) | per lot (account currency) | Overnight fee per side. Always the effective value, dimmed when inherited; zero shows 0.00 (owner 2026-10-05). |
| GRP | inherits | (effective value, dimmed) | — | REPLACES the 2026-09-29 blank-cell rule (owner 2026-10-05): every pricing cell shows what the group's traders actually pay; inherited values dimmed, this group's own values highlighted; Set by names the level. |
| GRP | ACTIONS / EDIT | ⋯ (row menu) | — | Owner 2026-09-29: the per-row EDIT is replaced by the ⋯ menu (Edit pricing…, Reset to symbol pricing…). |
| GRP | Edit pricing… | keep | — | Change this symbol's pricing for the group. |
| GRP | Reset override (inherit)… | Reset to symbol pricing… | — | Remove the group's own pricing. |
| GRP | NEW GROUP / EDIT GROUP (form) | New group / Edit group | — | Form title. |
| GRP | Name | keep | — | Group name. |
| GRP | Leverage | keep | — | Written 1:N. |
| GRP | Margin call % | Margin call level (%) | % | Level that triggers the warning. |
| GRP | Stop out % | Stop-out level (%) | % | Level that auto-closes positions. |
| GRP | Book / routing | Trade handling | — | Book, Market book or Book with manual dealing. |
| GRP | Account mode (LIVE + DEMO / LIVE ONLY / DEMO ONLY) | Account kinds allowed (Live and demo / Live only / Demo only) | — | Which accounts may join. |
| GRP | Advanced dealing options | keep | — | Show the dealing override. |
| GRP | Dealer | Dealing | — | How orders fill for this group. |
| GRP | DESK-CONTROLLED (queues when the desk is on) | Same as dealing switch | — | Waits for a dealer only while Manual dealing is on. |
| GRP | NEVER QUEUE (ignores the desk) | Always automatic dealing | — | Never waits for a dealer. |
| GRP | ALWAYS QUEUE | Always manual dealing | — | Every order waits for a dealer. |
| GRP | Trading | Allowed sides | — | Which sides this group may open. |
| GRP | Max lot | Max volume (lots) | lots | Largest trade size; empty = no cap. |
| GRP | Swap-free | keep | — | No overnight fees. |
| GRP | Force dealer mode | Ignore broker dealing switch | — | Group keeps its own dealing setting. |
| GRP | Default group for new accounts | keep | — | New accounts join this group. |
| GRP | CREATE / SAVE | Create group / Save | — | Form button. |
| GRP | ALLOWED SYMBOLS · <GROUP> (form) | Allowed symbols · <group> | — | Form title. |
| GRP | Restrict to the chosen symbols | keep | — | Off = group trades every enabled symbol. |
| GRP | Symbols this group may trade | keep | — | Tick the symbols allowed. |
| GRP | HALT GROUP / RESUME GROUP (dialog) | Halt group trading / Resume group trading | — | Confirm dialog title. |
| GRP | DELETE GROUP (dialog) | Delete group | — | Confirm dialog title. |
| GRP | TENANT NAME (<x>) | Type <host> to confirm | — | Shows the exact text to type, e.g. "Type futurix.vyxtrader.com to confirm" (the broker's host) (owner 2026-09-29). |
| GRP | PRICING · <OWNER> · <SYM> (form) | Pricing · <group> · <symbol> | — | Pricing editor title. |
| GRP | Spread | Spread setting | — | Same as symbol / Spread markup / Fixed spread. |
| GRP | INHERIT (next level decides) | Same as symbol | — | The next level decides. |
| GRP | MARKUP (+ points on the raw spread) | Spread markup | points | Points added to the market spread. (10 points = 1 pip) |
| GRP | TARGET (total client spread) | Fixed spread | points | Total client spread, whatever the market spread. (10 points = 1 pip) |
| GRP | Points | Value (points) | points | 1 point = the last price digit. (10 points = 1 pip) |
| GRP | Commission per lot | Commission (per lot) | per lot (account currency) | Edit form: empty = same as symbol (the table shows the effective value, owner 2026-10-05). |
| GRP | Swap long / Swap short | Swap long (per lot) / Swap short (per lot) | per lot (account currency) | Edit form: empty = same as symbol (the table shows the effective value, owner 2026-10-05). |
| GRP | RESET PRICING OVERRIDE (dialog) | Reset to symbol pricing | — | Confirm dialog title. |
| GRP | RESET (button) | Reset | — | Confirm button. |

### Account types (ATY)

> Removed (D4, owner 2026-10-01): the group is the pricing tier; the Account types screen, its sidebar entry and every account-type picker are gone from the backoffice. An AccountType audit row opens nothing ("no related screen"). The rows below are kept as history.

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| ATY | 1) ATY  ACCOUNT TYPES | removed (D4, owner 2026-10-01) | — | Types clients choose (Standard, Raw…). |
| ATY | <n> TYPES · <n> ENABLED | removed (D4, owner 2026-10-01) | — | Totals. |
| ATY | + TYPE | removed (D4, owner 2026-10-01) | — | Create a new type. |
| ATY | NAME | removed (D4, owner 2026-10-01) | — | Type name. |
| ATY | DESCRIPTION | removed (D4, owner 2026-10-01) | — | Staff note. |
| ATY | PRICING | removed (D4, owner 2026-10-01) | — | Text shown to clients. |
| ATY | MARKUP + PTS | removed (D4, owner 2026-10-01) | points | Default markup for this type. (10 points = 1 pip) |
| ATY | COMMISSION / LOT | removed (D4, owner 2026-10-01) | $ per lot | Default commission. |
| ATY | SWAP LONG / SWAP SHORT | removed (D4, owner 2026-10-01) | $ per lot | Default swaps. |
| ATY | ORDER | removed (D4, owner 2026-10-01) | — | Position in the client's list. |
| ATY | DEFAULT | removed (D4, owner 2026-10-01) | — | Chosen for new accounts. |
| ATY | STATUS (ENABLED / DISABLED) | removed (D4, owner 2026-10-01) | — | Whether new accounts can pick it. |
| ATY | Edit… | removed (D4, owner 2026-10-01) | — | Change the type. |
| ATY | Disable… / Enable… | removed (D4, owner 2026-10-01) | — | Stop or allow new accounts on this type. |
| ATY | Add new type… | removed (D4, owner 2026-10-01) | — | Create a new type. |
| ATY | 2) PRC  PRICING OVERRIDES | removed (D4, owner 2026-10-01) | — | Per-symbol pricing for this type. |
| ATY | WHO DECIDES A CLIENT'S SPREAD… | removed (D4, owner 2026-10-01) | — | Order: account › type per symbol › type default › group › symbol. |
| ATY | RAW + PTS | removed (D4, owner 2026-10-01) | points | Spread from the price feed before your markup. (10 points = 1 pip) (owner 2026-09-29) |
| ATY | MODE + VALUE + PTS | removed (D4, owner 2026-10-01) | points | ONE column (owner 2026-09-29): "+N" = markup, "Fixed N" = fixed spread; blank = next level decides. |
| ATY | VALUE + PTS | removed (D4, owner 2026-10-01) | — | See the row above. |
| ATY | CLIENT SPREAD + PTS | removed (D4, owner 2026-10-01) | points | Spread the client sees. (10 points = 1 pip) |
| ATY | per group | removed (D4, owner 2026-10-01) | — | The client's group decides. |
| ATY | SOURCE (THIS TYPE · SYMBOL / TYPE DEFAULT / CLIENT'S GROUP) | removed (D4, owner 2026-10-01) | — | Which level decides. |
| ATY | <x> (type) / inherits | removed (D4, owner 2026-10-01) | — | Owner 2026-09-29: blank = next level decides; this type's own values are highlighted. |
| ATY | COMMISSION / LOT, SWAP LONG, SWAP SHORT (pricing) | removed (D4, owner 2026-10-01) | $ per lot | Per-symbol values. |
| ATY | Edit pricing… | removed (D4, owner 2026-10-01) | — | Change this symbol's pricing. |
| ATY | Reset override (inherit)… | removed (D4, owner 2026-10-01) | — | Remove this type's own pricing. |
| ATY | NEW ACCOUNT TYPE / EDIT ACCOUNT TYPE (form) | removed (D4, owner 2026-10-01) | — | Form title. |
| ATY | Name / Description | removed (D4, owner 2026-10-01) | — | Form fields. |
| ATY | Pricing hint | removed (D4, owner 2026-10-01) | — | Shown to clients, e.g. "spreads from 0.0 + $3.5/lot". |
| ATY | Sort order | removed (D4, owner 2026-10-01) | — | Position in the client's list. |
| ATY | Default for new accounts | removed (D4, owner 2026-10-01) | — | New accounts get this type. |
| ATY | DISABLE / ENABLE ACCOUNT TYPE (dialog) | removed (D4, owner 2026-10-01) | — | Confirm dialog title. |

### Copy rules (MIR)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| MIR | 1) MIR  MIRROR · REVERSE TRADING RULES | Copy rules | — | Copy or reverse trades from one account/group into another. |
| MIR | <n> ACTIVE OF <n> | {n} active of {m} | — | Rules running now. |
| MIR | + RULE | Add copy rule | — | Create a new copy rule. |
| MIR | SOURCE | Copied from | — | Account or group being copied. |
| MIR | DIRECTION (REVERSE / SAME) | Copy type (Reverse / Copy) | — | Same side, or opposite side. |
| MIR | TARGET ACCOUNT | Copied into | — | Account that receives the trades. |
| MIR | MULTIPLIER | Volume multiplier | — | Copied volume = original × this. |
| MIR | FILL PRICE (SOURCE PRICE / MARKET) | Fill price (Original price / Current price) | — | Price the copied trade fills at. |
| MIR | SYMBOLS | keep | — | Symbols copied; ALL = every symbol. |
| MIR | LIMITS | keep | — | Max open lots and max daily loss. |
| MIR | STATUS (ACTIVE / DISABLED / KILLED) | Status (Active / Disabled / Stopped by limit) | — | Rule state. |
| MIR | SINCE | Created (UTC) | UTC | When the rule was created. |
| MIR | ACTIONS (DISABLE / ENABLE) | ⋯ (row menu) | — | No actions column: the row menu holds Enable / Disable (owner 2026-09-30). |
| MIR | Disable… / Enable… | keep | — | Stop or start the rule. |
| MIR | Edit multiplier / fill / symbols… | Edit copy rule… | — | Change multiplier, fill price, symbols. |
| MIR | Add new mirror rule… | Add copy rule… | — | Create a new copy rule. |
| MIR | NEW MIRROR RULE / EDIT MIRROR RULE (form) | New copy rule / Edit copy rule | — | Form title. |
| MIR | Source (ONE ACCOUNT / A GROUP) | Copy from (One account / A group) | — | What is copied. |
| MIR | Source account number | Copied from account | — | When copying one account. |
| MIR | Source group | Copied from group | — | When copying a group. |
| MIR | Target account number | Copied into account | — | Account that receives trades. |
| MIR | Direction (REVERSE / COPY (SAME)) | Copy type (Reverse / Copy) | — | Opposite or same side. |
| MIR | Multiplier | Volume multiplier | — | Copied volume = original × this. |
| MIR | Fill price | keep | — | Original price or current price. |
| MIR | Symbol filter | Symbols | — | Comma-separated; empty = all. |
| MIR | Max open lots | Max open volume (lots) | lots | Empty = no cap. |
| MIR | Max daily loss | Max daily loss (<ccy>) | copied-into account currency | Rule stops after this loss, compared in the copied-into account's currency, e.g. "Max daily loss (EUR)"; empty = no cap (owner 2026-09-30). |
| MIR | CCY (column, new) | Ccy | — | The copied-into account's currency; also in the inspector (owner 2026-09-30). |
| MIR | Edit limits… | keep | — | Change max open volume and max daily loss (owner 2026-09-30). |
| MIR | COPY RULE LIMITS (form) | Copy rule limits | — | Form title (owner 2026-09-30). |
| MIR | Re-enable (stopped by limit)… | keep | — | Restart a rule its limit stopped (owner 2026-09-30). |
| MIR | RE-ENABLE STOPPED COPY RULE (dialog) | Re-enable stopped copy rule | — | Safety confirm: when it stopped, at which limits, the loss with its currency (owner 2026-09-30). |
| MIR | Created / Stopped (inspector) | Created (UTC) / Stopped (UTC) | UTC | When the rule was created / stopped by its limit (owner 2026-09-30). |
| MIR | Delete copy rule… | keep | — | Backend needed: no delete endpoint yet (docs/BACKEND-NEEDED.md); shown disabled (owner 2026-09-30). |
| MIR | DISABLE / ENABLE MIRROR RULE (dialog) | Disable / Enable copy rule | — | Confirm dialog title. |

### Risk (RISK)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RISK | OPEN EXPOSURE (KPI) | Open lots | lots | Sum of all open client volume in lots (decision D7) (owner 2026-09-30). |
| RISK | FLOATING P/L · CLIENTS (KPI) | Client floating P/L ($) | $ | Clients' profit/loss on open positions now. |
| RISK | OPEN POSITIONS (KPI) | keep | — | Open positions across all accounts. |
| RISK | ACCOUNTS AT RISK (KPI) | Accounts at margin call | — | Accounts at or below margin call level. |
| RISK | <n> AT STOP-OUT (KPI sub) | {n} at stop-out | — | Accounts at or below stop-out level. |
| RISK | 1) RISK  BROKER RISK SETTINGS | Broker risk settings | — | Dealing, limits and trading state. |
| RISK | DEALING MODE (section) | Dealing | — | Slippage rules; dealer review lives on DEAL (owner 2026-09-30). |
| RISK | Dealer review · DEAL › | keep | — | Link to the Dealing screen (the desk switch lives there) (owner 2026-09-30). |
| RISK | Smart dealer accept % | Auto-accept slippage (%) | % | Orders with less slippage fill without a dealer. |
| RISK | Smart dealer reject % | Auto-reject slippage (%) | % | Orders with more slippage are rejected without a dealer. |
| RISK | EDIT | ⋯ (settings menu) | — | No EDIT buttons: Edit auto-accept / auto-reject slippage…, Edit limits…, Clear slippage rules…, Remove limits… in the menu (owner 2026-09-30). |
| RISK | EXPOSURE & POSITION LIMITS (section) | Limits | — | For all clients caps. |
| RISK | Total exposure limit | Max open volume (lots) | lots | The most lots all clients may hold open together. |
| RISK | Max open positions / account | Max positions per account | — | Cap on open positions per account. |
| RISK | TRADING STATE (section) | Trading state | — | Open, close-only or halted. |
| RISK | Trading (OPEN / HALTED) | Trading (Open / Trading halted) | — | Whether new trades are allowed. |
| RISK | EMERGENCY | Trading halt › | — | Link beside the trading state, to the Trading halt screen (owner 2026-09-30). |
| RISK | Close-only (ON / OFF) | keep | — | Only closing allowed. |
| RISK | SMART DEALER (dialog) | Auto-accept / Auto-reject slippage | — | Dialog title. |
| RISK | ACCEPT % · REJECT % | Accept (%) · Reject (%) | % | Two labelled fields (owner 2026-09-30). |
| RISK | LIMITS (dialog) | Limits | — | Dialog title. |
| RISK | EXPOSURE USD · MAX POSITIONS | Max open volume (lots) · Max positions per account | lots | Two labelled fields; 0 = no limit (owner 2026-09-30). |
| RISK | 2) MRG  MARGIN WATCH · LOWEST FIRST | Margin | — | Accounts with positions, lowest margin level first. |
| RISK | <n> WITH POSITIONS · <n> AT RISK | {n} with positions · {n} at margin call | — | Totals. |
| RISK | FULL MARGIN SCREEN | Open Margin screen | — | Go to the full Margin screen. |
| RISK | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| RISK | EQUITY | Equity | account ccy | Balance + credit + floating P/L, in the account's own currency; see CCY (owner 2026-09-30). |
| RISK | USED MARGIN | Used margin | account ccy | Margin held by open positions, in the account's own currency; see CCY (owner 2026-09-30). |
| RISK | FREE MARGIN | Free margin | account ccy | Equity minus used margin, in the account's own currency; see CCY (owner 2026-09-30). |
| RISK | POSITIONS | keep | — | Open positions. |
| RISK | EXPOSURE | Open volume (lots) | lots | Total volume of open positions. |
| RISK | FLOATING PROFIT / LOSS | Floating P/L | account ccy | Profit/loss of open positions, in the account's own currency; see CCY (owner 2026-09-30). |
| RISK | CCY (column, new) | Ccy | — | The account's currency (narrow column; also in the inspector) (owner 2026-09-30). |
| RISK | MARGIN LEVEL | Margin level (%) | % | Equity ÷ used margin × 100. |
| RISK | STATUS (NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK) | keep | — | Where the margin level sits. |
| RISK | Open client 360 | Open client | — | Open the client's account page. |
| RISK | Live exposure · this account | Live exposure for this account | — | Open Live Exposure filtered to it. |
| RISK | Close all <n> positions… | keep | — | Close every position of the account at market; disabled for the hedge account with the reason "hedge: close from Dealing" (full text on hover) (owner 2026-09-30). |
| RISK | CLOSE ALL POSITIONS (dialog) | keep | — | Confirm dialog title. |

### Risk radar (RDR)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RDR | ACCOUNTS TRACKED (KPI) | Accounts checked | — | Accounts with trades in the last 30 days. |
| RDR | FLAGGED (KPI) | Flagged | — | Accounts with at least one pattern. |
| RDR | SCALP (KPI) | Scalping | — | Very short holding times. |
| RDR | MARTINGALE (KPI) | keep | — | Doubling volume after losses. |
| RDR | LATENCY ARB (KPI) | Latency arbitrage | — | Profits from delayed prices. |
| RDR | NEWS TRADER (KPI) | News trading | — | Trades clustered around news. |
| RDR | SAME-IP CLUSTERS (KPI) | Shared IP groups | — | Accounts signing in from the same IP. |
| RDR | TOP PROFIT / DAY (KPI) | Top profit per day ($) | $ | Highest average daily profit. |
| RDR | 1) RDR  RISK RADAR · 30-DAY BEHAVIOUR | Risk radar (30 days) | — | Trading-pattern flags over 30 days. |
| RDR | <shown> OF <total> · <n> SAME-IP | {n} of {m} · {k} shared IP | — | Totals. |
| RDR | ALL · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS | All · Flagged · Scalping · Martingale · Latency arbitrage · News trading | — | Filters. |
| RDR | ACCOUNT | keep | — | Account number. |
| RDR | FLAGS (— / LOW / MED / HIGH) | Risk score (— / Low / Medium / High) | — | How many patterns matched. |
| RDR | WHICH | Patterns | — | Which patterns matched. |
| RDR | TRADES · 30D | Trades (30 days) | — | Closed trades in 30 days. |
| RDR | WIN RATE | Win rate (%) | % | Share of trades in profit. |
| RDR | AVERAGE HOLD | Average hold time | — | Average time a position stays open. |
| RDR | AVERAGE LOT | Average volume (lots) | lots | Average trade size. |
| RDR | P/L PER DAY | Closed P/L per day ($) | $ | Average daily profit/loss. |
| RDR | Flags · stats (detail) | Show details | — | Open the detail panel. |
| RDR | Open client 360 | Open client | — | Open the client's account page. |
| RDR | Live exposure | keep | — | Open Live Exposure for this account. |
| RDR | 2) ACCT  FLAGGED ACCOUNT | Flagged account | — | Detail of the selected account. |
| RDR | score | Risk score | — | Number of matched patterns. |
| RDR | FLAGS · 30 DAYS (section) | Patterns (30 days) | — | Each pattern: flagged or clear. |
| RDR | Scalper / Martingale / Latency arbitrage / News trader | Scalping / Martingale / Latency arbitrage / News trading | — | Pattern names. |
| RDR | FLAGGED / clear | Flagged / Clear | — | Pattern result. |
| RDR | STATS (section) | Stats | — | Trade statistics. |
| RDR | profit velocity / day | Closed P/L per day ($) | $ | Average daily profit/loss. |
| RDR | avg hold / avg lot | Average hold time / Average volume (lots) | lots | Trade averages. |
| RDR | OPEN CLIENT | Open client | — | Open the client's account page. |
| RDR | EXPOSURE | Live exposure | — | Open Live Exposure for this account. |
| RDR | FLAG · WHITELIST · NOTE — not available yet | keep | — | Planned actions. |
| RDR | SAME-IP CLUSTERS · <n> | Shared IP groups · {n} | — | Accounts sharing an IP address. |
| RDR | <ip> <n> ACCOUNTS | keep | — | Accounts on that IP. |
| RDR | SELECT AN ACCOUNT | keep | — | Empty detail state. |

### Trading halt (EMG)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| EMG | 1) HALT  HALT ALL NEW TRADING | Trading halt | — | Stop all new trades for all clients. |
| EMG | status (TRADING NORMALLY / HALTED · NO NEW TRADING) | Status (Trading normally / Trading halted: no new trades) | — | For all clients trading state. |
| EMG | HALT ALL NEW TRADING | Halt all new trading | — | Refuse every new order for all clients. |
| EMG | RESUME ALL TRADING | keep | — | Allow new orders again. |
| EMG | type the tenant name to confirm | Type <host> to confirm | — | Safety check. Shows the exact text to type, e.g. "Type futurix.vyxtrader.com to confirm" (the broker's host) (owner 2026-09-29). |
| EMG | KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE — not available yet | Sign out all clients · Incident log (not available yet) | — | Planned controls. |
| EMG | 2) CLOSE-ONLY  CLOSE-ONLY MODE | Close-only | — | Clients can only close positions. |
| EMG | status (OPENS ALLOWED / CLOSE-ONLY · OPENS BLOCKED) | Status (New trades allowed / Close-only) | — | Close-only state. |
| EMG | ENABLE CLOSE-ONLY | Turn on close-only | — | Block new trades, allow closes. |
| EMG | RESUME NORMAL TRADING | keep | — | End close-only. |
| EMG | 3) GROUPS  HALT ONE GROUP | Halt a group | — | Stop new trades for one group. |
| EMG | {n} OF {m} HALTED | {n} of {m} halted | — | Groups halted. |
| EMG | GROUP (· default) | Group | — | Group name; default group marked. |
| EMG | TYPE | Trade handling | — | Book, Market book… |
| EMG | LEVERAGE | keep | — | 1:N. |
| EMG | STATUS (TRADING / CLOSE-ONLY / HALTED) | Status (Trading / Close-only / Trading halted) | — | Group state (owner 2026-09-29). |
| EMG | Set close-only… / Allow new trades again… | keep (Groups words) | — | Group close-only on or off (owner 2026-09-29). |
| EMG | SET GROUP CLOSE-ONLY / ALLOW NEW TRADES AGAIN (dialog) | Set group close-only / Allow new trades again | — | Confirm dialog title (owner 2026-09-29). |
| EMG | ACTIONS (HALT / RESUME) | ⋯ (row menu) | — | No actions column: the row menu holds Halt / Resume; double-click toggles (owner 2026-09-29). |
| EMG | Halt group… / Resume group… | Halt group trading… / Resume group trading… | — | Same words as Groups (owner 2026-09-29). |
| EMG | 4) SYMBOLS  DISABLE ONE SYMBOL | Disable a symbol | — | Stop new trades on one symbol. |
| EMG | {n} OF {m} DISABLED | {n} of {m} disabled | — | Symbols disabled. |
| EMG | search "symbol" | Search symbol | — | Search box. |
| EMG | SYMBOL | keep | — | Symbol. |
| EMG | CATEGORY | Asset class | — | Metals, FX, indices… |
| EMG | TRADING MODE (BOTH / BUY ONLY / SELL ONLY) | Allowed sides (Both sides / Buy only / Sell only) | — | Which sides can open; as on Symbols and Groups (owner 2026-09-29). |
| EMG | STATUS (ENABLED / DISABLED) | keep | — | Symbol state. |
| EMG | ACTIONS (HALT / RE-ENABLE) | ⋯ (row menu) | — | No actions column: the row menu holds Disable / Enable; double-click toggles (owner 2026-09-29). |
| EMG | Halt symbol… / Re-enable symbol… | Disable symbol… / Enable symbol… | — | Stop or restart new trades on it. |
| EMG | HALT ALL NEW TRADING / RESUME ALL TRADING (dialog) | Halt all new trading / Resume all trading | — | Confirm dialog title. |
| EMG | ENABLE CLOSE-ONLY MODE / RESUME NORMAL TRADING (dialog) | Turn on close-only / Resume normal trading | — | Confirm dialog title. |
| EMG | HALT GROUP / RESUME GROUP (dialog) | Halt group trading / Resume group trading | — | Confirm dialog title; same as Groups (owner 2026-09-29). |
| EMG | DISABLE SYMBOL / RE-ENABLE SYMBOL (dialog) | Disable symbol / Enable symbol | — | Confirm dialog title. |
| EMG | TENANT NAME (<x>) | Type <host> to confirm | — | Shows the exact text to type, e.g. "Type futurix.vyxtrader.com to confirm" (the broker's host) (owner 2026-09-29). |

### Margin (MRG)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| MRG | 1) MRG  MARGIN · LOWEST LEVEL FIRST | Margin | — | Accounts with positions, lowest margin level first. |
| MRG | <n> ACCOUNTS · <n> AT OR BELOW MARGIN CALL | {n} accounts · {k} at margin call | — | Totals. |
| MRG | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| MRG | EQUITY | Equity | account ccy | Balance + credit + floating P/L, in the account's own currency; see CCY (owner 2026-09-30). |
| MRG | USED MARGIN | Used margin | account ccy | Margin held by open positions, in the account's own currency; see CCY (owner 2026-09-30). |
| MRG | FREE MARGIN | Free margin | account ccy | Equity minus used margin, in the account's own currency; see CCY (owner 2026-09-30). |
| MRG | POSITIONS | keep | — | Open positions. |
| MRG | EXPOSURE | Open volume (lots) | lots | Total volume of open positions. |
| MRG | FLOATING PROFIT / LOSS | Floating P/L | account ccy | Profit/loss of open positions, in the account's own currency; see CCY (owner 2026-09-30). |
| MRG | CCY (column, new) | Ccy | — | The account's currency (narrow column; also in the inspector) (owner 2026-09-30). |
| MRG | MARGIN LEVEL | Margin level (%) | % | Equity ÷ used margin × 100. |
| MRG | STATUS (NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK) | keep | — | Where the margin level sits. |
| MRG | Open client 360 | Open client | — | Open the client's account page. |
| MRG | Live exposure · this account | Live exposure for this account | — | Open Live Exposure filtered to it. |
| MRG | Close all <n> positions… | keep | — | Close every position of the account; disabled for the hedge account with the reason "hedge: close from Dealing" (full text on hover) (owner 2026-09-30). |

### Liquidity providers (LP)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| LP | 1) LP  LIQUIDITY PROVIDERS | Liquidity providers | — | Provider records; none is connected until an LP bridge exists (owner 2026-09-30). |
| LP | Banner (new) | No liquidity provider is connected · every order is filled in the book (market-book groups are refused) · the status below is your record of each relationship | — | Always shown while there is no LP bridge (owner 2026-09-30). |
| LP | <n> LPS · <n> ACTIVE | {n} providers · none connected | — | Totals; a record status is not a connection, so it always reads none connected until an LP bridge exists (owner 2026-09-30). |
| LP | ROUTING | remove | — | Routing rules are merged into this screen and hidden until an LP bridge exists (owner 2026-09-30). |
| LP | Routing rules line (new) | Routing rules: hidden until an LP bridge exists ({n} saved, not used for trading) | — | Count only; "none saved" when there are none (owner 2026-09-30). |
| LP | + LP | Add liquidity provider | — | Create a provider record. |
| LP | PROVIDER | keep | — | Provider name. |
| LP | PROTOCOL | Connection type | — | FIX, REST… |
| LP | STATUS | keep | — | Prospective, negotiating or contracted; a record already set to connected shows "Connected · no bridge" (owner 2026-09-30). |
| LP | ROUTING RULES | keep | — | Rules saved for this provider; hidden by default (can be shown from Columns) while there is no LP bridge (owner 2026-09-30). |
| LP | CONTACT | keep | — | Person at the provider. |
| LP | SINCE | Added (UTC) | UTC | When the provider was added. |
| LP | Status: PROSPECTIVE / NEGOTIATING / CONTRACTED / CONNECTED | Status: Prospective / Negotiating / Contracted / Connected | — | Set the provider's status, under the STATUS menu heading; Connected is shown disabled with the reason "needs the LP bridge", the current status is disabled as "current status" (owner 2026-09-30). |
| LP | STATUS (menu heading, new) | Status | — | Heading over the status items in the row menu, right-click and inspector (owner 2026-09-30). |
| LP | Notes… | keep | — | Edit notes. |
| LP | Add new LP… | Add liquidity provider… | — | Create a provider record. |
| LP | 2) NOW  HOW ORDERS FILL TODAY (panel, new) | How orders fill today | — | One row per group: what happens to a client order today (replaces the routing screen's "how orders route today · by group") (owner 2026-09-30). |
| LP | GROUP / TRADE HANDLING / WHAT HAPPENS TO A CLIENT ORDER | Group / Trade handling / What happens to a client order | — | Columns; trade handling uses the Groups names (owner 2026-09-30). |
| LP | What happens to a client order (values) | Filled at once (book) / Queued for the dealer (desk on) / Filled at once (desk off) / Always sent to the dealer / Refused until a liquidity provider is connected / Filled at once, then copied reversed (copy rule) / System only (hedge account) | — | Only the variant for the actual desk state is shown (owner 2026-09-30). |
| LP | DEALER DESK (stat) | Dealer desk: On · reviewing orders / Off · filled at once | — | Only the actual desk state is shown (owner 2026-09-30). |
| LP | Open in Groups / Copy group name (group row menu) | keep | — | Group row menu (owner 2026-09-30). |
| LP | 2) BOOK  BOOK EXPOSURE · OPEN LOTS | Exposure by trade handling | — | Open volume in the market book vs the book; panel 3 now (owner 2026-09-30). |
| LP | A <x> / B <x> | Market book {x} lots / Book {x} lots | lots | Totals (shown as money today; should be lots). |
| LP | SYMBOL | keep | — | Symbol. |
| LP | A-BOOK LOTS | Market book (lots) | lots | Open volume passed to a liquidity provider. |
| LP | B-BOOK LOTS | Book (lots) | lots | Open volume the broker keeps. |
| LP | TOTAL | Total (lots) | lots | Both books. |
| LP | A-BOOK % | Market book (%) | % | Share of volume in the market book; hidden by default (can be shown from Columns), it reads 0 while there is no LP bridge (owner 2026-09-30). |
| LP | Live exposure · this symbol | Live exposure for this symbol | — | Open Live Exposure filtered to it. |
| LP | Symbol settings | keep | — | Open the symbol's settings. |
| LP | NEW LIQUIDITY PROVIDER (form) | New liquidity provider | — | Form title. |
| LP | Name / Protocol / Contact / Contact e-mail / Contact phone / Notes | Name / Connection type / Contact / Contact e-mail / Contact phone / Notes | — | Form fields. |
| LP | LP NOTES (form) | Liquidity provider notes | — | Form title (owner 2026-09-30). |
| LP | Connect (FIX session)… / Delete provider… (MANAGE) | keep | — | Shown disabled, backend needed; Delete provider… is last and red (owner 2026-09-30). |

### Routing rules (ROUTE)

Hidden until an LP bridge exists: the screen is merged into Liquidity providers, has no nav entry, and the rows below stay as the names to use when it returns (owner 2026-09-30).

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| ROUTE | 1) ROUTE  ROUTING RULES | Routing rules | — | Which liquidity provider gets each symbol (planned). |
| ROUTE | <n> RULES · <n> LPS | {n} rules · {n} providers | — | Totals. |
| ROUTE | + RULE | Add routing rule | — | Create a rule. |
| ROUTE | planned · not executed yet | Planned: not used for trading yet | — | Rules are saved but not applied. |
| ROUTE | PRIORITY | keep | — | 1 = checked first. |
| ROUTE | RULE | keep | — | Provider and symbol. |
| ROUTE | SYMBOL (ANY) | Symbol (Any) | — | Symbol the rule covers. |
| ROUTE | LIQUIDITY PROVIDER | keep | — | Provider and its status. |
| ROUTE | ENABLED (ON/OFF) | keep | — | Rule on or off. |
| ROUTE | Delete rule… | keep | — | Remove the rule. |
| ROUTE | Add new routing rule… | Add routing rule… | — | Create a rule. |
| ROUTE | 2) RULE  SELECTED RULE | Selected rule | — | Detail of the chosen rule. |
| ROUTE | priority / liquidity provider / LP record status / symbol / route / created | Priority / Liquidity provider / Provider status / Symbol / Trade handling / Created (UTC) | UTC | Rule details. |
| ROUTE | A-BOOK (LP) | Market book (A-book) | — | Trades go to the provider. |
| ROUTE | NOTES | keep | — | Staff notes. |
| ROUTE | CONDITIONS · EDIT / DELETE — not available yet | keep | — | Planned. |
| ROUTE | OPEN LP | Open liquidity provider | — | Go to the provider. |
| ROUTE | SELECT A RULE | keep | — | Empty detail state. |
| ROUTE | NEW ROUTING RULE (form) | New routing rule | — | Form title. |
| ROUTE | Liquidity provider / Symbol / Priority / Notes | keep | — | Form fields. |
| ROUTE | DELETE ROUTING RULE (dialog) | Delete routing rule | — | Confirm dialog title. |

### Price feed health (FEED)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| FEED | TRADING CORE (KPI) | Trading server | — | Whether the trading server answers (owner 2026-09-30). |
| FEED | GATEWAY (KPI) | Client server | — | Whether the server clients connect to answers; short so eight tiles fit at 1366, the panel keeps "Client connection server" (owner 2026-09-30). |
| FEED | PRICE ALERTS (KPI) | Price alerts | — | Whether client price alerts are running. |
| FEED | SYMBOLS TICKING (KPI) | Live symbols | — | Symbols with a price at most 15 s old; short so eight tiles fit at 1366 (owner 2026-09-30). |
| FEED | STALE · > 60 S (KPI) | Stale prices (> 15 s) | — | Symbols with no new price for over 15 seconds: the server's own rule, such a price cannot fill an order or trigger a stop-out (replaces > 60 s) (owner 2026-09-30). |
| FEED | EA → ENGINE p50 / p95 (KPI) | Price delay (ms, typical / slow) | — | Time from price source to trading server. |
| FEED | ROUND TRIP (KPI) | Round trip (ms) | ms | Time for a request to the trading server and back; short so eight tiles fit at 1366, the panel keeps "Server round trip (ms)" (owner 2026-09-30). |
| FEED | ORDER ACK p50 / p95 (KPI) | Order confirm (ms) | ms | Time to confirm an order; "typical / slow" in the note under the value; the panel keeps the full words (owner 2026-09-30). |
| FEED | 1) CORE  TRADING CORE · FEED STATS | Trading server | — | Price feed statistics on the trading server. |
| FEED | EA → engine last / p50 / p95 | Price delay (ms): last / typical / slow | ms | Delay from the price source (owner 2026-09-30). |
| FEED | p99 / max | Price delay (ms): slowest / max | ms | Slowest 1% and the largest delay (owner 2026-09-30). |
| FEED | samples | Samples | — | Prices measured. |
| FEED | ticks in | Prices received | — | Price updates received. |
| FEED | queue length | Waiting prices | — | Prices not processed yet. |
| FEED | dropped invalid / missing t0 | Rejected prices (invalid / no timestamp) | — | Price updates thrown away. |
| FEED | NATS out / publish failures | Prices sent / send failures | — | Internal price distribution. |
| FEED | candle write failures | Chart save failures | — | Chart bars that failed to save. |
| FEED | DB ok / fail (lag) | Database saves ok / failed (delay) | — | Database writes. |
| FEED | round-trip time | Server round trip (ms) | — | Request time to the server. |
| FEED | mono → UTC offset | Clock offset (ms) | — | Server clock vs UTC. |
| FEED | NO SNAPSHOT · trading core not reachable | No data (title) / trading server not reachable (reason under it) | — | Error state: title + reason in the panels, one line "No data: trading server not reachable" in the table (owner 2026-09-30). |
| FEED | 2) GW  API GATEWAY | Client connection server | — | Stats of the server clients connect to. |
| FEED | WS connections / disconnections | Client connections / disconnections | — | Live client links. |
| FEED | ticks forwarded | Prices sent to clients | — | Price updates forwarded. |
| FEED | NATS messages received | Internal messages received | — | Messages from the trading server. |
| FEED | order-ack p50 / p95 / samples | Order confirmation time (ms, typical / slow) / samples | — | Order confirmation speed. |
| FEED | NO SNAPSHOT · gateway not reachable | No data (title) / client connection server not reachable (reason under it) | — | Error state (owner 2026-09-30). |
| FEED | 3) ALERTS  PRICE-ALERT ENGINE | Price alerts | — | Client price-alert service. |
| FEED | active alerts / triggered (total) | Active alerts / Triggered (total) | — | Alert counts. |
| FEED | persist failures | Save failures | — | Alerts that failed to save. |
| FEED | hot-reload add / cancel / malformed | Alert updates: added / cancelled / invalid | — | Live alert changes. |
| FEED | 4) SYM  PER-SYMBOL FEED | Price feed per symbol | — | Price updates for each symbol. |
| FEED | <n> LIVE · <n> STALE / CORE NOT REACHABLE | {n} live · {n} stale / Trading server not reachable | — | Totals; stale = older than 15 s (owner 2026-09-30). |
| FEED | SYMBOL | keep | — | Symbol. |
| FEED | TICKS | remove | — | Updates since start: the server sends only the 60 s count, so only Updates (60 s) is shown (owner 2026-09-30). |
| FEED | 60 S | Updates (60 s) | — | Updates in the last minute. |
| FEED | LAST TICK | Last price update | — | Seconds since the last price. |
| FEED | BID / ASK | keep | — | Latest prices. |
| FEED | SOURCE | Price origin | — | Where the price comes from: MT5 (interim), or Synthetic (test) for the shadow-bot test symbols only (owner 2026-09-30). |
| FEED | FEED (LIVE / STALE) | Price feed (Live / Stale) | — | Live = a price at most 15 s old; Stale = older (the server's own rule) (owner 2026-09-30). |
| FEED | Symbol settings | keep | — | Open the symbol's settings. |
| FEED | Live exposure · this symbol | Live exposure for this symbol | — | Open Live Exposure filtered to it. |
| FEED | Price-source line (new) | Price source: the MT5 price feed (interim) · one MT5 terminal on the server sends every symbol's price · no paid or liquidity-provider feed is connected · a price older than 15 s cannot fill an order or trigger a stop-out | — | Always shown under the KPIs (owner 2026-09-30). |
| FEED | Price origin values (new) | MT5 (interim) / Synthetic (test) | — | Synthetic only for the shadow-bot tenant's test symbols (owner 2026-09-30). |
| FEED | Price alerts empty state (new) | No data (title) / price alerts not answering (reason under it) | — | Trading server up, price alerts not answering (owner 2026-09-30). |
| FEED | Symbol table empty state (new) | No prices received since the trading server started | — | Trading server up, no symbol priced yet (owner 2026-09-30). |
| FEED | Last price update (UTC) (side panel, new) | keep | UTC | When the last price arrived (owner 2026-09-30). |
| FEED | Orders (side panel, new) | can fill at this price / wait for a fresh price (older than 15 s) | — | What an order on this symbol can do now (owner 2026-09-30). |
| FEED | RESTART PRICE FEED (new) | Restart price feed | — | Shown disabled, backend needed; will later live in VyX Connect's Feed Manager (owner 2026-09-30). |
| FEED | Copy ▸ (symbol menu) | Copy: Symbol / Bid / Ask / Bid / ask | — | Row menu, right-click and side panel (owner 2026-09-30). |

### Clients (CLI)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CLI | Force sign-out (new) | Force sign-out… | — | Signs every device of the account out now; opens a confirm (step 2, backoffice 1.0.57) (owner 2026-09-30). |
| CLI | 1) CLI  CLIENTS & ACCOUNTS | Clients & accounts | — | All client accounts. |
| CLI | {n} TOTAL | keep | — | — |
| CLI | + ACCOUNT | Add account | — | Open a new client account. |
| CLI | ALL / LIVE / DEMO (chips) | keep | — | — |
| CLI | KYC WAIT | ID check waiting | — | Accounts whose ID check is waiting for review. |
| CLI | SUSPENDED | Suspended or closed | — | Accounts that are not active. |
| CLI | IB | Referred clients | — | Clients brought in by a partner (IB). |
| CLI | account · name · e-mail (search) | keep | — | — |
| CLI | ACCOUNT | keep | — | Account number. |
| CLI | CLIENT | keep | — | — |
| CLI | E-MAIL | keep | — | — |
| CLI | ACCOUNT MODE | Live / Demo | — | Live or demo account. |
| CLI | ACCOUNT TYPE | removed (D4, owner 2026-10-01) | — | — |
| CLI | COUNTRY | keep | — | — |
| CLI | KYC | ID check | — | ID check status. |
| CLI | GROUP | keep | — | — |
| CLI | LEVERAGE | keep | — | Written 1:N. |
| CLI | BALANCE | Balance ($) | $ | — |
| CLI | CREDIT | Credit ($) | $ | Bonus money the broker lends to trade with. |
| CLI | STATUS | keep | — | — |
| CLI | ACTIONS | Open | — | Click the row to open the client. |
| CLI | VERIFIED / NONE (ID check value) | Verified / Not started | — | — |
| CLI | Open client 360 | Open client | — | Open the client's account page. |
| CLI | Live exposure | keep | — | — |
| CLI | Deposits · withdrawals | Deposit & withdrawal history | — | Opens Deposits & withdrawals filtered to this account (owner 2026-10-05). |
| CLI | Wallet | Account balance | — | This client's balance, credit and equity. |
| CLI | Credit / debit… | Add / deduct funds… | — | Change the balance by hand; does not touch Credit. |
| CLI | Deposit… (new) | Deposit… | — | Record a deposit on this account; counts in the deposit totals (owner 2026-10-05). |
| CLI | Withdraw… (new) | Withdraw… | — | Record a withdrawal from this account; needs approved KYC and enough free margin (owner 2026-10-05). |
| CLI | Deposit / withdraw form: payment method | Payment method | — | Built-in first choice "Manual / Bank transfer", always available, then the broker's enabled methods (owner 2026-10-05). |
| CLI | Deposit / withdraw form: built-in method | Manual / Bank transfer | — | For brokers with no payment methods set up (owner 2026-10-05). |
| CLI | Deposit / withdraw form: reference | Reference | — | Optional, e.g. the bank reference (owner 2026-10-05). |
| CLI | Deposit / withdraw form: reason | Reason | — | Required; saved to the ledger and the audit log (owner 2026-10-05). |
| CLI | Change group… | keep | — | — |
| CLI | Leverage… | Change leverage… | — | — |
| CLI | Risk limits… | keep | — | Swap-free and max daily loss. |
| CLI | Statement CSV… | Save statement as CSV… | — | — |
| CLI | Reset trader password… | Reset client password… | — | — |
| CLI | Suspend account… | keep | — | — |
| CLI | Activate account… | keep | — | — |
| CLI | CLIENTS & ACCOUNTS (empty-area menu header) | Clients & accounts | — | — |
| CLI | Add new account… | Add account… | — | — |
| CLI | COLUMNS / Reset columns | keep | — | — |
| CLI | NEW ACCOUNT (form) | keep | — | — |
| CLI | Full name * | keep | — | — |
| CLI | E-mail * | keep | — | — |
| CLI | Mode | Live / Demo | — | — |
| CLI | Group (form) | keep | — | Sets pricing, leverage and trade handling. |
| CLI | Leverage (hint "blank = the group's own leverage") | keep; hint "blank = same as group" | — | — |
| CLI | Opening balance | Opening balance ($) | $ | Demo accounts only. |
| CLI | Country | keep | — | — |
| CLI | Phone | keep | — | — |
| CLI | Password | keep | — | Shown once after creation. |
| CLI | KYC document (optional) | ID document (optional) | — | — |
| CLI | PASSPORT / NATIONAL ID / DRIVER'S LICENCE | Passport / National ID / Driver's licence | — | — |
| CLI | Document front | keep | — | — |
| CLI | CREATE | keep | — | — |
| CLI | CREDIT / DEBIT (form) | Add / deduct funds | — | Changes the balance; not the Credit ($) bonus. |
| CLI | Direction: CREDIT (+) / DEBIT (−) | Add funds (+) / Deduct funds (−) | — | — |
| CLI | Amount * (hint USD) | Amount ($) | $ | — |
| CLI | Note * | Reason | — | Saved to the ledger and the audit log. |
| CLI | APPLY | keep | — | — |
| CLI | CHANGE GROUP (form) | keep | — | Also sets leverage to the new group's leverage. |
| CLI | MOVE | Change group | — | — |
| CLI | CHANGE LEVERAGE (form) | keep | — | — |
| CLI | hint "1:200 → 200" | keep | — | — |
| CLI | SAVE | keep | — | — |
| CLI | RISK LIMITS (form) | keep | — | — |
| CLI | Swap-free | keep | — | No overnight swap charged. |
| CLI | NO / YES / GROUP DEFAULT | No / Yes / Same as group | — | — |
| CLI | Max daily loss | Max daily loss ($) | $ | Blocks new orders once today's loss reaches it; open positions stay open. |
| CLI | RESET TRADER PASSWORD (confirm) | Reset client password | — | — |
| CLI | RESET | keep | — | — |
| CLI | PASSWORD RESET | keep | — | — |
| CLI | DONE | keep | — | — |
| CLI | SUSPEND ACCOUNT / ACTIVATE ACCOUNT (confirm) | keep | — | — |
| CLI | SUSPEND / ACTIVATE (confirm button) | keep | — | — |
| CLI | ACCOUNT CREATED | keep | — | — |

### Client page (CLI·360)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CLI·360 | 1) CLI  CLIENT | Client | — | — |
| CLI·360 | CLIENTS (breadcrumb) | ← Clients | — | Back to the list. |
| CLI·360 | CLIENT <no> · <mode> · <country> | keep | — | — |
| CLI·360 | KYC <status> (tag) | ID check <status> | — | — |
| CLI·360 | IB (tag) | Referred client | — | Brought in by a partner (IB). |
| CLI·360 | SWAP-FREE (tag) | Swap-free | — | — |
| CLI·360 | CUSTOM PRICING (tag) | keep | — | This account has its own pricing. |
| CLI·360 | Email | E-mail | — | — |
| CLI·360 | Group | keep | — | — |
| CLI·360 | Account type | removed (D4, owner 2026-10-01) | — | Not shown: the group is the tier (an account type is a label with no effect); it stays readable in the audit log only. |
| CLI·360 | Leverage | keep | — | — |
| CLI·360 | Balance | Balance ($) | $ | — |
| CLI·360 | Credit | Credit ($) | $ | Bonus money the broker lends to trade with. |
| CLI·360 | Risk score | keep | — | Score from the risk radar. |
| CLI·360 | Last IP | keep | — | IP address of the last sign-in. |
| CLI·360 | ACCOUNTS (section) | Account | — | — |
| CLI·360 | CREDIT / DEBIT | Add / deduct funds | — | Changes the balance; not the Credit ($) bonus. |
| CLI·360 | CHANGE GROUP | keep | — | — |
| CLI·360 | LEVERAGE (button) | Change leverage | — | — |
| CLI·360 | RISK LIMITS | keep | — | — |
| CLI·360 | STATEMENT CSV | Save statement as CSV | — | — |
| CLI·360 | RESET PASSWORD | keep | — | — |
| CLI·360 | SUSPEND / ACTIVATE | keep | — | — |
| CLI·360 | 2) EQ  BALANCE CURVE | Balance history ($) | $ | Balance after each transaction; not equity. |
| CLI·360 | 7D / 30D / 90D / 1Y | 7 days / 30 days / 90 days / 1 year | — | — |
| CLI·360 | <first> → <last> (stat) | <first> → <last> ($) | $ | Balance at start and end of the range. |
| CLI·360 | 3) TRD  TRADES | Positions & closed trades | — | — |
| CLI·360 | <n> OPEN · FLOATING ±x · WIN y% OF z CLOSED | <n> positions · Floating P/L ±x ($) · won y% of z closed trades | $ | — |
| CLI·360 | TICKET | Ticket # | — | — |
| CLI·360 | SYM | Symbol | — | — |
| CLI·360 | SIDE | keep | — | Buy or sell. |
| CLI·360 | LOTS | Volume (lots) | lots | — |
| CLI·360 | OPEN (column) | Open price | — | — |
| CLI·360 | CLOSE (column) | Close price | — | Current price while the position is open. |
| CLI·360 | OPENED | Opened (UTC) | UTC | — |
| CLI·360 | CLOSED | Closed (UTC) | UTC | — |
| CLI·360 | PROFIT / LOSS | P/L ($) | $ | Floating P/L for positions, closed P/L for closed trades. |
| CLI·360 | NOTE | Trade handling | — | Market book or Book; "Voided" for voided trades. |
| CLI·360 | OPEN (chip in CLOSED) | Still open | — | — |
| CLI·360 | A-BOOK / B-BOOK | Market book / Book | — | — |
| CLI·360 | VOIDED | keep | — | — |
| CLI·360 | Open in Live exposure (modify / close / reverse) | keep | — | — |
| CLI·360 | Open in Deals (replay / void / delete) | Open in Closed trades (fill details / void / delete) | — | — |
| CLI·360 | 4) LED  LEDGER | Ledger | — | Every money movement on this account. |
| CLI·360 | TIME | Time (UTC) | UTC | — |
| CLI·360 | TYPE | keep | — | — |
| CLI·360 | AMOUNT | Amount ($) | $ | — |
| CLI·360 | REASON | keep | — | — |
| CLI·360 | STATUS | keep | — | — |
| CLI·360 | Credit / Debit (ledger type) | Funds added / Funds deducted | — | Manual balance change by staff. |
| CLI·360 | Neg-bal protect | Negative balance protection | — | Balance reset to zero after going negative. |
| CLI·360 | Trade P/L | Closed P/L | $ | — |
| CLI·360 | Deposit / Withdrawal / Commission / Swap / Transfer in / Transfer out | keep | — | — |
| CLI·360 | 5) NOTE  NOTES · CRM | Notes | — | — |
| CLI·360 | CRM NOTES · NOT AVAILABLE YET | Notes not available yet | — | — |
| CLI·360 | 6) SES  SESSIONS · DEVICES · IP | Sign-in history | — | Last 50 sign-ins with IP address and device. |
| CLI·360 | LOGIN (log kind) | Sign-in | — | — |
| CLI·360 | COLUMNS / Reset columns | keep | — | — |

### Leads (CRM)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CRM | 1) CRM  LEADS · SALES | Leads | — | Prospective clients and sales follow-up. |
| CRM | <shown> SHOWN OF <total> · <n> CONVERTED | {n} shown of {m} · {k} became clients | — | Totals. |
| CRM | + LEAD | Add lead | — | Create a lead. |
| CRM | OPEN · <n> / NEW / CONTACTED / QUALIFIED / CONVERTED / LOST / ALL | Open · New · Contacted · Qualified · Became client · Lost · All | — | Status filters. |
| CRM | NAME | keep | — | Lead's name. |
| CRM | E-MAIL / PHONE / COUNTRY | keep | — | Contact details. |
| CRM | SOURCE | Came from | — | Web, referral, campaign… |
| CRM | STATUS | keep | — | Sales stage. |
| CRM | CONVERTED TO | Client account | — | Account the lead became. |
| CRM | NOTES | keep | — | Staff notes. |
| CRM | CREATED | Created | — | Age of the lead. |
| CRM | Mark NEW / CONTACTED / QUALIFIED / LOST | Mark new / contacted / qualified / lost | — | Change the sales stage. |
| CRM | Mark CONVERTED → account… | Mark as client: create account… / Mark as client: link an account… | — | Two menu items: open a new account for the lead, or link one that exists (owner 2026-09-30). |
| CRM | Assign to staff… | keep | — | Backend needed: shown disabled (owner 2026-09-30). |
| CRM | MARK <n> LEADS LOST (dialog) | Mark {n} leads lost | — | Bulk title; open leads only (owner 2026-09-30). |
| CRM | Add new lead… | Add lead… | — | Create a lead. |
| CRM | NEW LEAD (form) | New lead | — | Form title. |
| CRM | Full name / E-mail / Phone / Country / Source / Notes | Full name / E-mail / Phone / Country / Came from / Notes | — | Form fields. |
| CRM | LEAD STATUS (dialog) | Change lead status | — | Confirm dialog title. |
| CRM | CONVERT LEAD (dialog) | Mark lead as client | — | Dialog title. |
| CRM | ACCOUNT NUMBER | keep | — | The client's account number. |

### Partners (IB)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| IB | suspended: pay frozen (menu reason) | keep | — | Why Pay … owed is disabled for a suspended partner; short form of the server's "partner suspended: pay is frozen" (cut off in the menu) (owner 2026-09-30). |
| IB | 1) IB  PARTNERS · INTRODUCING BROKERS | Partners (IB) | — | Partners who refer clients for commission. |
| IB | {n} PARTNERS · {n} CLIENTS · PAYABLE {x} | {n} partners · {n} referred clients · Partner pay owed | account ccy | Totals, per currency (owner 2026-09-30). |
| IB | PAYOUT RUN | Pay all partners | — | Pay every owed partner commission. |
| IB | + PARTNER | Add partner | — | Link a partner to a client. |
| IB | ALL · PAYOUT DUE · PER LOT · PERCENTAGE | All · Owed · per lot · % of commission | — | Filters. |
| IB | INTRODUCING BROKER ACCOUNT | Partner account | — | Partner's account number. |
| IB | NAME | keep | — | Partner's name. |
| IB | COMMISSION PLAN | Partner pay plan | — | per lot or % of commission. |
| IB | CLIENTS | Referred clients | — | Clients the partner brought. |
| IB | ACTIVE | Active clients | — | Referred clients trading this month. |
| IB | LOTS · MONTH TO DATE | Volume this month (lots) | lots | Referred clients' lots this month. |
| IB | NET DEP · MTD | Net deposits this month | account ccy | Referred clients' deposits minus withdrawals; backend needed, not drawn yet (owner 2026-09-30). |
| IB | COMMISSION · MONTH TO DATE | Partner pay this month | account ccy | Earned this month; backend needed, not drawn yet (owner 2026-09-30). |
| IB | PENDING COMMISSION | Partner pay owed | account ccy | Earned and not paid yet; CCY column beside it (owner 2026-09-30). |
| IB | ACTIONS (VIEW PAY / VIEW) | ⋯ (row menu) | — | Show referred clients (Enter) · Open partner account · Copy · MONEY: Pay {x} owed… · Edit pay plan… · MANAGE: Suspend partner… (last, backend needed) (owner 2026-09-30). |
| IB | PAY <n> PARTNERS (dialog) | Pay {n} partners | — | Bulk pay title (owner 2026-09-30). |
| IB | Referred clients (detail) | Show referred clients | — | Open the detail panel. |
| IB | Pay {x} pending… | Pay {x} owed… | — | Pay the partner now. |
| IB | Edit commission plan… | Edit pay plan… | — | Change per lot or %. |
| IB | Open IB account 360 | Open partner account | — | Open the partner's account page. |
| IB | Add new partner… | Add partner… | — | Link a partner to a client. |
| IB | 2) IB  {no} · {NAME} / SELECT A PARTNER | {no} · {name} / Select a partner | — | Detail panel title. |
| IB | Owner / Plan / Referred clients / Payable now / Last payout | Owner / Pay plan / Referred clients / Partner pay owed / Last paid (UTC) | account ccy | Partner summary, with the currency (owner 2026-09-30). |
| IB | Sub-IB levels · link · schedule — NOT AVAILABLE | Sub-partners · Referral link · Pay schedule (not available yet) | — | Planned. |
| IB | FUNNEL · MTD — NOT AVAILABLE YET | Referral funnel this month (not available yet) | — | Planned. |
| IB | REFERRED CLIENTS (section) | Referred clients | — | Clients brought by the partner. |
| IB | PAY {amount} | Pay {amount} | $ | Pay everything owed. |
| IB | EDIT PLAN | Edit pay plan | — | Change per lot or %. |
| IB | CLIENT / NAME / PENDING COMMISSION / ACTIONS (PAY) | Client / Name / Partner pay owed / CCY / ⋯ (Pay {x} owed…) | account ccy | Referred-clients table (owner 2026-09-30). |
| IB | Open client {number} | keep | — | Open the client's account page. |
| IB | NEW IB RELATIONSHIP (form) | New partner link | — | Form title. |
| IB | IB account number | Partner account number | — | Partner's account. |
| IB | Referred client account number | keep | — | Client the partner brought. |
| IB | Commission (PER LOT (USD) / % OF COMMISSION) | Partner pay (per lot / % of commission) | — | How the partner is paid. |
| IB | Rate | Rate (per lot or %) | per lot / % | per lot, or % when % of commission. |
| IB | PAY IB COMMISSION / PAY PARTNER / PAYOUT RUN (dialogs) | Pay partner / Pay partner / Pay all partners | — | Confirm dialog titles. |
| IB | PAY (button) | Pay | — | Confirm button. |
| IB | EDIT PLAN (dialog) + TYPE · RATE + APPLY | Edit pay plan · Type and rate · Apply | — | Type (per lot or % of commission) and rate, e.g. 5 per lot or 40%. |

### ID checks (KYC)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| KYC | 1) KYC  VERIFICATION QUEUE | ID checks (KYC) | — | Clients waiting for identity approval. |
| KYC | NOTHING WAITING / <n> WAITING · OLDEST <age> | keep | — | Queue size and oldest wait. |
| KYC | IN-APP · <n> (tab) | In-app · {n} | — | Checks sent from the trading app. |
| KYC | CLIENT PORTAL · <n> (tab) | Client portal · {n} | — | Checks sent from the website. |
| KYC | WAITING · APPROVED · REJECTED · ALL | keep | — | Status filters. |
| KYC | ID | Account | — | The client's account number (portal checks: —); the check ID itself is in the CSV as "Check ID" (owner 2026-09-30). |
| KYC | CLIENT | keep | — | Client name. |
| KYC | COUNTRY | keep | — | Client's country. |
| KYC | LEVEL | ID check level | — | Level requested/granted. |
| KYC | DOCUMENTS | keep | — | Documents uploaded. |
| KYC | STATUS | keep | — | Waiting, approved or rejected. |
| KYC | AGE | Waiting time | — | How long it has waited. |
| KYC | ACTIONS (REVIEW) | ⋯ (row menu) | — | Review documents (Enter) · Open client · Copy · DECISION: Approve… · Reject… (last) (owner 2026-09-30). |
| KYC | Review (documents + decision) | Review documents | — | Open the documents and decide. |
| KYC | Approve… / Reject… | keep | — | Decide the ID check. |
| KYC | Open client 360 | Open client | — | Open the client's account page. |
| KYC | 2) DOC  <ACC> · <NAME> / SELECT A RECORD | Documents · <account> · <name> / Select a check | — | Detail panel title. |
| KYC | DOCUMENTS (section) · FRONT · BACK | Documents · Front · Back | — | ID images. |
| KYC | CHECKS (section) | Checks | — | Automatic checks on the documents. |
| KYC | DECISION (section) | Decision | — | Approve or reject. |
| KYC | Level to grant | ID check level to grant | — | Level given on approval. |
| KYC | APPROVE / REJECT | keep | — | Decide. |
| KYC | ALREADY <STATUS> | keep | — | Already decided. |
| KYC | SUITABILITY (section) | Suitability | — | Client's experience and finances. |
| KYC | IDENTITY (section) · ADDRESS PROOF | Identity · Proof of address | — | Portal documents. |
| KYC | NO RECORD SELECTED | keep | — | Empty detail state. |
| KYC | APPROVE KYC (dialog) | Approve ID check | — | Confirm dialog title. |
| KYC | REJECT KYC (dialog) | Reject ID check | — | Confirm dialog title. |
| KYC | REASON (SENT TO THE CLIENT) | Reason (sent to the client) | — | Why it was rejected. |

### Live account applications (LAR)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| LAR | 1) LAR  LIVE ACCOUNT REQUESTS | Live account applications (panel title) · Account applications (sidebar) | — | Clients asking for a live account; the sidebar drops "Live" to fit beside its badge (owner 2026-09-30). |
| LAR | NONE PENDING / <n> PENDING | None waiting / {n} waiting | — | Applications to decide. |
| LAR | PENDING · APPROVED · REJECTED · ALL | Waiting · Approved · Rejected · All | — | Status filters. |
| LAR | CLIENT | keep | — | Client name. |
| LAR | E-MAIL / COUNTRY / PHONE | keep | — | Contact details. |
| LAR | ACCOUNT TYPE | removed (D4, owner 2026-10-01) | — | Not shown: the group is the tier (an account type is a label with no effect); it stays readable in the audit log only. |
| LAR | STATUS | keep | — | Waiting, approved or rejected. |
| LAR | CREATED ACCOUNT | Live account | — | Account created on approval. |
| LAR | REJECTION REASON | keep | — | Reason sent to the client. |
| LAR | REQUESTED | Requested (UTC) | UTC | When the client applied. |
| LAR | ACTIONS | ⋯ (row menu) | — | DECISION: Approve and create live account… (Enter) · Reject… · then Open account · Copy (owner 2026-09-30). |
| LAR | Approve · create the live account | Approve and create live account | — | Creates the live account. |
| LAR | Reject… | keep | — | Refuse with a reason. |
| LAR | Open account <no> | keep | — | Open the created account. |
| LAR | APPROVE LIVE ACCOUNT (dialog) | Approve live account application | — | Confirm dialog title. |
| LAR | REJECT LIVE ACCOUNT REQUEST (dialog) | Reject live account application | — | Confirm dialog title. |
| LAR / KYC | REJECT <n> APPLICATIONS / REJECT <n> ID CHECKS (dialog) | Reject {n} applications / Reject {n} ID checks | — | Bulk reject titles; one reason for all; decided ones skipped (owner 2026-09-30). |
| all screens | row-menu section headings | DECISION · LEAD · MONEY · TRADING · MANAGE · ACCOUNT · SECURITY | — | A heading names what is under it: approve/reject under DECISION, lead stages under LEAD, delete/suspend under MANAGE (Delete group…, Delete copy rule…, Suspend partner…); ACCOUNT only for account actions (owner 2026-09-30). |
| LAR | REASON (SENT TO THE CLIENT) | Reason (sent to the client) | — | Why it was refused. |

### Deposits & withdrawals (DEP)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DEP | PENDING DEPOSITS (KPI) | Deposits waiting | account ccy | Deposit requests to decide; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | PENDING WITHDRAWALS (KPI) | Withdrawals waiting | account ccy | Withdrawal requests to decide; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | AWAITING 2ND ADMIN (KPI) | Needs a second admin | — | Marked withdrawals waiting for the second approval. |
| DEP | DEPOSITS · 30D (KPI) | Deposits, 30 days | account ccy | Completed deposits; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | WITHDRAWALS · 30D (KPI) | Withdrawals, 30 days | account ccy | Completed withdrawals; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | AVG TICKET · 30D (KPI) | Average Amount, 30 days | account ccy | Average request size; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | REJECTED (KPI) | Rejected | — | Rejected requests. |
| DEP | PSP COST · MTD (KPI) | Payment method fees this month | account ccy | Fees charged by payment methods; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | 1) DEP  DEPOSITS & WITHDRAWALS | Deposits & withdrawals | — | Money requests from clients. |
| DEP | NONE PENDING / <n> PENDING · <sum> USD | None waiting / {n} waiting · {x} | account ccy | Waiting total; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | PENDING · DEPOSITS · WITHDRAWALS · MARKED · COMPLETED · REJECTED · ALL | Waiting · Deposits · Withdrawals · Approved by first admin · Completed · Rejected · All | — | Filters. |
| DEP | search "account · client" | Search account or client | — | Search box. |
| DEP | CLIENT / ACCOUNT | keep | — | Client name / account number. |
| DEP | TYPE | keep | — | Deposit or withdrawal. |
| DEP | AMOUNT | Amount | account ccy | Requested amount; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | BALANCE | Balance | account ccy | Account balance now; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| DEP | STATUS | keep | — | Waiting, completed or rejected. |
| DEP | STEP | Approval step | — | Next step needed. |
| DEP | MARKED BY | Approved by (first admin) | — | First admin who approved. |
| DEP | NOTE | keep | — | Staff note. |
| DEP | CREATED | Requested (UTC) | UTC | When the client asked. |
| DEP | ACTIONS (<PRIMARY> · REJECT) | ⋯ (row menu) | — | No actions column: the row menu holds the actions (owner 2026-09-30). |
| DEP | Approve · complete the deposit | Approve deposit | — | Adds the money to the balance. |
| DEP | Mark for approval (1st admin) | Approve withdrawal (first admin)… | — | DUAL approval only: a second admin must confirm (owner 2026-09-30). |
| DEP | Confirm · complete the withdrawal (2nd admin) | Confirm withdrawal (second admin)… | — | DUAL approval only: pays out; disabled "you approved it" for the first approver (full text on hover) (owner 2026-09-30). |
| DEP | Pay out (single approval) | Approve & pay out… | — | SINGLE approval (the broker's setting, e.g. Futurix): one action that approves and pays out; no first / second admin wording anywhere on the screen (owner 2026-09-30). |
| DEP | Approval wording rule | keep | — | Two-step words (first admin, second admin, Approved by first admin, Needs a second admin) appear ONLY when the broker is on DUAL withdrawal approval (owner 2026-09-30). |
| DEP | APPROVAL STEP values | Waiting for approval · First admin approves · Second admin confirms · Approved by you · second admin needed · KYC not approved | — | DUAL shows all; SINGLE shows Waiting for approval · KYC not approved (owner 2026-09-30). |
| DEP | Open account balances | keep | — | Row menu: opens Account balances for the account (owner 2026-09-30). |
| DEP / APR | REJECT <n> REQUESTS (dialog) | Reject {n} requests | — | Bulk reject title; one note for all; decided (and your own) requests skipped (owner 2026-09-30). |
| DEP / APR / TRX / WAL | side panel figures | keep (as on screen) | — | The inspector figures for the focused row (owner 2026-09-30). |
| DEP | Cancel my mark | Cancel my approval | — | Remove your first approval. |
| DEP | Reject… | keep | — | Refuse the request. |
| DEP | Open client <acc> | keep | — | Open the client's account page. |
| DEP | header button (new) | New deposit… | — | The screen's one orange button: pick an account, then record a deposit (owner 2026-10-05). |
| DEP | header button (new) | New withdrawal… | — | Pick an account, then record a withdrawal (owner 2026-10-05). |
| DEP | account filter chip (new) | Account {account} × | — | Shown when opened from an account's Deposit & withdrawal history; × clears it (owner 2026-10-05). |
| DEP | staff-recorded row (new) | Recorded by {name} | — | The entry was recorded by staff, not requested by the client (owner 2026-10-05). |
| DEP | empty: no rows at all | No deposits or withdrawals yet | — | With the link New deposit… (owner 2026-10-05). |
| DEP | empty: Waiting filter | Nothing waiting for a decision. | — | (owner 2026-10-05) |
| DEP | empty: filters or search | No requests match these filters | — | With the link Clear filters (owner 2026-10-05). |
| DEP | empty: one account | No deposits or withdrawals for {account} yet | — | With the link New deposit… (owner 2026-10-05). |
| DEP | APPROVE DEPOSIT (dialog) | keep | — | Confirm dialog title. |
| DEP | PAY OUT WITHDRAWAL (dialog) + PAY OUT | Pay out withdrawal / Pay out | — | Single-admin payout. |
| DEP | MARK WITHDRAWAL FOR APPROVAL (dialog) + MARK | Approve withdrawal (First Admin) / Approve | — | A second admin confirms. |
| DEP | CONFIRM WITHDRAWAL (dialog) + CONFIRM | Confirm withdrawal (Second Admin) / Confirm | — | Pays out. |
| DEP | CANCEL YOUR MARK (dialog) + CANCEL MARK | Cancel your approval / Cancel approval | — | Removes your first approval. |
| DEP | REJECT REQUEST (dialog) | keep | — | Confirm dialog title. |
| DEP | NOTE (OPTIONAL) | Note (optional) | — | Reason for rejecting. |

### Approvals (APR)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| APR | 1) BAL  BALANCE ADJUSTMENTS · AWAITING A SECOND ADMIN | Balance changes needing a second admin | — | Add/deduct funds requests to approve. |
| APR | <n> PENDING · <±sum> | {n} waiting · {x} | account ccy | Waiting total; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| APR | PENDING · ALL | Waiting · All | — | Filters both panels. |
| APR | REQUESTED | Requested (UTC) | UTC | When it was requested. |
| APR | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| APR | AMOUNT | Amount | account ccy | + adds funds, − deducts funds; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| APR | BALANCE NOW | Balance now | account ccy | Account balance before the change; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| APR | NOTE | keep | — | Requester's note. |
| APR | REQUESTED BY ( (you) ) | keep | — | Staff who asked. |
| APR | STATUS (PENDING / APPROVED / REJECTED) | Status (Waiting / Approved / Rejected) | — | Request state. |
| APR | REVIEW | Review note | — | Second admin's note. |
| APR | ACTIONS (APPROVE · REJECT / AWAITING OTHER ADMIN) | ⋯ (row menu) | — | Approve… / Reject…; on your own request both disabled with "your own request: another admin decides" and the row shows "(you)" (owner 2026-09-30). |
| APR | Approve… / Reject… | keep | — | Decide the request. |
| APR | Open client <acc> | keep | — | Open the client's account page. |
| APR | 2) POS  POSITION ACTIONS · DELETE / VOID / REVERSE | Position changes needing a second admin | — | Delete / void / reverse requests. |
| APR | <n> PENDING | {n} waiting | — | Waiting count. |
| APR | ACTION (DELETE / VOID / REVERSE) | keep | — | What was requested. |
| APR | TICKET | Ticket # | — | Position/trade number. |
| APR | POSITION | keep | — | Symbol, side, volume. |
| APR | REASON | keep | — | Why it was requested. |
| APR | APPROVE / REJECT <kind> (dialog) | Approve / Reject <kind> | — | Confirm dialog titles. |
| APR | REVIEW NOTE | keep | — | Note kept in the audit log. |

### Payment methods (PSP)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| PSP | 1) PSP  PAYMENT METHODS | Payment methods | — | How clients deposit and withdraw. |
| PSP | <n> OF 5 ENABLED · <n> UNSAVED | {n} of 5 enabled · {n} not saved | — | Totals. |
| PSP | METHOD (USDT · TRC20 / USDT · BEP20 / BTC / ETH / BANK TRANSFER) | Payment method | — | Method name. |
| PSP | ENABLED (ON/OFF) | keep | — | Clients can use it. |
| PSP | MINIMUM | Minimum (USD) | broker currency | Smallest amount allowed; the code is the broker's currency (Broker.defaultAccountCurrency), none when unknown (owner 2026-10-01). |
| PSP | MAXIMUM | Maximum (USD) | broker currency | Largest amount allowed; the broker's currency code, as on CFG (owner 2026-10-01). |
| PSP | FEE % | Fee (%) | % | Percentage fee. |
| PSP | FEE FIXED | Fixed fee (USD) | broker currency | Flat fee per request; the broker's currency code, as on CFG (owner 2026-10-01). |
| PSP | WALLET ADDRESS | keep | — | Where clients send crypto. |
| PSP | INSTRUCTIONS | keep | — | Text shown to clients. |
| PSP | (blank) CHANGED / DEFAULTS | Not saved / Default | — | Row state. |
| PSP | ACTIONS (SAVE) | Actions (Save) | — | Save this row. |
| PSP | Save this row… | keep | — | Save the edits. |
| PSP | Revert this row | Undo changes on this row | — | Discard edits. |
| PSP | Disable (stage) / Enable (stage) | Disable / Enable (unsaved) | — | Marks the change; save to apply. |
| PSP | SAVE PAYMENT METHOD (dialog) | keep | — | Confirm dialog title. |

### Internal transfers (TRX)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| TRX | 1) TRX  INTERNAL TRANSFER | Internal transfer | — | Move money between two accounts. |
| TRX | FROM | From account | — | Account the money leaves. |
| TRX | TO | To account | — | Account the money goes to. |
| TRX | AMOUNT | Amount | account ccy | Money to move; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| TRX | NOTE | keep | — | Kept in the audit log. |
| TRX | PREVIEW | keep | — | Show balances before and after. |
| TRX | TRANSFER | keep | — | Move the money. |
| TRX | ready · TRANSFER to confirm | Ready: press Transfer to confirm | — | Preview passed. |
| TRX | 2) HIST  TRANSFER HISTORY · LAST 200 | Transfer history (last 200) | — | Past transfers. |
| TRX | <n> LEGS | {n} entries | — | One entry per account side. |
| TRX | WHEN | When (UTC) | UTC | Time of the transfer. |
| TRX | ACCOUNT | keep | — | Account number. |
| TRX | TYPE (OUT / IN) | Direction (Out / In) | — | Money left or arrived. |
| TRX | AMOUNT | Amount | account ccy | Money moved; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| TRX | Open client 360 | Open client | — | Open the client's account page. |
| TRX | Use as FROM account / Use as TO account | Use as From account / Use as To account | — | Fill the form. |
| TRX | INTERNAL TRANSFER (dialog) | keep | — | Confirm dialog title. |

### Account balances (WAL)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| WAL | 1) WAL  WALLETS · ACCOUNT BALANCES | Account balances | — | Money on every account. |
| WAL | <n> ACCOUNTS · LIVE BALANCE <x> · CREDIT <x> · EQUITY <x> | {n} accounts · Live balance · Credit · Equity | account ccy | Totals; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | ALL · LIVE · DEMO · WITH CREDIT · NEGATIVE | All · Live · Demo · With credit · Negative balance | — | Filters. |
| WAL | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| WAL | ACCOUNT MODE (LIVE/DEMO) | Live / Demo | — | Account kind. |
| WAL | CURRENCY | keep | — | Account currency. |
| WAL | BALANCE | Balance | account ccy | Deposited money; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | CREDIT | Credit | account ccy | Bonus money lent to trade with; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | EQUITY | Equity | account ccy | Balance + credit + floating P/L; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | FREE MARGIN | Free margin | account ccy | Equity minus used margin; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | FLOATING PROFIT / LOSS | Floating P/L | account ccy | Profit/loss of open positions; in the account's currency, CCY column beside it, totals per currency (owner 2026-09-30). |
| WAL | STATUS | keep | — | Account state. |
| WAL | Open client 360 (credit / debit · leverage · risk limits) | Open client (funds, leverage, limits) | — | Open the client's account page. |
| WAL | Live exposure | keep | — | Open Live Exposure for this account. |
| WAL | Deposits · withdrawals | Deposits & withdrawals | — | Open this account's requests. |
| WAL | Internal transfer | keep | — | Open the transfer form. |

### Staff (USR)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| USR | 1) USR  STAFF · ROLES | Staff | — | Back-office users and roles. |
| USR | {n} USERS · 3 ROLES | {n} staff · 3 roles | — | Totals. |
| USR | + INVITE | Add staff | — | Create a staff login. |
| USR | USER ( (you) ) | Staff | — | Staff e-mail. |
| USR | ROLE | keep | — | Admin, manager or support. |
| USR | LAST ACTIVE | Last active (UTC) | UTC | Last sign-in. |
| USR | STATUS (ACTIVE / DISABLED) | keep | — | Can sign in or not. |
| USR | ACTIONS (LOCKED / EDIT DISABLE / EDIT ACTIVATE) | remove | — | No per-row links: the staff menu (row ⋯, right-click, side panel) holds these actions (owner 2026-09-30). |
| USR | Edit… | keep | — | Open the staff editor. |
| USR | Disable access… / Re-activate… | keep | — | Block or restore sign-in. |
| USR | Invite a team member… | Add staff… | — | Create a staff login. |
| USR | 2) PERM  ROLE MATRIX | Permissions | — | What each role can do. |
| USR | SELECT A MANAGER TO DELEGATE / CLICK A CELL IN {NAME} TO STAGE / {ROLE} · NOTHING TO DELEGATE | Select a manager to give extra permissions / Click a cell to change / Nothing to give | — | Hint. |
| USR | SAVE / REVERT | Save / Undo | — | Save or discard permission changes. |
| USR | PERMISSION / ADMIN / MANAGER / SUPPORT | keep | — | Matrix columns. |
| USR | KYC review | ID check review | — | Permission. |
| USR | Risk settings / Emergency controls / Internal transfers | Risk settings / Trading halt / Internal transfers | — | Permissions. |
| USR | Funds approval | Deposit & withdrawal approval | — | Permission. |
| USR | IB payouts | Partner payouts | — | Permission. |
| USR | Account finance | Add / deduct funds | — | Permission; the side panel adds "(also leverage and account status)" on the line under it, the matrix shows the short name (owner 2026-09-30). |
| USR | Reverse mirror rules | Copy rules | — | Permission. |
| USR | 3) EDIT  STAFF MEMBER | Edit staff | — | Staff editor. |
| USR | BACK TO CFG | Back to Broker settings | — | Return to Broker settings. |
| USR | e-mail · role · status · last sign-in · created · 2FA · devices · IPs | E-mail · Role · Status · Last sign-in (UTC) · Created (UTC) · Two-step sign-in (2FA) · Devices · IP addresses | UTC | Staff details. |
| USR | DELEGATED PERMISSIONS | Extra permissions | — | Permissions given to this manager. |
| USR | SAVE PERMISSIONS / REVERT | Save permissions / Undo | — | Buttons. |
| USR | ADMIN · FULL ACCESS / SUPPORT · NONE DELEGABLE | Admin: full access / Support: no extra permissions | — | Role notes. |
| USR | ACCESS (section) | Access | — | Disable or restore sign-in. |
| USR | DISABLE ACCESS / RE-ACTIVATE | Disable access / Re-activate | — | Buttons. |
| USR | PASSWORD RESET · ROLE CHANGE — not available yet | keep | — | Planned. |
| USR | 3) INVITE  ADD STAFF | 3) ADD  Add staff | — | New staff form (owner 2026-09-30). |
| USR | NEW STAFF MEMBER (section) | New staff | — | Form section. |
| USR | e-mail / ROLE (ADMIN · MANAGER · SUPPORT) | E-mail / Role (Admin · Manager · Support) | — | Form fields. |
| USR | CREATE / CANCEL | Create / Cancel | — | Form buttons. |
| USR | DELEGATE PERMISSIONS (dialog) | Give extra permissions | — | Confirm dialog title. |
| USR | Can edit pricing (permission) | Pricing | — | Permission: spread, commission, swap, hedged margin; matrix, side panel, CSV (owner 2026-09-30). |
| USR | Can trade on client accounts (permission) | Trade on client accounts | — | Permission: close, bulk close, SL/TP, open for a client (owner 2026-09-30). |
| USR | INITIAL PASSWORD · SHOWN ONCE (dialog) | FIRST PASSWORD (SHOWN ONCE) | — | Dialog title, like NTF's NEW PASSWORD (SHOWN ONCE) (owner 2026-09-30). |
| USR | 2FA (column, new) | 2FA: Set up / At next sign-in | — | Whether the staff member's two-step sign-in is set up (owner 2026-09-30). |
| USR | ROLE / SECURITY / ACCESS (menu headings, new) | keep | — | Headings over the role items, the password / 2FA / sign-out items, and Re-activate / Disable (owner 2026-09-30). |
| USR | Reset two-step sign-in (2FA)… / Sign out everywhere… (new) | keep | — | Shown disabled, backend needed (owner 2026-09-30). |
| USR | RE-ACTIVATE SELECTED… / DISABLE SELECTED… (selection bar, new) | keep | — | Disable is red, last, a typed confirm; you, those already in that state and the last active admin are skipped (owner 2026-09-30). |
| USR | Disabled-item reasons (new) | your own row / the broker must keep one active admin / current role / your own: change it in Security | — | The server's rules, mirrored (owner 2026-09-30). |
| USR | DISABLE STAFF ACCESS / RE-ACTIVATE STAFF ACCESS (dialog) | Disable staff access / Re-activate staff access | — | Confirm dialog titles. |
| USR | ADD STAFF MEMBER (dialog) | Add staff | — | Confirm dialog title. |
| USR | INITIAL PASSWORD · SHOWN ONCE | First password (Shown Once) | — | Copy it now; it cannot be shown again. |

### Audit log (AUD)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| AUD | 1) AUD  AUDIT LOG | Audit log | — | Every staff and system change. |
| AUD | {n} ENTRIES | {n} entries | — | Entries shown. |
| AUD | SAVE CSV | Save as CSV | — | Download the log. |
| AUD | search | Search | — | Search the log. |
| AUD | WHEN | When (UTC) | UTC | Time of the change. |
| AUD | ACTOR | Done by | — | Staff or system that made the change. |
| AUD | ACTION | keep | — | What was done. |
| AUD | ENTITY | Record type | — | Kind of record changed; hidden by default so the table fits at 1366 (in Columns and the side panel) (owner 2026-09-30). |
| AUD | ORDER | Ticket # | — | Related order, if any. |
| AUD | ACCOUNT | keep | — | Related account: the order's, else the record's own account number (an account, or a position / order / transaction label ending in its account) (owner 2026-09-30). |
| AUD | FIELDS CHANGED | keep | — | Number of values changed; hidden by default so the table fits at 1366 (owner 2026-09-30). |
| AUD | Before → after (detail) | Show changes | — | Open the before/after panel (menu, right-click, side panel) (owner 2026-09-30). |
| AUD | Open the record | Open {record} | — | One label naming the record (Open client, Open closed trade, Open Liquidity providers …); "Open the record" only as the disabled item with "no related screen" (owner 2026-09-30). |
| AUD | Open client | keep | — | Open the related client. |
| AUD | 2) DIFF  BEFORE → AFTER | Changes | — | Panel title CHANGES; values before and after as the server recorded them (no money format / CCY) (owner 2026-09-30). |
| AUD | actor · action · entity · record · order · when | Done by · Action · Record type · Record · Ticket # · When (UTC) | UTC | Entry details. |
| AUD | CHANGES (section) · (removed) | Changes · (removed) | — | Each changed value. |
| AUD | OPEN {CODE} | Open {record} | — | Same label as the menu item (owner 2026-09-30). |
| AUD | SELECT AN ENTRY / NO FIELD CHANGES RECORDED | keep | — | Empty states. |
| AUD | Done by: no staff member (new) | System | — | The server's "system": an automatic change or a client's own action (the server does not tell them apart yet) (owner 2026-09-30). |
| AUD | Done by: direct database change (new) | Direct database change | — | An owner-approved direct database write (no staff member, a source text); also a DIRECT DATABASE CHANGE tag (owner 2026-09-30). |
| AUD | SOURCE (side panel section, new) | Source | — | The full source text of a direct database change (owner 2026-09-30). |
| AUD | Empty value in Changes (new) | (blank: inherits) / (empty) | — | The server's null ("-"): (blank: inherits) for an inheritable setting (swapFree, spreadMarkup, targetTotalSpreadPips, commissionPerLot, swapLong, swapShort), (empty) otherwise; same in the CSV (owner 2026-09-30). |
| AUD | no related screen (reason, new) | keep | — | Why Open the record is disabled (owner 2026-09-30). |
| AUD | Copy ▸ (new) | Copy: Record / Ticket # / Account / Changes / Entry ID | — | Row menu, right-click, side panel (owner 2026-09-30). |

### Security (SEC)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SEC | 1) ME  THIS SIGN-IN | This sign-in | — | Your current session. |
| SEC | signed in as | keep | — | Your e-mail. |
| SEC | role | keep | — | Your role. |
| SEC | tenant | Web address | — | The host you are signed in to (owner 2026-09-30). |
| SEC | broker | Company | — | The firm's name (owner D3 2026-10-05). |
| SEC | since | Signed in (UTC) | UTC | When you signed in. |
| SEC | 2FA challenged this sign-in (YES · AUTHENTICATOR CODE / NO) | Two-step sign-in used (Yes / No) | — | Whether a code was asked. |
| SEC | finance rights (YES/NO) | Can approve money (Yes / No) | — | Deposit/withdrawal/fund rights. |
| SEC | session (COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY) | Session (ends on sign-out or timeout) | — | How the session ends. |
| SEC | REQUEST PASSWORD RESET | keep | — | Ask an admin to reset your password. |
| SEC | SIGN OUT | keep | — | End this session. |
| SEC | 2) SEC  ACCOUNT SECURITY | Account security | — | Sign-in protection. |
| SEC | TWO-FACTOR (Enrolment; Enrol · reset · backup codes) | Two-step sign-in (2FA) (Set up; reset; backup codes) | — | Authenticator codes. |
| SEC | PASSKEYS · HARDWARE KEYS (Registered keys) | Passkeys & security keys | — | Not available yet. |
| SEC | ACTIVE SESSIONS (Other devices; Sign out everywhere) | keep | — | Your devices as a table: DEVICE / IP ADDRESS / SIGNED IN (UTC); menu Copy, Sign out this device… (not this device); SIGN OUT SELECTED… (owner 2026-09-30). |
| SEC | API KEYS (Personal tokens) | keep | — | Not available yet. |
| SEC | IP ALLOWLIST (Allowed addresses) | Allowed IP addresses | — | Not available yet. |
| SEC | ORG POLICY (Staff 2FA mandatory; Session timeout; Password rotation) | Staff policy (Two-step sign-in required; session timeout; password change interval) | — | Not available yet. |
| SEC | REQUEST PASSWORD RESET (dialog) | keep | — | Confirm dialog title. |
| SEC | NOTE FOR STAFF (optional) / REQUEST | Note for staff (optional) / Send request | — | Dialog input and button. |

### Broker settings (CFG)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CFG | 1) TENANT  THIS BROKER | This company | — | The firm's record (owner D3 2026-10-05). |
| CFG | Broker / Host / Subdomain / Custom domain | Broker / Web address / Subdomain / Custom domain | — | Where the broker is reached. |
| CFG | Tier | Plan | — | Broker's platform plan. |
| CFG | Status | keep | — | Active or not. |
| CFG | Default account currency | keep | — | Currency for new accounts. |
| CFG | Default account leverage | keep | — | Leverage for new accounts (1:N). |
| CFG | SIGNED IN (section): Admin · Role · Unread notifications · Finance rights | Signed In: Staff · Role · Unread notifications · Can approve money | — | Your session. |
| CFG | 3) CFG  BROKER SETTINGS | Broker settings | — | Defaults for new accounts. |
| CFG | SAVE | Save settings | — | Save changes. |
| CFG | TRADING (section) | Trading | — | Trading defaults. |
| CFG | Default leverage | keep | — | 1:N for new accounts. |
| CFG | Margin call (PER GROUP · GRP) | Margin call level (%) (set per group) | % | Set on the Groups screen. |
| CFG | Stop-out (PER GROUP · GRP) | Stop-out level (%) (set per group) | % | Set on the Groups screen. |
| CFG | Negative balance protection | keep | — | Not available yet. |
| CFG | Hedging allowed | keep | — | Not available yet. |
| CFG | Max slippage | Max slippage (points) | points | The broker's cap, edited on DEAL; "unlimited" when none is set. |
| CFG | FUNDING (section) | Deposits & withdrawals | — | Money defaults. |
| CFG | Min deposit (PER METHOD · PSP) | Min deposit ({CCY}) (set per payment method) | broker currency | Money labels carry the broker's own currency code (Broker.defaultAccountCurrency), e.g. "Min deposit (USD)"; no suffix when unknown; never "($)" (owner 2026-09-30). |
| CFG | Withdrawal auto-approve ≤ | Auto-approve withdrawals up to ({CCY}) | broker currency | Not available yet (owner 2026-09-30). |
| CFG | Require KYC L1 to deposit | Require ID check level 1 to deposit | — | Not available yet. |
| CFG | Require KYC L2 above | Require ID check level 2 above ({CCY}) | broker currency | Not available yet (owner 2026-09-30). |
| CFG | BRANDING · TENANT (section): Broker · Domain · Tier · status · Accent · Terminal theme · Desktop build | Branding: Accent colour · Terminal theme · Backoffice app version (Broker · Domain · Plan · Status only on the Staff page's panel; the CFG screen shows them once, in THIS BROKER) | — | No duplicate rows; the version is this backoffice app's own release version, "development build" for an unreleased build (owner 2026-09-30). |
| CFG | SECURITY (section): Staff 2FA mandatory · Session timeout · Audit retention | Security: Two-step sign-in required · Session timeout · Audit log kept for | — | Not available yet. |
| CFG | note "Default leverage and currency…" | keep | — | Only new accounts get these defaults. |
| CFG | SETTINGS UNAVAILABLE / LOADING SETTINGS… | keep | — | Error / loading states. |
| CFG | WITHDRAWAL APPROVAL · <x> (dialog) / SWITCH TO <x> | Withdrawal approval · <x> / Switch to <x> | — | One-admin or two-admin payouts. |
| CFG | SAVE BROKER SETTINGS (dialog) | keep | — | Confirm dialog title. |

### Backoffice 1.0.61 additions (owner 2026-10-05)

| Screen | Was | Label | Unit | Notes |
|---|---|---|---|---|
| CLI | Deposit… / Withdraw… (Account menu, two items) | Deposit / Withdraw… | — | One item; opens one window with tabs DEPOSIT · WITHDRAW. "Deposit & withdrawal history" stays as it is (owner 2026-10-05). |
| CLI | (window tabs, new) | DEPOSIT · WITHDRAW | — | The window opens on the tab of the action the user chose. |
| DEP | NEW DEPOSIT… · NEW WITHDRAWAL… (header, two buttons) | NEW DEPOSIT / WITHDRAWAL… | — | One button; opens the account picker, then the same window (owner 2026-10-05). |
| CLI | Withdraw: ID check not approved (status bar only) | Withdrawals need an approved ID check | — | Shown inside the WITHDRAW tab with the submit button disabled; never only in the status bar (owner 2026-10-05, rule: every refusal shows where the user clicked). |
| CLI | (link, new) | Open ID check | — | Next to the line above; opens the client's ID check. |
| CLI | (action, new) | Resend verification e-mail | — | Client-portal login whose e-mail is not verified; Account menu and the client page. Hidden when there is no portal login or it is verified (owner 2026-10-05). |
| CLI | (result, new) | Verification e-mail sent to z***@gmail.com | — | Toast after a send. |
| CLI | (refusals, new) | Already verified · This client is not active · E-mail is not set up for this broker · Too many resends for this client, try again in an hour · The e-mail could not be sent: <reason> | — | Shown in the action's own dialog or as the disabled item's reason, never only in the status bar. |
| CLI | NEW PASSWORD / password shown once (dialogs: Reset client password, Add account, staff first password) | Sign-in details | — | Details card (owner 2026-10-05): rows Account · Name · Group · Live / Demo · Server · Web login · Password (masked, Show); a copy icon on every row. |
| CLI | (buttons, new) | COPY ALL DETAILS · E-MAIL TO CLIENT · DONE | — | No CANCEL: the change has already happened. E-MAIL TO CLIENT is enabled only when the broker's e-mail works. |
| CLI | It was NOT e-mailed (e-mail is not set up for this broker, or sending failed) | Not e-mailed: <reason> | — | One line; the reason names which (e-mail off for this broker / the provider's error). |
| CLI | (copy block, new) | Account: … / Name: … / Group: … (Live) / Server: … / Web login: … / Password: … | — | What COPY ALL DETAILS puts on the clipboard, one item per line, ready to paste to the client. |
| SHELL | UPDATE vX READY · click to restart (before sign-in) | Updating to vX · restarting | — | Before sign-in a downloaded update installs and restarts on its own (owner 2026-10-05). |
| SHELL | UPDATE vX READY (signed in) | Update vX installs when you close | — | Signed in: never interrupts; "Restart now" stays in the cell's menu (owner 2026-10-05). |
| FEED | (row, new) | Caddy | — | The VPS web server in front of the feed. States: OK · FAIL (with the reasons) · No report for 15 min (the check itself is not running) (owner 2026-10-05). |
| FEED | (sub-labels, new) | Last check (UTC) · Reasons | — | Under the Caddy row. |
| CLI | (password card title) | PASSWORD RESET | — | The card after Reset password / Set password (owner 2026-10-05). |
| CLI | (e-mailed line) | ✓ New password sent to <email> | — | One line when the e-mail went out. |
| CLI | (reveal button) | SHOW PASSWORD | — | Shows the masked password; each reveal is on the audit log (Password revealed). |
| CLI | (not e-mailed lines) | Not e-mailed: e-mail is unavailable · Internal account: not e-mailed · No e-mail address on this account | — | One line each; the password is on the card either way. |
| CLI | (action, new) | Set password… | — | Staff choose the client's password (owner 2026-10-05). |
| CLI | (Set password form) | New password · E-mail it to the client · SET PASSWORD | — | The e-mail switch is off and locked on an internal account. |
| CLI | (weak password) | Use at least 8 characters with letters and digits. | — | The form's refusal (code WEAK_PASSWORD). |
| CLI | (flag, new) | Internal account | — | A broker's own test / staff account: left out of the dashboard, risk radar, reports and the exposure limit; never e-mailed credentials. BROKER_ADMIN only (owner 2026-10-05). |
| CLI | (menu items, new) | Mark as internal account · Unmark internal account | — | Account menu, ACCOUNT section. |
| AUD | PASSWORD_REVEALED | Password revealed | — | Who clicked SHOW PASSWORD on whose account, and when. |
| AUD | ACCOUNT_PASSWORD_SET · ACCOUNT_INTERNAL_FLAG_CHANGED · STAFF_VERIFICATION_RESENT | Set trader password · Changed internal account flag · Resent verification e-mail | — | Audit log wording (owner 2026-10-05). |
| SHELL | VYXTRADER BACKOFFICE (login window of a broker build) | <BROKER> BACKOFFICE | — | Login window title, logo, colours and window title come from the build's brand pin before sign-in (owner 2026-10-05); same for the terminal login. |

## Terminal

### Shell (term-shell)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·shell | panel splitter (tooltip) | Drag to resize · double-click to reset | — | Sizes are saved per account; the Workspace tab's note: "Drag a line between panels to resize it; double-click the line to put that one back. Sizes are saved for this account." (owner 2026-09-30) |
| T·shell | FUTURIX (brand text) | keep | — | Your broker's name. |
| T·shell | `FXG> {SYMBOL} {description}` (command line) | {SYMBOL} · {description} | — | Current chart symbol; click or press F2 to search symbols. |
| T·shell | Symbol search (F2) (tooltip) | keep | — | Opens symbol search. |
| T·shell | PRO \| BASIC (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·shell | DES desc / MW watch / OT ticket / POS positions / NEWS feed (fixture) | remove | — | Placeholder tags, not shown after sign-in. |
| T·shell | ACCOUNT | Account | — | Account number and whether it is Live or Demo. |
| T·shell | {number} {mode} | keep | — | Account number · Live / Demo. |
| T·shell | EQUITY USD | Equity ($) | $ | Balance + credit + floating P/L. |
| T·shell | MARGIN LVL | Margin level (%) | % | Equity ÷ used margin × 100; "—" when no positions are open. |
| T·shell | THEME ☀ LIGHT / ☾ DARK | Light theme / Dark theme | — | Switch light or dark colours. |
| T·shell | USER ▾ | keep (shows name) | — | Account menu: switch account or sign out. |
| T·shell | {NAME} · {ACCOUNT} {MODE} (menu header) | keep | — | Who is signed in. |
| T·shell | Switch account… | keep | — | Go back to sign-in; the saved password is kept. |
| T·shell | Sign out | keep | — | Sign out; the saved password is kept. |
| T·shell | Sign out and forget this computer | keep | — | Sign out and delete the saved password from this PC. |
| T·shell | SWITCH ACCOUNT (confirm title) | Switch account | — | Confirms going back to sign-in. |
| T·shell | SWITCH (confirm button) | Switch account | — | — |
| T·shell | SIGN OUT (confirm title / button) | Sign out | — | Confirms sign-out. |
| T·shell | SIGN OUT AND FORGET (confirm title) | Sign out and forget this computer | — | Confirms sign-out and deleting the saved password. |
| T·shell | TAPE | Prices | — | Moving strip of prices; click a symbol to chart it. |
| T·shell | `SYMBOL price ±x.xx%` (tape cell) | keep | % | Current price and change since the day opened. |
| T·shell | {Broker} · Live\|Demo · {ping}MS | {Broker} · Live\|Demo · {ping} ms | — | Price feed connection and delay to the server. |
| T·shell | HH:mm:ss UTC | keep | UTC | Server clock. |
| T·shell | {open sessions} / NO SESSION | Open markets: {sessions} / Markets closed | — | Trading sessions open right now. |
| T·shell | downloading vX… n% | Downloading update vX… n% | % | New version downloading. |
| T·shell | UPDATE vX READY · click to restart | Update vX ready · click to restart | — | Restart to install the new version. |
| T·shell | F1 HELP | Help (F1) | — | Opens help. |
| T·shell | F2 WATCH | Symbol search (F2) | — | Search and open a symbol. |
| T·shell | F3 CHART | Chart (F3) | — | Focus the chart. |
| T·shell | F4 TICKET | Order ticket (F4) | — | Focus the order ticket volume box. |
| T·shell | F5 POSITIONS | Positions (F5) | — | Show open positions. |
| T·shell | F6 NEWS | Calendar & news (F6) | — | Show the economic calendar. |
| T·shell | F7 ACCOUNT | Account (F7) | — | Show the account panel. |
| T·shell | F8 ALERTS | Price alerts (F8) | — | Open price alerts. |
| T·shell | F9 NEW ORDER | New order (F9) | — | Open the new order window. |
| T·shell | F9 BOTS (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·shell | F10 REPORTS | Statement (F10) | — | Trade history and statement. |
| T·shell | F11 LAYOUT | Chart layout (F11) | — | Switch single chart / 2×2 grid. |
| T·shell | F12 SETTINGS | Settings (F12) | — | Open settings. |

### Market Watch (term-marketwatch)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·marketwatch | 1) MW MARKET WATCH | Market Watch | — | Symbols you follow with live prices. |
| T·marketwatch | MARKET MONITOR (fixture) | Market Watch | — | Same panel before sign-in. |
| T·marketwatch | FEED LIVE (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·marketwatch | HH:mm:ss UTC | keep | UTC | Server clock. |
| T·marketwatch | SYMBOL | Symbol | — | Symbol name. |
| T·marketwatch | BID | Bid | — | Price you sell at. |
| T·marketwatch | ASK | Ask | — | Price you buy at. |
| T·marketwatch | SPRD | Client spread (points) | points | Ask minus bid you pay. (10 points = 1 pip) |
| T·marketwatch | HIGH | Day high | — | Highest bid today (UTC). |
| T·marketwatch | LOW | Day low | — | Lowest bid today (UTC). |
| T·marketwatch | CHG% | Change (%) | % | Change since the day opened. |
| T·marketwatch | METALS / FOREX / OTHER (group bars) | Metals / Forex / Other | — | Asset class. |
| T·marketwatch | NO FEED | No price | — | No price received for this symbol yet. |
| T·marketwatch | search symbols… | Search symbols… | — | Filter or find a symbol. |
| T·marketwatch | + ADD | Add symbol | — | Add a symbol to your list. |
| T·marketwatch | Open chart, {SYM} | Open chart · {SYM} | — | Show this symbol on the chart. |
| T·marketwatch | New order, {SYM} | New order · {SYM} | — | Open the new order window for this symbol. |
| T·marketwatch | Specification, {SYM}… | Symbol details · {SYM}… | — | Contract size, volume limits, spread. |
| T·marketwatch | Add symbol… | keep | — | Add a symbol to your list. |
| T·marketwatch | Remove {SYM} from watchlist | Remove {SYM} from Market Watch | — | Hide this symbol from your list. |
| T·marketwatch | Columns ▸ | keep | — | Choose which columns show. |
| T·marketwatch | Change % | Change (%) | % | Show the change column. |
| T·marketwatch | Spread | Client spread (points) | points | Show the client spread column. (10 points = 1 pip) |
| T·marketwatch | Daily High / Low | Day high / low | — | Show today's high and low. |
| T·marketwatch | ADD SYMBOL (flyout title) | Add symbol | — | — |
| T·marketwatch | search… | Search symbols… | — | — |
| T·marketwatch | all enabled symbols are on the watchlist | All available symbols are already in Market Watch | — | — |
| T·marketwatch | no match | No matching symbol | — | — |
| T·marketwatch | REMOVE FROM WATCHLIST (confirm title) | Remove from Market Watch | — | Confirms removing the symbol. |
| T·marketwatch | REMOVE (confirm button) | Remove | — | — |
| T·marketwatch | Symbol Specification (window title) | Symbol details | — | Rows: … Bid / Ask (the trader's own prices), Client spread (points); never markup, raw ask or the spread rule (owner 2026-10-01). |
| T·marketwatch | {SYMBOL} · {CATEGORY} (dialog title row) | keep | — | — |
| T·marketwatch | Symbol id | remove | — | Internal code; not useful to traders. |
| T·marketwatch | Digits | Price digits | — | Decimal places in the price. |
| T·marketwatch | Tick size | Point size | — | Smallest price step (1 point). |
| T·marketwatch | Contract size | keep | — | Units in 1 lot. |
| T·marketwatch | Pip value / 1 lot ("… USD per tick") | Point value ($ per lot) | $ per lot | Money gained or lost per 1-point move on 1 lot. |
| T·marketwatch | Stop level ("n ticks") | Min stop distance (points) | points | Closest a stop loss / take profit may be to the price. (10 points = 1 pip) |
| T·marketwatch | Min lot | Min volume (lots) | lots | Smallest trade size. |
| T·marketwatch | Max lot | Max volume (lots) | lots | Largest trade size. |
| T·marketwatch | Lot step | Volume step (lots) | lots | Size increments allowed. |
| T·marketwatch | Bid / Ask | keep | — | Current sell / buy price. |
| T·marketwatch | Spread ("n pts") | Client spread (points) | points | Current ask minus bid you pay. (10 points = 1 pip) |
| T·marketwatch | BUY ask markup | remove (already in Ask) | — | Broker markup; the Ask shown already includes it. |
| T·marketwatch | Market (OPEN (live quote) / CLOSED / unknown) | Market: Open / Closed / Unknown | — | Whether the symbol trades right now. |
| T·marketwatch | Margin / 1 lot @ 1:N | Margin for 1 lot ($) | $ | Margin held for 1 lot at your leverage 1:N. |
| T·marketwatch | Swaps, commissions and trading hours: per account group (broker) | Swap, commission and trading hours depend on your account group | — | — |
| T·marketwatch | CLOSE | Close | — | Close this window. |

### Chart (term-chart)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·chart | position / order line labels | SL · TP · BUY 0.40 at 4451.97 · BUY LIMIT 0.25 at 4446.00 | price | Plain text at the left edge, no boxes; P/L added on hover / drag (or always: setting); a group = total lots at the weighted average; crowded labels stack with a leader to their line (owner 2026-10-01). |
| T·chart | Position labels (chart right-click) | Position labels ▸ Grouped / All / Off | — | Grouped (default): one tag per side and price cluster; All: one tag per position; Off: no entry lines or tags (SL / TP lines stay) (owner 2026-09-30). |
| T·chart | cluster tag | {Buy/Sell} {lots} ×{n} · {±#,##0.00} {CCY} (e.g. Buy 0.4 ×3 · +175.00 USD) | account ccy | Hover it: one line per position, {Side} {lots} @ {open price} · {P/L} (owner 2026-09-30). |
| T·chart | P/L on SL/TP tags (chart setting) | P/L on SL/TP tags: Always (off = on hover) | — | Default off: the tags show the level alone and the P/L appears on hover / while selected or dragged (owner 2026-09-30). |
| T·chart | SL / TP tag P/L | {level} · {±#,##0.00} {account currency code} (e.g. SL 4485.00 · −61.08 USD) | account ccy | No "$": the account's currency code after the value (owner 2026-09-30). |
| T·chart | 2) GP | Chart | — | Price chart for the selected symbol. |
| T·chart | {SYMBOL} · {description} | keep | — | — |
| T·chart | LAYOUT · SINGLE / LAYOUT · 2×2 | Layout: Single chart / 2×2 grid | — | Click to switch; right-click for options. |
| T·chart | LAST | Current price | — | Latest bid. |
| T·chart | CHG | Change (%) | % | Change since the day opened. |
| T·chart | O / H / L | Open / High / Low | — | Current candle open, high, low. |
| T·chart | VOL | Tick volume | — | Number of price updates in the current candle. |
| T·chart | CHART LAYOUT | Chart layout | — | — |
| T·chart | Single | Single chart | — | One chart. |
| T·chart | Grid 2×2 | 2×2 grid | — | Four charts. |
| T·chart | Crosshair sync (grid) | Link crosshair across grid | — | Move the crosshair on all four charts together. |
| T·chart | Double-click a cell: maximize / restore | keep | — | — |
| T·chart | 1M 5M 15M 30M 1H 4H D W | M1 M5 M15 M30 H1 H4 D1 W1 | — | Candle timeframe. |
| T·chart | 1m 5m 15m 30m 1H 4H D (grid cell) | M1 M5 M15 M30 H1 H4 D1 | — | Candle timeframe (same words as the main chart). |
| T·chart | INDICATORS (n) / STUDIES | Indicators (n) | — | Add or change chart indicators. |
| T·chart | EMA 20/50 | keep | — | Show 20 and 50 moving averages. |
| T·chart | VWAP (fixture) | remove | — | Placeholder, not live. |
| T·chart | SESSIONS | Sessions | — | Shade Asia, London and New York hours. |
| T·chart | DRAW | Draw | — | Drawing tools. |
| T·chart | FIB / OB / FVG (fixture) | remove | — | Placeholders, not live. |
| T·chart | INDICATORS (flyout title) | Indicators | — | — |
| T·chart | {e.g. MA(9)} overlay \| pane | {indicator}(n) · on price / below chart | — | Where the indicator is drawn. |
| T·chart | ⚙ (indicator row) | Settings | — | Change the indicator's inputs and colour. |
| T·chart | CHART (flyout section) | Chart | — | — |
| T·chart | One-click panel | One-click trading panel | — | Show the Buy/Sell panel on the chart. |
| T·chart | Sessions ASIA · LONDON · NY | Sessions: Asia · London · New York | — | Shade trading session hours. |
| T·chart | DRAWING TOOLS | Drawing tools | — | — |
| T·chart | Trend line | keep | — | — |
| T·chart | Horizontal line | keep | — | — |
| T·chart | Ray | keep | — | — |
| T·chart | Rectangle | keep | — | — |
| T·chart | Fibonacci retracement | keep | — | — |
| T·chart | Clear all drawings (n) | keep | — | Delete every drawing on this symbol. |
| T·chart | Chart settings… | keep | — | Candle colours and display options. |
| T·chart | SELL {bid} | Sell {bid} | — | Sell at market at the bid. |
| T·chart | BUY {ask+markup} | Buy {ask} | — | Buy at market at the ask. |
| T·chart | − {lots} + | Volume (lots) | lots | Trade size for one-click buttons. |
| T·chart | 1-CLICK · OFF \| ON | One-click trading: Off / On | — | When on, orders send without a confirm. |
| T·chart | ‹ / › | Hide / Show one-click trading panel | — | Collapse or expand the one-click panel. |
| T·chart | drawing mini-toolbar ⚙ / ✕ | Drawing settings / Delete drawing | — | — |
| T·chart | Don't ask again until the terminal is restarted | keep | — | Skip this confirm until you restart. |
| T·chart | CANCEL (confirm) | Cancel | — | — |
| T·chart | PLACE ORDER | Place order | — | Send the order. |
| T·chart | MODIFY | Save change | — | Send the new stop loss / take profit. |
| T·chart | ADD ALERT | Add alert | — | Create the price alert. |
| T·chart | {SIDE} {TYPE} (confirm title, e.g. BUY LIMIT) | Buy limit / Sell limit / Buy stop / Sell stop | — | Confirms a pending order from the chart. |
| T·chart | {SIDE} {SYMBOL} AT MARKET (confirm title) | {Buy/Sell} {SYMBOL} at market | — | Confirms a market order. |
| T·chart | ADD PRICE ALERT (confirm title) | Add price alert | — | — |
| T·chart | MOVE SL / MOVE TP (confirm title) | Move stop loss / Move take profit | — | Confirms a dragged line. |
| T·chart | SET SL / SET TP (confirm title) | Set stop loss / Set take profit | — | Confirms from the right-click menu. |
| T·chart | sending… | Sending… | — | — |
| T·chart | OK · … | Done · … | — | Result of the last action. |
| T·chart | FAILED · … | Failed · … | — | Reason the last action failed. |
| T·chart | {price} · below market / above market | keep | — | Price under the cursor vs current price. |
| T·chart | Buy Limit @ {price} | Buy limit at {price} | — | Pending order to buy if price falls here. |
| T·chart | Sell Limit @ {price} | Sell limit at {price} | — | Pending order to sell if price rises here. |
| T·chart | Sell Stop @ {price} | Sell stop at {price} | — | Pending order to sell if price falls here. |
| T·chart | Buy Stop @ {price} | Buy stop at {price} | — | Pending order to buy if price rises here. |
| T·chart | Set SL {price} · BUY\|SELL {lots} | Set stop loss at {price} · Buy/Sell {lots} lots | — | Move this position's stop loss here. |
| T·chart | Set TP {price} · BUY\|SELL {lots} | Set take profit at {price} · Buy/Sell {lots} lots | — | Move this position's take profit here. |
| T·chart | Alert below {price} / Alert above {price} | Alert when price falls to {price} / rises to {price} | — | Create a price alert. |
| T·chart | Collapse / Expand one-click panel | Hide / Show one-click trading panel | — | — |
| T·chart | {Kind} settings… | keep | — | Edit this drawing. |
| T·chart | Remove drawing | Delete drawing | — | — |
| T·chart | Reset view | keep | — | Back to default zoom and scroll. |
| T·chart | Maximize | keep | — | Show this grid cell full size. |
| T·chart | {SYMBOL} ▾ (grid cell) | keep | — | Pick the symbol for this cell. |
| T·chart | H x L y (grid cell) | Day high x · Day low y | — | Today's high and low. |
| T·chart | Chart appearance: CANDLES | Candles | — | — |
| T·chart | Up body / Down body / Up border / Down border / Up wick / Down wick | keep | — | Candle colours. |
| T·chart | DISPLAY | Display | — | — |
| T·chart | Grid lines | keep | — | — |
| T·chart | Last-price line | Current price line | — | — |
| T·chart | Previous day high/low (PDH/PDL) | Previous day high / low | — | Lines at yesterday's high and low. |
| T·chart | Session map (Asia/London/NY) | Sessions (Asia / London / New York) | — | — |
| T·chart | OHLC info bar | Candle values bar | — | Open, high, low, close under the cursor. |
| T·chart | Timezone UTC | Time zone (UTC) | UTC | Chart times are UTC. |
| T·chart | CANCEL / SAVE | Cancel / Save | — | — |

### Order Ticket (term-ticket)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·ticket | 3) OT ORDER TICKET | Order ticket | — | Place a market or pending order. |
| T·ticket | {symbol} (header-right) | keep | — | Symbol on the chart. |
| T·ticket | MARKET / LIMIT / STOP | Market / Limit / Stop | — | Order type. |
| T·ticket | SYMBOL | Symbol | — | Pick the symbol; also switches the chart. |
| T·ticket | PRICE | Price | — | Price for a limit or stop order. |
| T·ticket | order-type guidance (under Price) | {Above the market / Below the market / Inside the spread}: Buy {limit/stop} · Sell {limit/stop} [· on the {TYPE} tab only BUY / SELL fits] | — | Which pending type fits each side at the typed price; the same line on the docked ticket and F9 (owner 2026-09-30). |
| T·ticket | VOLUME LOTS | Volume (lots) | lots | Trade size. |
| T·ticket | STOP LOSS (wm SL) | Stop loss | — | Price that closes the position at a loss. |
| T·ticket | TAKE PROFIT (wm TP) | Take profit | — | Price that closes the position at a profit. |
| T·ticket | RISK % | Risk (% of equity) | % | Sets volume so the stop loss loses this share of equity. |
| T·ticket | LEVERAGE | keep | — | Your account leverage, 1:N. |
| T·ticket | EXPIRY (GTC) | Expiry: Until cancelled | — | Pending order stays until you cancel it. |
| T·ticket | MARGIN REQ {cur} | Margin needed ($) | $ | Margin this order will hold. |
| T·ticket | PIP VALUE {cur} | Point value ($) | $ | Money per 1-point move at this volume. |
| T·ticket | SELL / SELL LIMIT / SELL STOP {bid} | Sell / Sell limit / Sell stop {price} | — | Send a sell order. |
| T·ticket | BUY / BUY LIMIT / BUY STOP {ask} | Buy / Buy limit / Buy stop {price} | — | Send a buy order. |
| T·ticket | SL/TP: BUY only / SL/TP: SELL only | Stop loss / take profit fits Buy only / Sell only | — | Which side your stop loss / take profit is valid for. |
| T·ticket | SL/TP on the wrong side for BUY and SELL | Stop loss / take profit on the wrong side for both Buy and Sell | — | — |
| T·ticket | RISK | Risk ($) | $ | Loss if the stop loss is hit. |
| T·ticket | REWARD | Reward ($) | $ | Profit if the take profit is hit. |
| T·ticket | R:R | Reward : risk | — | Reward divided by risk. |
| T·ticket | SESSIONS · 03:17 UTC | Sessions · {HH:mm} (UTC) | UTC | Trading sessions and the time now. |
| T·ticket | {session} OPEN / countdown | {session}: Open / opens in {time} | — | — |
| T·ticket | SELL · C2 / BUY · C1 (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·ticket | SMART EXECUTION (fixture) | remove | — | Placeholder, not shown after sign-in. |

### New Order (term-neworder)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·neworder | New Order (window title) | New order | — | — |
| T·neworder | NEW ORDER · F9 | New order (F9) | — | — |
| T·neworder | SYMBOL | Symbol | — | — |
| T·neworder | TYPE (MARKET / LIMIT / STOP) | Order type: Market / Limit / Stop | — | — |
| T·neworder | PRICE | Price | — | Price for a limit or stop order. |
| T·neworder | VOLUME LOTS | Volume (lots) | lots | Trade size. |
| T·neworder | STOP LOSS | Stop loss | — | — |
| T·neworder | TAKE PROFIT | Take profit | — | — |
| T·neworder | RISK % | Risk (% of equity) | % | Sets volume so the stop loss loses this share of equity. |
| T·neworder | SLIPPAGE MAX (wm M = unlimited) | MAX SLIPPAGE (POINTS) · empty value reads Unlimited | points | Largest price change you accept on fill (10 points = 1 pip); Unlimited = no limit of your own (owner 2026-10-01). |
| T·neworder | EXPIRY | Expiry: Until cancelled | — | — |
| T·neworder | LEVERAGE | keep | — | — |
| T·neworder | MARGIN REQ | Margin needed ($) | $ | Margin this order will hold. |
| T·neworder | PIP VALUE | Point value ($) | $ | Money per 1-point move at this volume. |
| T·neworder | RISK / REWARD / R:R | Risk ($) / Reward ($) / Reward : risk | $ | Loss at stop loss, profit at take profit, and their ratio. |
| T·neworder | CANCEL / PLACE ORDER | Cancel / Place order | — | — |
| T·neworder | SELL / BUY | Sell / Buy | — | — |
| T·neworder | CLOSE | Close | — | Close this window. |

### Positions (term-positions)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·positions | 4) TRADE | Positions | — | Your open positions. |
| T·positions | stream warning (amber) | Prices not updating | — | Price feed is down; values may be old. |
| T·positions | stream warning, short form | STREAM ⚠ | — | Shown when the full warning does not fit beside the tabs and the close buttons; the full text on hover (owner 2026-09-30). |
| T·positions | CLOSE PROFIT | Close profitable | — | Close every position in profit. |
| T·positions | CLOSE LOSS | Close losing | — | Close every position in loss. |
| T·positions | CLOSE ALL | Close all | — | Close every open position. |
| T·positions | bulk-close scope menu (right-click on Close profitable / losing / all) | Close {profitable/losing/all}: every symbol / Buy only / Sell only / {symbol} only | — | Narrows a bulk close; always confirmed with the count (owner 2026-09-30). |
| T·positions | bulk-close confirm (scoped) | Close every {profitable/losing} {Buy/Sell} position [on {symbol}] ({n})? | — | (owner 2026-09-30) |
| T·positions | TICKET | Ticket # | — | Position number. |
| T·positions | OPENED | Opened (UTC) | UTC | Open time. |
| T·positions | SYMBOL | Symbol | — | — |
| T·positions | SIDE | Side | — | Buy or sell. |
| T·positions | LOTS | Volume (lots) | lots | — |
| T·positions | OPEN | Open price | — | — |
| T·positions | CURRENT | Current price | — | Price the position would close at now. |
| T·positions | DURATION | Time open | — | How long the position has been open. |
| T·positions | S/L ✎ | SL ✎ | — | Stop loss; click to edit. |
| T·positions | T/P ✎ | TP ✎ | — | Take profit; click to edit. |
| T·positions | SWAP | Swap ($) | $ | Overnight fees charged so far. |
| T·positions | COMM | Commission ($) | $ | Commission charged on this position. |
| T·positions | PTS | Move (points) | points | Price move since open, in your favour or against. (10 points = 1 pip) |
| T·positions | P/L USD | Floating P/L ($) | $ | Profit or loss if closed now. |
| T·positions | P/L header before sign-in | P/L | — | No currency until the account's is known; then P/L {CCY} (owner 2026-09-30). |
| T·positions | COMMENT ✎ | Comment ✎ | — | Your note; click to edit. |
| T·positions | ACTIONS | Actions | — | — |
| T·positions | BE | Break-even | — | Move stop loss to the open price. |
| T·positions | PART | Close part | — | Close 25 / 50 / 75 %. |
| T·positions | MOD | Modify | — | Change stop loss / take profit or close. |
| T·positions | SHARE | Share | — | Make a picture card of this position. |
| T·positions | REV | Reverse | — | Close and open the opposite side at the same volume. |
| T·positions | Reverse (row menu) | Reverse (Sell → Buy)… / Reverse (Buy → Sell)… | — | The row menu names the direction (owner 2026-09-30). |
| T·positions | ✕ | Close position | — | Close at market. |
| T·positions | close awaiting dealer (amber status) | Close waiting for dealer | — | Your close request is with the dealer. |
| T·positions | row status in the actions cell | WAITING / REQUOTED | — | Short status on a close with the dealer (full text on hover; the row menu heads with CLOSE WAITING FOR DEALER) (owner 2026-09-30). |
| T·positions | CANCEL (withdraw close) | Withdraw close | — | Cancel your close request; the position stays open. |
| T·positions | origin hint (hotkey / 1-click / reverse / source) | Opened by: hotkey / one-click trading / reverse / copy | — | How this position was opened. |
| T·positions | Modify / close #TICKET SYMBOL… | Modify or close #TICKET SYMBOL… | — | — |
| T·positions | Smart rules #TICKET SYMBOL… | Trade assistant #TICKET SYMBOL… | — | Automatic break-even, partial close and trailing stop. |
| T·positions | Close SYMBOL LOTS | Close SYMBOL {lots} lots | — | — |
| T·positions | Close by ▸ | keep | — | Close against an opposite position on the same symbol. |
| T·positions | #TICKET SIDE LOTS @ OPEN | #TICKET {Side} {lots} lots at {open price} | — | Opposite position to close against. |
| T·positions | Close by… (no opposite SYMBOL position) | Close by (no opposite SYMBOL position) | — | — |
| T·positions | Share #TICKET SYMBOL… | keep | — | — |
| T·positions | Close 25% now / 50% / 75% | Close 25% / 50% / 75% | % | Close part of the volume at market. |
| T·positions | COLUMNS | Columns | — | — |
| T·positions | Fit columns to width | keep | — | — |
| T·positions | Reset columns | keep | — | — |
| T·positions | N POSITIONS · L LOTS · EXPOSURE X CUR | N positions · L lots · Exposure ($) X | $ | Count, total volume and total position value. |
| T·positions | footer swap (muted) | Swap ($) | $ | Total swap on open positions. |
| T·positions | footer total P/L | Floating P/L ($) | $ | Total profit/loss of open positions. |
| T·positions | No open positions | keep | — | — |
| T·positions | CLOSE POSITION (confirm title / button) | Close position | — | — |
| T·positions | CLOSE BY (confirm title / button) | Close by | — | — |
| T·positions | CLOSE ALL POSITIONS / CLOSE PROFITABLE POSITIONS / CLOSE LOSING POSITIONS | Close all positions / Close profitable positions / Close losing positions | — | — |
| T·positions | BREAK-EVEN (confirm) | Break-even | — | Stop loss moves to the open price. |
| T·positions | PARTIAL CLOSE n% (confirm title) | Close part (n%) | % | — |
| T·positions | CLOSE PART (confirm button) | Close part | — | — |
| T·positions | WITHDRAW CLOSE REQUEST / WITHDRAW | Withdraw close request / Withdraw | — | — |
| T·positions | REVERSE POSITION? / BUY → SELL | Reverse position / Buy → Sell | — | — |
| T·positions | MODIFY SL / MODIFY TP (confirm title) | Change stop loss / Change take profit | — | — |
| T·positions | Modify / Close Position (window title) | Modify or close position | — | — |
| T·positions | OPEN / CURRENT / P/L | Open price / Current price / Floating P/L ($) | $ | — |
| T·positions | STOP LOSS / TAKE PROFIT (section) | Stop loss / Take profit | — | — |
| T·positions | CLEAR | Remove | — | Remove this stop loss / take profit. |
| T·positions | MODIFY SL / TP | Save stop loss / take profit | — | — |
| T·positions | CLOSE (section) | Close | — | — |
| T·positions | LOTS TO CLOSE | Volume to close (lots) | lots | — |
| T·positions | 25% / 50% / 100% | keep | % | Fill in part of the volume. |
| T·positions | CLOSE POSITION / CLOSE x OF y (PARTIAL) | Close position / Close x of y lots | lots | — |
| T·positions | CLOSE WINDOW | Close window | — | — |
| T·positions | Share Trade (window title) | Share position | — | — |
| T·positions | SHARE CARD · 1200×630 PNG | Share card (image) | — | Picture of the trade to post. |
| T·positions | COPY TEXT | Copy text | — | — |
| T·positions | SAVE PNG | Save image | — | — |
| T·positions | CLOSE (share) | Close | — | — |

### Dock tabs (term-tabs)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·tabs | PENDING | Pending orders | — | Limit/stop orders not filled yet. |
| T·tabs | dock tab labels | keep TRADE / PENDING / ORDERS / HISTORY / BALANCE / LOG for now | — | The long names do not fit beside the close buttons at 1366; they move with the terminal text batch (owner 2026-09-30). |
| T·tabs | ORDERS | Order history | — | Every order you sent and what happened. |
| T·tabs | HISTORY | Closed trades | — | Positions you have closed. |
| T·tabs | BALANCE | Deposits & withdrawals | — | Money in and out of the account. |
| T·tabs | LOG | Journal | — | Terminal activity log. |
| T·tabs | N pending orders | keep | — | — |
| T·tabs | TICKET | Ticket # | — | — |
| T·tabs | CREATED | Placed (UTC) | UTC | When the order was sent. |
| T·tabs | TYPE (LIMIT / STOP / MARKET / CLOSE #T) | Type: Limit / Stop / Market / Close #T | — | — |
| T·tabs | SIDE | Side | — | Buy or sell. |
| T·tabs | LOTS | Volume (lots) | lots | — |
| T·tabs | PRICE | Price | — | Order price. |
| T·tabs | S/L / T/P | SL / TP | — | Stop loss / take profit. |
| T·tabs | ACTIONS | Actions | — | — |
| T·tabs | ✕ (pending) | Cancel order | — | — |
| T·tabs | REQUOTED (row state) | New price offered | — | Dealer offers a different price. |
| T·tabs | ✓ {offered} | Accept {price} | — | Accept the dealer's new price. |
| T·tabs | ✕ REJECT | Reject | — | Refuse the new price; the order is cancelled. |
| T·tabs | CANCEL ORDER (confirm title / button) | Cancel order | — | — |
| T·tabs | N orders total | keep | — | — |
| T·tabs | FILLED | Fill price | — | Price the order filled at. |
| T·tabs | STATUS | Status | — | Filled, rejected, cancelled, waiting for dealer. |
| T·tabs | RANGE | Period | — | — |
| T·tabs | 1D 1W 1M 3M 6M ALL CUSTOM | 1D · THIS WEEK · LAST 7 DAYS · 1M · 3M · 6M · ALL · CUSTOM | — | THIS WEEK = since the broker's trading week start (WEEK P/L's window); LAST 7 DAYS = the last 7 × 24 h (was 1W) (owner 2026-10-01). |
| T·tabs | HISTORY footer | {n} TRADES · {lots} LOTS · P/L ±x · COMMISSION −x · SWAP ±x … NET ±#,##0.00 CCY | account ccy | Totals of the trades shown (range + symbol); NET = P/L + swap − commission; no live open P/L on HISTORY (owner 2026-10-01). |
| T·tabs | LOG trade lines | BUY 0.01 XAUUSD filled @ 4161.50 · #100002513 · 266 ms / SELL 0.05 XAUUSD closed @ 4456.68 · #100001171 · 300 ms | — | One line per trade, by its ticket; never an internal id, no server ms (owner 2026-10-01). |

| T·tabs | FROM / TO | From (UTC) / To (UTC) | UTC | — |
| T·tabs | SYMBOL (ALL) | Symbol: All | — | — |
| T·tabs | summary text | keep | $ | Totals for the selected period. |
| T·tabs | STATEMENT ⤓ | Save statement | — | Save a statement for the period. |
| T·tabs | Export statement (save dialog title) | Save statement | — | — |
| T·tabs | OPENED | Opened (UTC) | UTC | — |
| T·tabs | OPEN PRICE | Open price | — | — |
| T·tabs | CLOSE PRICE | Close price | — | Coloured by how it closed. |
| T·tabs | SWAP | Swap ($) | $ | — |
| T·tabs | COMM | Commission ($) | $ | — |
| T·tabs | CLOSED | Closed (UTC) | UTC | — |
| T·tabs | REASON | Closed by | — | You, stop loss, take profit, stop-out, dealer. |
| T·tabs | DURATION | Time open | — | — |
| T·tabs | PROFIT / LOSS | Closed P/L ($) | $ | Result of the closed trade. |
| T·tabs | Share #TICKET SYMBOL… | keep | — | — |
| T·tabs | STATEMENT PERIOD | Statement period | — | — |
| T·tabs | Last day / Last week / Last month / Last 3 months / Last 6 months / All time / Custom range… | keep | — | — |
| T·tabs | Columns… | keep | — | — |
| T·tabs | DATE | Date (UTC) | UTC | — |
| T·tabs | TYPE (balance) | Type | — | Deposit, withdrawal, credit, adjustment. |
| T·tabs | AMOUNT | Amount ($) | $ | Signed: + in, − out. |
| T·tabs | REASON (balance) | Reason | — | Why the money moved. |
| T·tabs | STATUS (balance) | Status | — | — |
| T·tabs | TIME | Time (UTC) | UTC | — |
| T·tabs | SRC | From | — | Where the message came from. |
| T·tabs | MESSAGE | Message | — | — |

### Trade assistant (term-stm)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·stm | SMART TRADE MANAGER (panel header, window title, messages) | TRADE ASSISTANT / Trade assistant | — | The right-column panel; off = its header line only (owner 2026-09-30). |
| T·stm | SMART TRADE MANAGER | Trade assistant | — | Hotkeys and bulk actions for your positions. |
| T·stm | ENABLED / DISABLED (pill) | On / Off | — | Turn the trade assistant on or off. |
| T·stm | Smart Trade Manager (tooltip) | Trade assistant | — | — |
| T·stm | SYMBOL · TYPE | Symbol · Order type | — | What the hotkeys trade. |
| T·stm | LOT SIZE | Volume (lots) | lots | Size used by the hotkeys. |
| T·stm | SL / TP | Stop loss / Take profit (points) | points | Distance from the entry price. (10 points = 1 pip) |
| T·stm | BUY HOTKEY | Buy hotkey | — | Key that sends a buy. |
| T·stm | SELL HOTKEY | Sell hotkey | — | Key that sends a sell. |
| T·stm | set hotkey (wm) | Press to set | — | — |
| T·stm | Press a key (tooltip) | keep | — | — |
| T·stm | POSITION ACTIONS | Position actions | — | — |
| T·stm | All symbols / This symbol | keep | — | Which positions the actions apply to. |
| T·stm | All / Buy / Sell | keep | — | — |
| T·stm | Break-even … Apply | Break-even · Apply | — | Stop loss to open price on positions in profit. |
| T·stm | Partial close [50] % … Close | Close part (%) · Close | % | Close this share of each position. |
| T·stm | Close profitable / Close losing / Close all | keep | — | — |
| T·stm | CLOSE PROFITABLE / CLOSE LOSING / CLOSE ALL (confirm titles) | Close profitable / Close losing / Close all | — | — |
| T·stm | Smart Trade Manager (window title) | Trade assistant · #TICKET | — | Automatic rules for one position. |
| T·stm | SYMBOL SIDE LOTS @ OPEN · #TICKET | {SYMBOL} {Side} {lots} lots at {open price} · Ticket # | — | — |
| T·stm | bid x · +n pips · SL … · TP … · lots | Bid x · +n points · SL … · TP … · lots | points | Live state of the position. (10 points = 1 pip) |
| T·stm | AUTOMATED RULES | Automatic rules | — | — |
| T·stm | ARMED (state text) | On | — | Rule is active. |
| T·stm | BREAK-EVEN | Break-even | — | Move stop loss to open when in profit. |
| T·stm | trigger (pips in profit) | Start at profit (points) | points | Profit needed before stop loss moves. (10 points = 1 pip) |
| T·stm | lock (pips, 0 = open) | Lock in (points; 0 = open price) | points | Where the stop loss goes, above open. (10 points = 1 pip) |
| T·stm | PARTIAL CLOSE AT TP1 | Close part at first target | — | — |
| T·stm | TP1 price | First target price | — | — |
| T·stm | close (%) | Close (%) | % | Share of volume to close. |
| T·stm | TRAILING STOP | Trailing stop | — | Stop loss follows price. |
| T·stm | distance (pips) | Distance (points) | points | Gap kept behind price. (10 points = 1 pip) |
| T·stm | step (pips) | Step (points) | points | Minimum move before the stop loss moves. (10 points = 1 pip) |
| T·stm | DISARM ALL | Turn off all rules | — | — |
| T·stm | ARM SELECTED RULES | Turn on selected rules | — | — |
| T·stm | ARM SMART RULES / ARM (confirm) | Turn on rules | — | — |
| T·stm | MANUAL ACTIONS | Actions now | — | — |
| T·stm | BREAK-EVEN NOW | Break-even now | — | — |
| T·stm | CLOSE 25% / 50% / 75% | Close 25% / 50% / 75% | % | — |
| T·stm | CLOSE (red) | Close position | — | — |
| T·stm | CLOSE WINDOW | Close window | — | — |

### Account (term-account)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·account | 6) ACC ACCOUNT | Account | — | Account money figures. |
| T·account | BALANCE | Balance ($) | $ | Money in the account, before open positions. |
| T·account | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| T·account | OPEN P/L | Floating P/L ($) | $ | Profit/loss of open positions. |
| T·account | MARGIN USED | Used margin ($) | $ | Margin held by open positions. |
| T·account | FREE MARGIN | Free margin ($) | $ | Equity minus used margin. |
| T·account | DAY P/L | Today's P/L ($) | $ | Closed P/L since trading day start plus floating P/L. |
| T·account | WEEK P/L | This week's P/L ($) | $ | Closed P/L since Monday 00:00 UTC plus floating P/L. |
| T·account | MARGIN n% (gauge) | Used margin (% of equity) | % | Share of equity held as margin. |
| T·account | LEVEL n% | Margin level (%) | % | Equity ÷ used margin × 100. |
| T·account | CALL n% | Margin call level (%) | % | Margin level where you get a warning. |
| T·account | STOP-OUT 20% (fixture) | Stop-out level (%) | % | Margin level where positions are closed automatically. |

### Calendar & news (term-eco)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·eco | header on a failed read | CALENDAR UNAVAILABLE · RETRYING | — | Retries after 30 s, 2 min, then every 5 min (owner 2026-10-01). |
| T·eco | impact filter | ALL IMPACT / HIGH · MED … (button) · All impacts / High / Medium / Low (checkboxes) | — | Like the currency filter (owner 2026-10-01). |
| T·eco | 5) ECO CALENDAR · NEWS | Calendar & news | — | Economic events that can move prices. |
| T·eco | {n} EVENTS · {h} HIGH · UTC | {n} events · {h} high impact · times in UTC | UTC | — |
| T·eco | CALENDAR OFFLINE | Calendar unavailable | — | Could not load events. |
| T·eco | USD · XAU (before load) | Loading… | — | — |
| T·eco | time column | Time (UTC): HH:mm today, weekday + time on another day (e.g. Thu 02:05) | UTC | Never "01 02:05", which reads like a time (owner 2026-09-30). |
| T·eco | HIGH / MED / LOW | High / Medium / Low | — | Expected market impact. |
| T·eco | NEWS (fixture rows) | News | — | Headline, not a scheduled event. |

### Price alerts (term-alerts)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·alerts | triggered-alert chart marker (new) | ALERT ≥ {level} / ALERT ≤ {level} | price | Amber flag at the trigger time, kept for the session (up to 20 per symbol) (owner 2026-09-30). |
| T·alerts | Price Alerts (window title) | Price alerts | — | — |
| T·alerts | PRICE ALERTS · F8 | Price alerts (F8) | — | — |
| T·alerts | SYMBOL | Symbol | — | — |
| T·alerts | condition button (above / below) | Rises to / Falls to | — | When to alert. |
| T·alerts | PRICE | Price | — | — |
| T·alerts | ADD | Add alert | — | — |
| T·alerts | COND | Condition | — | — |
| T·alerts | STATUS | Status | — | Active, triggered, cancelled. |
| T·alerts | CREATED | Created (UTC) | UTC | — |
| T·alerts | ✕ CANCEL | Delete alert | — | — |
| T·alerts | ADD ALERT / CANCEL ALERT (confirm titles) | Add alert / Delete alert | — | — |
| T·alerts | CANCEL / CLOSE | Cancel / Close | — | — |

### Settings (term-settings)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·settings | Workspace: time zone | TIME ZONE · Show times in · UTC / My computer / Broker (New York) | — | Every time on screen; the zone is named beside the clock (UTC, PKT, EDT) with the details on hover (owner 2026-10-01). |
| T·settings | Trading: max slippage | Max slippage (points) · Unlimited | points | Unlimited = no limit of your own (owner 2026-10-01). |
| T·settings | tab strip | TRADING / CHART / NOTIFICATIONS / WORKSPACE | — | Every setting sits in exactly one tab; a fixed-size dialog without maximize (owner 2026-09-30). |
| T·settings | Settings (window title) | keep | — | — |
| T·settings | CONFIRMATIONS | Confirmations | — | Which actions ask before sending. |
| T·settings | Confirm ticket / New Order / dock closes before sending | Confirm orders from the ticket and New order (F9), closes, partial closes and cancels | — | Says what it gates (owner 2026-09-30). |
| T·settings | Confirm chart right-click orders | Confirm orders from the chart menu | — | — |
| T·settings | Confirm SL/TP drags and inline edits | Confirm stop loss / take profit changes (chart drags, inline edits, break-even) | — | Says what it gates (owner 2026-09-30). |
| T·settings | Confirm price alerts | keep | — | — |
| T·settings | confirmations note | Close by, reverse and every bulk close always ask. Trade assistant hotkeys send at once, without a confirmation, and only while the Trade assistant is ON. | — | (owner 2026-09-30) |
| T·settings | saved-where note | The confirmations, the max slippage and the hotkeys are saved for this account only; 1-click is saved to your account on the server. | — | (owner 2026-09-30) |
| T·settings | Slippage max (points · M = unlimited) | Max slippage (points) · M = no limit | points | Largest price change you accept on fill. (10 points = 1 pip) |
| T·settings | ⚠ With market volatility or price movement, your entries/orders may be rejected. | ⚠ When prices move fast, orders may be rejected with this limit. | — | — |
| T·settings | I understand — apply this slippage limit | I understand, apply this slippage limit | — | No long dash as sentence punctuation (owner 2026-09-30). |
| T·settings | ACCOUNT | Account | — | — |
| T·settings | 1-click trading ON by default (skips only the human confirm) | One-click trading on at start (skips the confirm only) | — | — |
| T·settings | CHART | Chart | — | — |
| T·settings | Crosshair sync across the 2×2 grid | Link crosshair across the 2×2 grid | — | — |
| T·settings | CHART APPEARANCE… | Chart appearance… | — | Candle colours and display. |
| T·settings | WORKSPACE | Workspace | — | — |
| T·settings | RESET GRID SYMBOLS | Reset grid symbols | — | Put the default symbols back in the 2×2 grid. |
| T·settings | RESET PANEL SIZES (Workspace tab, new) | RESET PANEL SIZES | — | Every panel back to its default size for this account (owner 2026-09-30). |
| T·settings | footer before sign-in | Not signed in: server settings unavailable. | — | (owner 2026-09-30) |
| T·settings | Sounds and keyboard remapping: coming soon. | removed | — | No "coming soon" text anywhere (owner 2026-09-30). |
| T·settings | CANCEL / SAVE | Cancel / Save | — | — |

### Hotkeys & sounds (term-hotkeys-sounds)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·hotkeys-sounds | F-key strip labels | see T·shell rows | — | Same labels as the status bar. |
| T·hotkeys-sounds | BUY HOTKEY / SELL HOTKEY | Buy hotkey / Sell hotkey | — | Key that sends the order. |
| T·hotkeys-sounds | set hotkey (wm) / Press a key | Press to set / Press a key | — | — |
| T·hotkeys-sounds | hint line | keep | — | — |
| T·hotkeys-sounds | LOG columns TIME / SRC / MESSAGE | Time (UTC) / From / Message | UTC | — |
| T·hotkeys-sounds | COLUMNS (header menu) | Columns | — | — |
| T·hotkeys-sounds | action line OK · / FAILED · | Done · / Failed · | — | Result of the last action, clears after 3 s. |

### Sign-in (term-session)

| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·session | refusal window message + progress | keep | — | Why the terminal cannot start. |
| T·session | Build <id> | Version <id> | — | — |
| T·session | CLOSE (refusal) | Close | — | — |
| T·session | <ProductTitle> — Sign in (window title) | keep | — | — |
| T·session | <ProductTitle> · sign in to start · dd MMM yyyy UTC | keep | UTC | — |
| T·session | ☾ / ☀ | Dark theme / Light theme | — | — |
| T·session | SERVER ▾ | Server | — | Live or Demo server. |
| T·session | <Brand> — Live Server / Demo Server | <Brand> — Live / <Brand> — Demo | — | — |
| T·session | Other server… | keep | — | Type a server address. |
| T·session | SERVER ADDRESS | Server address | — | — |
| T·session | ACCOUNT NUMBER | Account number | — | — |
| T·session | PASSWORD | Password | — | — |
| T·session | AUTHENTICATOR CODE | Authenticator code | — | 6-digit code from your authenticator app. |
| T·session | Remember me on this computer | keep | — | Save the password on this PC. |
| T·session | Forgot password? | keep | — | — |
| T·session | CANCEL | Cancel | — | — |
| T·session | SIGN IN / SIGNING IN… | Sign in / Signing in… | — | — |
| T·session | VERIFY / VERIFYING… | Verify / Verifying… | — | — |
| T·session | RESET YOUR PASSWORD | Reset your password | — | — |
| T·session | Your broker will contact you with a new password. | keep | — | — |
| T·session | NOTE FOR SUPPORT (OPTIONAL) | Note for support (optional) | — | — |
| T·session | how to reach you, preferred time… (wm) | keep | — | — |
| T·session | Reset request sent. Your broker will contact you. | keep | — | — |
| T·session | ← Back to sign in | keep | — | — |
| T·session | SEND REQUEST | Send request | — | — |
| T·session | update banner | Update ready · restart to install | — | — |
| T·session | vX | Version X | — | — |

### Client portal sign-in and registration (portal, new 2026-10-05)

| Screen | Label in the app | Approved label | Unit | Tooltip / note |
|---|---|---|---|---|
| PORTAL | Resend verification e-mail (link button, new) | Resend verification e-mail | — | Register page after "an account with this email already exists, check your inbox for the verification link"; login page after "please verify your email before logging in" or an expired link (owner 2026-10-05). While waiting: "Resend verification e-mail (60 s)". |
| PORTAL | sent line (new) | If an unverified account exists for that address, we've sent a new link. | — | Same line for every address: never says whether the address is registered. |
| PORTAL | rate limit line (new) | Too many attempts, try again later. | — | 3 per address and 10 per IP per hour. |
| PORTAL | empty address line (new) | Enter your e-mail address above first. | — | — |

## Consistency changes

Each item lists the old variants, then the final word. The glossary above is the result.

1. **Casing**: part 2 used Title Case (`Margin Level (%)`, `Used Margin ($)`, `Deposits & Withdrawals`); parts 1 and 3 and the glossary use sentence case. All proposed names are now sentence case (`Margin level (%)`), so the same word looks the same on every screen.
2. **Buy / sell / net volume**: `Long (lots)`, `Short (lots)`, `Net (lots)` (DASH, DEAL) → `Buy volume (lots)`, `Sell volume (lots)`, `Net volume (lots)`, as on EXP and SYM.
3. **Total open volume**: `Exposure (lots)` (RPT, RISK, MRG) → `Open volume (lots)`, as on DASH. "Exposure" is now only a money figure or a limit.
4. **Net value**: EXP `NOTIONAL` `Exposure ($)` → `Net exposure ($)`, as on DASH.
5. **Waiting vs pending**: `Pending withdrawals ($)`, `Pending deposits & withdrawals`, `ID check pending`, `Pending` chips (DASH, CLI) → `Withdrawals waiting ($)`, `Deposits & withdrawals waiting`, `ID check waiting`, `Waiting`, as on DEP, KYC, LAR and APR. "Pending" now means a pending order only.
6. **Age**: `AGE` (DASH, DEAL, kept as-is) → `Waiting time`, as on KYC.
7. **Partner clients**: `Partner clients` / `Partner client` (DASH, CLI, CLI·360) → `Referred clients` / `Referred client`, as on IB and RPT.
8. **Partner pay**: `Owed ($)`, `Owed now ($)` (IB) → `Partner pay owed ($)`. `Partner pay rate` and `Rate` now carry `($ per lot or %)`.
9. **Trade handling**: `Book` (CLI·360) and `Handling` (EXP) → `Trade handling`, the glossary word. `Market / Broker Book Positions` (EXP) → `Market book / Broker book positions`, as on DASH.
10. **Dealing**: `Dealing mode` and `Execution` (DEAL) → `Dealing`, as on EXP, RISK and GRP. `MODE` is a banned code. The values stay `Manual dealing` and `Automatic dealing`.
11. **Broker dealing switch**: `Same as broker switch` (GRP, two rows) → `Same as broker dealing switch`, to match `Ignore broker dealing switch`.
12. **Halt state**: `Trading halt` used as a state (EXP, RISK, EMG) → `Trading halted`. `Trading halt` stays the name of the control and the screen.
13. **Emergency**: `Emergency controls` (RISK link, USR permission) → `Trading halt`, the nav name of the EMG screen.
14. **Auto accept/reject**: DEAL `Auto accept / reject` → `Auto-accept / auto-reject slippage (%)`, as on RISK.
15. **Dealer P/L family**: `Dealer net P/L ($)` and `Net P/L ($)` (DEAL, SDM) → `Dealer P/L ($)`. In SDM, `Dealer P/L ($)` meant only the Broker book side, so it is now `Broker book P/L ($)`. `Hedge P/L ($)` / `Hedge P/L ($, still open)` → `Hedge account P/L ($)` / `Hedge account floating P/L ($)`.
16. **Client spread**: terminal `Spread (points)` (Market Watch column, toggle, symbol details) and DEAL `Client spread` (unit missing) → `Client spread (points)`.
17. **DEAL Market Watch aligned to the terminal**: `Market watch` → `Market Watch`, `watchlist` → `Market Watch`, `Specification` → `Symbol details`, `Daily high / low` → `Day high / Day low`, `No price feed` → `No price`, `Change` → `Change (%)`, `Open chart, X` → `Open chart · X`.
18. **DEAL chart aligned to the terminal**: `1M…W` → `M1…W1`, `O · H · L` → `Open / High / Low`, `Grid 2×2 / Crosshair sync` → `2×2 grid / Link crosshair across grid`, `Remove drawing` → `Delete drawing`, `@ P` → `at P`, `Set SL P` → `Set stop loss at P`, `Alert below/above` → `Alert when price falls to / rises to`, `Collapse / Expand` → `Hide / Show one-click trading panel`, `MODIFY` → `Save change`, and `at current price` → `at market` in the market-order confirm.
19. **Theme**: `Theme: Light / Dark` and `Dark / Light theme` (terminal shell, sign-in) → `Light theme / Dark theme`, as on the backoffice.
20. **Open client**: `Open client 360` (DASH, CLI, DEAL, all kept as-is) → `Open client`, as in part 2. `360` is internal jargon.
21. **Live exposure links**: `Live exposure · this symbol` (DASH, kept as-is) → `Live exposure for this symbol`, as on LP, FEED, RISK and MRG.
22. **Account balances**: `Wallets` (nav) and `Wallet` (DASH, CLI menus) → `Account balances` / `Account balance`, as on the WAL panel.
23. **Internal transfers**: nav `Transfers` → `Internal transfers`, as on TRX.
24. **Broker settings**: nav `Settings`, `F12 SETTINGS` and USR `Back to settings` → `Broker settings`, as on CFG.
25. **Closed trades**: nav `Trade history` and CLI·360 `Open in Trade history (replay…)` → `Closed trades` and `(fill details…)`, as on DLS, DEAL and the terminal.
26. **Routing rules**: part 1 renamed nav `Liquidity routing` to `Trade handling`. That clashes with the group-book concept, because ROUTE sets the liquidity provider per symbol. It is now `Routing rules`, as on ROUTE and LP.
27. **Add account**: `New account` / `New account…` (CLI button and menu) → `Add account` / `Add account…`, the same pattern as Add group, Add partner, Add lead and Add staff. Form titles stay `New …`.
28. **Statement**: `Export statement (CSV)` (CLI, CLI·360) and terminal `Download statement` → `Save statement (as CSV)`, as with `Save as CSV` on RPT and AUD.
29. **Sign-in**: `Login history`, `LOGIN`, `Switch staff login…` and `Last IP` tooltip (CLI·360, SHELL) → `Sign-in history`, `Sign-in` and `Sign in as another staff user…`, as on SEC and USR.
30. **Banned SOURCE**: `Lead source` (CRM, two rows) → `Came from`, `Price source` (FEED) → `Price origin`, terminal journal `Source` (two rows) → `From`.
31. **Copy fill price**: MIR `Market` (as a price) → `Current price`.
32. **Swap units**: `Swap long / Swap short ($ per lot)` (GRP, ATY) → `Swap long ($ per lot) / Swap short ($ per lot)`. Each name now carries its unit, as on SYM.
33. **Ledger reason**: terminal balance tab `Comment` → `Reason`, as in the CLI·360 ledger.
34. **Price digits**: SYM `DIGITS` (kept as-is) → `Price digits`, as in terminal symbol details.
35. **Approved by**: DEP `Marked by` and filter `Marked by first admin` → `Approved by (first admin)`, to match the renamed action `Approve (first admin)`.
36. **Date range**: `From / To` (RPT, terminal tabs) → `From (UTC) / To (UTC)`, as on DEAL.
37. **Ticket #**: KYC `ID` → `Check #`. `Ticket #` is kept for orders, positions and trades only.
38. **Units in the name**: terminal `Points` → `Move (points)`, DEAL `+1 / +2 / +3` → `+1 / +2 / +3 steps`, CLI·360 `<first> → <last>` → `<first> → <last> ($)`, DASH `Market book / Broker book` stat → `… (lots)`.
39. **Margin panel**: RISK `Margin Watch` → `Margin`, the same name as the MRG screen it summarises.

Resolved 2026-10-01 (owner): broker-wide **Max slippage** (DEAL, CFG) is stored in points (Broker.defaultMaxSlippagePoints, web 58b077a) and labelled Max slippage (points); no cap reads "unlimited".

## Note (2026-09-25, after Batch 3)
- The symbol limit is enforced per account as the total of its open lots (lib/risk.ts checkSymbolExposure), not as a broker-wide net: rows above were corrected to "Max lots per account (lots)". Backoffice 1.0.26 already shows the largest account against it.
