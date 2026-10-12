import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kycWord, KYC_EMAIL } from "@/lib/kyc-words";

// Owner decision 2026-10-07: one word everywhere, "KYC", values Not verified / Pending / Verified / Rejected. This is a
// grep-style guard over every user-facing source file of the web app (pages, components, routes, lib): none of the old
// words may come back. Comment lines are skipped. The native apps have the same guard in Vyx.Shared.Tests.
const ROOTS = ["app", "components", "lib"];
const FORBIDDEN: [string, RegExp][] = [
  ["ID check", /\bID[ -]?checks?\b/i],
  ["Not started", /\bnot started\b/i],
  ["Identity verification", /\bidentity verification\b/i],
  ["Verify (your) identity", /\bverify (your )?identity\b/i],
  ["identity is verified", /\bidentity is (already )?verified\b/i],
  ["Not submitted", /\bnot submitted\b/i],
  ["NO KYC", /"NO KYC"|>NO KYC</],
];

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
}

describe("KYC wording (owner 2026-10-07)", () => {
  it("no user-facing file says ID check, Not started, Identity verification, Not submitted or the other old words", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
        const code = line.replace(/\s\/\/\s.*$/, "");
        for (const [name, re] of FORBIDDEN) if (re.test(code)) hits.push(`${f}:${i + 1} (${name}) ${t.slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("raw statuses become Not verified / Pending / Verified / Rejected", () => {
    expect([null, undefined, "NONE", "PENDING", "APPROVED", "REJECTED"].map((s) => kycWord(s))).toEqual(["Not verified", "Not verified", "Not verified", "Pending", "Verified", "Rejected"]);
    expect(kycWord("VERIFIED")).toBe("Verified");
  });

  it("e-mail wording for the later KYC mails", () => {
    expect(KYC_EMAIL).toEqual({ subjectApproved: "Your KYC is approved", subjectRejected: "Your KYC needs new documents", headingApproved: "KYC approved", headingRejected: "KYC not approved" });
  });
});
