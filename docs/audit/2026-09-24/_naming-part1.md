# Naming, part 1: SHELL · DASH · CLI · CLI·360 · DEAL

Sources: `_naming-glossary.md`, `ui-map.md` (bo-SHELL, bo-DASH, bo-CLI, bo-DEAL). Confirm titles and form labels checked against `DealingScreen.cs` and `ClientsScreen.cs`. Panel numbers and codes (e.g. "1) CLI") are dropped from every proposed title.

## Shell (SHELL)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| SHELL | {BrokerName} Backoffice (window title) | keep | — | Broker name and app name. |
| SHELL | BACKOFFICE (brand tile) | keep | — | This is the broker's back office. |
| SHELL | search · Ctrl+K | Search (Ctrl+K) | — | Find a client, order, position, transaction, symbol or screen. |
| SHELL | BROKER | keep | — | The broker you are signed in to. |
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
| SHELL | Dealing | keep | — | Orders waiting for dealer, hedging and dealing mode. |
| SHELL | Trade history | keep | — | Closed trades for all clients. |
| SHELL | Symbols | keep | — | Symbol settings. |
| SHELL | Groups | keep | — | Client groups: pricing, leverage and trade handling. |
| SHELL | Account types | keep | — | Account types offered to clients. |
| SHELL | Mirror rules | Copy rules | — | Rules that copy or reverse trades into another account. |
| SHELL | Risk | keep | — | Risk settings. |
| SHELL | Risk radar | keep | — | Accounts and IP addresses flagged as risky. |
| SHELL | Trading halt | keep | — | Stop all trading or allow close-only. |
| SHELL | Margin | keep | — | Accounts near margin call or stop-out. |
| SHELL | Liquidity | Liquidity providers | — | Liquidity provider connections. |
| SHELL | Liquidity routing | Trade handling | — | Which book each group's trades go to. |
| SHELL | Feed health | Price feed health | — | Is the price feed live, per symbol. |
| SHELL | Clients | keep | — | All client accounts. |
| SHELL | Leads | keep | — | Prospects not yet clients. |
| SHELL | IB partners | Partners (IB) | — | Introducing brokers and their clients. |
| SHELL | KYC review | ID checks (KYC) | — | Client ID documents waiting for review. |
| SHELL | Account requests | Live account applications | — | Requests to open a live account. |
| SHELL | Deposits · withdrawals | Deposits & withdrawals | — | Client deposit and withdrawal requests. |
| SHELL | Approvals | Approvals (needs a second admin) | — | Changes waiting for a second admin to approve. |
| SHELL | Payment methods | keep | — | Deposit and withdrawal methods. |
| SHELL | Transfers | keep | — | Transfers between accounts. |
| SHELL | Wallets | keep | — | Client wallets. |
| SHELL | Team | Staff | — | Staff logins and roles. |
| SHELL | Audit log | keep | — | Every staff action, who and when. |
| SHELL | Security | keep | — | Login and 2-step security. |
| SHELL | Settings | keep | — | Broker-wide settings. |
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
| SHELL | F12 SETTINGS | keep | — | Go to Settings. |
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
| SHELL | Security… | keep | — | Your password and 2-step login. |
| SHELL | Switch account… | Switch staff login… | — | Sign in as another staff user. |
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

## Dashboard (DASH)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DASH | NET DEPOSITS · 7D | Net deposits, 7 days ($) | $ | Deposits minus withdrawals in the last 7 days. |
| DASH | DEPOSITS · 30D | Deposits, 30 days ($) | $ | Completed deposits in the last 30 days. |
| DASH | WITHDRAWALS · PENDING | Pending withdrawals ($) | $ | Withdrawals waiting for approval. |
| DASH | ACTIVE TRADERS | keep | — | Accounts with at least one open position. |
| DASH | OPEN VOLUME | Open volume (lots) | lots | Total volume of all open positions. |
| DASH | B-BOOK P/L · FLOATING | Broker book (B-book) floating P/L ($) | $ | Floating P/L of positions the broker keeps, seen from the broker's side. |
| DASH | MARGIN CALLS | keep | — | Accounts at or below the margin call level. |
| DASH | NEW CLIENTS · 7D | New clients, 7 days | — | Accounts opened in the last 7 days. |
| DASH | DEALER QUEUE | Orders waiting for dealer | — | Orders that need a dealer's decision now. |
| DASH | 1) CLI  CLIENTS | Clients | — | All client accounts. |
| DASH | {n} TOTAL | keep | — | Number of accounts. |
| DASH | 2) EXP  OPEN BOOK | Live exposure | — | Open positions by symbol. |
| DASH | A / B BOOK (stat) | Market book / Broker book | lots | Open volume passed to a liquidity provider vs kept by the broker. |
| DASH | NET $ EXP (stat) | Net exposure ($) | $ | Value of client longs minus shorts across all symbols. |
| DASH | 3) APPR  APPROVALS QUEUE | Pending deposits & withdrawals | — | Deposit and withdrawal requests waiting for a decision. |
| DASH | dep / wdr (stat) | Deposits / withdrawals | — | Count of each waiting. |
| DASH | 4) FLOW  DEPOSITS VS WITHDRAWALS · 7D | Deposits vs withdrawals, 7 days ($) | $ | Daily money in and out. |
| DASH | DEP / WDR / NET (legend) | Deposits / Withdrawals / Net | $ | — |
| DASH | 5) ACT  ACTIVITY | Staff activity | — | Latest staff actions from the audit log. |
| DASH | ALL STAFF | keep | — | Shows every staff member's actions. |
| DASH | ALL (chip) | keep | — | — |
| DASH | LIVE (chip) | keep | — | Live accounts only. |
| DASH | DEMO (chip) | keep | — | Demo accounts only. |
| DASH | KYC WAIT (chip) | ID check pending | — | Accounts whose ID check is waiting for review. |
| DASH | SUSPENDED (chip) | Suspended or closed | — | Accounts that are not active. |
| DASH | IB (chip) | Partner clients | — | Clients brought in by a partner (IB). |
| DASH | ID (column) | Account | — | Account number. |
| DASH | CLIENT | keep | — | Client name. |
| DASH | COUNTRY | keep | — | — |
| DASH | KYC (column) | ID check | — | ID check status. |
| DASH | CATEGORY | Trade handling | — | Broker book, Market book or Reverse trading, set by the group. |
| DASH | GROUP | keep | — | — |
| DASH | BALANCE | Balance ($) | $ | — |
| DASH | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| DASH | LOTS | Open volume (lots) | lots | Volume of this account's open positions. |
| DASH | MARGIN % | Margin level (%) | % | Equity ÷ used margin × 100. |
| DASH | INTRODUCING BROKER | Partner | — | Partner (IB) who brought this client. |
| DASH | STATUS | keep | — | — |
| DASH | ACTIONS | Open | — | Click the row to open the client. |
| DASH | OK / WAIT / REJ / FLAG (ID check chip) | Verified / Pending / Rejected / Flagged | — | — |
| DASH | SUSP / CLSD (status chip) | Suspended / Closed | — | — |
| DASH | OPEN (row action) | keep | — | Open this client. |
| DASH | Open client 360 | keep | — | Full client view. |
| DASH | Live exposure (menu) | keep | — | This client's open positions. |
| DASH | Deposits · withdrawals (menu) | Deposits & withdrawals | — | This client's deposit and withdrawal requests. |
| DASH | Wallet | keep | — | This client's wallet. |
| DASH | SYMBOL | keep | — | — |
| DASH | LONG | Long (lots) | lots | Client buy volume. |
| DASH | SHORT | Short (lots) | lots | Client sell volume. |
| DASH | NET | Net (lots) | lots | Long minus short. |
| DASH | PROFIT / LOSS (exposure) | Floating P/L ($) | $ | Clients' floating P/L on this symbol. |
| DASH | A / B POS | Market book / Broker book positions | — | Number of positions in each book. |
| DASH | Live exposure · this symbol | keep | — | — |
| DASH | Symbol settings | keep | — | — |
| DASH | TYPE | keep | — | Deposit or withdrawal. |
| DASH | AMOUNT | Amount ($) | $ | — |
| DASH | NOTE | keep | — | Client's note. |
| DASH | AGE | keep | — | Time since the request. |
| DASH | DEP / WDR (type chip) | Deposit / Withdrawal | — | — |
| DASH | MARKED (status chip) | Client marked sent | — | Client says the money has been sent. |
| DASH | WAITING (status chip) | keep | — | Waiting for a staff decision. |
| DASH | Open in Deposits · withdrawals (approve / reject) | Open in Deposits & withdrawals (approve / reject) | — | — |
| DASH | COLUMNS (header menu) | keep | — | Show or hide columns. |
| DASH | Reset columns | keep | — | — |

## Clients list (CLI)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CLI | 1) CLI  CLIENTS & ACCOUNTS | Clients & accounts | — | All client accounts. |
| CLI | {n} TOTAL | keep | — | — |
| CLI | + ACCOUNT | New account | — | Open a new client account. |
| CLI | ALL / LIVE / DEMO (chips) | keep | — | — |
| CLI | KYC WAIT | ID check pending | — | Accounts whose ID check is waiting for review. |
| CLI | SUSPENDED | Suspended or closed | — | Accounts that are not active. |
| CLI | IB | Partner clients | — | Clients brought in by a partner (IB). |
| CLI | account · name · e-mail (search) | keep | — | — |
| CLI | ACCOUNT | keep | — | Account number. |
| CLI | CLIENT | keep | — | — |
| CLI | E-MAIL | keep | — | — |
| CLI | ACCOUNT MODE | Live / Demo | — | Live or demo account. |
| CLI | ACCOUNT TYPE | keep | — | — |
| CLI | COUNTRY | keep | — | — |
| CLI | KYC | ID check | — | ID check status. |
| CLI | GROUP | keep | — | — |
| CLI | LEVERAGE | keep | — | Written 1:N. |
| CLI | BALANCE | Balance ($) | $ | — |
| CLI | CREDIT | Credit ($) | $ | Bonus money the broker lends to trade with. |
| CLI | STATUS | keep | — | — |
| CLI | ACTIONS | Open | — | Click the row to open the client. |
| CLI | VERIFIED / NONE (ID check value) | Verified / Not started | — | — |
| CLI | Open client 360 | keep | — | — |
| CLI | Live exposure | keep | — | — |
| CLI | Deposits · withdrawals | Deposits & withdrawals | — | — |
| CLI | Wallet | keep | — | — |
| CLI | Credit / debit… | Add / deduct funds… | — | Change the balance by hand; does not touch Credit. |
| CLI | Change group… | keep | — | — |
| CLI | Leverage… | Change leverage… | — | — |
| CLI | Risk limits… | keep | — | Swap-free and max daily loss. |
| CLI | Statement CSV… | Export statement (CSV)… | — | — |
| CLI | Reset trader password… | Reset client password… | — | — |
| CLI | Suspend account… | keep | — | — |
| CLI | Activate account… | keep | — | — |
| CLI | CLIENTS & ACCOUNTS (empty-area menu header) | Clients & accounts | — | — |
| CLI | Add new account… | New account… | — | — |
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

## Client 360 (CLI·360)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| CLI·360 | 1) CLI  CLIENT | Client | — | — |
| CLI·360 | CLIENTS (breadcrumb) | ← Clients | — | Back to the list. |
| CLI·360 | CLIENT <no> · <mode> · <country> | keep | — | — |
| CLI·360 | KYC <status> (tag) | ID check <status> | — | — |
| CLI·360 | IB (tag) | Partner client | — | Brought in by a partner (IB). |
| CLI·360 | SWAP-FREE (tag) | Swap-free | — | — |
| CLI·360 | CUSTOM PRICING (tag) | keep | — | This account has its own pricing. |
| CLI·360 | Email | E-mail | — | — |
| CLI·360 | Group | keep | — | — |
| CLI·360 | Account type | keep | — | — |
| CLI·360 | Leverage | keep | — | — |
| CLI·360 | Balance | Balance ($) | $ | — |
| CLI·360 | Credit | Credit ($) | $ | Bonus money the broker lends to trade with. |
| CLI·360 | Risk score | keep | — | Score from the risk radar. |
| CLI·360 | Last IP | keep | — | IP of the last login. |
| CLI·360 | ACCOUNTS (section) | Account | — | — |
| CLI·360 | CREDIT / DEBIT | Add / deduct funds | — | Changes the balance; not the Credit ($) bonus. |
| CLI·360 | CHANGE GROUP | keep | — | — |
| CLI·360 | LEVERAGE (button) | Change leverage | — | — |
| CLI·360 | RISK LIMITS | keep | — | — |
| CLI·360 | STATEMENT CSV | Export statement (CSV) | — | — |
| CLI·360 | RESET PASSWORD | keep | — | — |
| CLI·360 | SUSPEND / ACTIVATE | keep | — | — |
| CLI·360 | 2) EQ  BALANCE CURVE | Balance history ($) | $ | Balance after each transaction; not equity. |
| CLI·360 | 7D / 30D / 90D / 1Y | 7 days / 30 days / 90 days / 1 year | — | — |
| CLI·360 | <first> → <last> (stat) | keep | $ | Balance at start and end of the range. |
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
| CLI·360 | NOTE | Book | — | Market book or Broker book; "Voided" for voided trades. |
| CLI·360 | OPEN (chip in CLOSED) | Still open | — | — |
| CLI·360 | A-BOOK / B-BOOK | Market book / Broker book | — | — |
| CLI·360 | VOIDED | keep | — | — |
| CLI·360 | Open in Live exposure (modify / close / reverse) | keep | — | — |
| CLI·360 | Open in Deals (replay / void / delete) | Open in Trade history (replay / void / delete) | — | — |
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
| CLI·360 | 6) SES  SESSIONS · DEVICES · IP | Login history | — | Last 50 logins with IP and device. |
| CLI·360 | LOGIN (log kind) | keep | — | — |
| CLI·360 | COLUMNS / Reset columns | keep | — | — |

## Dealing (DEAL)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| DEAL | 1) MW  MARKET WATCH | Market watch | — | — |
| DEAL | 2) QUEUE  PENDING QUEUE | Waiting orders | — | Orders waiting for dealer, offers waiting for client, and pending orders. |
| DEAL | 3) ACT  DEALING ACTIVITY | Dealing activity | — | Latest dealing events. |
| DEAL | 4) chart | Chart | — | Broker hedge account legs are drawn on it. |
| DEAL | 5) COV  COVERAGE ACCOUNT | Broker hedge account | — | The broker's own account for hedges. |
| DEAL | 6) MODE  DEALER MODE | Dealing mode | — | — |
| DEAL | 7) GRP  DEALING-GROUP | Broker book positions | — | Every open Broker book (B-book) position. |
| DEAL | 8) TICKET  ORDER TICKET | Hedge order | — | Order on the broker hedge account. |
| DEAL | 9) PANIC  EMERGENCY · DEALING GROUP | Trading halt · manual-dealing groups | — | — |
| DEAL | 10) SDM  SMART DEALER MANAGER | Hedge manager | — | Hedge or unhedge Broker book positions and see dealer P/L. |
| DEAL | TOTAL "n · L lot" (net strip) | Broker book positions (lots) | lots | — |
| DEAL | COVERED | Hedged (lots) | lots | — |
| DEAL | OPEN RISK | Unhedged (lots) | lots | Broker book volume not hedged. |
| DEAL | NET (net strip) | Net (lots) | lots | Client long minus short. |
| DEAL | DEALING-GROUP P/L | Broker book P/L ($) | $ | — |
| DEAL | COVERAGE P/L | Hedge account P/L ($) | $ | — |
| DEAL | DEALER NET P/L | Dealer net P/L ($) | $ | Broker book P/L plus hedge account P/L. |
| DEAL | search symbols… | keep | — | — |
| DEAL | + ADD | Add symbol | — | — |
| DEAL | ADD SYMBOL | keep | — | — |
| DEAL | search… | keep | — | — |
| DEAL | SYMBOL | keep | — | — |
| DEAL | BID / ASK | keep | — | — |
| DEAL | SPRD | Client spread (points) | points | — |
| DEAL | HIGH · LOW | Daily high / Daily low | — | — |
| DEAL | CHG% | Change (%) | % | Change since the day's open. |
| DEAL | NO FEED | No price feed | — | — |
| DEAL | Open chart, X | keep | — | — |
| DEAL | New order, X | keep | — | — |
| DEAL | Specification, X… | keep | — | — |
| DEAL | Add symbol… | keep | — | — |
| DEAL | Remove X from watchlist | keep | — | — |
| DEAL | Columns ▸ | keep | — | — |
| DEAL | Change % | Change (%) | % | — |
| DEAL | Spread (column toggle) | Client spread | points | — |
| DEAL | Daily High / Low | keep | — | — |
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
| DEAL | AGE | keep | — | — |
| DEAL | ACT | Actions | — | — |
| DEAL | AWAITING DEALER | Waiting for dealer | — | — |
| DEAL | AWAITING CLIENT | Waiting for client | — | New price offered, client has not answered. |
| DEAL | RESTING | Pending order | — | — |
| DEAL | ACCEPT ▾ | keep | — | — |
| DEAL | ACCEPT AT / CLOSE AT | keep | — | — |
| DEAL | Requested · <price> | keep | — | Fill at the price the client asked. |
| DEAL | Market · <price> | Current price · <price> | — | Fill at the current price. |
| DEAL | REQUOTE ▾ | Offer new price ▾ | — | — |
| DEAL | REQUOTE SYM SIDE VOL · step N pts | Offer new price SYM SIDE VOL · step N points | points | — |
| DEAL | +1 / +2 / +3 | keep | points | Steps away from the current price. |
| DEAL | custom price | keep | — | — |
| DEAL | REJECT | keep | — | — |
| DEAL | WITHDRAW | Withdraw offer | — | Cancel the new price offered to the client. |
| DEAL | CANCEL | Cancel pending order | — | — |
| DEAL | Open client 360 / Live exposure (menus) | keep | — | — |
| DEAL | DEALER SETTINGS (form) | keep | — | — |
| DEAL | Requote step (points) | New-price step (points) | points | Size of each +1 step when offering a new price. |
| DEAL | SAVE | keep | — | — |
| DEAL | ACCEPT ALL / REJECT ALL (confirm) | keep | — | — |
| DEAL | REASON (AUDIT TRAIL) | Reason (saved to audit log) | — | — |
| DEAL | CLOSE / OPEN / PLACED / MODIFY / CANCEL / TRIGGER (activity kind) | keep | — | — |
| DEAL | CHART LAYOUT / Single / Grid 2×2 / Crosshair sync (grid) | keep | — | — |
| DEAL | LAST | Current price | — | — |
| DEAL | CHG | Change | — | — |
| DEAL | O · H · L | keep | — | Open, high, low of the bar. |
| DEAL | VOL (chart header) | Tick volume | — | Number of price updates in the bar. |
| DEAL | 1M 5M 15M 30M 1H 4H D W | keep | — | — |
| DEAL | INDICATORS | keep | — | — |
| DEAL | CHART / Sessions / EMA 20/50 / VWAP / SESSIONS | keep | — | — |
| DEAL | One-click panel | One-click trading panel | — | — |
| DEAL | DRAWING TOOLS / Trend line / Horizontal line / Ray / Rectangle / Fibonacci retracement | keep | — | — |
| DEAL | Chart settings… | keep | — | — |
| DEAL | FIB / OB / FVG | Fibonacci / Order blocks / Fair value gaps | — | — |
| DEAL | SELL / BUY | keep | — | — |
| DEAL | lots (one-click) | Volume (lots) | lots | — |
| DEAL | <price> · below/above market | keep | — | — |
| DEAL | Buy Limit / Sell Stop / Sell Limit / Buy Stop @ P | keep | — | Pending order on the broker hedge account. |
| DEAL | Set SL P | Set stop loss P | — | — |
| DEAL | Set TP P | Set take profit P | — | — |
| DEAL | Alert below/above P | keep | — | — |
| DEAL | Collapse / Expand one-click panel | Collapse / Expand one-click trading panel | — | — |
| DEAL | <Kind> settings… / Remove drawing / Clear all drawings (n) | keep | — | — |
| DEAL | Reset view / Maximize | keep | — | — |
| DEAL | {SIDE} {SYM} AT MARKET (confirm) | {SIDE} {SYM} at current price | — | — |
| DEAL | PLACE ORDER / MODIFY | keep | — | — |
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
| DEAL | LONG / SHORT / NET | Long (lots) / Short (lots) / Net (lots) | lots | — |
| DEAL | PROFIT / LOSS | Floating P/L ($) on Positions/Exposure; Closed P/L ($) on Closed trades | $ | — |
| DEAL | FROM / TO | From (UTC) / To (UTC) | UTC | — |
| DEAL | APPLY | keep | — | — |
| DEAL | REALIZED | Closed P/L ($) | $ | — |
| DEAL | CLOSED / TIME (history) | Closed (UTC) | UTC | — |
| DEAL | CLOSE (column) | Close price | — | — |
| DEAL | P/L (GRP history stat) | Closed P/L ($) | $ | — |
| DEAL | ACC · SYM (menu header) | keep | — | — |
| DEAL | Execution | Dealing mode | — | — |
| DEAL | DEALER ON | Manual dealing | — | Dealer reviews every market order. |
| DEAL | AUTO-FILL | Automatic dealing | — | Market orders fill at the current price with no dealer. |
| DEAL | SWITCH TO AUTO-FILL / SWITCH TO DEALER ON | Switch to automatic dealing / Switch to manual dealing | — | — |
| DEAL | AUTO-FILL / DEALER ON (confirm) | Automatic dealing / Manual dealing | — | — |
| DEAL | Auto-hedge | keep | — | Hedge every Broker book fill on the broker hedge account. |
| DEAL | TURN AUTO-HEDGE ON / OFF | Turn auto-hedge on / off | — | — |
| DEAL | AUTO-HEDGE ON / OFF (confirm) | keep | — | — |
| DEAL | Dealing-group accounts | Accounts in manual-dealing groups | — | — |
| DEAL | Smart dealer | Auto accept / reject | — | Accept or reject orders automatically by slippage %. |
| DEAL | accept ≤ a% · reject ≥ r% | keep | % | — |
| DEAL | MAX SLIPPAGE | Max slippage (points) | points | Broker-wide max price change on fill; value is stored in pips today, convert before relabel. |
| DEAL | EDIT | keep | — | — |
| DEAL | MAX SLIPPAGE (form) · "Pips (blank = platform default…, 0 = reject any slippage)" | Max slippage (points) · "blank = platform default, 0 = no slippage" | points | — |
| DEAL | COVERAGE ACCOUNT (section / form) / Coverage account | Broker hedge account | — | — |
| DEAL | not set | keep | — | — |
| DEAL | SET / CHANGE COVERAGE ACCOUNT | Set / Change broker hedge account | — | — |
| DEAL | SET | keep | — | — |
| DEAL | Symbol ▾ / SYMBOL (menu header) | keep | — | — |
| DEAL | MKT / LIMIT / STOP | Market / Limit / Stop | — | — |
| DEAL | Volume | Volume (lots) | lots | — |
| DEAL | Take profit / Stop loss | keep | — | — |
| DEAL | SELL LIMIT / BUY STOP (captions) | keep | — | — |
| DEAL | Fills on the coverage account at the live price. | Fills on the broker hedge account at the current price. | — | — |
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
| DEAL | DEALER P/L · 1D | Dealer P/L ($), 1 day | $ | Broker book P/L plus hedge P/L. |
| DEAL | open … · booked … · closed … (1D) | open … · hedged … · closed … (1 day) | $ | — |
| DEAL | UNBOOKED · n | Not hedged · n | — | — |
| DEAL | BOOK ALL · n | Hedge all · n | — | Hedge every unhedged Broker book position on the broker hedge account. |
| DEAL | CLIENT / DEALER P&L | Client P/L ($) / Dealer P/L ($) | $ | — |
| DEAL | BOOK | Hedge | — | — |
| DEAL | BOOKED · n | Hedged · n | — | — |
| DEAL | COVERAGE (P/L) | Hedge P/L ($) | $ | — |
| DEAL | NET (SDM P/L) | Net P/L ($) | $ | — |
| DEAL | UNBOOK | Remove hedge | — | — |
| DEAL | hedge leg not found on the coverage account | Hedge not found on the broker hedge account | — | — |
| DEAL | CLOSED · n / CLOSED MM-DD HH:mm | Closed · n / Closed MM-DD HH:mm (UTC) | UTC | — |
| DEAL | COVERAGE (OPEN) | Hedge P/L ($, still open) | $ | — |
| DEAL | AWAITING DEALER · close the coverage leg | Waiting for dealer · close the hedge | — | — |
| DEAL | ORPHAN · auto-hedged leg did not close | Hedge left open · auto-hedge did not close it | — | — |
| DEAL | CLOSE (SDM button) | Close hedge | — | — |
| DEAL | BOOK NOW (confirm) | Hedge now | — | Client position stays open. |
| DEAL | BOOK ALL (confirm) | Hedge all | — | — |
| DEAL | CLOSE COVERAGE (confirm) / CLOSE | Close hedge / Close | — | — |
| DEAL | COLUMNS / Reset columns | keep | — | — |

## Added terms
| Concept | Word chosen |
|---|---|
| Client longs minus shorts, per symbol or total | Exposure (Net exposure ($), Net (lots)) |
| Live event + price stream status in the shell | Live updates |
| Groups with manual dealing (GroupType DEALING or forced dealing) | Manual-dealing groups |
| Broker book volume that has / has not been hedged | Hedged (lots) / Unhedged (lots) |
| Undo a hedge (UNBOOK) | Remove hedge |
| Book/unbook panel (SDM) | Hedge manager |
| Broker book P/L + hedge account P/L | Dealer P/L ($) |
| Queue panel holding dealer, client-offer and pending rows | Waiting orders |
| New price offered, client not answered yet | Waiting for client |
| Cancel an offered new price | Withdraw offer |
| Size of one new-price step | New-price step (points) |
| Smart dealer auto rules | Auto accept / reject |
| Client of a partner (IB chip/tag) | Partner clients / Partner client |
| Dashboard funds queue (not maker-checker) | Pending deposits & withdrawals |
| Balance-after-transaction chart | Balance history ($) |
| Manual balance change in the ledger | Funds added / Funds deducted |
| Row's book in trade lists | Book |
| Login event list | Login history |
| Staff audit feed on dashboard | Staff activity |
| Bar tick count on chart | Tick volume |
