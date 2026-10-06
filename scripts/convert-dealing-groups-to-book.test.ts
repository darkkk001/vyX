// DB-backed test for scripts/convert-dealing-groups-to-book.ts on the scratch database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { convertDealingGroups, ConvertRefused } from "./convert-dealing-groups-to-book";

const prisma = new PrismaClient();
const tag = `cdg${Date.now().toString(36)}`;
let dbReachable = true;
let brokerId = "";
let groupId = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; } catch { dbReachable = false; return; }
  const b = await prisma.broker.create({ data: { name: tag, subdomain: tag, dealingDeskAutoFillAt: new Date() } as never });
  brokerId = b.id;
  const g = await prisma.group.create({ data: { brokerId, name: "Dealing", category: "DEALING", groupType: "DEALING", leverage: 100 } as never });
  groupId = g.id;
});

afterAll(async () => {
  if (dbReachable && brokerId) {
    await prisma.auditLog.deleteMany({ where: { brokerId } });
    await prisma.group.deleteMany({ where: { brokerId } });
    await prisma.broker.delete({ where: { id: brokerId } });
  }
  await prisma.$disconnect();
});

describe("convert DEALING groups to Book", () => {
  it("dry run writes nothing", async () => {
    if (!dbReachable) return;
    const r = await convertDealingGroups(prisma, { apply: false, targets: [{ broker: tag, group: "Dealing" }] });
    expect(r.converted).toBe(0);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: groupId } })).category).toBe("DEALING");
  });

  it("refuses when the desk is in review (behaviour would change)", async () => {
    if (!dbReachable) return;
    await prisma.broker.update({ where: { id: brokerId }, data: { dealingDeskAutoFillAt: null } as never });
    await expect(convertDealingGroups(prisma, { apply: true, targets: [{ broker: tag, group: "Dealing" }] })).rejects.toBeInstanceOf(ConvertRefused);
    await prisma.broker.update({ where: { id: brokerId }, data: { dealingDeskAutoFillAt: new Date() } as never });
  });

  it("refuses the soak bot's group", async () => {
    await expect(convertDealingGroups(prisma, { apply: false, targets: [{ broker: "zzshadowbot", group: "SB Dealing Desk" }] })).rejects.toBeInstanceOf(ConvertRefused);
  });

  it("apply converts only category/groupType, writes one audit row, and a re-run changes nothing", async () => {
    if (!dbReachable) return;
    const before = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
    const r = await convertDealingGroups(prisma, { apply: true, targets: [{ broker: tag, group: "Dealing" }] });
    expect(r.converted).toBe(1);
    const after = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
    expect(after.category).toBe("B_BOOK");
    expect({ ...after, category: 0, groupType: 0, updatedAt: 0 }).toEqual({ ...before, category: 0, groupType: 0, updatedAt: 0 });
    expect(await prisma.auditLog.count({ where: { brokerId, action: "GROUP_CONFIG_UPDATED", entityId: groupId } })).toBe(1);
    const again = await convertDealingGroups(prisma, { apply: true, targets: [{ broker: tag, group: "Dealing" }] });
    expect(again.converted).toBe(0);
  });
});
