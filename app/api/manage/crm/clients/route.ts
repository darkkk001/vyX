import { NextRequest, NextResponse } from "next/server";
import { crmStaff, crmOwners } from "@/lib/crm/core";
import { crmClientRows, deposits30d } from "@/lib/crm/clients";
import { toCsv } from "@/lib/csv";

// CRM — CLIENTS. GET ?kyc=&stage=&owner=&q=[&format=csv] -> counts strip (total, KYC pending, funded, dormant 60d,
// deposits 30d), the filtered rows, the owners.
export async function GET(request: NextRequest) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const brokerId = g.staff.brokerId;
  const q = new URL(request.url).searchParams;
  const kyc = q.get("kyc"), stage = q.get("stage"), owner = q.get("owner");
  const text = (q.get("q") ?? "").trim().toLowerCase();
  const [all, dep, owners] = await Promise.all([crmClientRows(brokerId), deposits30d(brokerId), crmOwners(brokerId)]);
  const rows = all.filter((c) =>
    (!kyc || kyc === "ALL" || (kyc === "NONE" ? c.kyc === "NONE" : c.kyc === kyc)) &&
    (!stage || stage === "ALL" || c.stage === stage) &&
    (!owner || owner === "ALL" || (owner === "NONE" ? !c.owner : c.owner?.id === owner)) &&
    (!text || c.fullName.toLowerCase().includes(text) || c.email.toLowerCase().includes(text) || c.ref.toLowerCase() === text || c.ref.toLowerCase() === `c-${text}`));
  if (q.get("format") === "csv") {
    const body = toCsv(rows.map((c) => ({ ...c, owner: c.owner?.handle ?? "" })), [
      { key: "ref", label: "Client" }, { key: "fullName", label: "Name" }, { key: "email", label: "Email" }, { key: "kyc", label: "KYC" },
      { key: "accounts", label: "Accounts" }, { key: "balance", label: `Balance ${dep.currency}` }, { key: "depositsLtd", label: `Deposits LTD ${dep.currency}` },
      { key: "lastLoginAt", label: "Last login (UTC)" }, { key: "owner", label: "Owner" }, { key: "stage", label: "Stage" },
    ]);
    return new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    counts: {
      total: all.length,
      kycPending: all.filter((c) => c.kyc === "PENDING").length,
      funded: all.filter((c) => c.stage === "FUNDED").length,
      dormant60d: all.filter((c) => c.stage === "DORMANT").length,
      deposits30d: dep.amount,
    },
    currency: dep.currency,
    total: rows.length,
    rows: rows.slice(0, 1000),
    owners,
  });
}
