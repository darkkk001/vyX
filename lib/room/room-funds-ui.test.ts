import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currencySymbol, newRequestKey } from "@/components/room/money-input";
import { REQUEST_KEY } from "@/lib/room/request-key";

// Room Deposit / Withdraw / Transfer (owner 2026-11-09): the currency symbol inside the amount field, a stale
// "Enter an amount." clears on typing, one request per form load (Sending… until the answer, then the confirmation
// replaces the form), method cards in fixed slots, no "platform does not hold client money" line, and the Dashboard's
// Trade on links go straight to the WebTrader (new tab) and the installer.
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const DEPOSIT = "app/(broker)/room/(shell)/deposit/page.tsx";
const WITHDRAW = "app/(broker)/room/(shell)/withdraw/page.tsx";
const TRANSFER = "app/(broker)/room/(shell)/transfer/page.tsx";
const FORMS = [DEPOSIT, WITHDRAW, TRANSFER];

describe("currency symbol in the amount field", () => {
  it("comes from the account currency, the code when there is no symbol", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("GBP")).toBe("£");
    expect(currencySymbol("usd")).toBe("$");
    expect(currencySymbol(null)).toBe("$");
    expect(currencySymbol("XYZ")).toBe("XYZ");
  });
  it.each(FORMS)("%s: the amount is the AmountInput with the selected account's currency, the label without '· USD'", (f) => {
    const s = src(f);
    expect(s).toMatch(/<AmountInput id="\w+" currency=\{(account\?\.currency|ccy|from\?\.currency)\}/);
    expect(s).not.toMatch(/Amount · \{/);
    expect(s).toMatch(/>Amount<\/label>/);
  });
});

describe('the stale "Enter an amount."', () => {
  it.each(FORMS)("%s: typing in the amount clears a red message", (f) => {
    expect(src(f)).toMatch(/onChange=\{\(v\) => \{ setAmount\(v\); if \(msg && !msg\.ok\) setMsg\(null\); \}\}/);
  });
});

describe("one request per form load", () => {
  it("the key matches what the server accepts", () => {
    for (let i = 0; i < 20; i++) expect(REQUEST_KEY.test(newRequestKey())).toBe(true);
  });
  it.each(FORMS)("%s: sends the key, locks on the first click until the answer, then shows the confirmation", (f) => {
    const s = src(f);
    expect(s).toMatch(/useSendOnce\(\)/);
    expect(s).toMatch(/key: send\.key/);
    expect(s).toMatch(/if \(!send\.begin\(\)\) return;/);
    expect(s).toMatch(/send\.end\(\);/);
    expect(s).toMatch(/\{(done|status) \? \(\s*<div[^>]*>\s*<(FundsDone|DepositStatus)/);
    expect(s).toMatch(/send\.renew\(\)/);
  });
  it("the lock is a ref, so a second click in the same frame is refused before React re-renders", () => {
    expect(src("components/room/useFunds.ts")).toMatch(/if \(sending\.current\) return false;\s*sending\.current = true;/);
  });
});

describe("Deposit and Withdraw layout", () => {
  it("the 'platform does not hold client money' line is gone", () => {
    expect(src(DEPOSIT)).not.toMatch(/does not hold client money/);
    expect(src(WITHDRAW)).not.toMatch(/does not hold client money/);
  });
  it("method cards: three slots in a fixed order, an unset value leaves an empty slot", () => {
    const s = src("components/room/MethodGrid.tsx");
    expect(s).toMatch(/\[\["Processing", terms\.processing\], \["Fee", m\.feeLine \?\? "0%"\], \["Limits", limits\(terms, currency\)\]\]/);
    expect(s).not.toMatch(/lines\.filter/);
    expect(s).toMatch(/: <span key=\{k\} className="r-method-line" aria-hidden="true" \/>/);
  });
  it("every card the same height, slots at least one line tall, the Not available badge pinned at the bottom", () => {
    const css = src("app/(broker)/room/room.css");
    expect(css).toMatch(/\.r-method-grid \{[^}]*grid-auto-rows: 1fr;/);
    expect(css).toMatch(/\.r-method-line \{[^}]*min-height: 17px;/);
    expect(css).toMatch(/\.r-method-chip \{[^}]*margin-top: auto;/);
    // owner 2026-11-12 (Neteller "Instant-24 hours" was cut off): a long value wraps to a second line, never cut;
    // the label stays on one line, and grid-auto-rows 1fr keeps every card the height of the tallest
    expect(css).not.toMatch(/\.r-method-line \{[^}]*white-space: nowrap;/);
    expect(css).toContain(".r-method-line > span:first-child { flex-shrink: 0; white-space: nowrap; }");
    expect(css).toContain(".r-method-line > .mono { min-width: 0; text-align: right; overflow-wrap: anywhere; }");
    expect(css).not.toMatch(/\.r-method-line > \.mono \{[^}]*(ellipsis|overflow: hidden)/);
  });
});

describe("Trade on links", () => {
  const dash = () => src("app/(broker)/room/(shell)/page.tsx");
  it("WebTrader Open: the WebTrader in a new tab", () => {
    expect(dash()).toMatch(/<span>WebTrader<\/span><a href="\/trade" target="_blank" rel="noopener"/);
  });
  it("Desktop terminal Download: the installer itself", () => {
    expect(dash()).toMatch(/<span>Desktop terminal<\/span><a href="\/download\/terminal\/installer"/);
    expect(src("app/(broker)/download/terminal/installer/route.ts")).toMatch(/NextResponse\.redirect\(new URL\(feed \? feed\.setupPath : "\/download\/terminal", origin\), 302\)/);
  });
  it("Mobile app stays on Downloads", () => {
    expect(dash()).toMatch(/<span>Mobile app<\/span><a href="\/room\/downloads"/);
  });
  it("an account card's Trade: the WebTrader in a new tab with that account", () => {
    // Dashboard and Accounts share one card (owner 2026-11-10)
    expect(dash()).toContain("<AccountCard key={a.id} a={a}");
    expect(src("components/room/AccountCard.tsx")).toMatch(/href=\{`\/trade\?account=\$\{encodeURIComponent\(a\.accountNumber\)\}`\} target="_blank" rel="noopener">Trade<\/a>/);
    const trade = src("app/(broker)/trade/page.tsx");
    expect(trade).toMatch(/const toLogin = wanted \? `\/trade\/login\?account=\$\{wanted\}` : "\/trade\/login";/);
    expect(trade).toMatch(/if \(current\?\.accountNumber !== wanted\) redirect\(toLogin\);/);
  });
  it("Downloads Open WebTrader: a new tab", () => {
    expect(src("app/(broker)/room/(shell)/downloads/page.tsx")).toMatch(/<a href="\/trade" target="_blank" rel="noopener"[^>]*>Open WebTrader<\/a>/);
  });
});

describe("deposit confirmation and countdown (owner 2026-11-10)", () => {
  const dep = () => src(DEPOSIT);
  it("the card re-reads its request on every room event, and every 15 s while waiting", () => {
    expect(dep()).toMatch(/useRoomEvent\(\(\) => \{ if \(status\) void loadStatus\(status\.id\);/);
    expect(dep()).toMatch(/if \(status\?\.state !== "PENDING"\) return;\s*const t = setInterval\(\(\) => void loadStatus\(status\.id\), 15_000\);/);
  });
  it("coming back while it is pending shows the card again", () => {
    expect(dep()).toMatch(/if \(resume && b\.pending && b\.pending\.id !== dismissed\) setStatus/);
  });
  it("the submit button and the method card count down", () => {
    expect(dep()).toMatch(/methodWait \? `Next request in \$\{countdown\(methodWait, serverNow\)\}`/);
    expect(src("components/room/MethodGrid.tsx")).toMatch(/>Next request in \{countdown\(waits\[m\.id\], now\)\}</);
  });
  it("the card's three outcomes", () => {
    const c = src("components/room/DepositStatus.tsx");
    for (const t of ["Waiting for confirmation", "Your deposit has been approved", "Your deposit was rejected", "New balance of", "Reason: "]) expect(c).toContain(t);
  });
});

describe("demo Top up", () => {
  it("on demo cards of the Dashboard and Accounts, never on live ones", () => {
    for (const p of ["app/(broker)/room/(shell)/page.tsx", "app/(broker)/room/(shell)/accounts/page.tsx"]) expect(src(p), p).toContain("<AccountCard key={a.id} a={a}");
    const card = src("components/room/AccountCard.tsx");
    expect(card).toMatch(/\) : <TopUpButton account=\{a\}/);
    expect(card).toMatch(/\{live \? \(\s*<>\s*<a [^\n]*>Deposit<\/a>\s*<a [^\n]*>Withdraw<\/a>\s*<a [^\n]*>Transfer<\/a>/);
    expect(src("components/room/TopUpButton.tsx")).toMatch(/if \(account\.mode !== "DEMO"\) return null;/);
  });
  it("Accounts page Trade opens the WebTrader with that account", () => {
    expect(src("components/room/AccountCard.tsx")).toMatch(/href=\{`\/trade\?account=\$\{encodeURIComponent\(a\.accountNumber\)\}`\} target="_blank" rel="noopener">Trade<\/a>/);
  });
});
