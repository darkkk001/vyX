#!/usr/bin/env bash
# Vercel Ignored Build Step (vercel.json ignoreCommand). Exit 0 = SKIP the build, exit 1 = build.
# Previews: always skipped (only main deploys). Production (owner 2026-10-26): skipped when everything changed since the
# last deployed commit lies outside the web app -- docs, deploy scripts, tools, the engine, the EA, the VPS services, the
# old Tauri shells, report SQL, Markdown. Feed files under public/ are NOT excluded: their index files are still served
# by the web. A redeploy of the same commit (an env var change, a rollback rebuild) always builds. Anything uncertain
# (no previous deploy, the previous commit not in the shallow clone, a git error) builds.
if [ "$VERCEL_ENV" != "production" ]; then exit 0; fi
BASE="${VERCEL_GIT_PREVIOUS_SHA:-}"
HEAD_SHA="${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse HEAD)}"
if [ -n "$BASE" ] && [ "$BASE" = "$HEAD_SHA" ]; then echo "vercel-ignore: redeploy of ${BASE:0:7}, building"; exit 1; fi
if [ -n "$BASE" ] && ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=50 origin "$BASE" 2>/dev/null || true
fi
if [ -z "$BASE" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then echo "vercel-ignore: no usable previous commit, building"; exit 1; fi
git diff --quiet "$BASE" "$HEAD_SHA" -- . \
  ':(exclude)docs' ':(exclude)deploy' ':(exclude)tools' ':(exclude)engine' ':(exclude)mt5-ea' ':(exclude)services' \
  ':(exclude)desktop-tauri' ':(exclude)manager-tauri' ':(exclude)admin-tauri' ':(exclude)scripts/report' ':(exclude)*.md'
rc=$?
if [ $rc -eq 0 ]; then echo "vercel-ignore: only non-web paths changed since ${BASE:0:7}, skipping"; exit 0; fi
echo "vercel-ignore: web paths changed since ${BASE:0:7} (or git said $rc), building"; exit 1
