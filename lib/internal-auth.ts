import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer <secret>` against the expected secret, in constant time (both sides hashed first, so
 *  neither the value nor its length leaks through timing). An unset or empty expected secret never matches. */
export function bearerMatches(authorization: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (provided == null) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
