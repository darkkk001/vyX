// READ-ONLY STAFF OBSERVER (S5): signs into the zzshadowbot backoffice as observer@zzshadowbot.local (role SUPPORT,
// no extra permissions: every write route refuses it) and reads ONE thing, the open positions of the broker's
// coverage account 49990099, so the bot can see an auto-hedge leg appear and close without a trade login on that system
// account. Every request is checked against guards.assertObserverRequest (exactly three: sign-in, the 2FA step, that
// read). The credentials come from the file scripts/seed-zzshadowbot-observer.ts writes; nothing of them (password,
// TOTP secret, pending token, session cookie) is ever journaled.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COVERAGE_ACCOUNT, GuardRefused, TENANT, TRADE_HOST, assertObserverRequest } from "./guards";
import { msLeftInStep, totp } from "./totp";

export type CoveragePos = { id: string; ticket: number | null; symbol: string; side: "BUY" | "SELL"; volume: number; openPrice: number; openedAt: string };
export type ObserverCreds = { email: string; password: string; totpSecret: string; tenant: string };

/** What the runner needs: the coverage account's open positions (the live observer, or the dry-run simulator). */
export interface Observer {
  coveragePositions(): Promise<CoveragePos[]>;
}

export const DEFAULT_OBSERVER_FILE = path.join(os.homedir(), ".vyx", "shadowbot-observer.json");

export function loadObserverCreds(file: string): ObserverCreds {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new GuardRefused(`observer credentials not readable at ${file} (created by scripts/seed-zzshadowbot-observer.ts --apply)`);
  }
  const c = raw as Partial<ObserverCreds>;
  if (c.tenant !== TENANT || c.email !== `observer@${TENANT}.local`) throw new GuardRefused(`observer credentials in ${file} are not for ${TENANT}'s observer`);
  if (typeof c.password !== "string" || c.password.length < 16 || typeof c.totpSecret !== "string" || !/^[A-Z2-7]{16,}$/.test(c.totpSecret)) {
    throw new GuardRefused(`observer credentials in ${file} are incomplete`);
  }
  return { email: c.email, password: c.password, totpSecret: c.totpSecret, tenant: c.tenant };
}

export class HttpObserver implements Observer {
  private cookie: string | null = null;
  private lastLogin = 0;
  constructor(private readonly creds: ObserverCreds) {}

  private async post(pathQ: string, body: unknown): Promise<{ status: number; json: any; setCookie: string[] }> {
    const url = `${TRADE_HOST}${pathQ}`;
    assertObserverRequest("POST", url);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
    return { status: res.status, json: await res.json().catch(() => ({})), setCookie: res.headers.getSetCookie() };
  }

  /** Password, then the TOTP code computed from the stored secret (never a backup code: the observer has none). */
  private async login(): Promise<void> {
    const since = Date.now() - this.lastLogin;
    if (since < 15_000) throw new Error(`observer login refused by the bot: last one ${Math.round(since / 1000)} s ago (server allows 5/min)`);
    this.lastLogin = Date.now();
    const first = await this.post("/api/manage/login", { email: this.creds.email, password: this.creds.password });
    if (first.status !== 200) throw new Error(`observer sign-in answered ${first.status}: ${String(first.json?.error ?? "")}`);
    if (!first.json?.requiresTwoFactor || typeof first.json?.pendingToken !== "string") {
      // its 2FA is off (the seed turns it on): not the user the bot expects, so it does not continue
      throw new GuardRefused("the observer signed in without two-step verification: re-run scripts/seed-zzshadowbot-observer.ts");
    }
    if (msLeftInStep() < 3_000) await new Promise((r) => setTimeout(r, msLeftInStep() + 200)); // never a code about to expire
    const second = await this.post("/api/manage/login/verify-2fa", { pendingToken: first.json.pendingToken, code: totp(this.creds.totpSecret) });
    if (second.status !== 200) throw new Error(`observer two-step sign-in answered ${second.status}: ${String(second.json?.error ?? "")}`);
    const jar = second.setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!jar) throw new Error("observer sign-in: no session cookie returned");
    this.cookie = jar;
  }

  async coveragePositions(retry = true): Promise<CoveragePos[]> {
    const url = `${TRADE_HOST}/api/manage/accounts/${COVERAGE_ACCOUNT}/positions`;
    assertObserverRequest("GET", url);
    if (!this.cookie) await this.login();
    const res = await fetch(url, { headers: { cookie: this.cookie! }, redirect: "manual" });
    if ((res.status === 401 || res.status === 403) && retry) {
      this.cookie = null;
      return this.coveragePositions(false);
    }
    const j: any = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`coverage positions answered ${res.status}: ${String(j?.error ?? "")}`);
    return (j.positions as any[]).map((p) => ({ id: String(p.id), ticket: p.ticket ?? null, symbol: String(p.symbol), side: p.side, volume: Number(p.volume), openPrice: Number(p.openPrice), openedAt: String(p.openedAt) }));
  }
}
