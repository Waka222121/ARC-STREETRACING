import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { ARC_TESTNET_CHAIN_ID, ORION_HUB_V2_ADDRESS } from './src/onchain-facts';
import { ArcEscrowLedger } from './src/server/arcEscrowLedger';
import { MultiplayerRoomManager } from './src/server/multiplayerRoomManager';
import {
  ClientToServerMessage,
  ServerToClientMessage,
} from './src/shared/multiplayerProtocol';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Optional comma-separated allowed origins for Vercel + Cloud Run hybrid deployments
// Examples: "https://my-game.vercel.app,https://*.vercel.app" or "*" (default)
const RAW_CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').trim();
const ALLOWED_ORIGIN_PATTERNS = RAW_CORS_ORIGINS.split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGIN_PATTERNS.length === 0 || ALLOWED_ORIGIN_PATTERNS.includes('*')) {
    return true;
  }
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => {
    if (pattern === origin) return true;
    if (pattern.includes('*')) {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]+');
      return new RegExp(`^${escaped}$`).test(origin);
    }
    return false;
  });
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  // CORS headers for cross-origin Vercel frontend -> Cloud Run /api/* requests
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        ALLOWED_ORIGIN_PATTERNS.includes('*') ? '*' : origin,
      );
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const ledger = new ArcEscrowLedger();
  const roomManager = new MultiplayerRoomManager(ledger);

  // REST API: Health & Server Telemetry
  app.get('/api/health', (_req, res) => {
    const stats = roomManager.getStats();
    res.json({
      ok: true,
      mode: IS_PRODUCTION ? 'production' : 'development',
      chainId: ARC_TESTNET_CHAIN_ID,
      orionHubV2: ORION_HUB_V2_ADDRESS,
      ...stats,
      timestampMs: Date.now(),
    });
  });

  // REST API: Authoritative Arc Testnet Wallet Balance
  app.get('/api/wallet/:address', (req, res) => {
    const snapshot = ledger.getWalletSnapshot(req.params.address);
    res.json({ ok: true, wallet: snapshot });
  });

  // REST API: Authoritative +50 USDC Testnet Faucet
  app.post('/api/faucet', (req, res) => {
    const address =
      typeof req.body?.walletAddress === 'string' ? req.body.walletAddress : '';
    if (!address) {
      res.status(400).json({ ok: false, error: 'Missing walletAddress' });
      return;
    }
    const result = ledger.requestFaucet(address);
    if (!result.ok) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  });

  const server = http.createServer(app);

  // Authoritative WebSocket Server on /ws (same single port as HTTP)
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ origin }, done) => {
      if (isOriginAllowed(origin)) {
        done(true);
      } else {
        done(false, 403, 'Origin not allowed');
      }
    },
  });
  const aliveSockets = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws: WebSocket) => {
    const playerId = `plr_${crypto.randomBytes(6).toString('hex')}`;
    let registered = false;
    aliveSockets.set(ws, true);

    ws.on('pong', () => {
      aliveSockets.set(ws, true);
    });

    const sendSafe = (msg: ServerToClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on('message', (raw) => {
      aliveSockets.set(ws, true);
      try {
        const parsed = JSON.parse(raw.toString()) as ClientToServerMessage;
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;

        if (!registered) {
          if (parsed.type === 'auth:hello') {
            roomManager.registerClient(
              playerId,
              parsed.walletAddress,
              parsed.displayName,
              parsed.preferredColor,
              sendSafe,
            );
            registered = true;
            return;
          }
          // Auto-register fallback if a message arrives before auth:hello
          roomManager.registerClient(
            playerId,
            playerId,
            'RACER',
            '#2563eb',
            sendSafe,
          );
          registered = true;
        }

        roomManager.handleMessage(playerId, parsed, Date.now());
      } catch {
        // Ignore malformed JSON frames
      }
    });

    ws.on('close', () => {
      if (registered) {
        roomManager.handleDisconnect(playerId, Date.now());
      }
    });

    ws.on('error', () => {
      if (registered) {
        roomManager.handleDisconnect(playerId, Date.now());
      }
    });
  });

  // Cloud Run / Load Balancer WebSocket keepalive heartbeat (25s)
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (aliveSockets.get(client) === false) {
        client.terminate();
        continue;
      }
      aliveSockets.set(client, false);
      client.ping();
    }
  }, 25_000);

  // Fixed 60 Hz Authoritative Simulation & Escrow Timeout Loop
  const TICK_MS = 1000 / 60;
  let lastTickMs = Date.now();
  const simInterval = setInterval(() => {
    const nowMs = Date.now();
    const dt = Math.min(0.05, Math.max(0.005, (nowMs - lastTickMs) / 1000));
    lastTickMs = nowMs;
    roomManager.stepAllRooms(dt, nowMs);
  }, TICK_MS);

  // Frontend Delivery: Vite middleware in development, static dist/ in production
  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(rootDir, 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      }),
    );
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if (
        (req.method !== 'GET' && req.method !== 'HEAD') ||
        req.path.startsWith('/api/') ||
        req.path.startsWith('/ws')
      ) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ARC STREETRACING] Received ${signal}, shutting down gracefully...`);
    clearInterval(simInterval);
    clearInterval(heartbeatInterval);
    for (const client of wss.clients) {
      client.close(1001, 'Server restarting');
    }
    wss.close(() => {
      server.close(() => {
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.on('close', () => {
    clearInterval(simInterval);
    clearInterval(heartbeatInterval);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[ARC STREETRACING] Authoritative server listening on http://0.0.0.0:${PORT} (WebSocket /ws, mode=${IS_PRODUCTION ? 'production' : 'development'})`,
    );
  });
}

startServer().catch((err) => {
  console.error('[ARC STREETRACING] Fatal server startup error:', err);
  process.exit(1);
});
