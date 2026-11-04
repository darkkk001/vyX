import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { applyImport, planImport, publicRows } from "@/lib/symbol-import";

// POST /api/manage/symbols/import[?dryRun=1]   body: CSV text with the export header (see lib/symbol-import.ts)
// -> { rows: [{ line, symbol, action: "create" | "update" | "skip", ok, errors: string[] }] }
// dryRun=1 validates every row and writes NOTHING. Without it, only the rows that were ok are applied (one audit row
// each); a row that fails to write is reported with ok false and the others still apply. A failed row's action is "skip".
async function handle(request: NextRequest, dryRun: boolean) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const text = await request.text().catch(() => "");
  const plan = await planImport(session!, text);
  if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: 400 });
  if (!dryRun) await applyImport(session!, plan.rows);
  return NextResponse.json({ rows: publicRows(plan.rows) });
}

// a dry run changes nothing, so it must not announce a config change: only the applying call is wrapped
const apply = withConfigEvent("symbols", (request: NextRequest) => handle(request, false));
export async function POST(request: NextRequest) {
  const dry = new URL(request.url).searchParams.get("dryRun");
  if (dry === "1" || dry === "true") return handle(request, true);
  return apply(request);
}
