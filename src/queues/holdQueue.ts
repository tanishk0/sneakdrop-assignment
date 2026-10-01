import { Queue } from 'bullmq';
import { redisConnection } from '../redis.js';

export interface HoldExpirationJobData {
  holdId: string;
  userId: string;
}

export const HOLD_EXPIRATION_QUEUE_NAME = 'hold-expiration';

export const holdExpirationQueue = new Queue<HoldExpirationJobData>(
  HOLD_EXPIRATION_QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  }
);

/**
 * Schedule a delayed job to expire a hold after the configured hold duration.
 */
export async function scheduleHoldExpiration(
  holdId: string,
  userId: string,
  delayMs?: number
) {
  const defaultDelay =
    parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10) * 1000;
  const delay = delayMs !== undefined ? delayMs : defaultDelay;

  const job = await holdExpirationQueue.add(
    'expire-hold',
    { holdId, userId },
    {
      jobId: `expire-${holdId}`,
      delay,
    }
  );

  return job;
}

/**
 * Cancel an active delayed hold expiration job (e.g., when payment succeeds).
 */
export async function cancelHoldExpiration(holdId: string) {
  try {
    const job = await holdExpirationQueue.getJob(`expire-${holdId}`);
    if (job) {
      await job.remove();
      return true;
    }
  } catch (err) {
    console.warn(`Failed to remove job for hold ${holdId}:`, err);
  }
  return false;
}
