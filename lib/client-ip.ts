// Shared by the demo guest limit and the login / sign-up per-IP limits (infra audit 2026-10-28).
/**
 * The visitor's address for per-IP rate limits. Vercel's edge sets x-real-ip (the header @vercel/functions ipAddress()
 * reads) and x-vercel-forwarded-for from the connecting peer and overwrites any value the client sent, so they cannot be
 * spoofed on Vercel. x-forwarded-for is NOT used: its first hop is whatever the client put there anywhere that is not behind
 * such a proxy. No trusted header = "unknown", one shared bucket (it fails safe). IPv6 counts per /64 so rotating the host
 * part of one prefix buys nothing.
 */
export function clientIpOf(h: { get(name: string): string | null }): string {
  const raw = (h.get("x-real-ip") ?? h.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  if (!raw) return "unknown";
  if (raw.includes(":")) {
    const groups = raw.toLowerCase().split("::")[0].split(":").filter((g) => g !== "");
    return `v6:${groups.slice(0, 4).join(":")}`;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : "unknown";
}
