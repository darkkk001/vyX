import { NextRequest, NextResponse } from "next/server";
import { SymbolCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

const VALID_CATEGORIES = new Set(Object.values(SymbolCategory));

// Whole-array replace -- the client always has the full current set in
// hand (it started from this same route's own GET-level read via
// /api/trade/watchlist), same "client sends the full desired state"
// shape as the watchlist reorder endpoint.
export async function PUT(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const categories = Array.isArray(body?.categories) ? body.categories : null;
  if (!categories || !categories.every((c: unknown): c is SymbolCategory => typeof c === "string" && VALID_CATEGORIES.has(c as SymbolCategory))) {
    return NextResponse.json({ error: "categories must be an array of valid SymbolCategory values" }, { status: 400 });
  }

  await prisma.account.update({
    where: { id: session.accountId },
    data: { watchlistCollapsedCategories: { set: categories } },
  });
  return NextResponse.json({ collapsedCategories: categories });
}
