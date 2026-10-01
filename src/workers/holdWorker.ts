import { Worker, Job } from 'bullmq';
import { redisConnection } from '../redis.js';
import {
  HOLD_EXPIRATION_QUEUE_NAME,
  HoldExpirationJobData,
  scheduleHoldExpiration,
} from '../queues/holdQueue.js';
import { prisma } from '../db.js';

export interface ProcessExpirationResult {
  action: 'expired_and_promoted' | 'expired_and_restocked' | 'skipped';
  holdId: string;
  reason?: string;
  promotedUserId?: string;
  newHoldId?: string;
}

/**
 * Transactional processor for expiring an individual hold.
 * 1. Checks if hold is still ACTIVE and expired.
 * 2. Marks hold as EXPIRED.
 * 3. Inspects waitlist for earliest eligible WAITING user.
 * 4. If waiting user exists: creates new 5-min hold, marks queue entry PROMOTED.
 * 5. If queue is empty: increments available stock by 1.
 */
export async function processExpiredHold(
  holdId: string
): Promise<ProcessExpirationResult> {
  const result = await prisma.$transaction(
    async (tx) => {
      const hold = await tx.hold.findUnique({
        where: { id: holdId },
      });

      // If hold doesn't exist or is already completed/cancelled/expired, skip
      if (!hold) {
        return {
          action: 'skipped' as const,
          holdId,
          reason: 'Hold does not exist',
        };
      }

      if (hold.status !== 'ACTIVE') {
        return {
          action: 'skipped' as const,
          holdId,
          reason: `Hold status is ${hold.status}, not ACTIVE`,
        };
      }

      // Check if hold has actually expired (leeway of 500ms)
      if (hold.expiresAt.getTime() > Date.now() + 500) {
        return {
          action: 'skipped' as const,
          holdId,
          reason: 'Hold is not yet expired',
        };
      }

      // 1. Mark current hold as EXPIRED
      await tx.hold.update({
        where: { id: holdId },
        data: { status: 'EXPIRED' },
      });

      // 2. Lock inventory row to prevent concurrent race conditions
      const inventoryRows = await tx.$queryRaw<
        Array<{
          id: number;
          totalStock: number;
          availableStock: number;
        }>
      >`
        SELECT id, "totalStock", "availableStock"
        FROM inventory
        WHERE id = 1
        FOR UPDATE
      `;

      if (!inventoryRows || inventoryRows.length === 0) {
        throw new Error('Inventory row missing');
      }

      // 3. Find next eligible waiting user in FIFO order
      let promotedUserId: string | undefined;
      let newHoldId: string | undefined;

      while (true) {
        const candidate = await tx.queueEntry.findFirst({
          where: { status: 'WAITING' },
          orderBy: { joinedAt: 'asc' },
        });

        if (!candidate) {
          break; // Queue is empty
        }

        // Verify candidate eligibility (no other active hold, < 2 purchases)
        const candidateActiveHold = await tx.hold.findFirst({
          where: {
            userId: candidate.userId,
            status: 'ACTIVE',
            expiresAt: { gt: new Date() },
          },
        });

        const candidatePurchases = await tx.purchase.count({
          where: { userId: candidate.userId },
        });

        if (candidateActiveHold || candidatePurchases >= 2) {
          // Disqualify candidate and update entry
          await tx.queueEntry.update({
            where: { id: candidate.id },
            data: { status: 'EXPIRED' },
          });
          continue;
        }

        // Candidate is eligible! Create fresh 5-minute hold
        const holdDurationSeconds = parseInt(
          process.env.HOLD_DURATION_SECONDS || '300',
          10
        );
        const newExpiresAt = new Date(Date.now() + holdDurationSeconds * 1000);

        const newHold = await tx.hold.create({
          data: {
            userId: candidate.userId,
            status: 'ACTIVE',
            expiresAt: newExpiresAt,
          },
        });

        await tx.queueEntry.update({
          where: { id: candidate.id },
          data: {
            status: 'PROMOTED',
            promotedAt: new Date(),
          },
        });

        promotedUserId = candidate.userId;
        newHoldId = newHold.id;
        break;
      }

      // 4. If no eligible candidate was found in the queue, return the pair to stock
      if (!promotedUserId) {
        await tx.inventory.update({
          where: { id: 1 },
          data: {
            availableStock: { increment: 1 },
          },
        });

        return {
          action: 'expired_and_restocked' as const,
          holdId,
        };
      }

      return {
        action: 'expired_and_promoted' as const,
        holdId,
        promotedUserId,
        newHoldId,
      };
    },
    {
      isolationLevel: 'ReadCommitted',
      timeout: 10000,
    }
  );

  // If a new hold was created for a waitlist user, schedule its expiration job
  if (result.action === 'expired_and_promoted' && result.newHoldId && result.promotedUserId) {
    try {
      await scheduleHoldExpiration(result.newHoldId, result.promotedUserId);
      console.log(
        `[BullMQ] Promoted user ${result.promotedUserId} to hold ${result.newHoldId}, expiration scheduled.`
      );
    } catch (schedErr) {
      console.error(
        `Failed to schedule expiration for promoted hold ${result.newHoldId}:`,
        schedErr
      );
    }
  }

  return result;
}

/**
 * Sweep function that catches any expired ACTIVE holds that might have been
 * missed during downtime or restarts.
 */
export async function sweepExpiredHolds(): Promise<number> {
  try {
    const expiredHolds = await prisma.hold.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lte: new Date() },
      },
      select: { id: true },
      take: 20,
    });

    for (const hold of expiredHolds) {
      await processExpiredHold(hold.id);
    }

    return expiredHolds.length;
  } catch (err) {
    console.error('Error sweeping expired holds:', err);
    return 0;
  }
}

/**
 * Initializes and starts the BullMQ Hold Expiration Worker.
 */
export function startHoldWorker(): {
  worker: Worker<HoldExpirationJobData>;
  stop: () => Promise<void>;
} {
  const worker = new Worker<HoldExpirationJobData>(
    HOLD_EXPIRATION_QUEUE_NAME,
    async (job: Job<HoldExpirationJobData>) => {
      const { holdId, userId } = job.data;
      console.log(`[BullMQ Worker] Processing expiration for hold ${holdId} (user: ${userId})...`);
      const result = await processExpiredHold(holdId);
      console.log(`[BullMQ Worker] Hold ${holdId} outcome:`, result.action, result.reason || '');
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[BullMQ Worker] Job ${job?.id} failed:`, err);
  });

  worker.on('error', (err) => {
    console.error('[BullMQ Worker] Internal error:', err);
  });

  // Run a periodic sweep every 5 seconds as a safety net
  const sweepInterval = setInterval(async () => {
    await sweepExpiredHolds();
  }, 5000);

  console.log('[BullMQ Worker] Hold expiration worker started.');

  return {
    worker,
    stop: async () => {
      clearInterval(sweepInterval);
      await worker.close();
      console.log('[BullMQ Worker] Hold expiration worker stopped.');
    },
  };
}
