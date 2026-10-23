// The Node-runtime half of instrumentation.ts (Next.js startup hook). Kept in its own module and imported only behind
// `process.env.NEXT_RUNTIME === "nodejs"` (the pattern Next eliminates from the Edge bundle): everything here may use
// Node built-ins (lib/client-builds imports "crypto"), which the Edge compile cannot resolve.
export async function registerNode() {
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
