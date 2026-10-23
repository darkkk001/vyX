// Next.js startup hook: runs once per server instance. Node runtime only (the Edge runtime has no Prisma); skipped
// during `next build`. The schema guard (lib/schema-guard.ts, off with VYX_SCHEMA_GUARD=off) and the build-registry
// restore (lib/client-builds.ts) live in instrumentation-node.ts, imported ONLY behind this exact NEXT_RUNTIME check so
// the Edge bundle never compiles their Node built-ins (2026-10-23: an early `return` did not, and the build failed).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
