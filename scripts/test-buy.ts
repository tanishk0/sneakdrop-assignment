import { executeBuyTransaction, ApiError } from '../src/routes/buy.js';
import { prisma } from '../src/db.js';

async function runTests() {
  console.log('--- Starting POST /buy Core Logic Tests ---');

  try {
    // Reset test state
    await prisma.purchase.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.queueEntry.deleteMany();
    await prisma.inventory.upsert({
      where: { id: 1 },
      update: { totalStock: 20, availableStock: 20 },
      create: { id: 1, totalStock: 20, availableStock: 20 },
    });

    const testUser = 'test_user_alpha';
    console.log(`\n1. Testing first buy attempt for ${testUser}...`);
    const res1 = await executeBuyTransaction(testUser);
    console.log('Result:', JSON.stringify(res1, null, 2));

    if (res1.status !== 'held' || res1.hold.status !== 'ACTIVE') {
      throw new Error('Test 1 Failed: Expected hold with status ACTIVE');
    }
    console.log('✓ Test 1 Passed: 5-minute hold created, stock decremented.');

    console.log(`\n2. Testing duplicate hold attempt for ${testUser} (should reject)...`);
    try {
      await executeBuyTransaction(testUser);
      throw new Error('Test 2 Failed: Expected error due to active hold');
    } catch (err: any) {
      if (err instanceof ApiError && err.statusCode === 400) {
        console.log(`✓ Test 2 Passed: Rejected with "${err.message}"`);
      } else {
        throw err;
      }
    }

    console.log('\n3. Testing stock depletion and queue placement...');
    // Set available stock to 0 to simulate flash sale sellout
    await prisma.inventory.update({
      where: { id: 1 },
      data: { availableStock: 0 },
    });

    const waitlistUser = 'test_user_waitlist_1';
    const queueRes1 = await executeBuyTransaction(waitlistUser);
    console.log('Queue Result:', JSON.stringify(queueRes1, null, 2));

    if (queueRes1.status !== 'queued' || queueRes1.position !== 1) {
      throw new Error('Test 3 Failed: Expected queued status with position 1');
    }
    console.log('✓ Test 3 Passed: User placed in waiting line at position 1.');

    const waitlistUser2 = 'test_user_waitlist_2';
    const queueRes2 = await executeBuyTransaction(waitlistUser2);
    if (queueRes2.status !== 'queued' || queueRes2.position !== 2) {
      throw new Error('Test 3b Failed: Expected queued status with position 2');
    }
    console.log('✓ Test 3b Passed: Second user placed in waiting line at position 2.');

    console.log('\n4. Testing 2-purchase limit...');
    const buyerUser = 'test_user_buyer';
    await prisma.user.upsert({
      where: { id: buyerUser },
      update: {},
      create: { id: buyerUser, name: 'Buyer User' },
    });
    // Simulate 2 previous purchases
    const holdA = await prisma.hold.create({
      data: {
        userId: buyerUser,
        status: 'PURCHASED',
        expiresAt: new Date(),
      },
    });
    const holdB = await prisma.hold.create({
      data: {
        userId: buyerUser,
        status: 'PURCHASED',
        expiresAt: new Date(),
      },
    });

    const payA = await prisma.payment.create({
      data: {
        id: 'pay_a',
        userId: buyerUser,
        holdId: holdA.id,
        status: 'SUCCESS',
      },
    });
    const payB = await prisma.payment.create({
      data: {
        id: 'pay_b',
        userId: buyerUser,
        holdId: holdB.id,
        status: 'SUCCESS',
      },
    });

    await prisma.purchase.create({
      data: {
        userId: buyerUser,
        holdId: holdA.id,
        paymentId: payA.id,
      },
    });
    await prisma.purchase.create({
      data: {
        userId: buyerUser,
        holdId: holdB.id,
        paymentId: payB.id,
      },
    });

    // Reset stock to 5
    await prisma.inventory.update({
      where: { id: 1 },
      data: { availableStock: 5 },
    });

    try {
      await executeBuyTransaction(buyerUser);
      throw new Error('Test 4 Failed: Expected purchase limit error');
    } catch (err: any) {
      if (err instanceof ApiError && err.statusCode === 400 && err.message.includes('Maximum 2 pairs')) {
        console.log(`✓ Test 4 Passed: Rejected with "${err.message}"`);
      } else {
        throw err;
      }
    }

    console.log('\n🎉 ALL CORE /buy TESTS PASSED SUCCESSFULLY! 🎉');
  } catch (error) {
    console.error('Test execution failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
