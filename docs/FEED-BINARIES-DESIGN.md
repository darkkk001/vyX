# Native update feeds out of git (design, 2026-10-23)

Status: owner go 2026-10-24 for steps 1-5, in order. Step 2 done 2026-10-24: all 327 live binaries (7.35 GB) in bucket
`vyx-feeds`, byte-checked over S3 (327/327 = git, 315 also = releases.win.json; the 12 others are Setup/portable).
Step 1 done 2026-10-26: `feeds.vyxtrader.com` is the bucket's R2 custom domain; the public byte check passed
327/327 (served by Cloudflare from R2, no listing: the root and unknown keys answer 404). Steps 3-5 after Sunday's web deploy and QoreTrader terminal 1.0.95, cutover and
gateway sessions told first, the redirect proven on an installed QoreTrader backoffice before any other domain.
Futurix feeds stay held until the owner's test.

## Today

The Windows terminal and backoffice update feeds (Velopack packages, `releases.win.json`, `RELEASES`, `assets.win.json`,
`Setup-*.exe`, portable zip) live in this repo under `public/` and ship with every web deploy:

| feed | files | size | full packages |
|---|---|---|---|
| `native-terminal-updates/futurixglobal` | 115 | 2.2 GB | 65 |
| `native-backoffice-updates/futurixglobal` | 163 | 3.2 GB | 88 |
| `native-terminal-updates/qoretrader` | 29 | 0.7 GB | 21 |
| `native-backoffice-updates/qoretrader` | 29 | 0.8 GB | 21 |

About 6.9 GB in the working tree; `.git` is 12 GB (4.4 GB packed); 136 commits touched the feeds. Each publish is a
`publish-*.ps1 -FeedRoot C:\vyx\web\public\...` copy, then a web commit and a push. Costs:
- every clone, worktree and checkout carries gigabytes;
- every web deploy uploads them, and a feed publish is a full web deploy;
- the disk-full and slow-checkout incidents on this machine.

## Constraints (must not break)

1. **Installed apps cannot change their feed URL.** `ClientIdentity.FeedRoot` = `https://www.vyxtrader.com/native-` is
   compiled in, and brand.json's `updateUrl` (e.g. `https://www.vyxtrader.com/native-terminal-updates/futurixglobal/`) is
   pinned by hash. Every installed terminal and backoffice must keep updating from exactly those URLs.
2. **The download page and `/download/[kind]`** read `<origin>/native-<app>-updates/<slug>/releases.win.json` and redirect to
   `Setup-<Brand>.exe` (`lib/download-feed.ts`). Both must keep working.
3. **Feed release rule:** Futurix's feed goes live only after the owner's test (merge into live); other brands publish
   with the pack. Publishing must stay one deliberate step per brand.
4. **Integrity:** Velopack checks each package's SHA256 from `releases.win.json`. The kill switch is the build registry,
   not the feed, so it is unaffected.

## Design

**Storage: Cloudflare R2**, one bucket `vyx-feeds`, objects at the same relative paths:
`native-terminal-updates/futurixglobal/FuturixTraderNative-1.0.71-full.nupkg`, and so on. R2 charges nothing for egress;
update downloads are the whole traffic. Vercel Blob is the alternative (same Vercel account, no new vendor) but bills
egress. Pricing should be re-checked at go time.

**Public read through a custom domain:** `feeds.vyxtrader.com`, bound to the bucket in Cloudflare (public, read-only,
no listing).

**Same URLs for installed apps:** a redirect in `next.config` (or middleware), for the binary files only:

```
/native-:app(terminal|backoffice)-updates/:slug/:file(.*\.(nupkg|exe|zip))
  -> 302 https://feeds.vyxtrader.com/native-:app-updates/:slug/:file
```

The small index files (`releases.win.json`, `RELEASES`, `assets.win.json`) stay in the web repo, a few KB per brand:
- the download page keeps reading them same-origin;
- a publish of a new version is still a web commit that the owner can see and revert;
- the index decides what clients install, so it stays under git review.

Velopack's `SimpleWebSource` downloads with .NET `HttpClient`, which follows an https-to-https 302. **This must be
proven on an installed copy before any feed moves** (step 2 below).

**Publishing:** `publish-terminal.ps1` / `publish-backoffice.ps1` gain `-FeedTarget r2`:
1. Upload the new `.nupkg` / `Setup-*.exe` / zip to R2 first (wrangler or the S3 API; credentials in
   `C:\vyx-secrets`, never in the repo).
2. Check that each uploaded object's SHA256 matches the package's own value.
3. Only then write the index files into `public/native-*/<slug>/` for the usual commit and push.

Packages are never overwritten: version numbers are unique, so a rollback is the old index plus the old objects, which
are still there.

## Migration (one brand at a time, QoreTrader first)

1. Create the R2 bucket and the `feeds.vyxtrader.com` domain. Upload QoreTrader's current binaries and verify every
   SHA256 against its `releases.win.json`.
2. **Proof on an installed copy:** a QoreTrader terminal at version N-1 on the test machine, with the redirect deployed
   for `qoretrader` only. It must update to N through the redirect (delta and full), and the download page's Setup must
   install. Updating is the whole risk, so nothing else moves until this passes.
3. Delete QoreTrader's binaries from `public/` (index files stay); deploy.
4. Futurix the same way, inside an owner-approved window (feed release rule), with one installed Futurix copy updating
   through the redirect before the binaries leave `public/`.
5. The publish scripts default to `-FeedTarget r2`.

**Rollback** at any step: remove the redirect and restore the binaries to `public/` from git (they stay in history until
step 6). The same URLs then serve from Vercel again.

## Cleanup rule (owner 2026-10-24)

Per broker and app, R2 keeps the **newest 5 Full packages**. Also kept: Delta packages newer than the oldest kept Full
(an older delta only upgrades from a version that is no longer offered), and Setup / portable (one name each, replaced
by every publish). `tools/feeds/prune-r2.mjs` applies it:

1. dry run (no flag): prints, per feed, what stays and what goes;
2. `--index`: drops the pruned packages from `releases.win.json` and `RELEASES`, then the usual web commit, push,
   deploy, so no client is ever offered a package that is about to disappear;
3. `--r2`: deletes from R2 only what the **live** index on www no longer lists (re-read per feed right before the
   deletes), so running it before the index deploy deletes nothing.

Runs after each publish once a feed is on R2 (step 5); Futurix only in an owner-approved window. Dry run on
2026-10-24: about 6.3 GB would go across the 4 feeds (Futurix terminal 104 packages, QoreTrader terminal 18, Futurix
backoffice 153, QoreTrader backoffice 20). Nothing is applied before step 5. Deleting from R2 does not touch git
history (step 6).

## Step 6, separate decision: history

Deleting the files from `public/` stops the growth but does not shrink `.git`; the 4.4 GB pack stays. Rewriting history
with `git filter-repo` to drop the old binaries changes every commit hash. That means:
- every clone, worktree, the VPS checkout and every open branch must be re-cloned or rebased;
- Vercel and GitHub keep working, but old commit links break.

This needs its own go and a quiet day. Not part of steps 1-5.

## Cost of doing nothing

The feeds grow by about 50-60 MB per brand per release, per app. With two brands and weekly releases that is roughly
0.5 GB a month in the working tree and in history.
