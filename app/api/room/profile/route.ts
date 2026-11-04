import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { listClientSessions } from "@/lib/client-auth";
import { identityLocked, dateOnly, type KycState } from "@/lib/client-profile";

// Trader's Room Profile & security: personal information (identity fields lock with KYC), document states, 2FA state
// and the client's live sessions.
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const c = await prisma.client.findUnique({
    where: { id: session.clientId },
    select: {
      fullName: true, email: true, phone: true, country: true, dateOfBirth: true, clientNumber: true, createdAt: true, twoFactorEnabled: true,
      kycRecord: { select: { status: true, documentFrontUrl: true, addressProofUrl: true, reviewedAt: true, rejectionReason: true, updatedAt: true } },
    },
  });
  if (!c) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });
  const kyc = c.kycRecord;
  const docState = (present: boolean) => (!kyc || !present ? "Not uploaded" : kyc.status === "APPROVED" ? "Approved" : kyc.status === "REJECTED" ? "Rejected" : "Pending");
  const sessions = await listClientSessions(session.clientId, session.sessionId);
  return NextResponse.json({
    personal: {
      fullName: c.fullName,
      email: c.email,
      phone: maskPhone(c.phone),
      country: c.country,
      dateOfBirth: dateOnly(c.dateOfBirth),
      clientId: `C-${c.clientNumber}`,
      registeredAt: c.createdAt.toISOString(),
      locked: identityLocked((kyc?.status ?? null) as KycState),
    },
    documents: [
      { name: "Identity document", state: docState(Boolean(kyc?.documentFrontUrl)), at: kyc?.reviewedAt?.toISOString() ?? null },
      { name: "Proof of address", state: docState(Boolean(kyc?.addressProofUrl)), at: kyc?.reviewedAt?.toISOString() ?? null },
    ],
    rejectionReason: kyc?.status === "REJECTED" ? kyc.rejectionReason ?? null : null,
    twoFactorEnabled: c.twoFactorEnabled,
    sessions: sessions.map((s) => ({ id: s.sessionId, device: deviceOf(s.userAgent), ip: s.ip, at: s.createdAt || null, current: s.current })),
  });
}

function maskPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/\s+/g, "");
  if (d.length < 7) return p;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ····${d.slice(-3)}`;
}

/** "Windows · Chrome", "iPhone · Safari": a short device line from the user agent, never the raw string. */
function deviceOf(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const app = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${app}`;
}
