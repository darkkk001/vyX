# Naming part 3: Trader terminal (T·)

Source: ui-map.md `# term-*` sections plus a read-only check of `E:\vyxtrader\src\Vyx.Trader.App\` and `Vyx.Shared.Ui\Charting\`. Words follow `_naming-glossary.md`. Rows only for labels shown live; fixture-only labels are marked "(fixture)" and proposed as "remove" where they never appear once signed in.

## Shell (term-shell)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·shell | FUTURIX (brand text) | keep | — | Your broker's name. |
| T·shell | `FXG> {SYMBOL} {description}` (command line) | {SYMBOL} · {description} | — | Current chart symbol; click or press F2 to search symbols. |
| T·shell | Symbol search (F2) (tooltip) | keep | — | Opens symbol search. |
| T·shell | PRO \| BASIC (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·shell | DES desc / MW watch / OT ticket / POS positions / NEWS feed (fixture) | remove | — | Placeholder tags, not shown after sign-in. |
| T·shell | ACCOUNT | Account | — | Account number and whether it is Live or Demo. |
| T·shell | {number} {mode} | keep | — | Account number · Live / Demo. |
| T·shell | EQUITY USD | Equity ($) | $ | Balance + credit + floating P/L. |
| T·shell | MARGIN LVL | Margin level (%) | % | Equity ÷ used margin × 100; "—" when no positions are open. |
| T·shell | THEME ☀ LIGHT / ☾ DARK | Theme: Light / Dark | — | Switch light or dark colours. |
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

## Market Watch (term-marketwatch)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·marketwatch | 1) MW MARKET WATCH | Market Watch | — | Symbols you follow with live prices. |
| T·marketwatch | MARKET MONITOR (fixture) | Market Watch | — | Same panel before sign-in. |
| T·marketwatch | FEED LIVE (fixture) | remove | — | Placeholder, not shown after sign-in. |
| T·marketwatch | HH:mm:ss UTC | keep | UTC | Server clock. |
| T·marketwatch | SYMBOL | Symbol | — | Instrument name. |
| T·marketwatch | BID | Bid | — | Price you sell at. |
| T·marketwatch | ASK | Ask | — | Price you buy at. |
| T·marketwatch | SPRD | Spread (points) | points | Ask minus bid you are charged. |
| T·marketwatch | HIGH | Day high | — | Highest bid today (UTC). |
| T·marketwatch | LOW | Day low | — | Lowest bid today (UTC). |
| T·marketwatch | CHG% | Change (%) | % | Change since the day opened. |
| T·marketwatch | METALS / FOREX / OTHER (group bars) | Metals / Forex / Other | — | Symbol category. |
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
| T·marketwatch | Spread | Spread (points) | points | Show the spread column. |
| T·marketwatch | Daily High / Low | Day high / low | — | Show today's high and low. |
| T·marketwatch | ADD SYMBOL (flyout title) | Add symbol | — | — |
| T·marketwatch | search… | Search symbols… | — | — |
| T·marketwatch | all enabled symbols are on the watchlist | All available symbols are already in Market Watch | — | — |
| T·marketwatch | no match | No matching symbol | — | — |
| T·marketwatch | REMOVE FROM WATCHLIST (confirm title) | Remove from Market Watch | — | Confirms removing the symbol. |
| T·marketwatch | REMOVE (confirm button) | Remove | — | — |
| T·marketwatch | Symbol Specification (window title) | Symbol details | — | — |
| T·marketwatch | {SYMBOL} · {CATEGORY} (dialog title row) | keep | — | — |
| T·marketwatch | Symbol id | remove | — | Internal code; not useful to traders. |
| T·marketwatch | Digits | Price digits | — | Decimal places in the price. |
| T·marketwatch | Tick size | Point size | — | Smallest price step (1 point). |
| T·marketwatch | Contract size | keep | — | Units in 1 lot. |
| T·marketwatch | Pip value / 1 lot ("… USD per tick") | Point value ($ per lot) | $ per lot | Money gained or lost per 1-point move on 1 lot. |
| T·marketwatch | Stop level ("n ticks") | Min stop distance (points) | points | Closest a stop loss / take profit may be to the price. |
| T·marketwatch | Min lot | Min volume (lots) | lots | Smallest trade size. |
| T·marketwatch | Max lot | Max volume (lots) | lots | Largest trade size. |
| T·marketwatch | Lot step | Volume step (lots) | lots | Size increments allowed. |
| T·marketwatch | Bid / Ask | keep | — | Current sell / buy price. |
| T·marketwatch | Spread ("n pts") | Spread (points) | points | Current ask minus bid. |
| T·marketwatch | BUY ask markup | remove (already in Ask) | — | Broker markup; the Ask shown already includes it. |
| T·marketwatch | Market (OPEN (live quote) / CLOSED / unknown) | Market: Open / Closed / Unknown | — | Whether the symbol trades right now. |
| T·marketwatch | Margin / 1 lot @ 1:N | Margin for 1 lot ($) | $ | Margin held for 1 lot at your leverage 1:N. |
| T·marketwatch | Swaps, commissions and trading hours: per account group (broker) | Swap, commission and trading hours depend on your account group | — | — |
| T·marketwatch | CLOSE | Close | — | Close this window. |

## Chart (term-chart)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·chart | 2) GP | Chart | — | Price chart for the selected symbol. |
| T·chart | {SYMBOL} · {description} | keep | — | — |
| T·chart | LAYOUT · SINGLE / LAYOUT · 2×2 | Layout: Single / 2×2 | — | Click to switch; right-click for options. |
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
| T·chart | ‹ / › | Hide / Show panel | — | Collapse or expand the one-click panel. |
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
| T·chart | Collapse / Expand one-click panel | Hide / Show one-click panel | — | — |
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

## Order Ticket (term-ticket)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·ticket | 3) OT ORDER TICKET | Order ticket | — | Place a market or pending order. |
| T·ticket | {symbol} (header-right) | keep | — | Symbol on the chart. |
| T·ticket | MARKET / LIMIT / STOP | Market / Limit / Stop | — | Order type. |
| T·ticket | SYMBOL | Symbol | — | Pick the symbol; also switches the chart. |
| T·ticket | PRICE | Price | — | Price for a limit or stop order. |
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

## New Order (term-neworder)
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
| T·neworder | SLIPPAGE MAX (wm M = unlimited) | Max slippage (points) · M = no limit | points | Largest price change you accept on fill. |
| T·neworder | EXPIRY | Expiry: Until cancelled | — | — |
| T·neworder | LEVERAGE | keep | — | — |
| T·neworder | MARGIN REQ | Margin needed ($) | $ | Margin this order will hold. |
| T·neworder | PIP VALUE | Point value ($) | $ | Money per 1-point move at this volume. |
| T·neworder | RISK / REWARD / R:R | Risk ($) / Reward ($) / Reward : risk | $ | Loss at stop loss, profit at take profit, and their ratio. |
| T·neworder | CANCEL / PLACE ORDER | Cancel / Place order | — | — |
| T·neworder | SELL / BUY | Sell / Buy | — | — |
| T·neworder | CLOSE | Close | — | Close this window. |

## Positions (term-positions)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·positions | 4) TRADE | Positions | — | Your open positions. |
| T·positions | stream warning (amber) | Prices not updating | — | Price feed is down; values may be old. |
| T·positions | CLOSE PROFIT | Close profitable | — | Close every position in profit. |
| T·positions | CLOSE LOSS | Close losing | — | Close every position in loss. |
| T·positions | CLOSE ALL | Close all | — | Close every open position. |
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
| T·positions | PTS | Points | points | Price move since open, in your favour or against. |
| T·positions | P/L USD | Floating P/L ($) | $ | Profit or loss if closed now. |
| T·positions | COMMENT ✎ | Comment ✎ | — | Your note; click to edit. |
| T·positions | ACTIONS | Actions | — | — |
| T·positions | BE | Break-even | — | Move stop loss to the open price. |
| T·positions | PART | Close part | — | Close 25 / 50 / 75 %. |
| T·positions | MOD | Modify | — | Change stop loss / take profit or close. |
| T·positions | SHARE | Share | — | Make a picture card of this position. |
| T·positions | REV | Reverse | — | Close and open the opposite side at the same volume. |
| T·positions | ✕ | Close position | — | Close at market. |
| T·positions | close awaiting dealer (amber status) | Close waiting for dealer | — | Your close request is with the dealer. |
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

## Dock tabs (term-tabs)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·tabs | PENDING | Pending orders | — | Limit/stop orders not filled yet. |
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
| T·tabs | 1D 1W 1M 3M 6M ALL CUSTOM | Day / Week / Month / 3 months / 6 months / All / Custom | — | — |
| T·tabs | FROM / TO | From / To (UTC) | UTC | — |
| T·tabs | SYMBOL (ALL) | Symbol: All | — | — |
| T·tabs | summary text | keep | $ | Totals for the selected period. |
| T·tabs | STATEMENT ⤓ | Download statement | — | Save a statement for the period. |
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
| T·tabs | REASON (balance) | Comment | — | Why the money moved. |
| T·tabs | STATUS (balance) | Status | — | — |
| T·tabs | TIME | Time (UTC) | UTC | — |
| T·tabs | SRC | Source | — | Where the message came from. |
| T·tabs | MESSAGE | Message | — | — |

## Trade assistant (term-stm)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·stm | SMART TRADE MANAGER | Trade assistant | — | Hotkeys and bulk actions for your positions. |
| T·stm | ENABLED / DISABLED (pill) | On / Off | — | Turn the trade assistant on or off. |
| T·stm | Smart Trade Manager (tooltip) | Trade assistant | — | — |
| T·stm | SYMBOL · TYPE | Symbol · Order type | — | What the hotkeys trade. |
| T·stm | LOT SIZE | Volume (lots) | lots | Size used by the hotkeys. |
| T·stm | SL / TP | Stop loss / Take profit (points) | points | Distance from the entry price. |
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
| T·stm | bid x · +n pips · SL … · TP … · lots | Bid x · +n points · SL … · TP … · lots | points | Live state of the position. |
| T·stm | AUTOMATED RULES | Automatic rules | — | — |
| T·stm | ARMED (state text) | On | — | Rule is active. |
| T·stm | BREAK-EVEN | Break-even | — | Move stop loss to open when in profit. |
| T·stm | trigger (pips in profit) | Start at profit (points) | points | Profit needed before stop loss moves. |
| T·stm | lock (pips, 0 = open) | Lock in (points; 0 = open price) | points | Where the stop loss goes, above open. |
| T·stm | PARTIAL CLOSE AT TP1 | Close part at first target | — | — |
| T·stm | TP1 price | First target price | — | — |
| T·stm | close (%) | Close (%) | % | Share of volume to close. |
| T·stm | TRAILING STOP | Trailing stop | — | Stop loss follows price. |
| T·stm | distance (pips) | Distance (points) | points | Gap kept behind price. |
| T·stm | step (pips) | Step (points) | points | Minimum move before the stop loss moves. |
| T·stm | DISARM ALL | Turn off all rules | — | — |
| T·stm | ARM SELECTED RULES | Turn on selected rules | — | — |
| T·stm | ARM SMART RULES / ARM (confirm) | Turn on rules | — | — |
| T·stm | MANUAL ACTIONS | Actions now | — | — |
| T·stm | BREAK-EVEN NOW | Break-even now | — | — |
| T·stm | CLOSE 25% / 50% / 75% | Close 25% / 50% / 75% | % | — |
| T·stm | CLOSE (red) | Close position | — | — |
| T·stm | CLOSE WINDOW | Close window | — | — |

## Account (term-account)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·account | 6) ACC ACCOUNT | Account | — | Account money figures. |
| T·account | BALANCE | Balance ($) | $ | Money in the account, before open positions. |
| T·account | EQUITY | Equity ($) | $ | Balance + credit + floating P/L. |
| T·account | OPEN P/L | Floating P/L ($) | $ | Profit/loss of open positions. |
| T·account | MARGIN USED | Used margin ($) | $ | Margin held by open positions. |
| T·account | FREE MARGIN | Free margin ($) | $ | Equity minus used margin. |
| T·account | DAY P/L | Today's P/L ($) | $ | Closed P/L since 00:00 UTC plus floating P/L. |
| T·account | WEEK P/L | This week's P/L ($) | $ | Closed P/L since Monday 00:00 UTC plus floating P/L. |
| T·account | MARGIN n% (gauge) | Used margin (% of equity) | % | Share of equity held as margin. |
| T·account | LEVEL n% | Margin level (%) | % | Equity ÷ used margin × 100. |
| T·account | CALL n% | Margin call level (%) | % | Margin level where you get a warning. |
| T·account | STOP-OUT 20% (fixture) | Stop-out level (%) | % | Margin level where positions are closed automatically. |

## Calendar & news (term-eco)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·eco | 5) ECO CALENDAR · NEWS | Calendar & news | — | Economic events that can move prices. |
| T·eco | {n} EVENTS · {h} HIGH · UTC | {n} events · {h} high impact · times in UTC | UTC | — |
| T·eco | CALENDAR OFFLINE | Calendar unavailable | — | Could not load events. |
| T·eco | USD · XAU (before load) | Loading… | — | — |
| T·eco | time column | Time (UTC) | UTC | — |
| T·eco | HIGH / MED / LOW | High / Medium / Low | — | Expected market impact. |
| T·eco | NEWS (fixture rows) | News | — | Headline, not a scheduled event. |

## Price alerts (term-alerts)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
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

## Settings (term-settings)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·settings | Settings (window title) | keep | — | — |
| T·settings | CONFIRMATIONS | Confirmations | — | Which actions ask before sending. |
| T·settings | Confirm ticket / New Order / dock closes before sending | Confirm orders and closes from the ticket, New order and Positions | — | — |
| T·settings | Confirm chart right-click orders | Confirm orders from the chart menu | — | — |
| T·settings | Confirm SL/TP drags and inline edits | Confirm stop loss / take profit changes | — | Drags on the chart and edits in the table. |
| T·settings | Confirm price alerts | keep | — | — |
| T·settings | Slippage max (points · M = unlimited) | Max slippage (points) · M = no limit | points | Largest price change you accept on fill. |
| T·settings | ⚠ With market volatility or price movement, your entries/orders may be rejected. | ⚠ When prices move fast, orders may be rejected with this limit. | — | — |
| T·settings | I understand — apply this slippage limit | keep | — | — |
| T·settings | ACCOUNT | Account | — | — |
| T·settings | 1-click trading ON by default (skips only the human confirm) | One-click trading on at start (skips the confirm only) | — | — |
| T·settings | CHART | Chart | — | — |
| T·settings | Crosshair sync across the 2×2 grid | Link crosshair across the 2×2 grid | — | — |
| T·settings | CHART APPEARANCE… | Chart appearance… | — | Candle colours and display. |
| T·settings | WORKSPACE | Workspace | — | — |
| T·settings | RESET GRID SYMBOLS | Reset grid symbols | — | Put the default symbols back in the 2×2 grid. |
| T·settings | Sounds and keyboard remapping: coming soon. | keep | — | — |
| T·settings | CANCEL / SAVE | Cancel / Save | — | — |

## Hotkeys & sounds (term-hotkeys-sounds)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·hotkeys-sounds | F-key strip labels | see T·shell rows | — | Same labels as the status bar. |
| T·hotkeys-sounds | BUY HOTKEY / SELL HOTKEY | Buy hotkey / Sell hotkey | — | Key that sends the order. |
| T·hotkeys-sounds | set hotkey (wm) / Press a key | Press to set / Press a key | — | — |
| T·hotkeys-sounds | hint line | keep | — | — |
| T·hotkeys-sounds | LOG columns TIME / SRC / MESSAGE | Time (UTC) / Source / Message | UTC | — |
| T·hotkeys-sounds | COLUMNS (header menu) | Columns | — | — |
| T·hotkeys-sounds | action line OK · / FAILED · | Done · / Failed · | — | Result of the last action, clears after 3 s. |

## Sign-in (term-session)
| Screen | Current label | Proposed name | Unit | Tooltip (one line) |
|---|---|---|---|---|
| T·session | refusal window message + progress | keep | — | Why the terminal cannot start. |
| T·session | Build <id> | Version <id> | — | — |
| T·session | CLOSE (refusal) | Close | — | — |
| T·session | <ProductTitle> — Sign in (window title) | keep | — | — |
| T·session | <ProductTitle> · sign in to start · dd MMM yyyy UTC | keep | UTC | — |
| T·session | ☾ / ☀ | Dark / Light theme | — | — |
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

## Added terms
| Concept | Word chosen |
|---|---|
| Money per 1-point move (replaces "pip value") | Point value ($) — per lot: Point value ($ per lot) |
| Margin an order will hold before it is sent | Margin needed ($) |
| Smallest price step shown in symbol details | Point size |
| Share of equity risked at the stop loss | Risk (% of equity) |
| Loss at SL / profit at TP / ratio | Risk ($) / Reward ($) / Reward : risk |
| Closed P/L since 00:00 UTC plus floating P/L | Today's P/L ($) (week: This week's P/L ($)) |
| Used margin as share of equity (gauge) | Used margin (% of equity) |
| Price move of a position since open | Points |
| Why a trade closed | Closed by |
| Dealer offered a new price (client side) | New price offered |
| Balance tab (money in/out) | Deposits & withdrawals |
| Terminal log tab | Journal |
| Order tab (all sent orders) | Order history |
| Time a position has been open | Time open |
| Tick volume on candles | Tick volume |
| Candle timeframes | M1 M5 M15 M30 H1 H4 D1 W1 |
| Sum of open position values in footer | Exposure ($) |
| Symbol min/max/step size | Min volume / Max volume / Volume step (lots) |
| Pending order good until cancelled | Until cancelled |
| Trade assistant switch state | On / Off |
