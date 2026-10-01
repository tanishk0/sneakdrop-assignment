FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

# Copy root and client package files
COPY package*.json ./
RUN npm ci

COPY client/package*.json ./client/
RUN npm --prefix client ci

# Copy client source and build
COPY client ./client
RUN npm --prefix client run build

# Copy server configuration and schema
COPY tsconfig.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

# Runner image
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/src ./src
COPY tsconfig.json ./

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && npx tsx prisma/seed.ts && npx tsx src/index.ts"]
