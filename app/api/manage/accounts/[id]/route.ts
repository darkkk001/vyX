import { NextRequest, NextResponse } from "next/server";
import { Prisma, RoutingCategory, GroupModeRestriction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LEVERAGE_RULE, parseLeverage } from "@/lib/leverage";
import { publishAccountUpdated } from "@/lib/account-events";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { checkAccountStructure } from "@/lib/account-structure";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { setAccountTradingRights, tradingRightsNotice, pendingCancelReason, type TradingRightsChange } from "@/lib/account-trading-rights";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Handles two independently-permissioned edits on the same Account row:
// - groupId (MANAGER or BROKER_ADMIN) -- risk/ops config, same category
//   the symbols screen already lets MANAGER touch.
// - leverage/status (BROKER_ADMIN by default, delegatable via
//   ACCOUNT_FINANCE -- lib/permissions.ts) -- per AdminRole.MANAGER's own
//   schema comment ("narrower than BROKER_ADMIN... not KYC/finance"),
//   these are finance-adjacent, not dealing-desk config.
// A request can touch either or both fields; each is checked
// independently rather than requiring BROKER_ADMIN for the whole request
// just because one finance field happened to be present.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  // The internal flag is BROKER_ADMIN only, checked before the account lookup (no existence oracle for a MANAGER).
  if (body != null && "isInternal" in body && session.role !== "BROKER_ADMIN") {
    return NextResponse.json({ error: "only a broker admin can change the internal flag", code: "BROKER_ADMIN_ONLY" }, { status: 403 });
  }

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const hasGroupChange = body != null && "groupId" in body;
  // Same permission tier as groupId -- a pricing-tier LABEL (see
  // AccountType's own schema comment), not itself a balance/leverage
  // change, so MANAGER can reassign it same as group.
  const hasAccountTypeChange = body != null && "accountTypeId" in body;
  const hasFinanceChange = body != null && ("leverage" in body || "status" in body || "maxDailyLoss" in body);
  // Owner 2026-10-06 (S1): swap-free is decided by the GROUP only. The account-level override can no longer be set
  // (scripts/clear-account-swapfree-overrides.ts cleared the stored ones), so a body carrying it is refused, not ignored.
  if (body != null && "swapFree" in body) {
    return NextResponse.json({ error: "Swap-free is set on the group, not on the account.", code: "SWAP_FREE_GROUP_ONLY" }, { status: 400 });
  }
  // Owner 2026-10-05: the internal (test / staff) account flag, left out of every broker-wide figure. BROKER_ADMIN only.
  const hasInternalChange = body != null && "isInternal" in body;
  // Per-account trading rights (2026-09-28, owner decision 4): a risk control, BROKER_ADMIN or the Client trading
  // permission, applied at once (no second admin).
  const hasRightsChange = body != null && "tradingRights" in body;

  if (!hasGroupChange && !hasAccountTypeChange && !hasFinanceChange && !hasInternalChange && !hasRightsChange) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  if (hasInternalChange && typeof body.isInternal !== "boolean") {
    return NextResponse.json({ error: "isInternal must be true or false", code: "INVALID_BODY" }, { status: 400 });
  }
  if (hasFinanceChange && session.role !== "BROKER_ADMIN" && !(await hasPermission(session, "ACCOUNT_FINANCE"))) {
    return NextResponse.json(
      { error: "forbidden: leverage/status/maxDailyLoss changes require BROKER_ADMIN or ACCOUNT_FINANCE" },
      { status: 403 }
    );
  }

  let tradingRights: "FULL" | "CLOSE_ONLY" | "READ_ONLY" | undefined;
  if (hasRightsChange) {
    if (session.role !== "BROKER_ADMIN" && !(await hasPermission(session, "CLIENT_TRADING"))) {
      return NextResponse.json({ error: "forbidden: trading rights changes require BROKER_ADMIN or the Client trading permission", permission: "CLIENT_TRADING" }, { status: 403 });
    }
    if (body.tradingRights !== "FULL" && body.tradingRights !== "CLOSE_ONLY" && body.tradingRights !== "READ_ONLY") {
      return NextResponse.json({ error: "tradingRights must be FULL, CLOSE_ONLY or READ_ONLY" }, { status: 400 });
    }
    tradingRights = body.tradingRights;
  }

  // Stage 3b: Account.groupId is NOT NULL, so an account can no longer be
  // returned to the ungrouped state. Reject it explicitly rather than let it
  // surface as a constraint violation.
  if (hasGroupChange && body.groupId == null) {
    return NextResponse.json(
      { error: "an account must belong to a group; pick a different group instead of clearing it", code: "GROUP_REQUIRED" },
      { status: 400 }
    );
  }

  let group: { id: string; leverage: number; category: RoutingCategory; modeRestriction: GroupModeRestriction } | null = null;
  if (hasGroupChange && body.groupId != null) {
    const found = await prisma.group.findUnique({ where: { id: body.groupId } });
    if (!found || found.brokerId !== brokerId) {
      return NextResponse.json({ error: "group not found" }, { status: 404 });
    }
    // Same rule as account creation -- moving an existing client into the
    // reverse-mirror book is the same act as opening them there. The structural
    // check downstream still owns the more specific refusals.
    if (!found.isClientSelectable && found.category !== "COVERAGE") {
      return NextResponse.json(
        { error: "that group is not available for client accounts", code: "GROUP_NOT_CLIENT_SELECTABLE" },
        { status: 400 }
      );
    }
    group = { id: found.id, leverage: found.leverage, category: found.category, modeRestriction: found.modeRestriction };
  }

  let accountTypeId: string | null = null;
  if (hasAccountTypeChange && body.accountTypeId != null) {
    const found = await prisma.accountType.findUnique({ where: { id: body.accountTypeId } });
    // Deliberately NOT checking `enabled` here -- an existing account can
    // stay on (or be moved back to) a disabled type; `enabled` only gates
    // the Add-account picker and new assignments from a broker actively
    // choosing among CURRENT options, not this "put it back the way it
    // was" case. Same "old references still resolve" rule as
    // AccountType.enabled's own schema comment.
    if (!found || found.brokerId !== brokerId) {
      return NextResponse.json({ error: "account type not found" }, { status: 404 });
    }
    accountTypeId = found.id;
  }

  // A group change has to hold against the account's MODE, which this
  // request cannot change. Mass-assignment is covered by the same check --
  // a body naming the broker's COVERAGE group is refused here, not merely
  // hidden in the UI. The account TYPE needs no check: it is the
  // client-facing spread tier and carries no routing.
  if (hasGroupChange && group) {
    const violation = checkAccountStructure({ accountMode: account.accountMode, group });
    if (violation) {
      return NextResponse.json({ error: violation.message, code: violation.code }, { status: 400 });
    }
  }

  let leverage: number | undefined;
  if (hasFinanceChange && "leverage" in body) {
    leverage = parseLeverage(body.leverage) ?? undefined;
    if (leverage == null) {
      return NextResponse.json({ error: `leverage must be ${LEVERAGE_RULE}` }, { status: 400 });
    }
  }

  let status: "ACTIVE" | "SUSPENDED" | "CLOSED" | undefined;
  if (hasFinanceChange && "status" in body) {
    if (body.status !== "ACTIVE" && body.status !== "SUSPENDED" && body.status !== "CLOSED") {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    status = body.status;
  }

  let maxDailyLoss: Prisma.Decimal | null | undefined;
  if (hasFinanceChange && "maxDailyLoss" in body) {
    if (body.maxDailyLoss === null || body.maxDailyLoss === "") {
      maxDailyLoss = null;
    } else {
      try {
        maxDailyLoss = new Prisma.Decimal(String(body.maxDailyLoss));
      } catch {
        return NextResponse.json({ error: "invalid maxDailyLoss" }, { status: 400 });
      }
      if (maxDailyLoss.lte(0)) {
        return NextResponse.json({ error: "maxDailyLoss must be positive when set" }, { status: 400 });
      }
    }
  }

  // Audit 2026-09-24 (money): a group change copies the group's leverage onto the account, so when that CHANGES the
  // account's leverage it needs the same permission as a direct leverage edit (BROKER_ADMIN or ACCOUNT_FINANCE). A
  // group change that keeps the leverage stays open to any MANAGER.
  if (hasGroupChange && group && group.leverage !== account.leverage && !hasFinanceChange && session.role !== "BROKER_ADMIN" && !(await hasPermission(session, "ACCOUNT_FINANCE"))) {
    return NextResponse.json(
      {
        error: `forbidden: this group change would move leverage 1:${account.leverage} -> 1:${group.leverage}, which requires BROKER_ADMIN or ACCOUNT_FINANCE`,
        code: "GROUP_CHANGE_CHANGES_LEVERAGE",
      },
      { status: 403 }
    );
  }

  let rightsChange: TradingRightsChange | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const data: {
      groupId?: string;
      accountTypeId?: string | null;
      leverage?: number;
      status?: typeof status;
      maxDailyLoss?: Prisma.Decimal | null;
      isInternal?: boolean;
    } = {};
    const auditEntries: { action: string; oldValue: Prisma.InputJsonValue; newValue: Prisma.InputJsonValue }[] = [];

    if (hasGroupChange) {
      data.groupId = group!.id;
      // Assigning a group copies its leverage onto the account once, at
      // assignment time -- see Group's own schema comment. Unassigning
      // (groupId: null) doesn't reset leverage; there's nothing to reset
      // it to.
      if (group) {
        data.leverage = group.leverage;
      }
      auditEntries.push({
        action: "ACCOUNT_GROUP_CHANGED",
        oldValue: { groupId: account.groupId },
        newValue: { groupId: group?.id ?? null, appliedLeverage: group?.leverage ?? null },
      });
    }

    if (hasAccountTypeChange) {
      data.accountTypeId = accountTypeId;
      auditEntries.push({
        action: "ACCOUNT_TYPE_CHANGED",
        oldValue: { accountTypeId: account.accountTypeId },
        newValue: { accountTypeId },
      });
    }

    if (leverage !== undefined) {
      data.leverage = leverage; // an explicit leverage edit always wins over a group's copied-down value
      auditEntries.push({
        action: "LEVERAGE_CHANGE",
        oldValue: { leverage: account.leverage },
        newValue: { leverage },
      });
    }
    if (status !== undefined) {
      data.status = status;
      auditEntries.push({
        action: "ACCOUNT_STATUS_CHANGED",
        oldValue: { status: account.status },
        newValue: { status },
      });
    }
    if (maxDailyLoss !== undefined) {
      data.maxDailyLoss = maxDailyLoss;
      auditEntries.push({
        action: "ACCOUNT_MAX_DAILY_LOSS_CHANGED",
        oldValue: { maxDailyLoss: account.maxDailyLoss?.toString() ?? null },
        newValue: { maxDailyLoss: maxDailyLoss?.toString() ?? null },
      });
    }
    if (hasInternalChange && body.isInternal !== account.isInternal) {
      data.isInternal = body.isInternal;
      auditEntries.push({
        action: "ACCOUNT_INTERNAL_FLAG_CHANGED",
        oldValue: { isInternal: account.isInternal },
        newValue: { isInternal: body.isInternal },
      });
    }

    const result = await tx.account.update({ where: { id }, data });
    // trading rights: its own locked change + audit; dropping below FULL cancels the pending orders at once (owner
    // decision 2026-09-28), each audited with the reason the trader sees
    if (tradingRights !== undefined) {
      rightsChange = await setAccountTradingRights(tx, { brokerId, accountId: id, to: tradingRights, adminId: session.adminId, note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : undefined });
    }

    for (const entry of auditEntries) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: entry.action,
          entityType: "Account",
          entityId: id,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
        },
      });
    }

    return tradingRights !== undefined ? tx.account.findUniqueOrThrow({ where: { id } }) : result;
  });

  // Suspension hole (2026-09-28): a suspended / closed account's open sessions end at once (the order routes also
  // refuse it now), so a client signed in before the change cannot keep trading
  if (status !== undefined && status !== "ACTIVE" && account.status === "ACTIVE") {
    await revokeAllAccountSessions(id).catch((err) => console.error("[accounts] session revoke after suspend failed", err));
  }
  const change = rightsChange as TradingRightsChange | null;
  if (change?.changed) {
    const reason = pendingCancelReason(change.to);
    for (const orderId of change.cancelledOrderIds) {
      await publishTradingEvent("OrderCancelled", { order_id: orderId, account_id: id, broker_id: brokerId, reason }).catch(() => {});
    }
    await createNotification(prisma, {
      brokerId,
      accountId: id,
      type: "TRADING_RIGHTS_CHANGED",
      title: tradingRightsNotice(change),
      body: tradingRightsNotice(change),
      entityType: "Account",
      entityId: id,
    }).catch((err) => console.error("[accounts] trading rights notification failed", err));
  }

  // after commit: an open terminal / WebTrader picks up the new leverage / status / group / type at once
  await publishAccountUpdated(brokerId, id, "account");

  return NextResponse.json({
    id: updated.id,
    leverage: updated.leverage,
    status: updated.status,
    groupId: updated.groupId,
    accountTypeId: updated.accountTypeId,
    maxDailyLoss: updated.maxDailyLoss?.toString() ?? null,
    swapFree: updated.swapFree,
    isInternal: updated.isInternal,
    tradingRights: updated.tradingRights,
    cancelledPendingOrders: change?.cancelledOrderIds.length ?? 0,
  });
}
