/**
 * Owner 2026-11-11 (production build audit): client-side failure logs are for development only. In the production build
 * nothing is written to the browser console (anyone can open DevTools); behaviour is unchanged either way.
 */
export function clientError(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") console.error(...args);
}
