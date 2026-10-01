import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial database state...');

  // 1. Initialize Sneaker Inventory (20 pairs)
  const inventory = await prisma.inventory.upsert({
    where: { id: 1 },
    update: {
      totalStock: 20,
      availableStock: 20,
    },
    create: {
      id: 1,
      totalStock: 20,
      availableStock: 20,
    },
  });
  console.log(`✓ Inventory initialized: ${inventory.availableStock}/${inventory.totalStock} pairs available`);

  // 2. Seed mock test users for easy multi-user testing
  const testUsers = [
    { id: 'user_1', name: 'Alice (Fast Clicker)', email: 'alice@example.com' },
    { id: 'user_2', name: 'Bob (Sneakerhead)', email: 'bob@example.com' },
    { id: 'user_3', name: 'Charlie (Late Shopper)', email: 'charlie@example.com' },
    { id: 'user_4', name: 'Dave (Waitlist Candidate)', email: 'dave@example.com' },
    { id: 'user_5', name: 'Eve (Double Buyer)', email: 'eve@example.com' },
  ];

  for (const user of testUsers) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: { name: user.name, email: user.email },
      create: user,
    });
  }
  console.log(`✓ Seeded ${testUsers.length} test users.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
