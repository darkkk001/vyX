// Owner 2026-11-10: WebTrader shows the credit (bonus) on its own line under the balance, never added to it, while it is not 0
// (the native terminal's rule); equity still counts it (credit Model A). Source checks: the account panel, the status bar and
// the phone layout's grid.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", "components", "webtrader", f), "utf8");

describe("WebTrader credit display", () => {
  const wt = src("WebTrader.tsx");
  const mobile = src("MobileTrader.tsx");

  it("equity is balance + credit + floating P/L (unchanged)", () => {
    expect(wt).toContain('const equity = account ? parseFloat(account.balance) + parseFloat(account.credit ?? "0") + floatingPnl : 0;');
  });

  it("the account panel and the status bar show a Credit line right after Balance, only while the credit is not 0, hidden with the balance", () => {
    expect(wt).toContain("const showCredit = Math.abs(accountCredit) >= 0.005;");
    const panel = wt.indexOf('<span className="nt-row-label">Balance</span>');
    const panelCredit = wt.indexOf('{showCredit ? <div className="nt-row"><span className="nt-row-label">Credit</span>');
    expect(panel).toBeGreaterThan(0);
    expect(panelCredit).toBeGreaterThan(panel);
    expect(panelCredit).toBeLessThan(wt.indexOf('<span className="nt-row-label">Equity</span>'));
    const bar = wt.indexOf('<span className="status-label">Balance</span>');
    const barCredit = wt.indexOf('{showCredit ? <div className="status-item"><span className="status-label">Credit</span>');
    expect(barCredit).toBeGreaterThan(bar);
    expect(wt.slice(panelCredit, panelCredit + 260)).toContain('balanceHidden ? "••••••" : formatMoney(accountCredit)');
    // the balance itself is still the account's balance alone
    expect(wt).toContain('account ? formatMoney(account.balance) : ""');
  });

  it("the phone layout's grid shows CREDIT after BALANCE while it is not 0", () => {
    expect(wt).toContain("marginCall, credit: accountCredit }");
    const bal = mobile.indexOf('<span className="m-micro">BALANCE</span><b>{h(mMoney(f.balance))}</b>');
    const cr = mobile.indexOf('<span className="m-micro">CREDIT</span><b>{h(mMoney(f.credit))}</b>');
    expect(bal).toBeGreaterThan(0);
    expect(cr).toBeGreaterThan(bal);
    expect(mobile).toContain("f.credit != null && Math.abs(f.credit) >= 0.005");
  });
});
