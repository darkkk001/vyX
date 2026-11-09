import { Prisma } from "@prisma/client";

// The broker's own hedge (coverage) money is not client money (2026-11-06 investigation, owner 2026-11-09: build every
// queued item). The dashboard, Book P/L, the hedge book and risk exposure already left it out; the deposits figures and
// the reports counted it. One definition, the dashboard's (app/api/manage/dashboard/route.ts clientAccountSql): not the
// broker's coverage account, and not in a COVERAGE-category group.

/** Prisma `Account` filter: not the broker's hedge account, not in a COVERAGE group. Spread it into an `account: {...}` where. */
export function notCoverageAccount(coverageAccountId: string | null | undefined): Prisma.AccountWhereInput {
  return {
    ...(coverageAccountId ? { id: { not: coverageAccountId } } : {}),
    group: { category: { not: "COVERAGE" } },
  };
}

/** The same rule as SQL over an `"Account"` alias (default `a`). */
export function notCoverageSql(coverageAccountId: string | null | undefined, alias = "a"): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/"/g, "")}"`);
  return Prisma.sql`(${coverageAccountId ?? null}::text IS NULL OR ${a}.id <> ${coverageAccountId ?? null})
    AND NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = ${a}."groupId" AND g.category = 'COVERAGE')`;
}
