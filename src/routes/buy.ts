import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { scheduleHoldExpiration } from '../queues/holdQueue.js';

export const buyRouter = Router();

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface BuySuccessHoldResponse {
  status: 'held';
  message: string;
  hold: {
    id: string;
    userId: string;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    secondsRemaining: number;
  };
  inventoryRemaining: number;
}

export interface BuyQueuedResponse {
  status: 'queued';
  message: string;
  queueEntry: {
    id: string;
    userId: string;
    status: string;
    joinedAt: Date;
    promotedAt: Date | null;
  };
  position: number;
}

export type BuyResult = BuySuccessHoldResponse | BuyQueuedResponse;

/**
 * Core transactional logic for POST /buy:
 * 1. Transaction begins
 * 2. Lock inventory row (SELECT ... FOR UPDATE)
 * 3. Check user limits:
 *    - Max 1 active hold at a time
 *    - Max 2 total purchases
 * 4. Check availableStock:
 *    - If > 0: decrement stock, create 5-min hold, return 'held'
 *    - If <= 0: create or get queue entry, return 'queued' with position
 * 5. Commit
 */
export async function executeBuyTransaction(
  userId: string,
  customDurationSeconds?: number
): Promise<BuyResult> {
  const holdDurationSeconds =
    customDurationSeconds && customDurationSeconds > 0
      ? customDurationSeconds
      : parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

  return await prisma.$transaction(
    async (tx) => {
      // Ensure user exists (auto-register on demand for test convenience)
      await tx.user.upsert({
        where: { id: userId },
        update: {},
        create: {
          id: userId,
          name: `User ${userId}`,
        },
      });

      // 1. Lock inventory row immediately to serialize concurrent purchase attempts
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
        throw new ApiError(500, 'Inventory record not found. Please ensure database is seeded.');
      }

      const inventory = inventoryRows[0];

      // 2. Check user limits
      // Rule: "A user can hold only 1 pair at a time"
      const activeHold = await tx.hold.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
        },
      });

      if (activeHold) {
        const remainingSeconds = Math.max(
          0,
          Math.floor((activeHold.expiresAt.getTime() - Date.now()) / 1000)
        );
        throw new ApiError(400, 'User already has an active hold', {
          holdId: activeHold.id,
          expiresAt: activeHold.expiresAt,
          secondsRemaining: remainingSeconds,
        });
      }

      // Rule: "and can buy a maximum of 2 pairs in total."
      const totalPurchases = await tx.purchase.count({
        where: { userId },
      });

      if (totalPurchases >= 2) {
        throw new ApiError(400, 'Purchase limit reached. Maximum 2 pairs allowed per user.');
      }

      // 3. Stock check
      // Branch A: Stock > 0 -> Decrement stock and grant 5-minute hold
      if (inventory.availableStock > 0) {
        const newStock = inventory.availableStock - 1;
        await tx.inventory.update({
          where: { id: 1 },
          data: {
            availableStock: newStock,
          },
        });

        const expiresAt = new Date(Date.now() + holdDurationSeconds * 1000);

        const hold = await tx.hold.create({
          data: {
            userId,
            status: 'ACTIVE',
            expiresAt,
          },
        });

        // If user was previously in the waitlist, remove/update their waiting entry
        await tx.queueEntry.updateMany({
          where: {
            userId,
            status: 'WAITING',
          },
          data: {
            status: 'PROMOTED',
            promotedAt: new Date(),
          },
        });

        return {
          status: 'held',
          message: 'Hold acquired successfully for 5 minutes',
          hold: {
            id: hold.id,
            userId: hold.userId,
            status: hold.status,
            expiresAt: hold.expiresAt,
            createdAt: hold.createdAt,
            secondsRemaining: holdDurationSeconds,
          },
          inventoryRemaining: newStock,
        };
      }

      // Branch B: Stock <= 0 -> Add to waiting line (FIFO Queue)
      let queueEntry = await tx.queueEntry.findFirst({
        where: {
          userId,
          status: 'WAITING',
        },
      });

      if (!queueEntry) {
        queueEntry = await tx.queueEntry.create({
          data: {
            userId,
            status: 'WAITING',
          },
        });
      }

      // Determine place in waiting line (count users who joined at or before this entry)
      const position = await tx.queueEntry.count({
        where: {
          status: 'WAITING',
          joinedAt: { lte: queueEntry.joinedAt },
        },
      });

      return {
        status: 'queued',
        message: 'All pairs are currently reserved. You have been placed in the waiting line.',
        queueEntry: {
          id: queueEntry.id,
          userId: queueEntry.userId,
          status: queueEntry.status,
          joinedAt: queueEntry.joinedAt,
          promotedAt: queueEntry.promotedAt,
        },
        position,
      };
    },
    {
      isolationLevel: 'ReadCommitted',
      timeout: 10000,
    }
  );
}

// POST /buy and POST /api/buy endpoint handler
buyRouter.post('/buy', async (req: Request, res: Response) => {
  try {
    const rawUserId = req.body?.userId || req.headers['x-user-id'];

    if (!rawUserId || typeof rawUserId !== 'string' || !rawUserId.trim()) {
      return res.status(400).json({
        error: 'userId is required in request body or X-User-Id header',
      });
    }

    const userId = rawUserId.trim();
    const customDuration = req.body?.durationSeconds || (req.query.durationSeconds ? parseInt(req.query.durationSeconds as string, 10) : undefined);
    const result = await executeBuyTransaction(userId, customDuration);

    if (result.status === 'held') {
      try {
        const delayMs = customDuration ? customDuration * 1000 : undefined;
        await scheduleHoldExpiration(result.hold.id, result.hold.userId, delayMs);
      } catch (qErr) {
        console.error(`Failed to schedule BullMQ expiration for hold ${result.hold.id}:`, qErr);
      }
    }

    return res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    console.error('Error executing buy transaction:', error);
    return res.status(500).json({
      error: 'Failed to process buy request',
      details: error?.message || 'Internal server error',
    });
  }
});
