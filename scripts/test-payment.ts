import { prisma } from '../src/db.js';
import { executeBuyTransaction } from '../src/routes/buy.js';
import { processPaymentWebhook } from '../src/routes/payment.js';

async function runPaymentTests() {
  console.log('=== Starting Payment Webhook & Idempotency Tests ===\n');

  try {
    // 1. Reset state
    await prisma.purchase.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.queueEntry.deleteMany();
    await prisma.inventory.upsert({
      where: { id: 1 },
      update: { totalStock: 20, availableStock: 20 },
      create: { id: 1, totalStock: 20, availableStock: 20 },
    });

    const user1 = 'user_shopper_1';
    await prisma.user.upsert({
      where: { id: user1 },
      update: {},
      create: { id: user1, name: 'Shopper 1' },
    });

    console.log('1. User acquires a hold via POST /buy...');
    const buyResult = await executeBuyTransaction(user1);
    if (buyResult.status !== 'held') {
      throw new Error('Failed to acquire hold');
    }
    const holdId = buyResult.hold.id;
    console.log(`✓ Hold acquired: ${holdId}`);

    // 2. Test Idempotency with exact same payment ID sent 3 times
    const paymentId = 'payment_success_123';
    console.log(`\n2. Testing idempotency: Sending webhook with "${paymentId}" THREE times...`);

    console.log('   -> Sending webhook attempt #1...');
    const res1 = await processPaymentWebhook({
      paymentId,
      holdId,
      userId: user1,
      amount: 150.0,
      eventType: 'payment_succeeded',
    });
    console.log(`      Outcome #1: status=${res1.status}, duplicate=${res1.isIdempotentDuplicate}`);
    if (res1.status !== 'SUCCESS' || res1.isIdempotentDuplicate !== false) {
      throw new Error('Attempt #1 expected to succeed as primary');
    }

    console.log('   -> Sending webhook attempt #2 (same payment ID)...');
    const res2 = await processPaymentWebhook({
      paymentId,
      holdId,
      userId: user1,
      amount: 150.0,
      eventType: 'payment_succeeded',
    });
    console.log(`      Outcome #2: status=${res2.status}, duplicate=${res2.isIdempotentDuplicate}`);
    if (res2.isIdempotentDuplicate !== true) {
      throw new Error('Attempt #2 expected to be recognized as idempotent duplicate');
    }

    console.log('   -> Sending webhook attempt #3 (same payment ID)...');
    const res3 = await processPaymentWebhook({
      paymentId,
      holdId,
      userId: user1,
      amount: 150.0,
      eventType: 'payment_succeeded',
    });
    console.log(`      Outcome #3: status=${res3.status}, duplicate=${res3.isIdempotentDuplicate}`);
    if (res3.isIdempotentDuplicate !== true) {
      throw new Error('Attempt #3 expected to be recognized as idempotent duplicate');
    }

    // Verify DB count: EXACTLY 1 Purchase and 1 Payment
    const purchasesCount = await prisma.purchase.count({ where: { holdId } });
    const paymentsCount = await prisma.payment.count({ where: { id: paymentId } });
    console.log(`\n   Database Audit:`);
    console.log(`   Purchases for this hold: ${purchasesCount} (Expected: 1)`);
    console.log(`   Payments recorded: ${paymentsCount} (Expected: 1)`);

    if (purchasesCount !== 1 || paymentsCount !== 1) {
      throw new Error(`Idempotency check failed: expected 1 purchase, found ${purchasesCount}`);
    }
    console.log('✓ Idempotency verified: Exactly 1 Purchase created after 3 webhook calls.');

    // 3. Test Late Payment on Expired Hold
    console.log('\n3. Testing Late Payment handling (hold expired before payment arrived)...');
    const user2 = 'user_shopper_2';
    await prisma.user.upsert({
      where: { id: user2 },
      update: {},
      create: { id: user2, name: 'Shopper 2' },
    });

    // Create an expired hold
    const expiredHold = await prisma.hold.create({
      data: {
        userId: user2,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 60000), // 1 min in past
      },
    });

    const latePaymentId = 'pay_late_999';
    const lateRes = await processPaymentWebhook({
      paymentId: latePaymentId,
      holdId: expiredHold.id,
      userId: user2,
      amount: 150.0,
      eventType: 'payment_succeeded',
    });

    console.log('Late Payment Result:', JSON.stringify(lateRes, null, 2));

    if (lateRes.status !== 'REFUNDED') {
      throw new Error(`Expected late payment to be REFUNDED, got ${lateRes.status}`);
    }

    const latePurchases = await prisma.purchase.count({ where: { holdId: expiredHold.id } });
    const latePaymentRecord = await prisma.payment.findUnique({ where: { id: latePaymentId } });

    console.log(`Purchases created for late hold: ${latePurchases} (Expected: 0)`);
    console.log(`Payment record status: ${latePaymentRecord?.status} (Expected: REFUNDED)`);

    if (latePurchases !== 0) {
      throw new Error('Late payment must NOT create any Purchase');
    }
    if (latePaymentRecord?.status !== 'REFUNDED') {
      throw new Error('Late payment record must be marked REFUNDED');
    }
    console.log('✓ Late Payment verified: Automatically refunded without creating a purchase.');

    // 4. Test Concurrent Duplicate Webhooks (simulating high-concurrency race)
    console.log('\n4. Testing concurrent duplicate webhook bursts (5 parallel calls)...');
    const user3 = 'user_shopper_3';
    await prisma.user.upsert({
      where: { id: user3 },
      update: {},
      create: { id: user3, name: 'Shopper 3' },
    });

    const hold3 = await executeBuyTransaction(user3);
    const concurrentPaymentId = 'pay_burst_race_777';

    const burstResults = await Promise.all([
      processPaymentWebhook({ paymentId: concurrentPaymentId, holdId: hold3.hold.id, userId: user3 }),
      processPaymentWebhook({ paymentId: concurrentPaymentId, holdId: hold3.hold.id, userId: user3 }),
      processPaymentWebhook({ paymentId: concurrentPaymentId, holdId: hold3.hold.id, userId: user3 }),
      processPaymentWebhook({ paymentId: concurrentPaymentId, holdId: hold3.hold.id, userId: user3 }),
      processPaymentWebhook({ paymentId: concurrentPaymentId, holdId: hold3.hold.id, userId: user3 }),
    ]);

    const primarySuccesses = burstResults.filter((r) => !r.isIdempotentDuplicate && r.status === 'SUCCESS');
    const duplicateResponses = burstResults.filter((r) => r.isIdempotentDuplicate);

    console.log(`Parallel burst results: ${primarySuccesses.length} primary success, ${duplicateResponses.length} duplicate caught.`);

    if (primarySuccesses.length !== 1 || duplicateResponses.length !== 4) {
      throw new Error('Concurrent webhook race failed: Expected exactly 1 primary and 4 duplicates');
    }

    const totalPurchasesForUser3 = await prisma.purchase.count({ where: { holdId: hold3.hold.id } });
    if (totalPurchasesForUser3 !== 1) {
      throw new Error(`Expected exactly 1 purchase in database, got ${totalPurchasesForUser3}`);
    }
    console.log('✓ Concurrent Webhook Race verified: Exactly 1 purchase created under concurrent load.');

    console.log('\n🎉 ALL PAYMENT WEBHOOK & IDEMPOTENCY TESTS PASSED! 🎉\n');
  } catch (error) {
    console.error('Payment test failed:', error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

runPaymentTests();
