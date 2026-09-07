#!/usr/bin/env node
// Reputation guard (2026-09-05, widened 2026-09-08): em-dash (—, U+2014),
// en-dash (–, U+2013), and the ASCII "--" idiom in user-facing text all
// read as an AI fingerprint to anyone who's seen enough LLM output -- this
// project has hit that complaint more than once, and "--" is exactly the
// substitute an em-dash gets rewritten to if only the Unicode characters
// are blocked, so it has to be caught too. Scans tracked .ts/.tsx source
// for any of these outside `//` line comments and `/* */` block comments
// (comments are developer-facing, not shown to a user, so they're exempt
// -- this file's own header is fine, and so is this codebase's own
// pervasive use of "--" as a comment-prose connective). Not a perfect
// parser (a `//` or `/*` inside a real string literal would throw it
// off), but this codebase doesn't do that, and "good enough to catch the
// real cases" beats a full TS parser dependency for a solo-dev project.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync('git ls-files "*.ts" "*.tsx"', { cwd: process.cwd() })
  .toString()
  .split("\n")
  .filter(Boolean)
  // Test files are developer/CI-facing (it()/describe() names, fixtures),
  // never rendered to a real user -- out of scope for this check. Same
  // reasoning for scripts/** (2026-09-08): these are one-off CLI tools an
  // engineer runs from a terminal (migrations, backfills, audits) -- their
  // console.log/error output is developer-facing, never part of the
  // shipped web/desktop app a user or an inspector of the live product
  // could see, and "--execute"/"--offset-hours"-style CLI flags in their
  // own --help text would otherwise trip this check for no reason.
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .filter((f) => !f.startsWith("scripts/"));

// "--" not immediately followed by a letter/digit -- excludes CSS custom
// property syntax (`var(--text-3)`, `["--brand-primary"]`), which is
// always "--" fused directly to an identifier with nothing between, and
// appears constantly in this codebase's own inline styling. The prose
// idiom this check exists to catch is always "word -- word" (or "word
// --" at a clause end) -- a real space, quote, or line end right after
// the dashes, never a letter continuing an identifier.
const DASH = /[—–]|--(?![a-zA-Z0-9])/;
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
  console.error("Em-dash/en-dash/\"--\" found in user-facing code (replace with '-', ':', ',', or restructure the sentence):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("No em-dash/en-dash/\"--\" found in user-facing code.");
