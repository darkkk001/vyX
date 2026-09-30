import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";
import { randomUUID } from "node:crypto";

// web4: one private database per test FILE (see vitest.global.isolated-db.ts for why). Runs before the file imports
// anything, so lib/prisma's client is created against the file's own copy. No-op when the global setup did not
// prepare a template (non-local DATABASE_URL, or VYX_TEST_SHARED_DB=1).
const ctx = inject("vyxTestDb");
if (ctx) {
  const name = `${ctx.prefix}_f${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const admin = new PrismaClient({ datasourceUrl: ctx.adminUrl });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${ctx.template}" STRATEGY FILE_COPY`);
      lastError = null;
      break;
    } catch (e) {
      lastError = e; // "source database is being accessed by other users": another file is cloning right now
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
    }
  }
  await admin.$disconnect();
  if (lastError) throw lastError;
  const u = new URL(ctx.baseUrl);
  u.pathname = `/${name}`;
  process.env.DATABASE_URL = u.toString();
  process.env.DIRECT_URL = u.toString();
}
