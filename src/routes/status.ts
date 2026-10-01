import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { holdExpirationQueue } from '../queues/holdQueue.js';

export const statusRouter = Router();

statusRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const rawUserId = (req.query.userId as string) || (req.headers['x-user-id'] as string);
    const userId = rawUserId?.trim();

    // 1. Get current inventory
    const inventory = await prisma.inventory.findUnique({
      where: { id: 1 },
    });

    const activeHoldsTotal = await prisma.hold.count({
      where: {
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
    });

    const totalSold = await prisma.purchase.count();
    const waitingQueueTotal = await prisma.queueEntry.count({
      where: { status: 'WAITING' },
    });

    let userState: {
      userId: string;
      activeHold: {
        id: string;
        expiresAt: Date;
        secondsRemaining: number;
      } | null;
      queueEntry: {
        id: string;
        joinedAt: Date;
        position: number;
      } | null;
      purchasesCount: number;
      canHold: boolean;
      canPurchase: boolean;
    } | null = null;

    if (userId) {
      // User's active hold
      const userHold = await prisma.hold.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      const userPurchases = await prisma.purchase.count({
        where: { userId },
      });

      let userQueue = null;
      if (!userHold) {
        const queueEntry = await prisma.queueEntry.findFirst({
          where: {
            userId,
            status: 'WAITING',
          },
          orderBy: { joinedAt: 'asc' },
        });

        if (queueEntry) {
          const position = await prisma.queueEntry.count({
            where: {
              status: 'WAITING',
              joinedAt: { lte: queueEntry.joinedAt },
            },
          });

          userQueue = {
            id: queueEntry.id,
            joinedAt: queueEntry.joinedAt,
            position,
          };
        }
      }

      userState = {
        userId,
        activeHold: userHold
          ? {
              id: userHold.id,
              expiresAt: userHold.expiresAt,
              secondsRemaining: Math.max(
                0,
                Math.floor((userHold.expiresAt.getTime() - Date.now()) / 1000)
              ),
            }
          : null,
        queueEntry: userQueue,
        purchasesCount: userPurchases,
        canHold: !userHold && userPurchases < 2,
        canPurchase: userPurchases < 2,
      };
    }

    return res.status(200).json({
      inventory: {
        totalStock: inventory?.totalStock ?? 20,
        availableStock: inventory?.availableStock ?? 0,
        activeHoldsTotal,
        totalSold,
        waitingQueueTotal,
      },
      userState,
      serverTime: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error fetching drop status:', error);
    return res.status(500).json({
      error: 'Failed to retrieve drop status',
      details: error?.message,
    });
  }
});

/**
 * Reset drop state to test stock exhaustion, queues, and holds repeatedly:
 * - Resets inventory availableStock to 20
 * - Clears purchases, payments, holds, and queue entries
 * - Drains BullMQ queue
 */
statusRouter.post('/reset', async (_req: Request, res: Response) => {
  try {
    await prisma.purchase.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.queueEntry.deleteMany();

    await prisma.inventory.upsert({
      where: { id: 1 },
      update: { totalStock: 20, availableStock: 20 },
      create: { id: 1, totalStock: 20, availableStock: 20 },
    });

    try {
      await holdExpirationQueue.drain();
      await holdExpirationQueue.clean(0, 1000, 'delayed');
      await holdExpirationQueue.clean(0, 1000, 'waiting');
    } catch (qErr) {
      console.warn('Queue clean warning:', qErr);
    }

    return res.status(200).json({
      status: 'ok',
      message: 'Inventory reset to 20 pairs. All holds and queues cleared.',
    });
  } catch (error: any) {
    console.error('Error resetting drop:', error);
    return res.status(500).json({
      error: 'Failed to reset drop state',
      details: error?.message,
    });
  }
});
