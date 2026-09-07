import "server-only";
import { getRedis } from "@/lib/redis";

// A Live account is created at LiveAccountRequest approval time (an
// admin's action, not the client's own request/response cycle -- see
// LiveAccountRequest's own schema comment), so there's no HTTP response
// back to the client to hand the freshly-generated plaintext password to
// the way a self-service Demo creation can. The password is never stored
// anywhere in plaintext (same rule as every other generated credential in
// this app), so it has to be stashed somewhere for the client's own next
// portal visit to pick up once -- same "single-use, Redis-backed,
// GETDEL-consumed" shape as lib/sso.ts's own handoff tokens, just a much
// longer TTL since a client might not check back for a day or two, unlike
// an SSO redirect that completes within seconds.
const REVEAL_TTL_SECONDS = 60 * 60 * 48; // 48h

function revealKey(clientId: string) {
  return `live_account_credentials:${clientId}`;
}

export type RevealedAccountCredentials = {
  accountNumber: string;
  password: string;
};

export async function stashRevealedCredentials(clientId: string, credentials: RevealedAccountCredentials): Promise<void> {
  await getRedis().set(revealKey(clientId), JSON.stringify(credentials), "EX", REVEAL_TTL_SECONDS);
}

// Atomic read-then-delete -- the portal shows these exactly once, same
// reasoning as every other single-use credential in this app.
export async function consumeRevealedCredentials(clientId: string): Promise<RevealedAccountCredentials | null> {
  const raw = await getRedis().getdel(revealKey(clientId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RevealedAccountCredentials;
  } catch {
    return null;
  }
}
