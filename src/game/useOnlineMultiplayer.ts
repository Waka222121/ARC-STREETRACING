import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthoritativeWalletSnapshot,
  ClientToServerMessage,
  MatchFinishedPayload,
  MatchStartPayload,
  SerializedRacerState,
  SerializedRoomState,
  ServerToClientMessage,
} from '../shared/multiplayerProtocol';

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface OnlineMatchTickEvent {
  roomCode: string;
  serverTick: number;
  elapsedMs: number;
  racers: SerializedRacerState[];
}

export interface OnlineEliminationEvent {
  roomCode: string;
  playerId: string;
  laneIndex: 0 | 1 | 2 | 3;
  z: number;
  survivalTimeMs: number;
}

export interface UseOnlineMultiplayerOptions {
  walletAddress: string;
  displayName: string;
  preferredColor: string;
  onWalletSync?: (wallet: AuthoritativeWalletSnapshot, notice?: string) => void;
  onMatchStart?: (payload: MatchStartPayload) => void;
  onMatchTick?: (tick: OnlineMatchTickEvent) => void;
  onMatchEliminated?: (ev: OnlineEliminationEvent) => void;
  onMatchFinished?: (payload: MatchFinishedPayload) => void;
}

export interface OnlineMultiplayerApi {
  connectionStatus: WsConnectionStatus;
  playerId: string | null;
  roomState: SerializedRoomState | null;
  lastError: string | null;
  lastNotice: string | null;
  pingMs: number;
  clearError: () => void;
  quickMatch: (stakeTierUsdc: string) => void;
  createRoom: (stakeTierUsdc: string) => void;
  joinRoom: (roomCode: string) => void;
  leaveRoom: () => void;
  selectColor: (paintColor: string) => void;
  setStakeTier: (stakeTierUsdc: string) => void;
  lockStake: () => void;
  unlockStake: () => void;
  updateProfile: (displayName: string) => void;
  requestFaucet: () => void;
  sendLaneHop: (targetLaneIndex: 0 | 1 | 2 | 3) => void;
}

function getWebSocketUrl(): string {
  const rawEnvUrl = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_WS_URL?.trim();
  if (rawEnvUrl) {
    let normalized = rawEnvUrl.replace(/\/+$/, '');
    if (normalized.startsWith('https://')) {
      normalized = `wss://${normalized.slice('https://'.length)}`;
    } else if (normalized.startsWith('http://')) {
      normalized = `ws://${normalized.slice('http://'.length)}`;
    } else if (!normalized.startsWith('wss://') && !normalized.startsWith('ws://')) {
      normalized = `wss://${normalized}`;
    }
    if (!normalized.endsWith('/ws')) {
      normalized = `${normalized}/ws`;
    }
    return normalized;
  }
  if (typeof window === 'undefined') return 'ws://localhost:3000/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useOnlineMultiplayer(
  options: UseOnlineMultiplayerOptions,
): OnlineMultiplayerApi {
  const [connectionStatus, setConnectionStatus] =
    useState<WsConnectionStatus>('connecting');
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<SerializedRoomState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastNotice, setLastNotice] = useState<string | null>(null);
  const [pingMs, setPingMs] = useState<number>(12);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingQueueRef = useRef<ClientToServerMessage[]>([]);
  const clientSeqRef = useRef<number>(0);

  const walletAddressRef = useRef(options.walletAddress);
  const displayNameRef = useRef(options.displayName);
  const preferredColorRef = useRef(options.preferredColor);
  const callbacksRef = useRef(options);

  useEffect(() => {
    walletAddressRef.current = options.walletAddress;
    displayNameRef.current = options.displayName;
    preferredColorRef.current = options.preferredColor;
    callbacksRef.current = options;
  }, [options]);

  const sendMessage = useCallback((msg: ClientToServerMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      pendingQueueRef.current.push(msg);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let pingInterval: number | null = null;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(getWebSocketUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        setConnectionStatus('connected');
        const hello: ClientToServerMessage = {
          type: 'auth:hello',
          clientId: `cli_${Date.now()}`,
          walletAddress: walletAddressRef.current,
          displayName: displayNameRef.current,
          preferredColor: preferredColorRef.current,
        };
        ws.send(JSON.stringify(hello));

        while (pendingQueueRef.current.length > 0) {
          const queued = pendingQueueRef.current.shift();
          if (queued) {
            ws.send(JSON.stringify(queued));
          }
        }

        pingInterval = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', sentAtMs: Date.now() }));
          }
        }, 5000);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerToClientMessage;
          switch (msg.type) {
            case 'auth:welcome':
              setPlayerId(msg.playerId);
              callbacksRef.current.onWalletSync?.(msg.wallet);
              break;
            case 'wallet:state':
              callbacksRef.current.onWalletSync?.(msg.wallet, msg.notice);
              if (msg.notice) setLastNotice(msg.notice);
              break;
            case 'room:state':
              setRoomState(msg.room);
              setLastError(null);
              if (msg.notice) setLastNotice(msg.notice);
              break;
            case 'room:error':
              setLastError(msg.message);
              break;
            case 'match:start':
              setLastError(null);
              callbacksRef.current.onMatchStart?.(msg.payload);
              break;
            case 'match:tick':
              callbacksRef.current.onMatchTick?.({
                roomCode: msg.roomCode,
                serverTick: msg.serverTick,
                elapsedMs: msg.elapsedMs,
                racers: msg.racers,
              });
              break;
            case 'match:eliminated':
              callbacksRef.current.onMatchEliminated?.({
                roomCode: msg.roomCode,
                playerId: msg.playerId,
                laneIndex: msg.laneIndex,
                z: msg.z,
                survivalTimeMs: msg.survivalTimeMs,
              });
              break;
            case 'match:finished':
              callbacksRef.current.onMatchFinished?.(msg.payload);
              break;
            case 'pong':
              setPingMs(Math.max(1, Math.round((Date.now() - msg.sentAtMs) * 0.5)));
              break;
          }
        } catch {
          // Ignore invalid payloads
        }
      };

      ws.onclose = () => {
        if (pingInterval !== null) {
          window.clearInterval(pingInterval);
          pingInterval = null;
        }
        if (disposed) return;
        setConnectionStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingInterval !== null) window.clearInterval(pingInterval);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  const quickMatch = useCallback(
    (stakeTierUsdc: string) => {
      setLastError(null);
      sendMessage({ type: 'room:quick_match', stakeTierUsdc });
    },
    [sendMessage],
  );

  const createRoom = useCallback(
    (stakeTierUsdc: string) => {
      setLastError(null);
      sendMessage({ type: 'room:create', stakeTierUsdc });
    },
    [sendMessage],
  );

  const joinRoom = useCallback(
    (roomCode: string) => {
      setLastError(null);
      sendMessage({ type: 'room:join', roomCode });
    },
    [sendMessage],
  );

  const leaveRoom = useCallback(() => {
    setLastError(null);
    sendMessage({ type: 'room:leave' });
  }, [sendMessage]);

  const selectColor = useCallback(
    (paintColor: string) => {
      setLastError(null);
      sendMessage({ type: 'room:select_color', paintColor });
    },
    [sendMessage],
  );

  const setStakeTier = useCallback(
    (stakeTierUsdc: string) => {
      sendMessage({ type: 'room:set_stake_tier', stakeTierUsdc });
    },
    [sendMessage],
  );

  const lockStake = useCallback(() => {
    setLastError(null);
    sendMessage({ type: 'room:lock_stake' });
  }, [sendMessage]);

  const unlockStake = useCallback(() => {
    setLastError(null);
    sendMessage({ type: 'room:unlock_stake' });
  }, [sendMessage]);

  const updateProfile = useCallback(
    (displayName: string) => {
      sendMessage({ type: 'profile:update', displayName });
    },
    [sendMessage],
  );

  const requestFaucet = useCallback(() => {
    sendMessage({ type: 'wallet:faucet' });
  }, [sendMessage]);

  const sendLaneHop = useCallback(
    (targetLaneIndex: 0 | 1 | 2 | 3) => {
      clientSeqRef.current += 1;
      sendMessage({
        type: 'input:lane_hop',
        targetLaneIndex,
        clientSeq: clientSeqRef.current,
      });
    },
    [sendMessage],
  );

  return {
    connectionStatus,
    playerId,
    roomState,
    lastError,
    lastNotice,
    pingMs,
    clearError,
    quickMatch,
    createRoom,
    joinRoom,
    leaveRoom,
    selectColor,
    setStakeTier,
    lockStake,
    unlockStake,
    updateProfile,
    requestFaucet,
    sendLaneHop,
  };
}
