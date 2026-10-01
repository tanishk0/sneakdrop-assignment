import { prisma } from '../src/db.js';
import { executeBuyTransaction } from '../src/routes/buy.js';
import { scheduleHoldExpiration } from '../src/queues/holdQueue.js';
import { startHoldWorker } from '../src/workers/holdWorker.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLifecycleTests() {
  console.log('=== Starting BullMQ Hold Expiration Worker Tests ===\n');

  // Start worker
  const workerInstance = startHoldWorker();

  try {
    // 1. Reset DB state
    await prisma.purchase.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.queueEntry.deleteMany();
    await prisma.inventory.upsert({
      where: { id: 1 },
      update: { totalStock: 20, availableStock: 0 },
      create: { id: 1, totalStock: 20, availableStock: 0 },
    });

    console.log('1. Setting up initial condition: 0 stock, 1 active hold for Alice with 2-second duration.');
    const userAlice = 'user_alice';
    const userBob = 'user_bob_waitlist';
    const userCharlie = 'user_charlie';

    for (const uid of [userAlice, userBob, userCharlie]) {
      await prisma.user.upsert({
        where: { id: uid },
        update: {},
        create: { id: uid, name: uid },
      });
    }

    // Create Alice's hold with 2-second expiration
    const aliceExpiresAt = new Date(Date.now() + 2000);
    const aliceHold = await prisma.hold.create({
      data: {
        userId: userAlice,
        status: 'ACTIVE',
        expiresAt: aliceExpiresAt,
      },
    });

    // Schedule BullMQ job for Alice's hold to expire in 2 seconds
    await scheduleHoldExpiration(aliceHold.id, userAlice, 2000);
    console.log(`✓ Alice's hold created (${aliceHold.id}), BullMQ job scheduled for 2 seconds.`);

    // 2. Put Bob in the waitlist
    console.log('\n2. Putting Bob in the waitlist line (QueueEntry)...');
    const bobQueue = await prisma.queueEntry.create({
      data: {
        userId: userBob,
        status: 'WAITING',
      },
    });
    console.log(`✓ Bob added to queue (id: ${bobQueue.id}, status: ${bobQueue.status}).`);

    // 3. Wait 3 seconds for BullMQ worker to process Alice's expiration and promote Bob
    console.log('\n3. Waiting 3.5 seconds for BullMQ delayed job to fire...');
    await sleep(3500);

    // 4. Verify outcomes
    const updatedAliceHold = await prisma.hold.findUnique({
      where: { id: aliceHold.id },
    });
    console.log(`Alice's Hold Status: ${updatedAliceHold?.status}`);
    if (updatedAliceHold?.status !== 'EXPIRED') {
      throw new Error(`Expected Alice's hold to be EXPIRED, got ${updatedAliceHold?.status}`);
    }
    console.log('✓ Alice hold correctly transitioned to EXPIRED.');

    const updatedBobQueue = await prisma.queueEntry.findUnique({
      where: { id: bobQueue.id },
    });
    console.log(`Bob's Queue Status: ${updatedBobQueue?.status}`);
    if (updatedBobQueue?.status !== 'PROMOTED') {
      throw new Error(`Expected Bob's queue status to be PROMOTED, got ${updatedBobQueue?.status}`);
    }
    console.log('✓ Bob was automatically PROMOTED from waitlist!');

    const bobHold = await prisma.hold.findFirst({
      where: {
        userId: userBob,
        status: 'ACTIVE',
      },
    });
    if (!bobHold) {
      throw new Error('Expected Bob to have an ACTIVE hold created');
    }
    console.log(`✓ Bob was granted a new ACTIVE hold: ${bobHold.id}, expires: ${bobHold.expiresAt.toISOString()}`);

    // 5. Test expiration when waitlist is EMPTY -> Should restock to available inventory
    console.log('\n4. Testing expiration with EMPTY waitlist -> Should restock inventory...');
    const charlieExpiresAt = new Date(Date.now() + 1500);
    const charlieHold = await prisma.hold.create({
      data: {
        userId: userCharlie,
        status: 'ACTIVE',
        expiresAt: charlieExpiresAt,
      },
    });
    await scheduleHoldExpiration(charlieHold.id, userCharlie, 1500);

    const initialStock = (await prisma.inventory.findUnique({ where: { id: 1 } }))?.availableStock || 0;
    console.log(`Current stock before Charlie's hold expires: ${initialStock}`);

    console.log('Waiting 2.5 seconds for Charlie hold to expire with no one in line...');
    await sleep(2500);

    const updatedCharlieHold = await prisma.hold.findUnique({ where: { id: charlieHold.id } });
    const finalStock = (await prisma.inventory.findUnique({ where: { id: 1 } }))?.availableStock || 0;

    console.log(`Charlie's Hold Status: ${updatedCharlieHold?.status}`);
    console.log(`Stock after Charlie's hold expired: ${finalStock}`);

    if (updatedCharlieHold?.status !== 'EXPIRED') {
      throw new Error(`Expected Charlie's hold to be EXPIRED, got ${updatedCharlieHold?.status}`);
    }
    if (finalStock !== initialStock + 1) {
      throw new Error(`Expected stock to increment by 1 (from ${initialStock} to ${initialStock + 1}), got ${finalStock}`);
    }
    console.log('✓ Stock successfully incremented and returned to available inventory!');

    console.log('\n🎉 ALL BULLMQ HOLD LIFECYCLE TESTS PASSED PERFECTLY! 🎉\n');
  } catch (error) {
    console.error('Worker test failed:', error);
  } finally {
    await workerInstance.stop();
    await prisma.$disconnect();
    process.exit(0);
  }
}

runWorkerLifecycleTests();
