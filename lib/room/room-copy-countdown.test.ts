import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maxProcessingSeconds, durationWords, clock } from "@/lib/room/processing-time";

// Owner 2026-11-10: the Trader's Room is the broker's own site, so it never says "your broker" (the company speaks, or
// neutral); the Deposit form loses its "credits the deposit" line; the waiting deposit card counts down to the method's
// maximum processing time.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
function files(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}
// visible text only: comments are for developers
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no 'your broker' in the Trader's Room", () => {
  const scope = [...files("app/(broker)/room"), ...files("components/room"), ...files("app/api/room"), ...files("lib/room")];
  it("pages, components, Room APIs", () => {
    const hits = scope.filter((f) => /your broker|broker approval|broker credits|by the broker/i.test(code(read(f))));
    expect(hits).toEqual([]);
  });
  it("the owner's lines", () => {
    expect(read("app/(broker)/room/login/LoginForm.tsx")).toContain("Use the email you registered with.");
    expect(read("app/(broker)/room/(shell)/downloads/SignInCard.tsx")).toContain("use the password sent to your email.");
    expect(read("app/(broker)/room/(shell)/withdraw/page.tsx")).toContain("Withdrawals are paid only to accounts in your own name and are reviewed before payout.");
    expect(read("components/room/TierPanel.tsx")).toContain("Thresholds and benefits are set by {brand} and may change with notice.");
    expect(read("components/room/TierPanel.tsx")).toContain("const brand = useRoom().data?.platform?.name");
  });
  it("the Deposit form has no 'credits the deposit' line", () => {
    expect(read("app/(broker)/room/(shell)/deposit/page.tsx")).not.toMatch(/credits the deposit/);
  });
});

describe("deposit countdown", () => {
  it("reads the maximum of the method's processing time", () => {
    expect(maxProcessingSeconds("Instant–15 min")).toBe(900);
    expect(maxProcessingSeconds("Instant-15 min")).toBe(900);
    expect(maxProcessingSeconds("Instant-1 hour")).toBe(3600);
    expect(maxProcessingSeconds("Instant-30 min")).toBe(1800);
    expect(maxProcessingSeconds("1-24 hours")).toBe(86400);
    expect(maxProcessingSeconds("1 hour-1 day")).toBe(86400);
    expect(maxProcessingSeconds("1-3 business days")).toBe(3 * 86400);
    expect(maxProcessingSeconds("Same day")).toBeNull();
    expect(maxProcessingSeconds(null)).toBeNull();
  });
  it("m:ss, and the line under it", () => {
    expect(clock(900)).toBe("15:00");
    expect(clock(61.4)).toBe("1:01");
    expect(clock(0)).toBe("0:00");
    expect(clock(-5)).toBe("0:00");
    expect(clock(3600)).toBe("1:00:00");
    expect(durationWords(900)).toBe("15 minutes");
    expect(durationWords(3600)).toBe("1 hour");
    expect(durationWords(86400)).toBe("1 day");
  });
  it("the card: countdown from sentAt, the owner's lines, and the decided states as before", () => {
    const card = read("components/room/DepositStatus.tsx");
    expect(card).toContain("const left = v.maxSeconds ? v.maxSeconds - (now - new Date(v.sentAt).getTime()) / 1000 : null;");
    expect(card).toContain("Usually confirmed within {durationWords(v.maxSeconds!)}.");
    expect(card).toContain("Taking a little longer than usual. This page updates as soon as it&apos;s confirmed.");
    expect(card).toContain("setInterval(() => setNow(Date.now()), v.maxSeconds ? 1000 : 15_000)");
    expect(card).toContain('"Your deposit has been approved"');
    expect(card).toContain('"Your deposit was rejected"');
    expect(read("lib/room/deposit-status.ts")).toContain("maxSeconds: maxProcessingSeconds(r.paymentMethod?.processingTime),");
  });
});
