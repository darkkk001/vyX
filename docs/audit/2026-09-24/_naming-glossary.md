# Naming glossary (one concept = one word, every screen)

Used by `naming.md`. Plain broker language: a broker with no technical background understands it without explanation. No internal codes. Units in the name.

## Units (always in the label, in brackets)
| Quantity | Unit written | Example |
|---|---|---|
| Money | ($) — the account currency; all accounts are USD today | Balance ($) |
| Volume | (lots) | Volume (lots) |
| Price distance (spread, markup, slippage, stop level, SL/TP distance, requote step) | (points) — 1 point = the last price digit; never "pips" | Spread markup (points) |
| Ratios (margin level, margin call, stop-out, hedged margin, IB %) | (%) | Margin level (%) |
| Leverage | written 1:N, no unit | Leverage |
| Time | (UTC) when a clock time is shown | Opened (UTC) |
| Commission | ($ per lot) | Commission ($ per lot) |

## Canonical terms
| Concept | Use this word | Never use |
|---|---|---|
| Money deposited, before open trades | Balance ($) | BAL |
| Balance + credit + floating P/L | Equity ($) | EQ, NAV |
| Bonus money the broker lends to trade with | Credit ($) | (and never "Credit" for a deposit/adjustment: that is "Add funds" / "Deduct funds") |
| Profit/loss of open positions | Floating P/L ($) | FLOAT, UPNL, open P/L, unrealized |
| Profit/loss of closed trades | Closed P/L ($) | REALIZED, RPL |
| Margin held by open positions | Used margin ($) | MRG, margin used |
| Equity minus used margin | Free margin ($) | FREE |
| Equity ÷ used margin × 100 | Margin level (%) | MARGIN LVL, ML, LVL |
| Level that triggers the warning | Margin call level (%) | MC |
| Level that auto-closes positions | Stop-out level (%) | SO |
| Leverage | Leverage | LEV |
| A trade that is open | Position | trade (for open), deal |
| A closed position in history | Closed trade | deal, DLS |
| Buy/sell instruction not filled yet (limit/stop) | Pending order | resting order, RESTING |
| Order waiting for a dealer's decision | Order waiting for dealer | queued, QUEUE, awaiting dealer |
| Offering a new price to the client | Offer new price | requote, REQUOTE |
| Size of trade | Volume (lots) | VOL, LOT, size |
| Symbol | Symbol | instrument, SYM |
| Spread the client sees | Client spread (points) | SPRD, raw spread |
| Spread from the price feed before markup | Market spread (points) | RAW, raw spread, LP spread |
| Extra spread the broker adds | Spread markup (points) | MU, markup (without unit) |
| Overnight fee | Swap ($ per lot) — long / short | rollover |
| Fee per trade | Commission ($ per lot) | COMM |
| Price change limit on fill | Max slippage (points) | SLIP, deviation |
| Stop loss / take profit | Stop loss, Take profit (SL / TP only in narrow table headers) | S/L, T/P |
| Minimum SL/TP distance | Min stop distance (points) | stop level |
| Setting that takes the group's value | Same as group | INHERIT, inherit, GROUP DEFAULT |
| Setting that takes the symbol's value | Same as symbol | INHERIT |
| Broker keeps the client's risk | Broker book (B-book) — first use; then "Broker book" | B_BOOK, BOOK, B-BOOK alone |
| Trades passed to a liquidity provider | Market book (A-book) | A_BOOK, LP book |
| Group whose trades are reversed into a master account | Reverse trading | REVERSAL, MIR |
| Mirror / copy rule | Copy rule (Copy / Reverse) | mirror rule, MIR, SOURCE |
| The account/group a copy rule copies from | Copied from | SOURCE |
| The account that receives copied trades | Copied into | TARGET |
| Broker's own hedge account | Broker hedge account | coverage account, COV, COVERAGE |
| Placing a hedge for a client position | Hedge | BOOK, cover |
| Hedge automatically on every fill | Auto-hedge | AUTO-HEDGE (caps) is fine as a switch label |
| Dealer reviews every order | Manual dealing | DEALER ON, desk on, MODE |
| Orders fill automatically | Automatic dealing | AUTO-FILL, desk off |
| Stop all trading | Trading halt | HALT, kill |
| Only closing allowed | Close-only | CLOSE_ONLY |
| Client group (pricing + leverage tier) | Group | tier, category (for the group itself) |
| How a group's trades are handled | Trade handling (Broker book / Market book / Reverse trading) | CATEGORY, ROUTING, TYPE, groupType |
| Negative balance protection | Negative balance protection | NBP |
| Know-your-customer check | ID check (KYC) — first use; then "ID check" | KYC alone |
| Live account application | Live account application | LAR, account request |
| Deposit/withdrawal method | Payment method | PSP |
| Introducing broker | Partner (IB) — first use; then "Partner" | IB alone |
| Liquidity provider | Liquidity provider | LP alone |
| Maker-checker queue | Approvals (needs a second admin) | APR, maker-checker |
| Staff user | Staff | admin user, USR, team member |
| Price feed | Price feed | FEED, ticks |
| Smart trade manager | Trade assistant | STM, smart rules |
| One-click trading | One-click trading | 1-CLICK, ONE-CLICK |
| Ticket number | Ticket # | TKT, ID |
| Open/close price | Open price / Close price | CMP, current market price |
| Current price | Current price | CMP, LAST |
| Screen codes (DASH, CLI, EXP…) | never shown as the main label; the screen name only | codes in titles like "1) MIR" |

## Rules for the table
- `keep` in "Proposed name" when the current label already follows these rules.
- Proposed names in Title case for headers/sections, sentence case for buttons and menu items (e.g. "Close position").
- Tooltip: one line, what it is + where the number comes from if not obvious. No marketing.
- Same concept → same proposed word everywhere, taken from the table above. A new concept not in the table: pick one word and add it to the "Added terms" list at the end of your part file.
