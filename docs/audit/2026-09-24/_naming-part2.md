# Naming, part 2: back-office screens RPT through CFG

Follows `_naming-glossary.md`. Sources are `ui-map.md` (bo-RPT … bo-CFG) and the dialog/form labels in `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\*.cs` + `Controls\PricingPanel.cs` (read-only).
Conventions: panel titles lose their "1) CODE" prefix (glossary rule). The column picker items that appear on every screen ("COLUMNS", "Reset columns") are listed once, under RPT. `<x>` means a value filled in at runtime.

## Reports (RPT)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RPT | 1) RPT  REPORTS | Reports | — | Downloadable broker reports for a date range. |
| RPT | TRADING VOLUME (KPI) | Trading Volume (lots) | lots | Total lots of closed trades in the chosen range. |
| RPT | COMMISSION REVENUE (KPI) | Commission Earned ($) | $ | Commission charged to clients in the range. |
| RPT | NET DEPOSITS (KPI) | Net Deposits ($) | $ | Completed deposits minus completed withdrawals in the range. |
| RPT | NEW CLIENTS (KPI) | New Clients | — | Accounts created in the range. |
| RPT | SAVE CSV | Save as CSV | — | Download the report shown as a spreadsheet file. |
| RPT | TRADING (chip) | Trading | — | Closed trades report. |
| RPT | FINANCIAL (chip) | Deposits & Withdrawals | — | Money in/out report. |
| RPT | CLIENT (chip) | Clients | — | Client account list. |
| RPT | IB (chip) | Partners (IB) | — | Partner and referred-client commissions. |
| RPT | LP (chip) | Liquidity Providers | — | Liquidity provider records. |
| RPT | RISK (chip) | Risk | — | Open risk per account right now. |
| RPT | RANGE | Date Range (UTC) | UTC | Start and end date of the report. |
| RPT | from / to | From / To | UTC | First and last day included. |
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
| RPT | FULL NAME | Client Name | — | Client's full name. |
| RPT | EMAIL | E-mail | — | Client's e-mail address. |
| RPT | MODE | Live / Demo | — | Whether the account is live or demo. |
| RPT | CURRENCY | keep | — | Account currency. |
| RPT | BALANCE | Balance ($) | $ | Deposited money, not counting open positions. |
| RPT | GROUP | keep | — | Client group (pricing and leverage). |
| RPT | CREATED AT | Created (UTC) | UTC | When the account was created. |
| RPT | IB ACCOUNT | Partner Account | — | Partner's (IB) own account number. |
| RPT | CLIENT ACCOUNT | Referred Client | — | Account the partner brought in. |
| RPT | COMMISSION TYPE | Partner Pay Type | — | $ per lot, or % of commission. |
| RPT | COMMISSION RATE | Partner Pay Rate | $ per lot | Amount per lot, or percent when the type is %. |
| RPT | PENDING COMMISSION | Partner Pay Owed ($) | $ | Earned by the partner and not paid yet. |
| RPT | LAST PAYOUT AT | Last Paid (UTC) | UTC | When the partner was last paid. |
| RPT | NAME | Provider | — | Liquidity provider name. |
| RPT | PROTOCOL | Connection Type | — | How the provider connects (FIX, REST…). |
| RPT | CONTACT NAME / CONTACT EMAIL / CONTACT PHONE | Contact / Contact E-mail / Contact Phone | — | Person at the provider. |
| RPT | ROUTING RULES | keep | — | Number of symbol routing rules using this provider. |
| RPT | ADDED AT | Added (UTC) | UTC | When the provider was added. |
| RPT | OPEN POSITIONS | Positions | — | Number of open positions on the account. |
| RPT | EXPOSURE (LOTS) | Exposure (lots) | lots | Total open volume of the account. |
| RPT | FLOATING P&L | Floating P/L ($) | $ | Profit/loss of open positions now. |
| RPT | MARGIN LEVEL % | Margin Level (%) | % | Equity ÷ used margin × 100. |
| RPT | MARGIN CALL THRESHOLD % | Margin Call Level (%) | % | Margin level that triggers the warning. |
| RPT | STOP-OUT THRESHOLD % | Stop-out Level (%) | % | Margin level that auto-closes positions. |
| RPT | COLUMNS (header menu) | Columns | — | Show or hide table columns. |
| RPT | Reset columns | keep | — | Restore the default columns. |
| RPT | PICK A REPORT | Pick a report | — | Empty state before a report is chosen. |
| RPT | {n} rows (stat) | {n} Rows | — | Rows in the loaded report. |

## Notifications (NTF)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| NTF | 1) NTF  NOTIFICATIONS | Notifications | — | Alerts raised by the system for staff. |
| NTF | {n} UNREAD · {n} TOTAL | {n} Unread · {n} Total | — | Unread and total notifications. |
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
| NTF | ENTITY | Related Record | — | The account/request it is about. |
| NTF | Open the record | keep | — | Go to the screen for the related record. |
| NTF | Mark read | keep | — | Mark this notification as read. |
| NTF | Reset trader password… | Reset client password… | — | Generate a new password for the client (shown once). |
| NTF | 2) DETAIL  NOTIFICATION | Notification | — | The selected notification. |
| NTF | state · type · entity · created | Status · Type · Related record · Received (UTC) | UTC | Details of the notification. |
| NTF | OPEN {CODE} | Open {screen name} | — | Go to the related screen (no code shown). |
| NTF | REVIEW KYC | Review ID check | — | Open the ID check (KYC) for this client. |
| NTF | MARK READ | Mark read | — | Mark this notification as read. |
| NTF | RESET PASSWORD | Reset client password | — | Generate a new client password. |
| NTF | NO LINKED SCREEN | No related screen | — | This notification has nothing to open. |
| NTF | SELECT A NOTIFICATION | keep | — | Empty detail state. |
| NTF | MARK ALL READ (confirm) | Mark All Read | — | Confirm dialog title. |
| NTF | MARK ALL (button) | Mark all read | — | Confirm button. |
| NTF | RESET TRADER PASSWORD (confirm) | Reset Client Password | — | Confirm dialog title. |
| NTF | RESET (button) | Reset password | — | Confirm button. |
| NTF | NEW PASSWORD · SHOWN ONCE | New Password (Shown Once) | — | Copy it now; it cannot be shown again. |

## Live Exposure (EXP)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| EXP | 1) EXP  EXPOSURE BY SYMBOL | Exposure by Symbol | — | Open client volume per symbol, broker-wide. |
| EXP | <n> POSITIONS · <lots> LOTS · CLIENT P/L ±x | {n} Positions · {x} lots · Floating P/L ($) | lots / $ | Totals for everything shown. |
| EXP | BOOK (label) | Trade Handling | — | Filter by how the positions are handled. |
| EXP | ALL · A-BOOK · B-BOOK | All · Market book (A-book) · Broker book (B-book) | — | Show all, market-book or broker-book positions. |
| EXP | GROUP (label) + group chips | Group | — | Filter by client group. |
| EXP | SYMBOL | keep | — | Symbol. |
| EXP | POSITIONS | keep | — | Number of open positions. |
| EXP | BUY VOLUME | Buy Volume (lots) | lots | Total lots clients hold long. |
| EXP | SELL VOLUME | Sell Volume (lots) | lots | Total lots clients hold short. |
| EXP | NET | Net Volume (lots) | lots | Buy minus sell volume; the broker's exposure. |
| EXP | NOTIONAL | Exposure ($) | $ | Net volume × contract size × current price. |
| EXP | A / B POS | Market / Broker Book Positions | — | Positions in the market book vs the broker book. |
| EXP | AVERAGE OPEN | Average Open Price | — | Volume-weighted open price of the net volume. |
| EXP | CLIENT PROFIT / LOSS | Floating P/L ($) | $ | Clients' profit/loss on open positions now. |
| EXP | PRICE | Current Price | — | Latest price of the symbol. |
| EXP | MAXIMUM EXPOSURE | Max Exposure (lots) | lots | Net-volume limit set on the symbol. |
| EXP | Filter positions to this symbol | keep | — | Show only this symbol in Open Positions. |
| EXP | Close every position on this symbol… | Close all positions on this symbol… | — | Close all clients' positions on the symbol at market. |
| EXP | Symbol settings | keep | — | Open this symbol's settings. |
| EXP | 2) LIM  RISK LIMITS | Risk Limits | — | Broker-wide limits from the Risk screen. |
| EXP | EDIT ON RISK | Edit on Risk screen | — | Change these limits on the Risk screen. |
| EXP | TOTAL EXPOSURE | Exposure Limit ($) | $ | Broker-wide exposure cap. |
| EXP | MAX POSITIONS / ACCOUNT | Max Positions per Account | — | Open-position cap per account. |
| EXP | DEALING MODE | Dealing | — | Manual dealing or Automatic dealing. |
| EXP | TRADING (OPEN / CLOSE-ONLY / HALTED) | Trading (Open / Close-only / Trading halt) | — | Broker-wide trading state. |
| EXP | RISK SETTINGS UNAVAILABLE | keep | — | Limits could not be loaded. |
| EXP | 3) POS  OPEN POSITIONS · DEALER VIEW | Open Positions | — | Every client position, with dealer actions. |
| EXP | <shown> SHOWN OF <total> | {n} Shown of {m} | — | Positions matching the filters. |
| EXP | CLOSE BY SYMBOL | Close all shown positions | — | Close every position in the list at market. |
| EXP | SYMBOL (label) + chips | Symbol | — | Filter positions by symbol. |
| EXP | search "account · client" | Search account or client | — | Search box. |
| EXP | TICKET | Ticket # | — | Position number. |
| EXP | ACCOUNT | keep | — | Client account number. |
| EXP | CLIENT | keep | — | Client name. |
| EXP | GROUP | keep | — | Client group. |
| EXP | SIDE | keep | — | Buy or sell. |
| EXP | LOTS | Volume (lots) | lots | Size of the position. |
| EXP | OPEN | Open Price | — | Price the position opened at. |
| EXP | S/L | SL | — | Stop loss price. |
| EXP | T/P | TP | — | Take profit price. |
| EXP | PROFIT / LOSS | Floating P/L ($) | $ | Profit/loss of the position now. |
| EXP | BOOK ("A"/"B") | Handling | — | Market book (A) or Broker book (B). |
| EXP | OPENED | Opened (UTC) | UTC | When the position opened. |
| EXP | ACTIONS | keep | — | Row actions. |
| EXP | Modify SL / TP… | Change stop loss / take profit… | — | Set new SL/TP prices. |
| EXP | Close at market… | keep | — | Close the whole position at the current price. |
| EXP | Close part… | Close part of position… | — | Close some of the lots. |
| EXP | Close by | keep | — | Close against an opposite position of the same client. |
| EXP | Close by… (no opposite <SYM> position) | keep | — | Disabled: no opposite position to close against. |
| EXP | Reverse… | Reverse position… | — | Flip the position to the other side. |
| EXP | Open client <acc> | keep | — | Open the client's account page. |
| EXP | MODIFY POSITION (dialog) | Change Stop Loss / Take Profit | — | Dialog title. |
| EXP | CLOSE POSITION (dialog) | Close Position | — | Confirm dialog title. |
| EXP | CLOSE (button) | Close position | — | Confirm button. |
| EXP | CLOSE BY (dialog) | Close By | — | Confirm dialog title. |
| EXP | CLOSE PART (dialog) | Close Part of Position | — | Confirm dialog title. |
| EXP | LOTS (input) | Volume to close (lots) | lots | How many lots to close. |
| EXP | REVERSE POSITION (dialog) | Reverse Position | — | Dialog title. |
| EXP | How | Reverse method | — | Flip in place, or close and reopen opposite. |
| EXP | FLIP IN PLACE / CLOSE + REOPEN OPPOSITE | Flip in place / Close and reopen opposite | — | Reverse options. |
| EXP | CLOSE ALL POSITIONS / CLOSE BY SYMBOL (dialog) | Close All Shown Positions | — | Confirm dialog title. |
| EXP | CLOSE ALL (button) | Close all | — | Confirm button. |
| EXP | 4) FEED  LIVE ACTIVITY · BROKER-WIDE | Live Activity | — | Latest order events across the broker. |
| EXP | REQUOTE (log action) | New price | — | A new price was offered to the client. |
| EXP | FILL / ACCEPT / REJECT / STOP / MODIF | Filled / Accepted / Rejected / Stopped / Modified | — | Order event types. |
| EXP | NO ACTIVITY | No activity | — | Empty state. |

## Trade History (DLS)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DLS | 1) DLS  TRADE HISTORY | Closed Trades | — | Every closed trade, newest first. |
| DLS | N SHOWN OF M · NET ±x | {n} Shown of {m} · Closed P/L ($) | $ | Count and total profit/loss of the shown trades. |
| DLS | ALL · PROFIT · LOSS · VOIDED · TODAY | All · Profit · Loss · Voided · Today | — | Quick filters. |
| DLS | search "account · client · symbol" | Search account, client or symbol | — | Search box. |
| DLS | TICKET | Ticket # | — | Trade number. |
| DLS | ACCOUNT | keep | — | Client account number. |
| DLS | CLIENT | keep | — | Client name. |
| DLS | SYMBOL | keep | — | Symbol. |
| DLS | SIDE | keep | — | Buy or sell. |
| DLS | VOLUME | Volume (lots) | lots | Size of the trade. |
| DLS | OPEN | Open Price | — | Price it opened at. |
| DLS | CLOSE | Close Price | — | Price it closed at. |
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
| DLS | VOID DEAL (dialog) | Void Closed Trade | — | Confirm dialog title. |
| DLS | VOID (button) | Void trade | — | Confirm button. |
| DLS | REPLAY · <ticket> (dialog) | Fill Details · Ticket # | — | Dialog title. |
| DLS | DELETE DEAL (dialog) | Delete Closed Trade | — | Confirm dialog title. |
| DLS | DELETE (button) | Delete trade | — | Confirm button. |
| DLS | REASON | Reason | — | Why the trade is deleted (kept in the audit log). |

## Symbols (SYM)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SYM | 1) LIM  EXPOSURE LIMITS · NET LOTS PER SYMBOL | Exposure Limits per Symbol | — | Net-volume limit per symbol and how close it is. |
| SYM | SYMBOL | keep | — | Symbol. |
| SYM | NET LIMIT | Max Exposure (lots) | lots | Largest net volume allowed on the symbol. |
| SYM | NOW | Net Volume Now (lots) | lots | Current buy minus sell volume. |
| SYM | STATUS (OK / NEAR LIMIT / OVER LIMIT / NO LIMIT) | keep | — | How the net volume compares with the limit. |
| SYM | 2) SYM  SYMBOLS · SPREADS · SESSIONS | Symbols | — | Symbol pricing, sizes and trading hours. |
| SYM | <n> ENABLED · <n> TOTAL | {n} Enabled · {n} Total | — | Symbols clients can trade. |
| SYM | <n> SYMBOL(S) CHANGED · NOT SAVED | {n} symbols changed, not saved | — | Unsaved edits. |
| SYM | DISCARD | Discard changes | — | Throw away unsaved edits. |
| SYM | SAVE CHANGES | Save changes | — | Save all edited rows. |
| SYM | ALL · <CATEGORY> · ENABLED · DISABLED (chips) | keep | — | Filter symbols. |
| SYM | CATEGORY | Asset Class | — | Metals, FX, indices… |
| SYM | DIGITS | keep | — | Decimals in the price; 1 point = the last digit. |
| SYM | MARKUP | Spread Markup (points) | points | Extra spread the broker adds. |
| SYM | COMMISSION / LOT | Commission ($ per lot) | $ per lot | Fee per lot traded. |
| SYM | SWAP LONG | Swap Long ($ per lot) | $ per lot | Overnight fee for buy positions. |
| SYM | SWAP SHORT | Swap Short ($ per lot) | $ per lot | Overnight fee for sell positions. |
| SYM | MINIMUM LOT | Min Volume (lots) | lots | Smallest trade size. |
| SYM | MAXIMUM LOT | Max Volume (lots) | lots | Largest trade size. |
| SYM | STEP | Volume Step (lots) | lots | Size increment. |
| SYM | MAXIMUM EXPOSURE | Max Exposure (lots) | lots | Largest net volume allowed. |
| SYM | HEDGED MARGIN % | Hedged Margin (%) | % | Margin charged on opposite positions. |
| SYM | TRADING MODE | Allowed Sides | — | Both sides, buy only or sell only. |
| SYM | SESSIONS / EDIT… | Trading Hours (UTC) | UTC | When the symbol can trade. |
| SYM | ENABLED (ON/OFF) | keep | — | Whether clients can trade it. |
| SYM | CHANGED (chip) | Not saved | — | Row has unsaved edits. |
| SYM | Trading sessions… | Trading hours… | — | Edit the trading hours. |
| SYM | Disable (stage) / Enable (stage) | Disable / Enable (unsaved) | — | Marks the change; save to apply. |
| SYM | Revert this row | Undo changes on this row | — | Discard this row's edits. |
| SYM | HEDGED MARGIN x% ON <SYM> (dialog) | Hedged Margin (%) · <symbol> | % | Confirm dialog title. |
| SYM | SAVE SYMBOL CHANGES (dialog) | Save Symbol Changes | — | Confirm dialog title. |
| SYM | TRADING SESSIONS · <SYM> (dialog) | Trading Hours (UTC) · <symbol> | UTC | Dialog title. |
| SYM | SESSIONS (input) | Trading hours (UTC) | UTC | e.g. MON 00:00-23:59; empty = 24/7. |
| SYM | SAVE SESSIONS | Save trading hours | — | Confirm button. |

## Groups (GRP)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| GRP | 1) GRP  GROUPS | Groups | — | Client groups: pricing, leverage and handling. |
| GRP | <n> GROUPS · <n> HALTED | {n} Groups · {n} Trading halted | — | Group totals. |
| GRP | DESK <state> | Dealing: Manual / Automatic | — | Broker-wide dealing switch. |
| GRP | + GROUP | Add group | — | Create a new group. |
| GRP | NAME | keep | — | Group name. |
| GRP | ROUTING | Trade Handling | — | Broker book, Market book or Reverse trading. |
| GRP | A-BOOK · LP | Market book (A-book) | — | Trades passed to a liquidity provider. |
| GRP | B-BOOK | Broker book (B-book) | — | The broker keeps the client's risk. |
| GRP | DEALING DESK | Broker book · Manual dealing | — | Broker book where a dealer reviews every order. |
| GRP | REVERSAL | Reverse trading | — | Trades reversed into a master account. |
| GRP | COVERAGE · SYS | Broker hedge account | — | Group holding the broker's own hedge account. |
| GRP | PRICING ("Source" / "Custom (n symbols)") | Pricing ("Same as symbol" / "Custom on n symbols") | — | Whether the group has its own spreads. |
| GRP | DEALER | Dealing | — | How this group's orders are filled. |
| GRP | AUTO-FILL | Automatic dealing | — | Orders fill automatically. |
| GRP | MANUAL | Manual dealing | — | Dealer reviews every order. |
| GRP | BROKER DEFAULT | Same as broker switch | — | Follows the broker-wide dealing switch. |
| GRP | · FORCED | · Forced | — | Group ignores the broker switch. |
| GRP | · MIRROR | · Copy rule | — | Group has a copy rule. |
| GRP | TRADING (BOTH SIDES / BUY ONLY / SELL ONLY) | Allowed Sides | — | Which sides the group may open. |
| GRP | DEFAULT | Default Group | — | New accounts join this group. |
| GRP | STATUS (TRADING / HALTED) | Status (Trading / Trading halted) | — | Whether the group can open trades. |
| GRP | Edit group… | keep | — | Change group settings. |
| GRP | Allowed symbols… | keep | — | Choose which symbols the group trades. |
| GRP | Delete group… | keep | — | Delete (only when empty). |
| GRP | Halt trading… / Resume trading… | Halt group trading… / Resume group trading… | — | Stop or restart new trades for this group. |
| GRP | Add new group… | Add group… | — | Create a new group. |
| GRP | 2) PRC  PRICING OVERRIDES | Group Pricing | — | Spreads, commission and swaps for this group. |
| GRP | precedence text line | Who decides the client spread | — | Order: account › group › symbol. |
| GRP | RAW + PTS | Market Spread (points) | points | Spread from the price feed before markup. |
| GRP | MODE (TARGET / MARKUP / INHERIT) | Spread Setting (Fixed spread / Spread markup / Same as symbol) | — | How this group's spread is set. |
| GRP | VALUE + PTS | Setting Value (points) | points | Fixed spread or markup, in points. |
| GRP | CLIENT SPREAD + PTS | Client Spread (points) | points | Spread the client sees. |
| GRP | SOURCE (THIS GROUP / BROKER SYMBOL) | Set By (This group / Symbol) | — | Which level decides the spread. |
| GRP | COMMISSION / LOT | Commission ($ per lot) | $ per lot | Fee per lot; "Same as symbol" if blank. |
| GRP | SWAP LONG / SWAP SHORT | Swap Long / Swap Short ($ per lot) | $ per lot | Overnight fee per side. |
| GRP | inherits | Same as symbol | — | No group value; symbol decides. |
| GRP | ACTIONS / EDIT | Actions / Edit | — | Open pricing editor. |
| GRP | Edit pricing… | keep | — | Change this symbol's pricing for the group. |
| GRP | Reset override (inherit)… | Reset to symbol pricing… | — | Remove the group's own pricing. |
| GRP | NEW GROUP / EDIT GROUP (form) | New Group / Edit Group | — | Form title. |
| GRP | Name | keep | — | Group name. |
| GRP | Leverage | keep | — | Written 1:N. |
| GRP | Margin call % | Margin call level (%) | % | Level that triggers the warning. |
| GRP | Stop out % | Stop-out level (%) | % | Level that auto-closes positions. |
| GRP | Book / routing | Trade handling | — | Broker book, Market book or Broker book with manual dealing. |
| GRP | Account mode (LIVE + DEMO / LIVE ONLY / DEMO ONLY) | Account kinds allowed (Live and demo / Live only / Demo only) | — | Which accounts may join. |
| GRP | Advanced dealing options | keep | — | Show the dealing override. |
| GRP | Dealer | Dealing | — | How orders fill for this group. |
| GRP | DESK-CONTROLLED (queues when the desk is on) | Same as broker switch | — | Waits for a dealer only while Manual dealing is on. |
| GRP | NEVER QUEUE (ignores the desk) | Always automatic dealing | — | Never waits for a dealer. |
| GRP | ALWAYS QUEUE | Always manual dealing | — | Every order waits for a dealer. |
| GRP | Trading | Allowed sides | — | Which sides this group may open. |
| GRP | Max lot | Max volume (lots) | lots | Largest trade size; empty = no cap. |
| GRP | Swap-free | keep | — | No overnight fees. |
| GRP | Force dealer mode | Ignore broker dealing switch | — | Group keeps its own dealing setting. |
| GRP | Default group for new accounts | keep | — | New accounts join this group. |
| GRP | CREATE / SAVE | Create group / Save | — | Form button. |
| GRP | ALLOWED SYMBOLS · <GROUP> (form) | Allowed Symbols · <group> | — | Form title. |
| GRP | Restrict to the chosen symbols | keep | — | Off = group trades every enabled symbol. |
| GRP | Symbols this group may trade | keep | — | Tick the symbols allowed. |
| GRP | HALT GROUP / RESUME GROUP (dialog) | Halt Group Trading / Resume Group Trading | — | Confirm dialog title. |
| GRP | DELETE GROUP (dialog) | Delete Group | — | Confirm dialog title. |
| GRP | TENANT NAME (<x>) | Broker name | — | Type the broker name to confirm. |
| GRP | PRICING · <OWNER> · <SYM> (form) | Pricing · <group> · <symbol> | — | Pricing editor title. |
| GRP | Spread | Spread setting | — | Same as symbol / Spread markup / Fixed spread. |
| GRP | INHERIT (next level decides) | Same as symbol | — | The next level decides. |
| GRP | MARKUP (+ points on the raw spread) | Spread markup | points | Points added to the market spread. |
| GRP | TARGET (total client spread) | Fixed spread | points | Total client spread, whatever the market spread. |
| GRP | Points | Value (points) | points | 1 point = the last price digit. |
| GRP | Commission per lot | Commission ($ per lot) | $ per lot | Empty = same as symbol. |
| GRP | Swap long / Swap short | Swap long / Swap short ($ per lot) | $ per lot | Empty = same as symbol. |
| GRP | RESET PRICING OVERRIDE (dialog) | Reset to Symbol Pricing | — | Confirm dialog title. |
| GRP | RESET (button) | Reset | — | Confirm button. |

## Account Types (ATY)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| ATY | 1) ATY  ACCOUNT TYPES | Account Types | — | Types clients choose (Standard, Raw…). |
| ATY | <n> TYPES · <n> ENABLED | {n} Types · {n} Enabled | — | Totals. |
| ATY | + TYPE | Add account type | — | Create a new type. |
| ATY | NAME | keep | — | Type name. |
| ATY | DESCRIPTION | keep | — | Staff note. |
| ATY | PRICING | Pricing Hint | — | Text shown to clients. |
| ATY | MARKUP + PTS | Spread Markup (points) | points | Default markup for this type. |
| ATY | COMMISSION / LOT | Commission ($ per lot) | $ per lot | Default commission. |
| ATY | SWAP LONG / SWAP SHORT | Swap Long / Swap Short ($ per lot) | $ per lot | Default swaps. |
| ATY | ORDER | Sort Order | — | Position in the client's list. |
| ATY | DEFAULT | keep | — | Chosen for new accounts. |
| ATY | STATUS (ENABLED / DISABLED) | keep | — | Whether new accounts can pick it. |
| ATY | Edit… | keep | — | Change the type. |
| ATY | Disable… / Enable… | keep | — | Stop or allow new accounts on this type. |
| ATY | Add new type… | Add account type… | — | Create a new type. |
| ATY | 2) PRC  PRICING OVERRIDES | Account Type Pricing | — | Per-symbol pricing for this type. |
| ATY | WHO DECIDES A CLIENT'S SPREAD… | Who decides the client spread | — | Order: account › type per symbol › type default › group › symbol. |
| ATY | RAW + PTS | Market Spread (points) | points | Spread from the price feed. |
| ATY | MODE | Spread Setting | — | Fixed spread / Spread markup / Same as group. |
| ATY | VALUE + PTS | Setting Value (points) | points | Fixed spread or markup. |
| ATY | CLIENT SPREAD + PTS | Client Spread (points) | points | Spread the client sees. |
| ATY | per group | Same as group | — | The client's group decides. |
| ATY | SOURCE (THIS TYPE · SYMBOL / TYPE DEFAULT / CLIENT'S GROUP) | Set By (This type, per symbol / Type default / Client's group) | — | Which level decides. |
| ATY | <x> (type) / inherits | <x> (type) / Same as group | — | Type default, or next level decides. |
| ATY | COMMISSION / LOT, SWAP LONG, SWAP SHORT (pricing) | Commission / Swap Long / Swap Short ($ per lot) | $ per lot | Per-symbol values. |
| ATY | Edit pricing… | keep | — | Change this symbol's pricing. |
| ATY | Reset override (inherit)… | Reset to next level… | — | Remove this type's own pricing. |
| ATY | NEW ACCOUNT TYPE / EDIT ACCOUNT TYPE (form) | New Account Type / Edit Account Type | — | Form title. |
| ATY | Name / Description | keep | — | Form fields. |
| ATY | Pricing hint | keep | — | Shown to clients, e.g. "spreads from 0.0 + $3.5/lot". |
| ATY | Sort order | keep | — | Position in the client's list. |
| ATY | Default for new accounts | keep | — | New accounts get this type. |
| ATY | DISABLE / ENABLE ACCOUNT TYPE (dialog) | Disable / Enable Account Type | — | Confirm dialog title. |

## Copy Rules (MIR)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| MIR | 1) MIR  MIRROR · REVERSE TRADING RULES | Copy Rules | — | Copy or reverse trades from one account/group into another. |
| MIR | <n> ACTIVE OF <n> | {n} Active of {m} | — | Rules running now. |
| MIR | + RULE | Add copy rule | — | Create a new copy rule. |
| MIR | SOURCE | Copied From | — | Account or group being copied. |
| MIR | DIRECTION (REVERSE / SAME) | Copy Type (Reverse / Copy) | — | Same side, or opposite side. |
| MIR | TARGET ACCOUNT | Copied Into | — | Account that receives the trades. |
| MIR | MULTIPLIER | Volume Multiplier | — | Copied volume = original × this. |
| MIR | FILL PRICE (SOURCE PRICE / MARKET) | Fill Price (Original price / Market) | — | Price the copied trade fills at. |
| MIR | SYMBOLS | keep | — | Symbols copied; ALL = every symbol. |
| MIR | LIMITS | keep | — | Max open lots and max daily loss. |
| MIR | STATUS (ACTIVE / DISABLED / KILLED) | Status (Active / Disabled / Stopped by limit) | — | Rule state. |
| MIR | SINCE | Created (UTC) | UTC | When the rule was created. |
| MIR | ACTIONS (DISABLE / ENABLE) | keep | — | Toggle the rule. |
| MIR | Disable… / Enable… | keep | — | Stop or start the rule. |
| MIR | Edit multiplier / fill / symbols… | Edit copy rule… | — | Change multiplier, fill price, symbols. |
| MIR | Add new mirror rule… | Add copy rule… | — | Create a new copy rule. |
| MIR | NEW MIRROR RULE / EDIT MIRROR RULE (form) | New Copy Rule / Edit Copy Rule | — | Form title. |
| MIR | Source (ONE ACCOUNT / A GROUP) | Copy from (One account / A group) | — | What is copied. |
| MIR | Source account number | Copied from account | — | When copying one account. |
| MIR | Source group | Copied from group | — | When copying a group. |
| MIR | Target account number | Copied into account | — | Account that receives trades. |
| MIR | Direction (REVERSE / COPY (SAME)) | Copy type (Reverse / Copy) | — | Opposite or same side. |
| MIR | Multiplier | Volume multiplier | — | Copied volume = original × this. |
| MIR | Fill price | keep | — | Original price or market price. |
| MIR | Symbol filter | Symbols | — | Comma-separated; empty = all. |
| MIR | Max open lots | Max open volume (lots) | lots | Empty = no cap. |
| MIR | Max daily loss | Max daily loss ($) | $ | Rule stops after this loss; empty = no cap. |
| MIR | DISABLE / ENABLE MIRROR RULE (dialog) | Disable / Enable Copy Rule | — | Confirm dialog title. |

## Risk (RISK)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RISK | OPEN EXPOSURE (KPI) | Exposure ($) | $ | Value of all open client volume. |
| RISK | FLOATING P/L · CLIENTS (KPI) | Client Floating P/L ($) | $ | Clients' profit/loss on open positions now. |
| RISK | OPEN POSITIONS (KPI) | keep | — | Open positions across all accounts. |
| RISK | ACCOUNTS AT RISK (KPI) | Accounts at Margin Call | — | Accounts at or below margin call level. |
| RISK | <n> AT STOP-OUT (KPI sub) | {n} at stop-out | — | Accounts at or below stop-out level. |
| RISK | 1) RISK  BROKER RISK SETTINGS | Broker Risk Settings | — | Dealing, limits and trading state. |
| RISK | DEALING MODE (section) | Dealing | — | Manual or automatic dealing. |
| RISK | Manual dealing (ON · orders wait for a dealer / OFF · auto-fill) | Manual dealing (On · orders wait for dealer / Off · automatic dealing) | — | Broker-wide dealing switch. |
| RISK | TURN ON / TURN OFF | Turn on / Turn off | — | Switch manual dealing. |
| RISK | Smart dealer accept % | Auto-accept slippage (%) | % | Orders with less slippage fill without a dealer. |
| RISK | Smart dealer reject % | Auto-reject slippage (%) | % | Orders with more slippage are rejected without a dealer. |
| RISK | EDIT | keep | — | Change the value. |
| RISK | EXPOSURE & POSITION LIMITS (section) | Limits | — | Broker-wide caps. |
| RISK | Total exposure limit | Exposure limit ($) | $ | Broker-wide exposure cap. |
| RISK | Max open positions / account | Max positions per account | — | Cap on open positions per account. |
| RISK | TRADING STATE (section) | Trading State | — | Open, close-only or halted. |
| RISK | Trading (OPEN / HALTED) | Trading (Open / Trading halt) | — | Whether new trades are allowed. |
| RISK | EMERGENCY | Emergency controls | — | Go to the Emergency screen. |
| RISK | Close-only (ON / OFF) | keep | — | Only closing allowed. |
| RISK | DEALING MODE ON / OFF (dialog) | Manual Dealing On / Off | — | Confirm dialog title. |
| RISK | SMART DEALER (dialog) | Auto-accept / Auto-reject Slippage | — | Dialog title. |
| RISK | ACCEPT % · REJECT % | Accept (%) · Reject (%) | % | Two numbers, e.g. 0.5 2. |
| RISK | LIMITS (dialog) | Limits | — | Dialog title. |
| RISK | EXPOSURE USD · MAX POSITIONS | Exposure limit ($) · Max positions | $ | Two numbers; 0 = no limit. |
| RISK | 2) MRG  MARGIN WATCH · LOWEST FIRST | Margin Watch | — | Accounts with positions, lowest margin level first. |
| RISK | <n> WITH POSITIONS · <n> AT RISK | {n} with positions · {n} at margin call | — | Totals. |
| RISK | FULL MARGIN SCREEN | Open Margin screen | — | Go to the full Margin screen. |
| RISK | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| RISK | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| RISK | USED MARGIN | Used Margin ($) | $ | Margin held by open positions. |
| RISK | FREE MARGIN | Free Margin ($) | $ | Equity minus used margin. |
| RISK | POSITIONS | keep | — | Open positions. |
| RISK | EXPOSURE | Exposure (lots) | lots | Total open volume. |
| RISK | FLOATING PROFIT / LOSS | Floating P/L ($) | $ | Profit/loss of open positions. |
| RISK | MARGIN LEVEL | Margin Level (%) | % | Equity ÷ used margin × 100. |
| RISK | STATUS (NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK) | keep | — | Where the margin level sits. |
| RISK | Open client 360 | Open client | — | Open the client's account page. |
| RISK | Live exposure · this account | Live exposure for this account | — | Open Live Exposure filtered to it. |
| RISK | Close all <n> positions… | keep | — | Close every position of the account at market. |
| RISK | CLOSE ALL POSITIONS (dialog) | keep | — | Confirm dialog title. |

## Risk Radar (RDR)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| RDR | ACCOUNTS TRACKED (KPI) | Accounts Checked | — | Accounts with trades in the last 30 days. |
| RDR | FLAGGED (KPI) | Flagged | — | Accounts with at least one pattern. |
| RDR | SCALP (KPI) | Scalping | — | Very short holding times. |
| RDR | MARTINGALE (KPI) | keep | — | Doubling volume after losses. |
| RDR | LATENCY ARB (KPI) | Latency Arbitrage | — | Profits from delayed prices. |
| RDR | NEWS TRADER (KPI) | News Trading | — | Trades clustered around news. |
| RDR | SAME-IP CLUSTERS (KPI) | Shared IP Groups | — | Accounts signing in from the same IP. |
| RDR | TOP PROFIT / DAY (KPI) | Top Profit per Day ($) | $ | Highest average daily profit. |
| RDR | 1) RDR  RISK RADAR · 30-DAY BEHAVIOUR | Risk Radar (30 days) | — | Trading-pattern flags over 30 days. |
| RDR | <shown> OF <total> · <n> SAME-IP | {n} of {m} · {k} shared IP | — | Totals. |
| RDR | ALL · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS | All · Flagged · Scalping · Martingale · Latency arbitrage · News trading | — | Filters. |
| RDR | ACCOUNT | keep | — | Account number. |
| RDR | FLAGS (— / LOW / MED / HIGH) | Risk Score (— / Low / Medium / High) | — | How many patterns matched. |
| RDR | WHICH | Patterns | — | Which patterns matched. |
| RDR | TRADES · 30D | Trades (30 days) | — | Closed trades in 30 days. |
| RDR | WIN RATE | Win Rate (%) | % | Share of trades in profit. |
| RDR | AVERAGE HOLD | Average Hold Time | — | Average time a position stays open. |
| RDR | AVERAGE LOT | Average Volume (lots) | lots | Average trade size. |
| RDR | P/L PER DAY | Closed P/L per Day ($) | $ | Average daily profit/loss. |
| RDR | Flags · stats (detail) | Show details | — | Open the detail panel. |
| RDR | Open client 360 | Open client | — | Open the client's account page. |
| RDR | Live exposure | keep | — | Open Live Exposure for this account. |
| RDR | 2) ACCT  FLAGGED ACCOUNT | Flagged Account | — | Detail of the selected account. |
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
| RDR | SAME-IP CLUSTERS · <n> | Shared IP Groups · {n} | — | Accounts sharing an IP address. |
| RDR | <ip> <n> ACCOUNTS | keep | — | Accounts on that IP. |
| RDR | SELECT AN ACCOUNT | keep | — | Empty detail state. |

## Emergency (EMG)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| EMG | 1) HALT  HALT ALL NEW TRADING | Trading Halt | — | Stop all new trades broker-wide. |
| EMG | status (TRADING NORMALLY / HALTED · NO NEW TRADING) | Status (Trading normally / Trading halt: no new trades) | — | Broker-wide trading state. |
| EMG | HALT ALL NEW TRADING | Halt all new trading | — | Refuse every new order broker-wide. |
| EMG | RESUME ALL TRADING | keep | — | Allow new orders again. |
| EMG | type the tenant name to confirm | Type the broker name to confirm | — | Safety check. |
| EMG | KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE — not available yet | Sign out all clients · Incident log (not available yet) | — | Planned controls. |
| EMG | 2) CLOSE-ONLY  CLOSE-ONLY MODE | Close-only | — | Clients can only close positions. |
| EMG | status (OPENS ALLOWED / CLOSE-ONLY · OPENS BLOCKED) | Status (New trades allowed / Close-only) | — | Close-only state. |
| EMG | ENABLE CLOSE-ONLY | Turn on close-only | — | Block new trades, allow closes. |
| EMG | RESUME NORMAL TRADING | keep | — | End close-only. |
| EMG | manual dealing (ON · orders wait for a dealer / OFF · auto-fill) | Manual dealing (On / Off · automatic dealing) | — | Broker-wide dealing switch. |
| EMG | RISK › | Risk screen › | — | Change it on the Risk screen. |
| EMG | 3) GROUPS  HALT ONE GROUP | Halt a Group | — | Stop new trades for one group. |
| EMG | {n} OF {m} HALTED | {n} of {m} halted | — | Groups halted. |
| EMG | GROUP (· default) | Group | — | Group name; default group marked. |
| EMG | TYPE | Trade Handling | — | Broker book, Market book… |
| EMG | LEVERAGE | keep | — | 1:N. |
| EMG | STATUS (TRADING / HALTED) | Status (Trading / Trading halt) | — | Group state. |
| EMG | ACTIONS (HALT / RESUME) | Actions (Halt / Resume) | — | Toggle on double-click. |
| EMG | Halt group… / Resume group… | keep | — | Stop or restart the group. |
| EMG | 4) SYMBOLS  DISABLE ONE SYMBOL | Disable a Symbol | — | Stop new trades on one symbol. |
| EMG | {n} OF {m} DISABLED | {n} of {m} disabled | — | Symbols disabled. |
| EMG | search "symbol" | Search symbol | — | Search box. |
| EMG | SYMBOL | keep | — | Symbol. |
| EMG | CATEGORY | Asset Class | — | Metals, FX, indices… |
| EMG | TRADING MODE (BOTH / BUY ONLY / SELL ONLY) | Allowed Sides (Both / Buy only / Sell only) | — | Which sides can open. |
| EMG | STATUS (ENABLED / DISABLED) | keep | — | Symbol state. |
| EMG | ACTIONS (HALT / RE-ENABLE) | Actions (Disable / Enable) | — | Toggle on double-click. |
| EMG | Halt symbol… / Re-enable symbol… | Disable symbol… / Enable symbol… | — | Stop or restart new trades on it. |
| EMG | HALT ALL NEW TRADING / RESUME ALL TRADING (dialog) | Halt All New Trading / Resume All Trading | — | Confirm dialog title. |
| EMG | ENABLE CLOSE-ONLY MODE / RESUME NORMAL TRADING (dialog) | Turn On Close-only / Resume Normal Trading | — | Confirm dialog title. |
| EMG | HALT GROUP / RESUME GROUP (dialog) | Halt Group / Resume Group | — | Confirm dialog title. |
| EMG | DISABLE SYMBOL / RE-ENABLE SYMBOL (dialog) | Disable Symbol / Enable Symbol | — | Confirm dialog title. |
| EMG | TENANT NAME (<x>) | Broker name | — | Type the broker name to confirm. |

## Margin (MRG)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| MRG | 1) MRG  MARGIN · LOWEST LEVEL FIRST | Margin | — | Accounts with positions, lowest margin level first. |
| MRG | <n> ACCOUNTS · <n> AT OR BELOW MARGIN CALL | {n} accounts · {k} at margin call | — | Totals. |
| MRG | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| MRG | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| MRG | USED MARGIN | Used Margin ($) | $ | Margin held by open positions. |
| MRG | FREE MARGIN | Free Margin ($) | $ | Equity minus used margin. |
| MRG | POSITIONS | keep | — | Open positions. |
| MRG | EXPOSURE | Exposure (lots) | lots | Total open volume. |
| MRG | FLOATING PROFIT / LOSS | Floating P/L ($) | $ | Profit/loss of open positions. |
| MRG | MARGIN LEVEL | Margin Level (%) | % | Equity ÷ used margin × 100. |
| MRG | STATUS (NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK) | keep | — | Where the margin level sits. |
| MRG | Open client 360 | Open client | — | Open the client's account page. |
| MRG | Live exposure · this account | Live exposure for this account | — | Open Live Exposure filtered to it. |
| MRG | Close all <n> positions… | keep | — | Close every position of the account. |

## Liquidity Providers (LP)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| LP | 1) LP  LIQUIDITY PROVIDERS | Liquidity Providers | — | Providers that can take market-book trades. |
| LP | <n> LPS · <n> ACTIVE | {n} Providers · {n} Connected | — | Totals. |
| LP | ROUTING | Routing rules | — | Open the routing rules screen. |
| LP | + LP | Add liquidity provider | — | Create a provider record. |
| LP | PROVIDER | keep | — | Provider name. |
| LP | PROTOCOL | Connection Type | — | FIX, REST… |
| LP | STATUS | keep | — | Prospective, negotiating, contracted or connected. |
| LP | ROUTING RULES | keep | — | Rules sending trades to this provider. |
| LP | CONTACT | keep | — | Person at the provider. |
| LP | SINCE | Added (UTC) | UTC | When the provider was added. |
| LP | Status: PROSPECTIVE / NEGOTIATING / CONTRACTED / CONNECTED | Status: Prospective / Negotiating / Contracted / Connected | — | Set the provider's status. |
| LP | Notes… | keep | — | Edit notes. |
| LP | Add new LP… | Add liquidity provider… | — | Create a provider record. |
| LP | 2) BOOK  BOOK EXPOSURE · OPEN LOTS | Exposure by Trade Handling | — | Open volume in the market book vs the broker book. |
| LP | A <x> / B <x> | Market book {x} lots / Broker book {x} lots | lots | Totals (shown as money today; should be lots). |
| LP | SYMBOL | keep | — | Symbol. |
| LP | A-BOOK LOTS | Market Book (lots) | lots | Open volume passed to a liquidity provider. |
| LP | B-BOOK LOTS | Broker Book (lots) | lots | Open volume the broker keeps. |
| LP | TOTAL | Total (lots) | lots | Both books. |
| LP | A-BOOK % | Market Book (%) | % | Share of volume in the market book. |
| LP | Live exposure · this symbol | Live exposure for this symbol | — | Open Live Exposure filtered to it. |
| LP | Symbol settings | keep | — | Open the symbol's settings. |
| LP | NEW LIQUIDITY PROVIDER (form) | New Liquidity Provider | — | Form title. |
| LP | Name / Protocol / Contact / Contact e-mail / Contact phone / Notes | Name / Connection type / Contact / Contact e-mail / Contact phone / Notes | — | Form fields. |
| LP | LP NOTES (form) | Liquidity Provider Notes | — | Form title. |

## Routing Rules (ROUTE)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| ROUTE | 1) ROUTE  ROUTING RULES | Routing Rules | — | Which liquidity provider gets each symbol (planned). |
| ROUTE | <n> RULES · <n> LPS | {n} Rules · {n} Providers | — | Totals. |
| ROUTE | + RULE | Add routing rule | — | Create a rule. |
| ROUTE | planned · not executed yet | Planned: not used for trading yet | — | Rules are saved but not applied. |
| ROUTE | PRIORITY | keep | — | 1 = checked first. |
| ROUTE | RULE | keep | — | Provider and symbol. |
| ROUTE | SYMBOL (ANY) | Symbol (Any) | — | Symbol the rule covers. |
| ROUTE | LIQUIDITY PROVIDER | keep | — | Provider and its status. |
| ROUTE | ENABLED (ON/OFF) | keep | — | Rule on or off. |
| ROUTE | Delete rule… | keep | — | Remove the rule. |
| ROUTE | Add new routing rule… | Add routing rule… | — | Create a rule. |
| ROUTE | 2) RULE  SELECTED RULE | Selected Rule | — | Detail of the chosen rule. |
| ROUTE | priority / liquidity provider / LP record status / symbol / route / created | Priority / Liquidity provider / Provider status / Symbol / Trade handling / Created (UTC) | UTC | Rule details. |
| ROUTE | A-BOOK (LP) | Market book (A-book) | — | Trades go to the provider. |
| ROUTE | NOTES | keep | — | Staff notes. |
| ROUTE | CONDITIONS · EDIT / DELETE — not available yet | keep | — | Planned. |
| ROUTE | OPEN LP | Open liquidity provider | — | Go to the provider. |
| ROUTE | SELECT A RULE | keep | — | Empty detail state. |
| ROUTE | NEW ROUTING RULE (form) | New Routing Rule | — | Form title. |
| ROUTE | Liquidity provider / Symbol / Priority / Notes | keep | — | Form fields. |
| ROUTE | DELETE ROUTING RULE (dialog) | Delete Routing Rule | — | Confirm dialog title. |

## Price Feed Health (FEED)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| FEED | TRADING CORE (KPI) | Trading Server | — | Whether the trading server answers. |
| FEED | GATEWAY (KPI) | Client Connection Server | — | Whether the server clients connect to answers. |
| FEED | PRICE ALERTS (KPI) | Price Alerts | — | Whether client price alerts are running. |
| FEED | SYMBOLS TICKING (KPI) | Symbols with Live Prices | — | Symbols receiving prices now. |
| FEED | STALE · > 60 S (KPI) | Stale Prices (> 60 s) | — | Symbols with no new price for over 60 seconds. |
| FEED | EA → ENGINE p50 / p95 (KPI) | Price Delay (ms, typical / slow) | — | Time from price source to trading server. |
| FEED | ROUND TRIP (KPI) | Server Round Trip (ms) | — | Time for a request to the trading server and back. |
| FEED | ORDER ACK p50 / p95 (KPI) | Order Confirmation Time (ms, typical / slow) | — | Time to confirm an order. |
| FEED | 1) CORE  TRADING CORE · FEED STATS | Trading Server | — | Price feed statistics on the trading server. |
| FEED | EA → engine last / p50 / p95; p99 / max | Price delay (ms): last / typical / slow / slowest | — | Delay from price source. |
| FEED | samples | Samples | — | Prices measured. |
| FEED | ticks in | Prices received | — | Price updates received. |
| FEED | queue length | Waiting prices | — | Prices not processed yet. |
| FEED | dropped invalid / missing t0 | Rejected prices (invalid / no timestamp) | — | Price updates thrown away. |
| FEED | NATS out / publish failures | Prices sent / send failures | — | Internal price distribution. |
| FEED | candle write failures | Chart save failures | — | Chart bars that failed to save. |
| FEED | DB ok / fail (lag) | Database saves ok / failed (delay) | — | Database writes. |
| FEED | round-trip time | Server round trip (ms) | — | Request time to the server. |
| FEED | mono → UTC offset | Clock offset (ms) | — | Server clock vs UTC. |
| FEED | NO SNAPSHOT · trading core not reachable | No data: trading server not reachable | — | Error state. |
| FEED | 2) GW  API GATEWAY | Client Connection Server | — | Stats of the server clients connect to. |
| FEED | WS connections / disconnections | Client connections / disconnections | — | Live client links. |
| FEED | ticks forwarded | Prices sent to clients | — | Price updates forwarded. |
| FEED | NATS messages received | Internal messages received | — | Messages from the trading server. |
| FEED | order-ack p50 / p95 / samples | Order confirmation time (ms, typical / slow) / samples | — | Order confirmation speed. |
| FEED | NO SNAPSHOT · gateway not reachable | No data: client connection server not reachable | — | Error state. |
| FEED | 3) ALERTS  PRICE-ALERT ENGINE | Price Alerts | — | Client price-alert service. |
| FEED | active alerts / triggered (total) | Active alerts / Triggered (total) | — | Alert counts. |
| FEED | persist failures | Save failures | — | Alerts that failed to save. |
| FEED | hot-reload add / cancel / malformed | Alert updates: added / cancelled / invalid | — | Live alert changes. |
| FEED | 4) SYM  PER-SYMBOL FEED | Price Feed per Symbol | — | Price updates for each symbol. |
| FEED | <n> LIVE · <n> STALE / CORE NOT REACHABLE | {n} Live · {n} Stale / Trading server not reachable | — | Totals. |
| FEED | SYMBOL | keep | — | Symbol. |
| FEED | TICKS | Price Updates | — | Updates since start. |
| FEED | 60 S | Updates (60 s) | — | Updates in the last minute. |
| FEED | LAST TICK | Last Price Update | — | Seconds since the last price. |
| FEED | BID / ASK | keep | — | Latest prices. |
| FEED | SOURCE | Price Source | — | Where the price comes from. |
| FEED | FEED (LIVE / STALE) | Price Feed (Live / Stale) | — | Whether prices are arriving. |
| FEED | Symbol settings | keep | — | Open the symbol's settings. |
| FEED | Live exposure · this symbol | Live exposure for this symbol | — | Open Live Exposure filtered to it. |

## Leads (CRM)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CRM | 1) CRM  LEADS · SALES | Leads | — | Prospective clients and sales follow-up. |
| CRM | <shown> SHOWN OF <total> · <n> CONVERTED | {n} Shown of {m} · {k} became clients | — | Totals. |
| CRM | + LEAD | Add lead | — | Create a lead. |
| CRM | OPEN · <n> / NEW / CONTACTED / QUALIFIED / CONVERTED / LOST / ALL | Open · New · Contacted · Qualified · Became client · Lost · All | — | Status filters. |
| CRM | NAME | keep | — | Lead's name. |
| CRM | E-MAIL / PHONE / COUNTRY | keep | — | Contact details. |
| CRM | SOURCE | Lead Source | — | Web, referral, campaign… |
| CRM | STATUS | keep | — | Sales stage. |
| CRM | CONVERTED TO | Client Account | — | Account the lead became. |
| CRM | NOTES | keep | — | Staff notes. |
| CRM | CREATED | Created | — | Age of the lead. |
| CRM | Mark NEW / CONTACTED / QUALIFIED / LOST | Mark new / contacted / qualified / lost | — | Change the sales stage. |
| CRM | Mark CONVERTED → account… | Mark as client… | — | Link the lead to its account. |
| CRM | Add new lead… | Add lead… | — | Create a lead. |
| CRM | NEW LEAD (form) | New Lead | — | Form title. |
| CRM | Full name / E-mail / Phone / Country / Source / Notes | Full name / E-mail / Phone / Country / Lead source / Notes | — | Form fields. |
| CRM | LEAD STATUS (dialog) | Change Lead Status | — | Confirm dialog title. |
| CRM | CONVERT LEAD (dialog) | Mark Lead as Client | — | Dialog title. |
| CRM | ACCOUNT NUMBER | keep | — | The client's account number. |

## Partners (IB)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| IB | 1) IB  PARTNERS · INTRODUCING BROKERS | Partners (IB) | — | Partners who refer clients for commission. |
| IB | {n} PARTNERS · {n} CLIENTS · PAYABLE {x} | {n} Partners · {n} Clients · Owed ($) | $ | Totals. |
| IB | PAYOUT RUN | Pay all partners | — | Pay every owed partner commission. |
| IB | + PARTNER | Add partner | — | Link a partner to a client. |
| IB | ALL · PAYOUT DUE · PER LOT · PERCENTAGE | All · Owed · $ per lot · % of commission | — | Filters. |
| IB | INTRODUCING BROKER ACCOUNT | Partner Account | — | Partner's account number. |
| IB | NAME | keep | — | Partner's name. |
| IB | COMMISSION PLAN | Partner Pay Plan | — | $ per lot or % of commission. |
| IB | CLIENTS | Referred Clients | — | Clients the partner brought. |
| IB | ACTIVE | Active Clients | — | Referred clients trading this month. |
| IB | LOTS · MONTH TO DATE | Volume This Month (lots) | lots | Referred clients' lots this month. |
| IB | NET DEP · MTD | Net Deposits This Month ($) | $ | Referred clients' deposits minus withdrawals. |
| IB | COMMISSION · MONTH TO DATE | Partner Pay This Month ($) | $ | Earned this month. |
| IB | PENDING COMMISSION | Partner Pay Owed ($) | $ | Earned and not paid yet. |
| IB | ACTIONS (VIEW PAY / VIEW) | Actions (View and pay / View) | — | Row actions. |
| IB | Referred clients (detail) | Show referred clients | — | Open the detail panel. |
| IB | Pay {x} pending… | Pay {x} owed… | — | Pay the partner now. |
| IB | Edit commission plan… | Edit pay plan… | — | Change $ per lot or %. |
| IB | Open IB account 360 | Open partner account | — | Open the partner's account page. |
| IB | Add new partner… | Add partner… | — | Link a partner to a client. |
| IB | 2) IB  {no} · {NAME} / SELECT A PARTNER | {no} · {name} / Select a partner | — | Detail panel title. |
| IB | Owner / Plan / Referred clients / Payable now / Last payout | Owner / Pay plan / Referred clients / Owed now ($) / Last paid (UTC) | $ | Partner summary. |
| IB | Sub-IB levels · link · schedule — NOT AVAILABLE | Sub-partners · Referral link · Pay schedule (not available yet) | — | Planned. |
| IB | FUNNEL · MTD — NOT AVAILABLE YET | Referral funnel this month (not available yet) | — | Planned. |
| IB | REFERRED CLIENTS (section) | Referred Clients | — | Clients brought by the partner. |
| IB | PAY {amount} | Pay {amount} | $ | Pay everything owed. |
| IB | EDIT PLAN | Edit pay plan | — | Change $ per lot or %. |
| IB | CLIENT / NAME / PENDING COMMISSION / ACTIONS (PAY) | Client / Name / Partner Pay Owed ($) / Actions (Pay) | $ | Referred-clients table. |
| IB | Open client {number} | keep | — | Open the client's account page. |
| IB | NEW IB RELATIONSHIP (form) | New Partner Link | — | Form title. |
| IB | IB account number | Partner account number | — | Partner's account. |
| IB | Referred client account number | keep | — | Client the partner brought. |
| IB | Commission (PER LOT (USD) / % OF COMMISSION) | Partner pay ($ per lot / % of commission) | — | How the partner is paid. |
| IB | Rate | keep | $ per lot | $ per lot, or % when % of commission. |
| IB | PAY IB COMMISSION / PAY PARTNER / PAYOUT RUN (dialogs) | Pay Partner / Pay Partner / Pay All Partners | — | Confirm dialog titles. |
| IB | PAY (button) | Pay | — | Confirm button. |
| IB | EDIT PLAN (dialog) + TYPE · RATE + APPLY | Edit Pay Plan · Type and rate · Apply | — | e.g. "PER_LOT 5" or "PERCENTAGE 40". |

## ID Checks (KYC)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| KYC | 1) KYC  VERIFICATION QUEUE | ID Checks (KYC) | — | Clients waiting for identity approval. |
| KYC | NOTHING WAITING / <n> WAITING · OLDEST <age> | keep | — | Queue size and oldest wait. |
| KYC | IN-APP · <n> (tab) | In-app · {n} | — | Checks sent from the trading app. |
| KYC | CLIENT PORTAL · <n> (tab) | Client portal · {n} | — | Checks sent from the website. |
| KYC | WAITING · APPROVED · REJECTED · ALL | keep | — | Status filters. |
| KYC | ID | Ticket # | — | Check number. |
| KYC | CLIENT | keep | — | Client name. |
| KYC | COUNTRY | keep | — | Client's country. |
| KYC | LEVEL | ID Check Level | — | Level requested/granted. |
| KYC | DOCUMENTS | keep | — | Documents uploaded. |
| KYC | STATUS | keep | — | Waiting, approved or rejected. |
| KYC | AGE | Waiting Time | — | How long it has waited. |
| KYC | ACTIONS (REVIEW) | Actions (Review) | — | Open the documents. |
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
| KYC | APPROVE KYC (dialog) | Approve ID Check | — | Confirm dialog title. |
| KYC | REJECT KYC (dialog) | Reject ID Check | — | Confirm dialog title. |
| KYC | REASON (SENT TO THE CLIENT) | Reason (sent to the client) | — | Why it was rejected. |

## Live Account Applications (LAR)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| LAR | 1) LAR  LIVE ACCOUNT REQUESTS | Live Account Applications | — | Clients asking for a live account. |
| LAR | NONE PENDING / <n> PENDING | None waiting / {n} waiting | — | Applications to decide. |
| LAR | PENDING · APPROVED · REJECTED · ALL | Waiting · Approved · Rejected · All | — | Status filters. |
| LAR | CLIENT | keep | — | Client name. |
| LAR | E-MAIL / COUNTRY / PHONE | keep | — | Contact details. |
| LAR | ACCOUNT TYPE | keep | — | Account type requested. |
| LAR | STATUS | keep | — | Waiting, approved or rejected. |
| LAR | CREATED ACCOUNT | Live Account | — | Account created on approval. |
| LAR | REJECTION REASON | keep | — | Reason sent to the client. |
| LAR | REQUESTED | Requested (UTC) | UTC | When the client applied. |
| LAR | ACTIONS | keep | — | Row actions. |
| LAR | Approve · create the live account | Approve and create live account | — | Creates the live account. |
| LAR | Reject… | keep | — | Refuse with a reason. |
| LAR | Open account <no> | keep | — | Open the created account. |
| LAR | APPROVE LIVE ACCOUNT (dialog) | Approve Live Account Application | — | Confirm dialog title. |
| LAR | REJECT LIVE ACCOUNT REQUEST (dialog) | Reject Live Account Application | — | Confirm dialog title. |
| LAR | REASON (SENT TO THE CLIENT) | Reason (sent to the client) | — | Why it was refused. |

## Deposits & Withdrawals (DEP)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DEP | PENDING DEPOSITS (KPI) | Deposits Waiting ($) | $ | Deposit requests to decide. |
| DEP | PENDING WITHDRAWALS (KPI) | Withdrawals Waiting ($) | $ | Withdrawal requests to decide. |
| DEP | AWAITING 2ND ADMIN (KPI) | Needs a Second Admin | — | Marked withdrawals waiting for the second approval. |
| DEP | DEPOSITS · 30D (KPI) | Deposits, 30 days ($) | $ | Completed deposits. |
| DEP | WITHDRAWALS · 30D (KPI) | Withdrawals, 30 days ($) | $ | Completed withdrawals. |
| DEP | AVG TICKET · 30D (KPI) | Average Amount, 30 days ($) | $ | Average request size. |
| DEP | REJECTED (KPI) | Rejected | — | Rejected requests. |
| DEP | PSP COST · MTD (KPI) | Payment Method Fees This Month ($) | $ | Fees charged by payment methods. |
| DEP | 1) DEP  DEPOSITS & WITHDRAWALS | Deposits & Withdrawals | — | Money requests from clients. |
| DEP | NONE PENDING / <n> PENDING · <sum> USD | None waiting / {n} waiting · {x} ($) | $ | Waiting total. |
| DEP | PENDING · DEPOSITS · WITHDRAWALS · MARKED · COMPLETED · REJECTED · ALL | Waiting · Deposits · Withdrawals · Marked by first admin · Completed · Rejected · All | — | Filters. |
| DEP | search "account · client" | Search account or client | — | Search box. |
| DEP | CLIENT / ACCOUNT | keep | — | Client name / account number. |
| DEP | TYPE | keep | — | Deposit or withdrawal. |
| DEP | AMOUNT | Amount ($) | $ | Requested amount. |
| DEP | BALANCE | Balance ($) | $ | Account balance now. |
| DEP | STATUS | keep | — | Waiting, completed or rejected. |
| DEP | STEP | Approval Step | — | Next step needed. |
| DEP | MARKED BY | Marked By | — | First admin who approved. |
| DEP | NOTE | keep | — | Staff note. |
| DEP | CREATED | Requested (UTC) | UTC | When the client asked. |
| DEP | ACTIONS (<PRIMARY> · REJECT) | keep | — | Row actions. |
| DEP | Approve · complete the deposit | Approve deposit | — | Adds the money to the balance. |
| DEP | Mark for approval (1st admin) | Approve (first admin) | — | A second admin must confirm. |
| DEP | Confirm · complete the withdrawal (2nd admin) | Confirm withdrawal (second admin) | — | Pays out the withdrawal. |
| DEP | Cancel my mark | Cancel my approval | — | Remove your first approval. |
| DEP | Reject… | keep | — | Refuse the request. |
| DEP | Open client <acc> | keep | — | Open the client's account page. |
| DEP | APPROVE DEPOSIT (dialog) | keep | — | Confirm dialog title. |
| DEP | PAY OUT WITHDRAWAL (dialog) + PAY OUT | Pay Out Withdrawal / Pay out | — | Single-admin payout. |
| DEP | MARK WITHDRAWAL FOR APPROVAL (dialog) + MARK | Approve Withdrawal (First Admin) / Approve | — | A second admin confirms. |
| DEP | CONFIRM WITHDRAWAL (dialog) + CONFIRM | Confirm Withdrawal (Second Admin) / Confirm | — | Pays out. |
| DEP | CANCEL YOUR MARK (dialog) + CANCEL MARK | Cancel Your Approval / Cancel approval | — | Removes your first approval. |
| DEP | REJECT REQUEST (dialog) | keep | — | Confirm dialog title. |
| DEP | NOTE (OPTIONAL) | Note (optional) | — | Reason for rejecting. |

## Approvals (APR)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| APR | 1) BAL  BALANCE ADJUSTMENTS · AWAITING A SECOND ADMIN | Balance Changes Needing a Second Admin | — | Add/deduct funds requests to approve. |
| APR | <n> PENDING · <±sum> | {n} Waiting · {x} ($) | $ | Waiting total. |
| APR | PENDING · ALL | Waiting · All | — | Filters both panels. |
| APR | REQUESTED | Requested (UTC) | UTC | When it was requested. |
| APR | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| APR | AMOUNT | Amount ($) | $ | + adds funds, − deducts funds. |
| APR | BALANCE NOW | Balance Now ($) | $ | Account balance before the change. |
| APR | NOTE | keep | — | Requester's note. |
| APR | REQUESTED BY ( (you) ) | keep | — | Staff who asked. |
| APR | STATUS (PENDING / APPROVED / REJECTED) | Status (Waiting / Approved / Rejected) | — | Request state. |
| APR | REVIEW | Review Note | — | Second admin's note. |
| APR | ACTIONS (APPROVE · REJECT / AWAITING OTHER ADMIN) | Actions (Approve · Reject / Needs another admin) | — | You cannot approve your own request. |
| APR | Approve… / Reject… | keep | — | Decide the request. |
| APR | Open client <acc> | keep | — | Open the client's account page. |
| APR | 2) POS  POSITION ACTIONS · DELETE / VOID / REVERSE | Position Changes Needing a Second Admin | — | Delete / void / reverse requests. |
| APR | <n> PENDING | {n} Waiting | — | Waiting count. |
| APR | ACTION (DELETE / VOID / REVERSE) | keep | — | What was requested. |
| APR | TICKET | Ticket # | — | Position/trade number. |
| APR | POSITION | keep | — | Symbol, side, volume. |
| APR | REASON | keep | — | Why it was requested. |
| APR | APPROVE / REJECT <kind> (dialog) | Approve / Reject <kind> | — | Confirm dialog titles. |
| APR | REVIEW NOTE | keep | — | Note kept in the audit log. |

## Payment Methods (PSP)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| PSP | 1) PSP  PAYMENT METHODS | Payment Methods | — | How clients deposit and withdraw. |
| PSP | <n> OF 5 ENABLED · <n> UNSAVED | {n} of 5 enabled · {n} not saved | — | Totals. |
| PSP | METHOD (USDT · TRC20 / USDT · BEP20 / BTC / ETH / BANK TRANSFER) | Payment Method | — | Method name. |
| PSP | ENABLED (ON/OFF) | keep | — | Clients can use it. |
| PSP | MINIMUM | Minimum ($) | $ | Smallest amount allowed. |
| PSP | MAXIMUM | Maximum ($) | $ | Largest amount allowed. |
| PSP | FEE % | Fee (%) | % | Percentage fee. |
| PSP | FEE FIXED | Fixed Fee ($) | $ | Flat fee per request. |
| PSP | WALLET ADDRESS | keep | — | Where clients send crypto. |
| PSP | INSTRUCTIONS | keep | — | Text shown to clients. |
| PSP | (blank) CHANGED / DEFAULTS | Not saved / Default | — | Row state. |
| PSP | ACTIONS (SAVE) | Actions (Save) | — | Save this row. |
| PSP | Save this row… | keep | — | Save the edits. |
| PSP | Revert this row | Undo changes on this row | — | Discard edits. |
| PSP | Disable (stage) / Enable (stage) | Disable / Enable (unsaved) | — | Marks the change; save to apply. |
| PSP | SAVE PAYMENT METHOD (dialog) | keep | — | Confirm dialog title. |

## Internal Transfer (TRX)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| TRX | 1) TRX  INTERNAL TRANSFER | Internal Transfer | — | Move money between two accounts. |
| TRX | FROM | From Account | — | Account the money leaves. |
| TRX | TO | To Account | — | Account the money goes to. |
| TRX | AMOUNT | Amount ($) | $ | Money to move. |
| TRX | NOTE | keep | — | Kept in the audit log. |
| TRX | PREVIEW | keep | — | Show balances before and after. |
| TRX | TRANSFER | keep | — | Move the money. |
| TRX | ready · TRANSFER to confirm | Ready: press Transfer to confirm | — | Preview passed. |
| TRX | 2) HIST  TRANSFER HISTORY · LAST 200 | Transfer History (last 200) | — | Past transfers. |
| TRX | <n> LEGS | {n} entries | — | One entry per account side. |
| TRX | WHEN | When (UTC) | UTC | Time of the transfer. |
| TRX | ACCOUNT | keep | — | Account number. |
| TRX | TYPE (OUT / IN) | Direction (Out / In) | — | Money left or arrived. |
| TRX | AMOUNT | Amount ($) | $ | Money moved. |
| TRX | Open client 360 | Open client | — | Open the client's account page. |
| TRX | Use as FROM account / Use as TO account | Use as From account / Use as To account | — | Fill the form. |
| TRX | INTERNAL TRANSFER (dialog) | keep | — | Confirm dialog title. |

## Wallets (WAL)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| WAL | 1) WAL  WALLETS · ACCOUNT BALANCES | Account Balances | — | Money on every account. |
| WAL | <n> ACCOUNTS · LIVE BALANCE <x> · CREDIT <x> · EQUITY <x> | {n} Accounts · Live balance ($) · Credit ($) · Equity ($) | $ | Totals. |
| WAL | ALL · LIVE · DEMO · WITH CREDIT · NEGATIVE | All · Live · Demo · With credit · Negative balance | — | Filters. |
| WAL | ACCOUNT / CLIENT | keep | — | Account number / client name. |
| WAL | ACCOUNT MODE (LIVE/DEMO) | Live / Demo | — | Account kind. |
| WAL | CURRENCY | keep | — | Account currency. |
| WAL | BALANCE | Balance ($) | $ | Deposited money. |
| WAL | CREDIT | Credit ($) | $ | Bonus money lent to trade with. |
| WAL | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| WAL | FREE MARGIN | Free Margin ($) | $ | Equity minus used margin. |
| WAL | FLOATING PROFIT / LOSS | Floating P/L ($) | $ | Profit/loss of open positions. |
| WAL | STATUS | keep | — | Account state. |
| WAL | Open client 360 (credit / debit · leverage · risk limits) | Open client (funds, leverage, limits) | — | Open the client's account page. |
| WAL | Live exposure | keep | — | Open Live Exposure for this account. |
| WAL | Deposits · withdrawals | Deposits & withdrawals | — | Open this account's requests. |
| WAL | Internal transfer | keep | — | Open the transfer form. |

## Staff (USR)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| USR | 1) USR  STAFF · ROLES | Staff | — | Back-office users and roles. |
| USR | {n} USERS · 3 ROLES | {n} Staff · 3 roles | — | Totals. |
| USR | + INVITE | Add staff | — | Create a staff login. |
| USR | USER ( (you) ) | Staff | — | Staff e-mail. |
| USR | ROLE | keep | — | Admin, manager or support. |
| USR | LAST ACTIVE | Last Active (UTC) | UTC | Last sign-in. |
| USR | STATUS (ACTIVE / DISABLED) | keep | — | Can sign in or not. |
| USR | ACTIONS (LOCKED / EDIT DISABLE / EDIT ACTIVATE) | Actions (Your own row / Edit · Disable / Edit · Re-activate) | — | Row actions. |
| USR | Edit… | keep | — | Open the staff editor. |
| USR | Disable access… / Re-activate… | keep | — | Block or restore sign-in. |
| USR | Invite a team member… | Add staff… | — | Create a staff login. |
| USR | 2) PERM  ROLE MATRIX | Permissions | — | What each role can do. |
| USR | SELECT A MANAGER TO DELEGATE / CLICK A CELL IN {NAME} TO STAGE / {ROLE} · NOTHING TO DELEGATE | Select a manager to give extra permissions / Click a cell to change / Nothing to give | — | Hint. |
| USR | SAVE / REVERT | Save / Undo | — | Save or discard permission changes. |
| USR | PERMISSION / ADMIN / MANAGER / SUPPORT | keep | — | Matrix columns. |
| USR | KYC review | ID check review | — | Permission. |
| USR | Risk settings / Emergency controls / Internal transfers | keep | — | Permissions. |
| USR | Funds approval | Deposit & withdrawal approval | — | Permission. |
| USR | IB payouts | Partner payouts | — | Permission. |
| USR | Account finance | Add / deduct funds | — | Permission. |
| USR | Reverse mirror rules | Copy rules | — | Permission. |
| USR | 3) EDIT  STAFF MEMBER | Edit Staff | — | Staff editor. |
| USR | BACK TO CFG | Back to settings | — | Return to Broker Settings. |
| USR | e-mail · role · status · last sign-in · created · 2FA · devices · IPs | E-mail · Role · Status · Last sign-in (UTC) · Created (UTC) · Two-step sign-in (2FA) · Devices · IP addresses | UTC | Staff details. |
| USR | DELEGATED PERMISSIONS | Extra Permissions | — | Permissions given to this manager. |
| USR | SAVE PERMISSIONS / REVERT | Save permissions / Undo | — | Buttons. |
| USR | ADMIN · FULL ACCESS / SUPPORT · NONE DELEGABLE | Admin: full access / Support: no extra permissions | — | Role notes. |
| USR | ACCESS (section) | Access | — | Disable or restore sign-in. |
| USR | DISABLE ACCESS / RE-ACTIVATE | Disable access / Re-activate | — | Buttons. |
| USR | PASSWORD RESET · ROLE CHANGE — not available yet | keep | — | Planned. |
| USR | 3) INVITE  ADD STAFF | Add Staff | — | New staff form. |
| USR | NEW STAFF MEMBER (section) | New Staff | — | Form section. |
| USR | e-mail / ROLE (ADMIN · MANAGER · SUPPORT) | E-mail / Role (Admin · Manager · Support) | — | Form fields. |
| USR | CREATE / CANCEL | Create / Cancel | — | Form buttons. |
| USR | DELEGATE PERMISSIONS (dialog) | Give Extra Permissions | — | Confirm dialog title. |
| USR | DISABLE STAFF ACCESS / RE-ACTIVATE STAFF ACCESS (dialog) | Disable Staff Access / Re-activate Staff Access | — | Confirm dialog titles. |
| USR | ADD STAFF MEMBER (dialog) | Add Staff | — | Confirm dialog title. |
| USR | INITIAL PASSWORD · SHOWN ONCE | First Password (Shown Once) | — | Copy it now; it cannot be shown again. |

## Audit Log (AUD)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| AUD | 1) AUD  AUDIT LOG | Audit Log | — | Every staff and system change. |
| AUD | {n} ENTRIES | {n} Entries | — | Entries shown. |
| AUD | SAVE CSV | Save as CSV | — | Download the log. |
| AUD | search | Search | — | Search the log. |
| AUD | WHEN | When (UTC) | UTC | Time of the change. |
| AUD | ACTOR | Done By | — | Staff or system that made the change. |
| AUD | ACTION | keep | — | What was done. |
| AUD | ENTITY | Record Type | — | Kind of record changed. |
| AUD | ORDER | Ticket # | — | Related order, if any. |
| AUD | ACCOUNT | keep | — | Related account. |
| AUD | FIELDS CHANGED | keep | — | Number of values changed. |
| AUD | Before → after (detail) | Show changes | — | Open the before/after panel. |
| AUD | Open the record | keep | — | Go to the changed record. |
| AUD | Open client | keep | — | Open the related client. |
| AUD | 2) DIFF  BEFORE → AFTER | Changes | — | Values before and after. |
| AUD | actor · action · entity · record · order · when | Done by · Action · Record type · Record · Ticket # · When (UTC) | UTC | Entry details. |
| AUD | CHANGES (section) · (removed) | Changes · (removed) | — | Each changed value. |
| AUD | OPEN {CODE} | Open {screen name} | — | Go to the related screen. |
| AUD | SELECT AN ENTRY / NO FIELD CHANGES RECORDED | keep | — | Empty states. |

## Security (SEC)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SEC | 1) ME  THIS SIGN-IN | This Sign-in | — | Your current session. |
| SEC | signed in as | keep | — | Your e-mail. |
| SEC | role | keep | — | Your role. |
| SEC | tenant | Broker | — | Broker you are signed in to. |
| SEC | broker | Broker ID | — | Broker's internal name. |
| SEC | since | Signed in (UTC) | UTC | When you signed in. |
| SEC | 2FA challenged this sign-in (YES · AUTHENTICATOR CODE / NO) | Two-step sign-in used (Yes / No) | — | Whether a code was asked. |
| SEC | finance rights (YES/NO) | Can approve money (Yes / No) | — | Deposit/withdrawal/fund rights. |
| SEC | session (COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY) | Session (ends on sign-out or timeout) | — | How the session ends. |
| SEC | REQUEST PASSWORD RESET | keep | — | Ask an admin to reset your password. |
| SEC | SIGN OUT | keep | — | End this session. |
| SEC | 2) SEC  ACCOUNT SECURITY | Account Security | — | Sign-in protection. |
| SEC | TWO-FACTOR (Enrolment; Enrol · reset · backup codes) | Two-step Sign-in (2FA) (Set up; reset; backup codes) | — | Authenticator codes. |
| SEC | PASSKEYS · HARDWARE KEYS (Registered keys) | Passkeys & Security Keys | — | Not available yet. |
| SEC | ACTIVE SESSIONS (Other devices; Sign out everywhere) | keep | — | Not available yet. |
| SEC | API KEYS (Personal tokens) | keep | — | Not available yet. |
| SEC | IP ALLOWLIST (Allowed addresses) | Allowed IP Addresses | — | Not available yet. |
| SEC | ORG POLICY (Staff 2FA mandatory; Session timeout; Password rotation) | Staff Policy (Two-step sign-in required; Session timeout; Password change interval) | — | Not available yet. |
| SEC | REQUEST PASSWORD RESET (dialog) | keep | — | Confirm dialog title. |
| SEC | NOTE FOR STAFF (optional) / REQUEST | Note for staff (optional) / Send request | — | Dialog input and button. |

## Broker Settings (CFG)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CFG | 1) TENANT  THIS BROKER | This Broker | — | Broker record. |
| CFG | Broker / Host / Subdomain / Custom domain | Broker / Web address / Subdomain / Custom domain | — | Where the broker is reached. |
| CFG | Tier | Plan | — | Broker's platform plan. |
| CFG | Status | keep | — | Active or not. |
| CFG | Default account currency | keep | — | Currency for new accounts. |
| CFG | Default account leverage | keep | — | Leverage for new accounts (1:N). |
| CFG | SIGNED IN (section): Admin · Role · Unread notifications · Finance rights | Signed In: Staff · Role · Unread notifications · Can approve money | — | Your session. |
| CFG | 3) CFG  BROKER SETTINGS | Broker Settings | — | Defaults for new accounts. |
| CFG | SAVE | Save settings | — | Save changes. |
| CFG | TRADING (section) | Trading | — | Trading defaults. |
| CFG | Default leverage | keep | — | 1:N for new accounts. |
| CFG | Margin call (PER GROUP · GRP) | Margin call level (%) (set per group) | % | Set on the Groups screen. |
| CFG | Stop-out (PER GROUP · GRP) | Stop-out level (%) (set per group) | % | Set on the Groups screen. |
| CFG | Negative balance protection | keep | — | Not available yet. |
| CFG | Hedging allowed | keep | — | Not available yet. |
| CFG | Max slippage | Max slippage (points) | points | Not available yet. |
| CFG | FUNDING (section) | Deposits & Withdrawals | — | Money defaults. |
| CFG | Min deposit (PER METHOD · PSP) | Min deposit ($) (set per payment method) | $ | Set on Payment Methods. |
| CFG | Withdrawal auto-approve ≤ | Auto-approve withdrawals up to ($) | $ | Not available yet. |
| CFG | Require KYC L1 to deposit | Require ID check level 1 to deposit | — | Not available yet. |
| CFG | Require KYC L2 above | Require ID check level 2 above ($) | $ | Not available yet. |
| CFG | BRANDING · TENANT (section): Broker · Domain · Tier · status · Accent · Terminal theme · Desktop build | Branding: Broker · Domain · Plan · Status · Accent colour · Terminal theme · Desktop app version | — | Look of the client apps. |
| CFG | SECURITY (section): Staff 2FA mandatory · Session timeout · Audit retention | Security: Two-step sign-in required · Session timeout · Audit log kept for | — | Not available yet. |
| CFG | note "Default leverage and currency…" | keep | — | Only new accounts get these defaults. |
| CFG | SETTINGS UNAVAILABLE / LOADING SETTINGS… | keep | — | Error / loading states. |
| CFG | WITHDRAWAL APPROVAL · <x> (dialog) / SWITCH TO <x> | Withdrawal Approval · <x> / Switch to <x> | — | One-admin or two-admin payouts. |
| CFG | SAVE BROKER SETTINGS (dialog) | keep | — | Confirm dialog title. |

## Added terms
| Concept | Word chosen |
|---|---|
| Notional value of open volume (volume × contract × price) | Exposure ($); lots-based limits = Max exposure (lots) |
| Buy minus sell volume on a symbol | Net volume (lots) |
| Which sides a group/symbol may open (TRADING MODE, TRADING) | Allowed sides |
| Pricing mode TARGET (total spread fixed) | Fixed spread |
| DEALING DESK category (broker book, every order to a dealer) | Broker book · Manual dealing |
| Group dealer setting INHERIT / AUTO / MANUAL | Same as broker switch / Always automatic dealing / Always manual dealing |
| Force dealing mode | Ignore broker dealing switch |
| Symbol CATEGORY (metals, FX…) | Asset class |
| Symbol sessions | Trading hours (UTC) |
| Mirror multiplier | Volume multiplier |
| KILLED copy rule | Stopped by limit |
| Void a closed trade | Void |
| Replay fill | Fill details |
| Smart dealer accept/reject % | Auto-accept slippage (%) / Auto-reject slippage (%) |
| Maker-checker first/second step (MARK / CONFIRM) | Approve (first admin) / Confirm (second admin) |
| Balance adjustment | Balance change (Add funds / Deduct funds) |
| IB commission (what the partner earns) | Partner pay |
| Pending IB commission | Partner pay owed |
| Lead converted | Became client |
| Tenant | Broker |
| Tenant tier | Plan |
| 2FA | Two-step sign-in (2FA) |
| Finance rights | Can approve money |
| Entity (audit/notification) | Record / Record type |
| Actor (audit) | Done by |
| Trading core / API gateway | Trading server / Client connection server |
| Tick / tick latency | Price update / Price delay (ms) |
| Stale symbol | Stale price |
| p50 / p95 | typical / slow |
| Risk-radar pattern flags | Scalping, Martingale, Latency arbitrage, News trading, Shared IP groups |
| Account mode (live/demo) | Live / Demo |
| Protocol (LP) | Connection type |
