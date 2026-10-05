// Test-only: makes lib/prisma's shared client one that counts every SQL statement it sends. Import this BEFORE anything
// that imports "@/lib/prisma" (lib/prisma.ts reuses globalThis.prisma when it is set), and read/reset `statements.n`
// around the code being measured. Uses whatever DATABASE_URL the file's setup chose (vitest.setup.isolated-db.ts).
import { PrismaClient } from "@prisma/client";

export const statements = { n: 0 };

const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
client.$on("query", () => {
  statements.n++;
});
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;
