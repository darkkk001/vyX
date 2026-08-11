import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const superAdminPassword = await bcrypt.hash("ChangeMe123!", 10);
  await prisma.adminUser.upsert({
    where: { email: "super@vyxtrader.com" },
    update: {},
    create: {
      email: "super@vyxtrader.com",
      passwordHash: superAdminPassword,
      role: "SUPER_ADMIN",
      brokerId: null,
    },
  });

  const acmeFx = await prisma.broker.upsert({
    where: { subdomain: "acmefx" },
    update: {},
    create: {
      name: "AcmeFX",
      subdomain: "acmefx",
      tier: "STANDARD",
      logoUrl: "https://placehold.co/160x40?text=AcmeFX",
      primaryColor: null, // Standard tier: no custom brand color, default vyX theme
    },
  });

  const novaMarkets = await prisma.broker.upsert({
    where: { subdomain: "novamarkets" },
    update: {},
    create: {
      name: "Nova Markets",
      subdomain: "novamarkets",
      tier: "WHITE_LABEL",
      logoUrl: "https://placehold.co/160x40?text=Nova+Markets",
      primaryColor: "#7c3aed",
    },
  });

  const brokerAdminPassword = await bcrypt.hash("ChangeMe123!", 10);
  await prisma.adminUser.upsert({
    where: { email: "admin@acmefx.com" },
    update: {},
    create: {
      email: "admin@acmefx.com",
      passwordHash: brokerAdminPassword,
      role: "BROKER_ADMIN",
      brokerId: acmeFx.id,
    },
  });
  await prisma.adminUser.upsert({
    where: { email: "admin@novamarkets.com" },
    update: {},
    create: {
      email: "admin@novamarkets.com",
      passwordHash: brokerAdminPassword,
      role: "BROKER_ADMIN",
      brokerId: novaMarkets.id,
    },
  });

  console.log("Seeded:", { acmeFx: acmeFx.subdomain, novaMarkets: novaMarkets.subdomain });
  console.log("Super admin login: super@vyxtrader.com / ChangeMe123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
