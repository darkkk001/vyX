// Next.js startup hook: runs once per server instance. Node runtime only (the Edge runtime has no Prisma); skipped
// during `next build` and when VYX_SCHEMA_GUARD=off. See lib/schema-guard.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.VYX_SCHEMA_GUARD === "off") return;
  const { runSchemaCheck } = await import("@/lib/schema-guard");
  await runSchemaCheck();
}
