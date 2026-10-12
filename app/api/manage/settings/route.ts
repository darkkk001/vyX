import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { LEVERAGE_RULE, parseLeverage } from "@/lib/leverage";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseNewSettings } from "@/lib/broker-settings";
import { checkAllowlistSave, clientIpFromHeaders } from "@/lib/ip-allowlist";

async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// BROKER_ADMIN only, same carve-out as Risk/Emergency. Editing branding/
// tier/status stays Super Admin's job -- this route only covers
// defaults a broker's own team should control.
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId! } });
  return NextResponse.json({
    name: broker.name,
    subdomain: broker.subdomain,
    customDomain: broker.customDomain,
    tier: broker.tier,
    status: broker.status,
    defaultAccountCurrency: broker.defaultAccountCurrency,
    defaultAccountLeverage: broker.defaultAccountLeverage,
    // owner decision D5: SINGLE = one BROKER_ADMIN completes a withdrawal; DUAL = two different admins
    withdrawalApproval: broker.withdrawalApproval,
    // Phase 2 batch 7 (issue 82): shown read-only in the backoffice's Settings screen; applied on every stop-out close
    negativeBalanceProtection: broker.negativeBalanceProtection,
    // step 3b item 2 (owner 2026-10-07)
    sessionTimeoutMinutes: broker.sessionTimeoutMinutes,
    auditRetentionDays: broker.auditRetentionDays,
    autoApproveWithdrawalMax: broker.autoApproveWithdrawalMax?.toString() ?? null,
    hedgingAllowed: broker.hedgingAllowed,
    // step 3b item 3
    passwordMaxAgeDays: broker.passwordMaxAgeDays,
    staffIpAllowlist: broker.staffIpAllowlist,
  });
}

async function patchHandler(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const data: { defaultAccountCurrency?: string; defaultAccountLeverage?: number; withdrawalApproval?: "SINGLE" | "DUAL"; sessionTimeoutMinutes?: number | null; auditRetentionDays?: number | null; autoApproveWithdrawalMax?: Prisma.Decimal | null; hedgingAllowed?: boolean; passwordMaxAgeDays?: number | null; staffIpAllowlist?: string[] } = {};
  const extra = parseNewSettings(body && typeof body === "object" ? (body as Record<string, unknown>) : null);
  if (!extra.ok) return NextResponse.json({ error: extra.error }, { status: 400 });
  Object.assign(data, extra.data);
  // step 3b item 3: the staff IP allowlist. The list must contain the address it is saved from, so an admin can never lock themselves out.
  if (body && typeof body === "object" && "staffIpAllowlist" in body) {
    const chk = checkAllowlistSave((body as Record<string, unknown>).staffIpAllowlist, clientIpFromHeaders(request.headers));
    if (!chk.ok) return NextResponse.json({ error: chk.error, ...(chk.code ? { code: chk.code } : {}) }, { status: 400 });
    data.staffIpAllowlist = chk.entries;
  }

  if (typeof body?.defaultAccountCurrency === "string" && body.defaultAccountCurrency.trim()) {
    const defaultAccountCurrency = body.defaultAccountCurrency.trim().toUpperCase();
    // 2026-09-06 interim guard (Section B audit finding #2) -- same "no
    // cross-currency conversion exists yet" reasoning as the per-account
    // guard in app/api/manage/accounts/route.ts, applied here too since
    // this default is what a new account silently inherits when no
    // explicit currency is given at creation.
    if (defaultAccountCurrency !== "USD") {
      return NextResponse.json(
        {
          error:
            "Only USD is supported as the default account currency right now. No cross-currency P/L/margin conversion exists yet. Contact engineering once currency conversion ships.",
        },
        { status: 400 }
      );
    }
    data.defaultAccountCurrency = defaultAccountCurrency;
  }
  if (body?.defaultAccountLeverage != null) {
    const n = parseLeverage(body.defaultAccountLeverage);
    if (n == null) {
      return NextResponse.json({ error: `defaultAccountLeverage must be ${LEVERAGE_RULE}` }, { status: 400 });
    }
    data.defaultAccountLeverage = n;
  }

  if (body?.withdrawalApproval !== undefined) {
    if (body.withdrawalApproval !== "SINGLE" && body.withdrawalApproval !== "DUAL") {
      return NextResponse.json({ error: "withdrawalApproval must be SINGLE or DUAL" }, { status: 400 });
    }
    data.withdrawalApproval = body.withdrawalApproval;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  // audited (audit 2026-09-24: broker-settings saves wrote no AuditLog row); old and new value of every field sent
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true, defaultAccountLeverage: true, withdrawalApproval: true, sessionTimeoutMinutes: true, auditRetentionDays: true, autoApproveWithdrawalMax: true, hedgingAllowed: true, passwordMaxAgeDays: true, staffIpAllowlist: true } });
    const after = await tx.broker.update({ where: { id: brokerId }, data });
    const keys = Object.keys(data) as (keyof typeof data)[];
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "BROKER_SETTINGS_UPDATED",
        entityType: "Broker",
        entityId: brokerId,
        oldValue: Object.fromEntries(keys.map((k) => [k, before[k]])),
        newValue: Object.fromEntries(keys.map((k) => [k, after[k]])),
      },
    });
    return after;
  });
  return NextResponse.json({
    defaultAccountCurrency: updated.defaultAccountCurrency,
    defaultAccountLeverage: updated.defaultAccountLeverage,
    withdrawalApproval: updated.withdrawalApproval,
    sessionTimeoutMinutes: updated.sessionTimeoutMinutes,
    auditRetentionDays: updated.auditRetentionDays,
    autoApproveWithdrawalMax: updated.autoApproveWithdrawalMax?.toString() ?? null,
    hedgingAllowed: updated.hedgingAllowed,
    passwordMaxAgeDays: updated.passwordMaxAgeDays,
    staffIpAllowlist: updated.staffIpAllowlist,
  });
}

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const PATCH = withConfigEvent("settings", patchHandler);
