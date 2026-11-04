import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmStaff } from "@/lib/crm/core";

// POST text/csv (or {csv}) with a header row: name, email, phone, country, source (any order, case-insensitive; name +
// email required). Up to 2,000 rows; an e-mail already in the leads is skipped. Answers how many were added / skipped.
const MAX_ROWS = 2000;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

export async function POST(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const ct = request.headers.get("content-type") ?? "";
  const text = ct.includes("application/json") ? String((await request.json().catch(() => null))?.csv ?? "") : await request.text();
  if (text.length > 2_000_000) return NextResponse.json({ error: "File is too large (2 MB at most)." }, { status: 400 });
  const rows = parseCsv(text);
  if (rows.length < 2) return NextResponse.json({ error: "The file has no rows." }, { status: 400 });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const iName = col(["name", "full name", "fullname"]), iEmail = col(["email", "e-mail"]), iPhone = col(["phone", "mobile"]), iCountry = col(["country", "ctry"]), iSource = col(["source"]);
  if (iName < 0 || iEmail < 0) return NextResponse.json({ error: "The header needs name and email columns." }, { status: 400 });
  const body = rows.slice(1, MAX_ROWS + 1);
  const emails = body.map((r) => (r[iEmail] ?? "").trim().toLowerCase());
  const known = new Set((await prisma.lead.findMany({ where: { brokerId: staff.brokerId, email: { in: emails } }, select: { email: true } })).map((l) => l.email));
  let added = 0, skipped = 0;
  const seen = new Set<string>();
  for (const r of body) {
    const name = (r[iName] ?? "").trim().slice(0, 100);
    const email = (r[iEmail] ?? "").trim().toLowerCase().slice(0, 200);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || known.has(email) || seen.has(email)) { skipped++; continue; }
    seen.add(email);
    const cellOf = (i: number, n: number) => (i >= 0 && r[i]?.trim() ? r[i].trim().slice(0, n) : null);
    await prisma.lead.create({ data: { brokerId: staff.brokerId, fullName: name, email, phone: cellOf(iPhone, 32), country: cellOf(iCountry, 64), source: cellOf(iSource, 40) ?? "CSV", status: "NEW" } });
    added++;
  }
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, action: "LEADS_IMPORTED", entityType: "Lead", entityId: "csv", newValue: { added, skipped, rows: body.length, cut: rows.length - 1 > MAX_ROWS } } });
  return NextResponse.json({ added, skipped, cut: rows.length - 1 > MAX_ROWS });
}
