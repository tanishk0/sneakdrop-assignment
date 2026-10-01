import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';

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
