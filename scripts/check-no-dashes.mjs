#!/usr/bin/env node
// Reputation guard (2026-09-05): em-dash (—, U+2014) and en-dash (–, U+2013)
// in user-facing text read as an AI fingerprint to anyone who's seen enough
// LLM output -- this project has hit that complaint more than once. Scans
// tracked .ts/.tsx source for either character outside `//` line comments
// and `/* */` block comments (comments are developer-facing, not shown to
// a user, so they're exempt -- this file's own header is fine). Not a
// perfect parser (a `//` or `/*` inside a real string literal would throw
// it off), but this codebase doesn't do that, and "good enough to catch
// the real cases" beats a full TS parser dependency for a solo-dev project.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync('git ls-files "*.ts" "*.tsx"', { cwd: process.cwd() })
  .toString()
  .split("\n")
  .filter(Boolean)
  // Test files are developer/CI-facing (it()/describe() names, fixtures),
  // never rendered to a real user -- out of scope for this check.
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .filter((f) => !f.startsWith("scripts/check-no-dashes.mjs"));

const DASH = /[—–]/;
const violations = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  let inBlockComment = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let code = "";
    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("*/", j);
        if (end === -1) {
          j = line.length;
        } else {
          inBlockComment = false;
          j = end + 2;
        }
        continue;
      }
      const lineCommentIdx = line.indexOf("//", j);
      const blockCommentIdx = line.indexOf("/*", j);
      if (lineCommentIdx !== -1 && (blockCommentIdx === -1 || lineCommentIdx < blockCommentIdx)) {
        code += line.slice(j, lineCommentIdx);
        break;
      }
      if (blockCommentIdx !== -1) {
        code += line.slice(j, blockCommentIdx);
        inBlockComment = true;
        j = blockCommentIdx + 2;
        continue;
      }
      code += line.slice(j);
      break;
    }
    if (DASH.test(code)) {
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Em-dash/en-dash found in user-facing code (replace with '-', ':', or restructure the sentence):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("No em-dash/en-dash found in user-facing code.");
