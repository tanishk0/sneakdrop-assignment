# Sneaker Drop — System Implementation Notes

## Requirements
* **Docker & Docker Compose** (Recommended for 1-command startup)
  * Docker Desktop version 24+
* *Or for manual local running:*
  * Node.js (v20+ LTS)
  * PostgreSQL (v16+)
  * Redis (v7+)

---

## How to Run with Docker (Recommended)

1. Make sure Docker is running on your system.
2. In the project root directory, run:
   ```bash
   docker compose up --build
   ```
3. Open your browser at:
   ```text
   http://localhost:3000
   ```
4. To stop the containers:
   ```bash
   docker compose down
   ```

---

## How to Run Locally (Manual Setup)

1. **Install root and client dependencies**:
   ```bash
   npm install
   npm --prefix client install
   ```

2. **Configure environment**:
   Copy `.env.example` to `.env` and configure your database and Redis ports if needed:
   ```env
   PORT=3000
   DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5434/sneakerdrop?schema=public
   REDIS_HOST=localhost
   REDIS_PORT=6379
   HOLD_DURATION_SECONDS=300
   ```

3. **Initialize Database schema and seed initial data**:
   ```bash
   npm run prisma:push
   npm run prisma:seed
   ```

4. **Start the application**:
   ```bash
   npm start
   ```
   Or for live reloading dev mode:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` (or `http://localhost:5173` for Vite HMR dev server).

---

## Automated Test Suites

We have built dedicated automated test scripts that verify every core requirement and edge case:

### 1. High-Concurrency Stress Test (100 Simultaneous Requests)
Proves that exactly 20 pairs are held, 80 users are queued, and stock **never** oversells or goes below 0:
```bash
npm run test:concurrency
```

### 2. BullMQ Hold Expiration & Waitlist Promotion Lifecycle
Simulates accelerated holds, verifies auto-expiration, auto-promotion of waitlist candidates in FIFO order, and restocking on empty queues:
```bash
npx tsx scripts/test-worker.ts
```

### 3. Payment Webhook & Idempotency Test
Verifies that duplicate webhook transmissions (e.g. `payment_success_123` sent 3 times) result in exactly 1 purchase, and late payments after hold expiry are automatically refunded:
```bash
npx tsx scripts/test-payment.ts
```

---

## Architecture & Edge Case Solutions

### 1. Zero-Oversell Concurrency (`POST /buy`)
* **Problem**: 1,000s of users clicking "Buy" at the exact same millisecond causes read-modify-write race conditions that oversold 51 pairs in the previous sale.
* **Solution**: `SELECT id, "totalStock", "availableStock" FROM inventory WHERE id = 1 FOR UPDATE`.
* Row-level pessimistic locking serializes all concurrent buy requests at the database level. Stock is atomically decremented only if `availableStock > 0`. If 0, the user is immediately appended to `QueueEntry` with a sequential line position.

### 2. User Limits Enforcement
* **Rule 1**: *Only 1 active hold at a time.* Evaluated atomically under transaction lock. If user has an active, unexpired hold, request is rejected with `400 Bad Request`.
* **Rule 2**: *Maximum 2 pairs purchased in total.* Purchase count is verified before granting holds or completing purchases.

### 3. Hold Expiration & Waitlist Promotion (BullMQ + Redis)
* When a hold is created, a delayed BullMQ job is enqueued for 5 minutes (`300s`).
* When the job fires:
  1. If hold was already paid (`PURCHASED`), the worker skips.
  2. If hold is still `ACTIVE`, it is transitioned to `EXPIRED`.
  3. The worker queries `QueueEntry` for the earliest waiting user (`joinedAt ASC`).
  4. If a waiting user exists, they are automatically promoted to an `ACTIVE` hold with their own 5-minute timer, and a new BullMQ delayed job is scheduled.
  5. If the queue is empty, the sneaker returns to `availableStock` (`increment: 1`).
* A safety net sweep runs periodically every 5 seconds to catch any stale holds in case of unexpected restarts.

### 4. Fake Payment Webhook & Idempotency (`POST /payment/webhook`)
* **Duplicate Webhooks (Idempotency)**:
  * Unique constraints on `Payment.id`, `Purchase.paymentId`, and `Purchase.holdId`.
  * If the payment gateway sends the same `paymentId` multiple times, the service returns `200 OK` with `{ isIdempotentDuplicate: true }` and creates **no duplicate purchase**.
* **Late Payments After Expiration**:
  * If a payment arrives after the user's 5-minute hold expired (and the pair was given to the waitlist or restocked), the system **never** sells an unreserved shoe.
  * The payment is recorded with status `REFUNDED` and a simulated refund confirmation is issued.
