import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { buyRouter } from './routes/buy.js';
import { statusRouter } from './routes/status.js';
import { paymentRouter } from './routes/payment.js';
import { startHoldWorker } from './workers/holdWorker.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Mount API routes (support both /api/path and /path)
app.use('/api', buyRouter);
app.use(buyRouter);

app.use('/api', statusRouter);
app.use(statusRouter);

app.use('/api', paymentRouter);
app.use(paymentRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sneaker-drop',
  });
});

// Serve static frontend build
const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

// Fallback to client index.html for SPA routing
app.use((_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Start BullMQ Background Worker
const holdWorker = startHoldWorker();

const server = app.listen(port, () => {
  console.log(`Sneaker Drop server running on http://localhost:${port}`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    await holdWorker.stop();
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
