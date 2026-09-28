import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { publishAccountUpdated } from "@/lib/account-events";
import { previewGroupLeverage } from "@/lib/group-leverage-apply";

// Phase 2 batch 8 (issues 128 / 184, owner decisions): "Apply to existing accounts" -- copy the group's leverage down
// to the accounts already in it, explicitly (a group edit never does it by itself). Same permission as a direct
// leverage edit (BROKER_ADMIN or ACCOUNT_FINANCE).
//   GET  -> the preview: every account whose leverage differs, with its margin level now and after the change.
//   POST {expectedLeverage, includeBelowStopOut?} -> applies. expectedLeverage must equal the group's leverage now (the
//        preview the admin confirmed); accounts the change would put under stop-out are left out unless
//        includeBelowStopOut is true. One LEVERAGE_CHANGE audit row per account plus one GROUP_LEVERAGE_APPLIED summary,
//        in one transaction; each account is written only if its leverage is still the one previewed.
async function gate() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "ACCOUNT_FINANCE")) return null;
  return session!;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await gate();
  if (!session) return NextResponse.json({ error: "forbidden: applying leverage to accounts requires BROKER_ADMIN or ACCOUNT_FINANCE" }, { status: 403 });
  const { id } = await params;
  const preview = await previewGroupLeverage(session.brokerId!, id);
  if (!preview) return NextResponse.json({ error: "group not found" }, { status: 404 });
  return NextResponse.json(preview);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await gate();
  if (!session) return NextResponse.json({ error: "forbidden: applying leverage to accounts requires BROKER_ADMIN or ACCOUNT_FINANCE" }, { status: 403 });
  const brokerId = session.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const expected = typeof body?.expectedLeverage === "number" ? body.expectedLeverage : Number(body?.expectedLeverage);
  const includeBelowStopOut = body?.includeBelowStopOut === true;

  const preview = await previewGroupLeverage(brokerId, id);
  if (!preview) return NextResponse.json({ error: "group not found" }, { status: 404 });
  if (!Number.isFinite(expected) || expected !== preview.groupLeverage) {
    return NextResponse.json({ error: `the group's leverage is now 1:${preview.groupLeverage}; review the preview again`, groupLeverage: preview.groupLeverage }, { status: 409 });
  }

  const toApply = preview.rows.filter((r) => includeBelowStopOut || !r.belowStopOut);
  const skippedBelowStopOut = preview.rows.filter((r) => !includeBelowStopOut && r.belowStopOut).map((r) => r.accountNumber);

  const { applied, changedMeanwhile } = await prisma.$transaction(async (tx) => {
    const applied: typeof toApply = [];
    const changedMeanwhile: string[] = [];
    for (const r of toApply) {
      // only if still the previewed leverage: a concurrent edit of this one account wins and is reported
      const res = await tx.account.updateMany({ where: { id: r.accountId, brokerId, groupId: id, leverage: r.leverage }, data: { leverage: r.newLeverage } });
      if (res.count === 0) { changedMeanwhile.push(r.accountNumber); continue; }
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "LEVERAGE_CHANGE",
          entityType: "Account",
          entityId: r.accountId,
          oldValue: { leverage: r.leverage },
          newValue: { leverage: r.newLeverage, source: "GROUP_APPLY", groupId: id, marginLevelBefore: r.marginLevel, marginLevelAfter: r.marginLevelAfter },
        },
      });
      applied.push(r);
    }
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "GROUP_LEVERAGE_APPLIED",
        entityType: "Group",
        entityId: id,
        newValue: {
          leverage: preview.groupLeverage,
          applied: applied.map((r) => r.accountNumber),
          skippedBelowStopOut,
          changedMeanwhile,
          includedBelowStopOut: includeBelowStopOut ? preview.rows.filter((r) => r.belowStopOut).map((r) => r.accountNumber) : [],
        },
      },
    });
    return { applied, changedMeanwhile };
  });

  // the traders' terminals re-read their terms (leverage) at once; bounded per publish, after the commit
  await Promise.all(applied.map((r) => publishAccountUpdated(brokerId, r.accountId, "account")));

  return NextResponse.json({
    groupLeverage: preview.groupLeverage,
    applied: applied.map((r) => r.accountNumber),
    skippedBelowStopOut,
    changedMeanwhile,
  });
}
