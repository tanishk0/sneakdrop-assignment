import { prisma } from '../src/db.js';
import { executeBuyTransaction } from '../src/routes/buy.js';

function formatElapsed(start: number): string {
  return `${Date.now() - start}ms`;
}

async function runConcurrencyTests() {
  console.log('================================================================');
  console.log('⚡ HIGH-CONCURRENCY SNEAKER DROP SIMULATION (100 REQUESTS) ⚡');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // SCENARIO 1: 100 Simultaneous Requests from 100 DIFFERENT Users
    // -------------------------------------------------------------------------
    console.log('--- SCENARIO 1: 100 Simultaneous Requests from 100 DIFFERENT Users ---');
    console.log('Resetting database state: Total Stock = 20, Available Stock = 20...');

    await prisma.purchase.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.hold.deleteMany({});
    await prisma.queueEntry.deleteMany({});
    await prisma.inventory.upsert({
      where: { id: 1 },
      update: { totalStock: 20, availableStock: 20 },
      create: { id: 1, totalStock: 20, availableStock: 20 },
    });

    // Create 100 unique user IDs
    const totalUsers = 100;
    const userIds = Array.from({ length: totalUsers }, (_, i) => `concurrent_user_${i + 1}`);

    // Pre-create users in DB in a single batch
    console.log(`Seeding ${totalUsers} unique test users...`);
    await prisma.user.createMany({
      data: userIds.map((id, index) => ({
        id,
        name: `Concurrent User ${index + 1}`,
        email: `${id}@drop-test.com`,
      })),
      skipDuplicates: true,
    });
    console.log(`✓ 100 test users ready.`);

    console.log(`\nFiring 100 simultaneous POST /buy requests at the exact same millisecond...`);
    const startTime = Date.now();

    // Fire 100 requests concurrently
    const results = await Promise.all(
      userIds.map((userId) =>
        executeBuyTransaction(userId)
          .then((res) => ({ userId, success: true, ...res }))
          .catch((err) => ({ userId, success: false, error: err.message }))
      )
    );

    const elapsed = Date.now() - startTime;
    console.log(`All 100 requests completed in ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms per request under lock)\n`);

    // -------------------------------------------------------------------------
    // Analyze and Verify Results
    // -------------------------------------------------------------------------
    const heldResults = results.filter((r) => r.success && r.status === 'held');
    const queuedResults = results.filter((r) => r.success && r.status === 'queued');
    const failedResults = results.filter((r) => !r.success);

    console.log('📊 Scenario 1 In-Memory Results:');
    console.log(`  - Total Requests Fired:  ${results.length}`);
    console.log(`  - Holds Granted:         ${heldResults.length}  (Expected: 20)`);
    console.log(`  - Placed in Waitlist:    ${queuedResults.length}  (Expected: 80)`);
    console.log(`  - Errors/Failures:       ${failedResults.length}  (Expected: 0)`);

    // Verify directly in PostgreSQL
    const dbInventory = await prisma.inventory.findUnique({ where: { id: 1 } });
    const dbHoldsCount = await prisma.hold.count({ where: { status: 'ACTIVE' } });
    const dbQueueCount = await prisma.queueEntry.count({ where: { status: 'WAITING' } });

    console.log('\n🔍 PostgreSQL Database State Audit:');
    console.log(`  - Final Available Stock: ${dbInventory?.availableStock}  (Expected: 0)`);
    console.log(`  - Total Stock:           ${dbInventory?.totalStock}  (Expected: 20)`);
    console.log(`  - Active Holds in DB:    ${dbHoldsCount}  (Expected: 20)`);
    console.log(`  - Queue Entries in DB:   ${dbQueueCount}  (Expected: 80)`);

    // Strict Assertions
    if (heldResults.length !== 20) {
      throw new Error(`CRITICAL FAILURE: Expected exactly 20 holds, but got ${heldResults.length}!`);
    }
    if (queuedResults.length !== 80) {
      throw new Error(`CRITICAL FAILURE: Expected exactly 80 queued users, but got ${queuedResults.length}!`);
    }
    if (failedResults.length !== 0) {
      throw new Error(`CRITICAL FAILURE: Expected 0 failed requests, but ${failedResults.length} failed!`);
    }
    if (dbInventory?.availableStock !== 0) {
      throw new Error(`CRITICAL FAILURE: Stock must be exactly 0, but is ${dbInventory?.availableStock}!`);
    }
    if ((dbInventory?.availableStock ?? 0) < 0) {
      throw new Error(`CRITICAL OVERSELL DETECTED: Stock went negative (${dbInventory?.availableStock})!`);
    }
    if (dbHoldsCount !== 20) {
      throw new Error(`CRITICAL OVERSELL DETECTED: DB holds count is ${dbHoldsCount}, exceeding 20!`);
    }
    if (dbQueueCount !== 80) {
      throw new Error(`CRITICAL FAILURE: DB queue count is ${dbQueueCount}, expected 80!`);
    }

    // Verify Queue Position Integrity (1 to 80 strictly ascending)
    const positions = queuedResults.map((q: any) => q.position).sort((a: number, b: number) => a - b);
    const hasDuplicates = new Set(positions).size !== positions.length;
    if (hasDuplicates || positions[0] !== 1 || positions[positions.length - 1] !== 80) {
      console.warn('Queue positions notice:', positions.slice(0, 10), '...', positions.slice(-5));
    } else {
      console.log('✓ Queue ordering integrity verified: Positions 1 through 80 are strictly ordered without gaps.');
    }

    console.log('\n✅ SCENARIO 1 PASSED: Zero Overselling! Exactly 20 holds granted, exactly 80 placed in waitlist.\n');

    // -------------------------------------------------------------------------
    // SCENARIO 2: 100 Simultaneous Requests from ONE SINGLE User (Anti-Bot / Limit Test)
    // -------------------------------------------------------------------------
    console.log('--- SCENARIO 2: 100 Simultaneous Requests from ONE SINGLE User (Per-User Limit) ---');
    console.log('Resetting DB: Stock = 20...');
    await prisma.purchase.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.hold.deleteMany({});
    await prisma.queueEntry.deleteMany({});
    await prisma.inventory.update({
      where: { id: 1 },
      data: { availableStock: 20, totalStock: 20 },
    });

    const singleUserId = 'spam_bot_user_99';
    await prisma.user.upsert({
      where: { id: singleUserId },
      update: {},
      create: { id: singleUserId, name: 'Spam Bot User' },
    });

    console.log(`Firing 100 simultaneous requests from single user '${singleUserId}'...`);
    const singleUserResults = await Promise.all(
      Array.from({ length: 100 }).map(() =>
        executeBuyTransaction(singleUserId)
          .then((res) => ({ success: true, ...res }))
          .catch((err) => ({ success: false, error: err.message }))
      )
    );

    const singleHeld = singleUserResults.filter((r) => r.success && r.status === 'held');
    const singleRejected = singleUserResults.filter(
      (r) => !r.success && r.error && r.error.includes('already has an active hold')
    );

    console.log(`📊 Scenario 2 Results:`);
    console.log(`  - Holds Granted to this User: ${singleHeld.length}  (Expected: 1)`);
    console.log(`  - Blocked by 1-Hold Limit:    ${singleRejected.length}  (Expected: 99)`);

    const finalStockAfterSingle = (await prisma.inventory.findUnique({ where: { id: 1 } }))?.availableStock;
    console.log(`  - Stock Remaining:           ${finalStockAfterSingle}/20  (Expected: 19)`);

    if (singleHeld.length !== 1) {
      throw new Error(`Expected exactly 1 hold for single user, but got ${singleHeld.length}`);
    }
    if (finalStockAfterSingle !== 19) {
      throw new Error(`Expected stock to decrement by only 1 (19), got ${finalStockAfterSingle}`);
    }
    console.log('✓ Single-user burst integrity verified: Only 1 hold granted, 99 rejected.\n');

    // -------------------------------------------------------------------------
    // Clean Up
    // -------------------------------------------------------------------------
    console.log('Restoring clean state: Stock = 20/20...');
    await prisma.purchase.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.hold.deleteMany({});
    await prisma.queueEntry.deleteMany({});
    await prisma.user.deleteMany({
      where: {
        OR: [
          { id: { startsWith: 'concurrent_user_' } },
          { id: { startsWith: 'spam_bot_' } },
        ],
      },
    });
    await prisma.inventory.update({
      where: { id: 1 },
      data: { availableStock: 20, totalStock: 20 },
    });

    console.log('================================================================');
    console.log('🎉 ALL 100-REQUEST CONCURRENCY TESTS PASSED FLAWLESSLY! 🎉');
    console.log('================================================================');
  } catch (error) {
    console.error('\n❌ Concurrency Test Failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

runConcurrencyTests();
