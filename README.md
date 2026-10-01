# Sneaker Drop

A small shoe brand is launching one limited sneaker. They only have 20 pairs. When the sale opens, thousands of people will click Buy at the same second.

Last time, their website sold 51 pairs when they only had 20, and they had to refund 31 people. Your job is to build the full system for the next sale so this never happens again.

## The rules

1. When a user clicks Buy, one pair is held for them for 5 minutes. If they don't pay in time, the pair goes back to stock.
2. A user can hold only 1 pair at a time, and can buy a maximum of 2 pairs in total.
3. If stock is 0, users can join a waiting line. When someone's hold runs out, the first person in line automatically gets that pair, with their own 5 minutes.
4. Payments are fake. You don't need to build a real payment system, just make your own simple fake one that sends your app a "payment succeeded" message, like a real payment company would. Real ones are messy, so sometimes the message comes late, sometimes twice, sometimes in the wrong order.
5. One page shows the pairs left, the user's hold countdown, and their place in the waiting line. It doesn't need to look good, plain text is fine.

Use any language or tools you are comfortable with.

---

## How to Run Tests

Ensure the application is running (e.g. `docker compose up --build` or `npm run dev`), then execute any of the automated test suites:

### 1. High-Concurrency Stress Test (100 Simultaneous Requests)
Simulates 100 users clicking "Buy" at the exact same millisecond. Verifies that exactly 20 pairs are held, 80 users are queued, and stock **never** oversells:
```bash
npm run test:concurrency
```

### 2. Hold Expiration & Waitlist Queue Promotion Test
Verifies 5-minute hold auto-expiration, FIFO waitlist promotion, and inventory restocking:
```bash
npm run test:worker
```
*(or `npx tsx scripts/test-worker.ts`)*

### 3. Payment Webhook & Idempotency Test
Verifies duplicate webhook transmissions (idempotency) and auto-refund of late payments after hold expiry:
```bash
npm run test:payment
```
*(or `npx tsx scripts/test-payment.ts`)*

---

## What you send back

1. Your code (repo or zip)
2. A NOTES.md file that tells how to run the project, and any other requirements that are needed
3. A screen recording (Loom or any tool you like) where you explain your project

Please fork this repo and build your project in your fork.
