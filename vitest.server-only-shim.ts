// Vitest runs lib/*.ts directly under plain Node, not Next.js's webpack
// build -- "server-only" throws unconditionally outside that build (see
// node_modules/server-only/index.js), so vitest.config.mts aliases every
// import of it to this no-op instead.
export {};
