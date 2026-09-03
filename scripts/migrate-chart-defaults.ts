// One-time backfill for the showSessionHighLow (PDH/PDL) default flip
// (true -> false, lib/chart-settings.ts's own DEFAULT_CHART_SETTINGS
// comment). ChartSettingsDialog.tsx always PUTs the FULL settings object,
// so any account that has EVER saved any chart setting already has
// `showSessionHighLow: true` baked into its stored Account.chartSettings
// blob explicitly -- the default flip alone only reaches an account that
// has never saved a chart setting at all (mergeChartSettings' spread
// covers that case correctly with no DB write needed). This script
// reaches everyone else.
//
// Only flips the ONE key, via jsonb_set -- every other field in each
// account's blob (candle colors, sounds, theme, ...) is left exactly as
// that account saved it. Rows where chartSettings is NULL, or already
// has showSessionHighLow: false, are skipped (nothing to change).
//
// There's no way to tell "explicitly re-enabled after this migration
// already flipped it" apart from "never touched, still has the old
// baked-in true" from the stored JSON alone -- both look identical. This
// is accepted here: nobody could have taken an action that reads as
// "deliberately re-enabling" a toggle that has always, up to this point,
// been on by default -- there's no real "explicitly chose true" case
// this migration could be wrongly overwriting.
//
// Run:  npx tsx scripts/migrate-chart-defaults.ts [--execute]
// Default is a dry run.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

async function main() {
  const affected = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Account"
    WHERE "chartSettings" IS NOT NULL
      AND ("chartSettings"->>'showSessionHighLow') = 'true'
  `;

  console.log(`Accounts with showSessionHighLow: true saved explicitly: ${affected.length}`);
  if (affected.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  if (!EXECUTE) {
    console.log("\nDry run -- nothing written. Re-run with --execute to apply.");
    return;
  }

  const result = await prisma.$executeRaw`
    UPDATE "Account"
    SET "chartSettings" = jsonb_set("chartSettings"::jsonb, '{showSessionHighLow}', 'false'::jsonb)
    WHERE "chartSettings" IS NOT NULL
      AND ("chartSettings"->>'showSessionHighLow') = 'true'
  `;
  console.log(`Updated ${result} account(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
