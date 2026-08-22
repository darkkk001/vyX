import "server-only";
import crypto from "node:crypto";

// Used when staff resets someone else's password (a dealer resetting a
// trader's, Super Admin resetting a broker staff member's) instead of
// letting them type a new one -- the account/admin is meant to change it
// on next login anyway, so a strong, random value beats guessing a
// temporary one that's easy to remember (and therefore easy to guess).
// Shown to the resetter exactly once, same "shown once" convention as
// account creation's own generated-password display.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // no 0/O/1/l/I
export function generateTemporaryPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
