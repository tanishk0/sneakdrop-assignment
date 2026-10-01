import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { cancelHoldExpiration } from '../queues/holdQueue.js';

export const paymentRouter = Router();

export interface PaymentWebhookPayload {
  paymentId: string;
  holdId: string;
  userId?: string;
  amount?: number;
  eventType?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentProcessResult {
  isIdempotentDuplicate: boolean;
  status: 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'IGNORED';
  message: string;
  paymentId: string;
  purchaseId?: string | null;
  holdId?: string;
  userId?: string;
  refundReason?: string;
}

/**
 * Core transactional payment processor:
 * 1. Validates payload
 * 2. Idempotency Check:
 *    If Payment.id already processed -> return 200 immediately, do not duplicate Purchase.
 * 3. Inside transaction:
 *    - Re-check Payment.id against concurrent duplicate race
 *    - Find the Hold:
 *      - If Hold is still ACTIVE (and unexpired):
 *          Mark Hold as PURCHASED -> Create Payment -> Create Purchase
 *      - If Hold is NOT active (e.g. EXPIRED, reallocated to waitlist):
 *          Mark Payment as REFUNDED -> Do NOT create Purchase -> Return refund note
 */
export async function processPaymentWebhook(
  payload: PaymentWebhookPayload
): Promise<PaymentProcessResult> {
  const { paymentId, holdId } = payload;
  const amount = payload.amount ?? 150.0;

  // 1. Fast Idempotency Check (Outside transaction for speed)
  const existingPayment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { purchase: true },
  });

  if (existingPayment) {
    return {
      isIdempotentDuplicate: true,
      status: existingPayment.status as 'SUCCESS' | 'REFUNDED' | 'FAILED',
      message: 'Payment already processed (idempotent response).',
      paymentId: existingPayment.id,
      purchaseId: existingPayment.purchase?.id || null,
      holdId: existingPayment.holdId,
      userId: existingPayment.userId,
    };
  }

  // 2. Atomic processing inside PostgreSQL transaction
  const result = await prisma.$transaction(
    async (tx) => {
      // Re-check inside transaction to lock out concurrent duplicate webhooks
      const concurrentCheck = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { purchase: true },
      });

      if (concurrentCheck) {
        return {
          isIdempotentDuplicate: true,
          status: concurrentCheck.status as 'SUCCESS' | 'REFUNDED' | 'FAILED',
          message: 'Payment already processed (idempotent race caught).',
          paymentId: concurrentCheck.id,
          purchaseId: concurrentCheck.purchase?.id || null,
          holdId: concurrentCheck.holdId,
          userId: concurrentCheck.userId,
        };
      }

      // Find the Hold
      const hold = await tx.hold.findUnique({
        where: { id: holdId },
      });

      if (!hold) {
        // Hold does not exist at all -> Record as REFUNDED
        const payment = await tx.payment.create({
          data: {
            id: paymentId,
            userId: payload.userId || 'unknown',
            holdId,
            amount,
            status: 'REFUNDED',
            idempotencyKey: paymentId,
            rawPayload: JSON.stringify({
              ...payload,
              reason: 'Hold does not exist',
            }),
          },
        });

        return {
          isIdempotentDuplicate: false,
          status: 'REFUNDED' as const,
          message: 'Hold not found. Transaction marked as REFUNDED.',
          paymentId: payment.id,
          holdId,
        };
      }

      // Check if Hold is still ACTIVE and unexpired
      const isHoldActive =
        hold.status === 'ACTIVE' && hold.expiresAt.getTime() > Date.now();

      // CASE: Late Payment or Hold Expired/Reallocated
      if (!isHoldActive) {
        const reason =
          hold.status === 'EXPIRED'
            ? 'Hold expired prior to payment arrival. Sneaker returned to stock or reassigned to waitlist.'
            : `Hold is no longer ACTIVE (current status: ${hold.status}).`;

        const payment = await tx.payment.create({
          data: {
            id: paymentId,
            userId: hold.userId,
            holdId: hold.id,
            amount,
            status: 'REFUNDED',
            idempotencyKey: paymentId,
            rawPayload: JSON.stringify({
              ...payload,
              refundReason: reason,
              holdStatus: hold.status,
              holdExpiresAt: hold.expiresAt,
            }),
          },
        });

        return {
          isIdempotentDuplicate: false,
          status: 'REFUNDED' as const,
          message: `Late payment received: ${reason} Simulated refund issued.`,
          paymentId: payment.id,
          holdId: hold.id,
          userId: hold.userId,
          refundReason: reason,
        };
      }

      // Check user purchase limit: Maximum 2 pairs in total
      const totalPurchases = await tx.purchase.count({
        where: { userId: hold.userId },
      });

      if (totalPurchases >= 2) {
        const reason = 'User exceeded maximum purchase limit of 2 pairs.';
        const payment = await tx.payment.create({
          data: {
            id: paymentId,
            userId: hold.userId,
            holdId: hold.id,
            amount,
            status: 'REFUNDED',
            idempotencyKey: paymentId,
            rawPayload: JSON.stringify({
              ...payload,
              refundReason: reason,
            }),
          },
        });

        return {
          isIdempotentDuplicate: false,
          status: 'REFUNDED' as const,
          message: `${reason} Transaction refunded.`,
          paymentId: payment.id,
          holdId: hold.id,
          userId: hold.userId,
          refundReason: reason,
        };
      }

      // SUCCESS PATH:
      // 1. Mark Hold as PURCHASED
      await tx.hold.update({
        where: { id: hold.id },
        data: { status: 'PURCHASED' },
      });

      // 2. Create Payment entry
      const payment = await tx.payment.create({
        data: {
          id: paymentId,
          userId: hold.userId,
          holdId: hold.id,
          amount,
          status: 'SUCCESS',
          idempotencyKey: paymentId,
          rawPayload: JSON.stringify(payload),
        },
      });

      // 3. Create Purchase record
      const purchase = await tx.purchase.create({
        data: {
          userId: hold.userId,
          holdId: hold.id,
          paymentId: payment.id,
          amount,
        },
      });

      return {
        isIdempotentDuplicate: false,
        status: 'SUCCESS' as const,
        message: 'Payment verified and purchase successfully recorded!',
        paymentId: payment.id,
        purchaseId: purchase.id,
        holdId: hold.id,
        userId: hold.userId,
      };
    },
    {
      isolationLevel: 'ReadCommitted',
      timeout: 10000,
    }
  );

  // If successfully purchased, cancel the pending BullMQ expiration timer
  if (result.status === 'SUCCESS' && result.holdId) {
    await cancelHoldExpiration(result.holdId);
  }

  return result;
}

// POST /payment/webhook handler (also supports /payments/webhook)
async function webhookHandler(req: Request, res: Response) {
  try {
    const { paymentId, holdId } = req.body;

    if (!paymentId || typeof paymentId !== 'string' || !paymentId.trim()) {
      return res.status(400).json({
        error: 'paymentId is required',
      });
    }

    if (!holdId || typeof holdId !== 'string' || !holdId.trim()) {
      return res.status(400).json({
        error: 'holdId is required',
      });
    }

    const payload: PaymentWebhookPayload = {
      paymentId: paymentId.trim(),
      holdId: holdId.trim(),
      userId: req.body.userId?.trim(),
      amount: typeof req.body.amount === 'number' ? req.body.amount : 150.0,
      eventType: req.body.eventType || req.body.event || 'payment_succeeded',
      status: req.body.status || 'SUCCESS',
      metadata: req.body.metadata,
    };

    const result = await processPaymentWebhook(payload);

    // Always respond with 200 OK to payment webhooks to acknowledge receipt
    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Error processing payment webhook:', error);
    return res.status(500).json({
      error: 'Internal error processing payment webhook',
      details: error?.message,
    });
  }
}

paymentRouter.post('/payment/webhook', webhookHandler);
paymentRouter.post('/payments/webhook', webhookHandler);

// Helper endpoint for the frontend or test scripts to trigger a fake payment
paymentRouter.post('/payment/simulate', async (req: Request, res: Response) => {
  try {
    const { holdId, userId, paymentId, isLate } = req.body;

    if (!holdId) {
      return res.status(400).json({ error: 'holdId is required' });
    }

    const simPaymentId =
      paymentId || `pay_sim_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // If simulating late payment, we don't change timestamps here,
    // the webhook handler itself inspects hold.status and hold.expiresAt
    const payload: PaymentWebhookPayload = {
      paymentId: simPaymentId,
      holdId,
      userId,
      amount: 150.0,
      eventType: 'payment_succeeded',
    };

    const result = await processPaymentWebhook(payload);
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
