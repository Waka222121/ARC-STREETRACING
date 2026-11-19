# Multi-stage production Dockerfile for Google Cloud Run
# Serves Express REST API (/api/*), authoritative 60 Hz WebSocket server (/ws), and built Vite SPA (dist/) on $PORT

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.ts tsconfig.json ./
COPY src ./src
COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["./node_modules/.bin/tsx", "server.ts"]
