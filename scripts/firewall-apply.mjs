#!/usr/bin/env node
// Applies firewall/crm-rules.json to the Vercel project with the `vercel firewall` CLI (owner 2026-11-13).
//   node scripts/firewall-apply.mjs log       every rule as Log (watch the Firewall tab first)
//   node scripts/firewall-apply.mjs enforce   each rule's real action (challenge / rate limit)
// A rule with the same name is replaced, so running it again is safe. The changes are staged as a draft; the script
// prints the diff and the publish command (publishing needs the project name and the diff's effects digest).
// Run from a directory linked to the Vercel project (C:\vyx\web), e.g.
//   cd C:\vyx\web && node C:\vyx\wt-portal\scripts\firewall-apply.mjs log
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "log" && mode !== "enforce") {
  console.error("usage: node scripts/firewall-apply.mjs log|enforce");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "firewall", "crm-rules.json"), "utf8"));
// The CLI is run with node directly (no shell): a Windows shell mangles the quotes inside the --data JSON.
// VERCEL_CLI_JS overrides; otherwise the globally installed vercel package.
const CLI = process.env.VERCEL_CLI_JS
  ?? (process.platform === "win32" ? join(process.env.APPDATA ?? "", "npm", "node_modules", "vercel", "dist", "vc.js") : "/usr/local/lib/node_modules/vercel/dist/vc.js");
const vercel = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

/** The rule's action for this mode. Log keeps the rate-limit counting so the Firewall tab shows who would be limited. */
export function actionFor(rule, m) {
  if (m === "enforce") return rule.enforce;
  const rl = rule.enforce.mitigate.rateLimit;
  return rl
    ? { mitigate: { action: "rate_limit", rateLimit: { ...rl, action: "log" } } }
    : { mitigate: { action: "log" } };
}

const existing = JSON.parse(vercel(["firewall", "rules", "list", "--json"]) || "{}");
const byName = new Map((existing.rules ?? existing.customRules ?? existing ?? []).filter?.((r) => r?.name).map((r) => [r.name, r]) ?? []);
for (const rule of cfg.rules) {
  const data = JSON.stringify({ name: rule.name, description: rule.description, active: true, conditionGroup: rule.conditionGroup, action: actionFor(rule, mode) });
  const args = byName.has(rule.name) ? ["firewall", "rules", "update", byName.get(rule.name).id ?? rule.name, "--data", data, "--yes"] : ["firewall", "rules", "add", "--data", data, "--yes"];
  console.log(`${byName.has(rule.name) ? "update" : "add"}: ${rule.name} (${mode})`);
  console.log(vercel(args).trim());
}
console.log(vercel(["firewall", "diff"]).trim());
console.log(`\nPublish: npx vercel firewall publish --project ${cfg.project} --confirm-name ${cfg.project} --effects-digest <digest above>`);
