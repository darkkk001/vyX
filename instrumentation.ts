// Next.js startup hook: runs once per server instance. Node runtime only (the Edge runtime has no Prisma); skipped
// during `next build` and when VYX_SCHEMA_GUARD=off. See lib/schema-guard.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // the native build registry: rebuild a Redis that lost it from Postgres (lib/client-builds.ts). Never blocks startup.
  try {
    const { restoreClientBuildRegistry } = await import("@/lib/client-builds");
    await restoreClientBuildRegistry();
  } catch (err) {
    console.error("[client-builds] registry restore at startup failed", err);
  }
  if (process.env.VYX_SCHEMA_GUARD === "off") return;
  const { runSchemaCheck } = await import("@/lib/schema-guard");
  await runSchemaCheck();
}
