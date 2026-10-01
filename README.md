# Sneaker Drop

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

