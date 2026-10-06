import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { unavailableText } from "@/lib/price-source-alert";
import { clientBuildErrorMessage } from "@/lib/client-builds";

// Step 2 "foundations" (owner rule 2026-10-06): brokers and traders never see infrastructure. A grep-style guard over
// the surfaces reworded from the infra-leak sweep, so a later edit cannot quietly bring the old text back. Comments are
// stripped first (developer text is allowed to name the infrastructure).

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Source text with // and block comments removed (good enough for this codebase, like scripts/check-no-dashes.mjs). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      // keep "https://" and regex literals with "//" inside strings out of the cut: only cut "//" preceded by space/start
      return i >= 0 && (i === 0 || /\s/.test(l[i - 1])) ? l.slice(0, i) : l;
    })
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("reworded surfaces keep the old infrastructure text out", () => {
  const cases: [string, (string | RegExp)[]][] = [
    ["app/manage/(shell)/feed-health/FeedHealthManager.tsx", ["Rust", "Vercel", "Legacy p50", "engine/server", "WebSocket gateway", "services/api-gateway", "since boot", "Ticks ingested", "Ticks forwarded", "Order ack", "expected until it"]],
    ["app/manage/(shell)/feed-health/page.tsx", ["Tick-pipeline", "Tick Pipeline Audit", "local dev stack"]],
    ["components/webtrader/WebTrader.tsx", ['status-label">Ping', /instanceof Error \? (err|e)\.message/, "Feed went stale", /toFixed\(2\)\}<\/span>/]],
    ["components/webtrader/SmartTradeManager.tsx", [/instanceof Error \? (err|e)\.message/]],
    ["lib/desktop-api.ts", [/new (Api)?Error\([^)]*request to \$\{path\}/]],
    ["lib/mirror.ts", ["Rule ${rule.id}:", "breached", "kill switch triggered", 'err instanceof Error ? err.message : "unknown error"']],
    ["lib/pending-trigger.ts", ["could not be filled: ${reason}"]],
    ["app/api/trade/orders/route.ts", ["the database is being updated"]],
    ["app/api/manage/symbols/route.ts", ["Contact engineering", "not yet implemented"]],
    ["app/api/manage/dealing-desk-toggle/route.ts", ['reason: "internal error"']],
    ["app/api/manage/clients/[id]/resend-verification/route.ts", ["could not be sent: ${"]],
    ["app/(broker)/portal/(shell)/profile/ProfileView.tsx", ["(HTTP"]],
    ["app/manage/(shell)/groups/page.tsx", ["trading engine"]],
    ["app/manage/(shell)/positions/PositionsManager.tsx", ["MT5"]],
    ["app/manage/(shell)/emergency/page.tsx", ["broker-wide"]],
    ["app/manage/(shell)/risk/page.tsx", ["Broker-wide"]],
    ["app/api/manage/dashboard/route.ts", ["broker hedge account"]],
    ["lib/client-builds.ts", ["by your broker"]],
  ];
  for (const [file, banned] of cases) {
    it(file, () => {
      const src = code(file);
      for (const b of banned) {
        if (typeof b === "string") expect(src.includes(b), `${file} still contains ${JSON.stringify(b)}`).toBe(false);
        else expect(b.test(src), `${file} still matches ${b}`).toBe(false);
      }
    });
  }
});

describe("broker / trader UI code names no infrastructure", () => {
  // Feed health keeps its counters (NATS, database writes, clock sync) until step 4 moves them to the super admin.
  const files = [...walk("app/manage"), ...walk("app/(broker)"), ...walk("components/webtrader"), ...walk("components/manage")].filter((f) => !f.includes("feed-health"));
  const INFRA = /\b(MT5|NATS|Neon|Caddy|Vercel|Rust|Prisma)\b|pricing engine|trading engine|engine\/server|\(HTTP \$\{|\$\{[^}]*\}\s?ms\b|request to \$\{/;
  it(`${files.length} files`, () => {
    const hits: string[] = [];
    for (const f of files) {
      code(f).split("\n").forEach((line, i) => {
        if (INFRA.test(line) && !/^\s*import\b/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
  it("every server error shown on a manage / portal page goes through plainError (no raw `x.error ?? ...`)", () => {
    const hits: string[] = [];
    for (const f of [...files, ...walk("components/admin")]) {
      code(f).split("\n").forEach((line, i) => {
        if (/\b\w+\.error \?\? ["`]/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("notification and refusal texts", () => {
  it("price-source-down body: when, and what stops; no reason, no infrastructure", () => {
    const { body } = unavailableText(Date.UTC(2026, 9, 6, 9, 5));
    expect(body).toBe("Live prices unavailable since 09:05 UTC. Until they are back, no close, stop loss, take profit, stop-out or pending order is executed.");
    expect(body).not.toMatch(/engine|timeout|HTTP|\d+\s?ms\b|feed/i);
  });
  it("install refusals carry no actor (D4)", () => {
    for (const reason of ["revoked", "wrong-tenant", "unknown", "missing"] as const) {
      expect(clientBuildErrorMessage({ ok: false, reason, buildId: "x" } as never)).not.toMatch(/your broker|support/i);
    }
  });
});
