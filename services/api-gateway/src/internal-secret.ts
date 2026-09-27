// The internal service secret, checked the same way everywhere in the gateway (event relay, stats, the internal
// WebSocket). Secret rotation (2026-09-28): while INTERNAL_SERVICE_SECRET_PREVIOUS is set, the previous value is
// accepted too, so the web, the engine and Caddy can switch one at a time without a refused call; unset it (and
// restart) once every caller has switched. An empty expected value never matches.
export function internalSecretOk(provided: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = Array.isArray(provided) ? provided[0] : provided;
  if (!p) return false;
  const current = env.INTERNAL_SERVICE_SECRET ?? "";
  const previous = env.INTERNAL_SERVICE_SECRET_PREVIOUS ?? "";
  return (current !== "" && p === current) || (previous !== "" && p === previous);
}

export function rotationInProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.INTERNAL_SERVICE_SECRET_PREVIOUS ?? "") !== "";
}
