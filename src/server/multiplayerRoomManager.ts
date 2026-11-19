import { Amount } from '../onchain-money';
import {
  computeProgressiveHighwayPace,
  createOnlineHumanRacers,
  evaluateFourPlayerSessionStatus,
  findNearestHighwayLaneIndex,
  HIGHWAY_WORLD_LANE_X,
  LOBBY_PAINT_SWATCHES,
  normalizePaintHex,
  resolveRacerCollisions,
  stepLaneHopKinematics,
  stepSingleRacerPhysics,
  syncFourPlayerHighwayPack,
} from '../game/physics';
import {
  checkRacerTrafficCollision,
  createInitialTraffic,
  stepTrafficVehicles,
  TrafficVehicle,
} from '../game/traffic';
import { DEFAULT_CAR_CONFIG } from '../game/tuning';
import { CarConfig, RacerState } from '../game/types';
import {
  ClientToServerMessage,
  EscrowRoomStatus,
  MatchFinishedPayload,
  MatchRankingEntry,
  MatchStartPayload,
  OnlineSlotStatus,
  RoomStatus,
  SerializedLobbySlot,
  SerializedRacerState,
  SerializedRoomState,
  ServerToClientMessage,
} from '../shared/multiplayerProtocol';
import {
  ArcEscrowLedger,
  normalizeWalletAddress,
} from './arcEscrowLedger';

export const LOBBY_ESCROW_TIMEOUT_MS = 60_000;
export const MATCH_COUNTDOWN_MS = 3_000;

export interface ConnectedClientSession {
  playerId: string;
  walletAddress: string;
  displayName: string;
  preferredColor: string;
  roomCode: string | null;
  pingMs: number;
  send: (msg: ServerToClientMessage) => void;
}

interface InternalRoomSlot {
  laneIndex: 0 | 1 | 2 | 3;
  slotCode: 'P1' | 'P2' | 'P3' | 'P4';
  playerId: string | null;
  displayName: string;
  walletAddress: string | null;
  paintColor: string;
  status: OnlineSlotStatus;
  stakeUsdc6: bigint;
  relayerRewardUsdc6: bigint;
  totalDebitUsdc6: bigint;
  connected: boolean;
  pingMs: number | null;
}

interface ActiveSimulationState {
  racers: RacerState[];
  racerWalletByPlayerId: Map<string, string>;
  racerLaneByPlayerId: Map<string, 0 | 1 | 2 | 3>;
  racerTargetLaneByPlayerId: Map<string, 0 | 1 | 2 | 3>;
  racerConnectedByPlayerId: Map<string, boolean>;
  traffic: TrafficVehicle[];
  elapsedSec: number;
  serverTick: number;
  potUsdc6: bigint;
  participantWallets: string[];
  escrowTxHash: string;
}

interface InternalRoom {
  roomCode: string;
  isPublicQuickMatch: boolean;
  status: RoomStatus;
  hostPlayerId: string | null;
  stakeTierUsdc: string;
  escrowExpiresAt: number | null;
  escrowStatus: EscrowRoomStatus;
  countdownEndsAt: number | null;
  trafficSeed: number;
  orionRound: number;
  orionRandomnessHash: string;
  slots: [
    InternalRoomSlot,
    InternalRoomSlot,
    InternalRoomSlot,
    InternalRoomSlot,
  ];
  simulation: ActiveSimulationState | null;
}

const SLOT_ORDER: readonly (0 | 1 | 2 | 3)[] = [1, 0, 2, 3];
const SLOT_CODES: Record<0 | 1 | 2 | 3, 'P1' | 'P2' | 'P3' | 'P4'> = {
  1: 'P1',
  0: 'P2',
  2: 'P3',
  3: 'P4',
};

function generateRoomCode(existing: Set<string>): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let p1 = '';
    let p2 = '';
    for (let i = 0; i < 3; i++) {
      p1 += chars[Math.floor(Math.random() * chars.length)];
      p2 += chars[Math.floor(Math.random() * chars.length)];
    }
    const code = `${p1}-${p2}`;
    if (!existing.has(code)) return code;
  }
  return `ARC-${Math.floor(100 + Math.random() * 899)}`;
}

export function normalizeRoomCode(raw: string): string {
  const cleaned = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (cleaned.length > 3) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
  }
  return cleaned;
}

export class MultiplayerRoomManager {
  readonly ledger: ArcEscrowLedger;
  private readonly lobbyEscrowTimeoutMs: number;
  private readonly countdownDurationMs: number;
  private readonly clients = new Map<string, ConnectedClientSession>();
  private readonly rooms = new Map<string, InternalRoom>();

  constructor(
    ledger: ArcEscrowLedger = new ArcEscrowLedger(),
    options?: {
      lobbyEscrowTimeoutMs?: number;
      countdownDurationMs?: number;
    },
  ) {
    this.ledger = ledger;
    this.lobbyEscrowTimeoutMs =
      options?.lobbyEscrowTimeoutMs ?? LOBBY_ESCROW_TIMEOUT_MS;
    this.countdownDurationMs =
      options?.countdownDurationMs ?? MATCH_COUNTDOWN_MS;
  }

  getStats(): { connectedClients: number; activeRooms: number; playingRooms: number } {
    let playingRooms = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'playing') playingRooms += 1;
    }
    return {
      connectedClients: this.clients.size,
      activeRooms: this.rooms.size,
      playingRooms,
    };
  }

  getRoomState(roomCode: string, nowMs = Date.now()): SerializedRoomState | null {
    const room = this.rooms.get(normalizeRoomCode(roomCode));
    return room ? this.serializeRoom(room, nowMs) : null;
  }

  registerClient(
    playerId: string,
    walletAddress: string,
    displayName: string,
    preferredColor: string,
    send: (msg: ServerToClientMessage) => void,
  ): ConnectedClientSession {
    const normalizedWallet = this.ledger.ensureWallet(walletAddress);
    const cleanName = (displayName || 'RACER').trim().slice(0, 16) || 'RACER';
    const session: ConnectedClientSession = {
      playerId,
      walletAddress: normalizedWallet,
      displayName: cleanName,
      preferredColor: normalizePaintHex(preferredColor),
      roomCode: null,
      pingMs: 12,
      send,
    };
    this.clients.set(playerId, session);
    session.send({
      type: 'auth:welcome',
      playerId,
      wallet: this.ledger.getWalletSnapshot(normalizedWallet),
    });
    return session;
  }

  handleMessage(
    playerId: string,
    msg: ClientToServerMessage,
    nowMs = Date.now(),
  ): void {
    const client = this.clients.get(playerId);
    if (!client) return;

    switch (msg.type) {
      case 'auth:hello': {
        client.walletAddress = this.ledger.ensureWallet(msg.walletAddress);
        client.displayName =
          (msg.displayName || client.displayName).trim().slice(0, 16) || 'RACER';
        client.preferredColor = normalizePaintHex(msg.preferredColor);
        client.send({
          type: 'auth:welcome',
          playerId: client.playerId,
          wallet: this.ledger.getWalletSnapshot(client.walletAddress),
        });
        break;
      }
      case 'profile:update': {
        const cleanName = (msg.displayName || '').trim().slice(0, 16);
        if (!cleanName) return;
        client.displayName = cleanName;
        if (client.roomCode) {
          const room = this.rooms.get(client.roomCode);
          if (room) {
            const slot = room.slots.find((s) => s.playerId === client.playerId);
            if (slot) {
              slot.displayName = cleanName;
              this.broadcastRoomState(room, nowMs);
            }
          }
        }
        break;
      }
      case 'wallet:faucet': {
        const res = this.ledger.requestFaucet(client.walletAddress);
        client.send({
          type: 'wallet:state',
          wallet: res.wallet,
          notice: res.ok ? '+50.00 Testnet USDC credited on server ledger' : res.error,
        });
        break;
      }
      case 'ping': {
        client.send({
          type: 'pong',
          sentAtMs: msg.sentAtMs,
          serverNowMs: nowMs,
        });
        break;
      }
      case 'room:quick_match': {
        this.handleQuickMatch(client, msg.stakeTierUsdc, nowMs);
        break;
      }
      case 'room:create': {
        this.handleCreateRoom(client, msg.stakeTierUsdc, nowMs);
        break;
      }
      case 'room:join': {
        this.handleJoinRoom(client, msg.roomCode, nowMs);
        break;
      }
      case 'room:leave': {
        this.handleLeaveRoom(client, nowMs);
        break;
      }
      case 'room:select_color': {
        this.handleSelectColor(client, msg.paintColor, nowMs);
        break;
      }
      case 'room:set_stake_tier': {
        this.handleSetStakeTier(client, msg.stakeTierUsdc, nowMs);
        break;
      }
      case 'room:lock_stake': {
        this.handleLockStake(client, nowMs);
        break;
      }
      case 'room:unlock_stake': {
        this.handleUnlockStake(client, nowMs);
        break;
      }
      case 'input:lane_hop': {
        this.handleLaneHopInput(client, msg.targetLaneIndex);
        break;
      }
    }
  }

  handleDisconnect(playerId: string, nowMs = Date.now()): void {
    const client = this.clients.get(playerId);
    if (!client) return;
    this.clients.delete(playerId);

    if (!client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;

    const slot = room.slots.find((s) => s.playerId === playerId);
    if (!slot) return;

    if (room.status === 'lobby') {
      // Pre-race disconnect: refund locked stake if staked and free slot + color
      if (slot.status === 'staked' && slot.walletAddress) {
        this.ledger.refundStake(slot.walletAddress, slot.totalDebitUsdc6);
      }
      this.clearSlot(slot);
      this.reassignHostIfNeeded(room);
      this.checkIfLobbyStillHasStakes(room);
      this.cleanupOrBroadcastRoom(room, nowMs, `${client.displayName} left the lobby`);
      return;
    }

    if (room.status === 'countdown' || room.status === 'playing') {
      // Mid-race disconnect policy (Author Requirement):
      // Locked stake remains in the active pot as committed funds ("расценивается как уже внесённые средства").
      // The player's car stays on its current lane without steering input until eliminated by traffic.
      slot.connected = false;
      if (room.simulation) {
        room.simulation.racerConnectedByPlayerId.set(playerId, false);
      }
      this.broadcastRoomState(
        room,
        nowMs,
        `${client.displayName} disconnected — stake remains locked in pot`,
      );
      return;
    }

    // Finished room cleanup
    this.clearSlot(slot);
    this.reassignHostIfNeeded(room);
    this.cleanupOrBroadcastRoom(room, nowMs);
  }

  private createEmptyRoom(
    roomCode: string,
    isPublicQuickMatch: boolean,
    stakeTierUsdc: string,
  ): InternalRoom {
    const defaultColors: Record<0 | 1 | 2 | 3, string> = {
      0: LOBBY_PAINT_SWATCHES[0].hex,
      1: LOBBY_PAINT_SWATCHES[1].hex,
      2: LOBBY_PAINT_SWATCHES[2].hex,
      3: LOBBY_PAINT_SWATCHES[3].hex,
    };
    const makeSlot = (laneIndex: 0 | 1 | 2 | 3): InternalRoomSlot => ({
      laneIndex,
      slotCode: SLOT_CODES[laneIndex],
      playerId: null,
      displayName: 'Open Slot',
      walletAddress: null,
      paintColor: defaultColors[laneIndex],
      status: 'waiting',
      stakeUsdc6: 0n,
      relayerRewardUsdc6: 0n,
      totalDebitUsdc6: 0n,
      connected: false,
      pingMs: null,
    });

    const seedInfo = this.ledger.generateOrionSeed(roomCode);
    const room: InternalRoom = {
      roomCode,
      isPublicQuickMatch,
      status: 'lobby',
      hostPlayerId: null,
      stakeTierUsdc: (stakeTierUsdc || '5').trim() || '5',
      escrowExpiresAt: null,
      escrowStatus: 'idle',
      countdownEndsAt: null,
      trafficSeed: seedInfo.trafficSeed,
      orionRound: seedInfo.orionRound,
      orionRandomnessHash: seedInfo.orionRandomnessHash,
      slots: [makeSlot(0), makeSlot(1), makeSlot(2), makeSlot(3)],
      simulation: null,
    };
    this.rooms.set(roomCode, room);
    return room;
  }

  private pickFirstAvailablePaintColor(
    room: InternalRoom,
    preferredHex: string,
    excludePlayerId?: string,
  ): string {
    const occupied = new Set<string>();
    for (const s of room.slots) {
      if (s.status !== 'waiting' && s.playerId !== excludePlayerId) {
        occupied.add(normalizePaintHex(s.paintColor));
      }
    }
    const pref = normalizePaintHex(preferredHex);
    if (!occupied.has(pref)) return pref;
    for (const sw of LOBBY_PAINT_SWATCHES) {
      const hex = sw.hex.toLowerCase();
      if (!occupied.has(hex)) return hex;
    }
    return pref;
  }

  private seatClientInRoom(
    client: ConnectedClientSession,
    room: InternalRoom,
    nowMs: number,
  ): boolean {
    // Already seated in this room?
    const existing = room.slots.find((s) => s.playerId === client.playerId);
    if (existing) {
      this.broadcastRoomState(room, nowMs);
      return true;
    }
    // Find first open slot following P1 (lane 1), P2 (lane 0), P3 (lane 2), P4 (lane 3)
    let openSlot: InternalRoomSlot | null = null;
    for (const laneIdx of SLOT_ORDER) {
      const candidate = room.slots[laneIdx];
      if (candidate.status === 'waiting') {
        openSlot = candidate;
        break;
      }
    }
    if (!openSlot) {
      client.send({
        type: 'room:error',
        code: 'ROOM_FULL',
        message: `Room ${room.roomCode} already has 4 live players`,
      });
      return false;
    }

    const assignedColor = this.pickFirstAvailablePaintColor(
      room,
      client.preferredColor,
      client.playerId,
    );
    openSlot.playerId = client.playerId;
    openSlot.displayName = client.displayName;
    openSlot.walletAddress = client.walletAddress;
    openSlot.paintColor = assignedColor;
    openSlot.status = 'connected';
    openSlot.stakeUsdc6 = 0n;
    openSlot.relayerRewardUsdc6 = 0n;
    openSlot.totalDebitUsdc6 = 0n;
    openSlot.connected = true;
    openSlot.pingMs = client.pingMs;

    client.roomCode = room.roomCode;
    client.preferredColor = assignedColor;
    if (!room.hostPlayerId) {
      room.hostPlayerId = client.playerId;
    }
    this.broadcastRoomState(room, nowMs);
    return true;
  }

  private handleQuickMatch(
    client: ConnectedClientSession,
    stakeTierUsdc: string,
    nowMs: number,
  ): void {
    const cleanStake = (stakeTierUsdc || '5').trim() || '5';
    const stakeCheck = this.ledger.computeRequiredLockUsdc6(cleanStake);
    if (!stakeCheck.ok) {
      client.send({
        type: 'room:error',
        code: 'INVALID_STAKE',
        message: stakeCheck.error ?? 'Invalid stake amount',
      });
      return;
    }

    // Leave any current room first (if in lobby or finished)
    if (client.roomCode) {
      const cur = this.rooms.get(client.roomCode);
      if (cur && (cur.status === 'countdown' || cur.status === 'playing')) {
        client.send({
          type: 'room:error',
          code: 'ALREADY_STARTED',
          message: 'Cannot switch rooms while a race is in progress',
        });
        return;
      }
      this.handleLeaveRoom(client, nowMs);
    }

    // Find an open public quick-match room in lobby with matching stake tier and < 4 players
    let targetRoom: InternalRoom | null = null;
    for (const room of this.rooms.values()) {
      if (!room.isPublicQuickMatch || room.status !== 'lobby') continue;
      if (room.stakeTierUsdc !== cleanStake) continue;
      const openCount = room.slots.filter((s) => s.status === 'waiting').length;
      if (openCount > 0) {
        targetRoom = room;
        break;
      }
    }

    if (!targetRoom) {
      const code = generateRoomCode(new Set(this.rooms.keys()));
      targetRoom = this.createEmptyRoom(code, true, cleanStake);
    }

    this.seatClientInRoom(client, targetRoom, nowMs);
  }

  private handleCreateRoom(
    client: ConnectedClientSession,
    stakeTierUsdc: string,
    nowMs: number,
  ): void {
    const cleanStake = (stakeTierUsdc || '5').trim() || '5';
    const stakeCheck = this.ledger.computeRequiredLockUsdc6(cleanStake);
    if (!stakeCheck.ok) {
      client.send({
        type: 'room:error',
        code: 'INVALID_STAKE',
        message: stakeCheck.error ?? 'Invalid stake amount',
      });
      return;
    }

    if (client.roomCode) {
      const cur = this.rooms.get(client.roomCode);
      if (cur && (cur.status === 'countdown' || cur.status === 'playing')) {
        client.send({
          type: 'room:error',
          code: 'ALREADY_STARTED',
          message: 'Cannot create a new room while a race is in progress',
        });
        return;
      }
      this.handleLeaveRoom(client, nowMs);
    }

    const code = generateRoomCode(new Set(this.rooms.keys()));
    const room = this.createEmptyRoom(code, false, cleanStake);
    this.seatClientInRoom(client, room, nowMs);
  }

  private handleJoinRoom(
    client: ConnectedClientSession,
    rawCode: string,
    nowMs: number,
  ): void {
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) {
      client.send({
        type: 'room:error',
        code: 'ROOM_NOT_FOUND',
        message: `Room #${code || rawCode} was not found`,
      });
      return;
    }
    if (room.status !== 'lobby') {
      client.send({
        type: 'room:error',
        code: 'ALREADY_STARTED',
        message: `Room #${code} has already started racing`,
      });
      return;
    }
    if (client.roomCode && client.roomCode !== code) {
      this.handleLeaveRoom(client, nowMs);
    }
    this.seatClientInRoom(client, room, nowMs);
  }

  private handleLeaveRoom(client: ConnectedClientSession, nowMs: number): void {
    if (!client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    client.roomCode = null;
    if (!room) {
      client.send({ type: 'room:state', room: null });
      return;
    }
    const slot = room.slots.find((s) => s.playerId === client.playerId);
    if (!slot) {
      client.send({ type: 'room:state', room: null });
      return;
    }

    if (room.status === 'lobby') {
      if (slot.status === 'staked' && slot.walletAddress) {
        const wallet = this.ledger.refundStake(
          slot.walletAddress,
          slot.totalDebitUsdc6,
        );
        client.send({
          type: 'wallet:state',
          wallet,
          notice: 'Pre-race locked stake refunded',
        });
      }
      this.clearSlot(slot);
      this.reassignHostIfNeeded(room);
      this.checkIfLobbyStillHasStakes(room);
      client.send({ type: 'room:state', room: null });
      this.cleanupOrBroadcastRoom(room, nowMs, `${client.displayName} left the room`);
      return;
    }

    if (room.status === 'countdown' || room.status === 'playing') {
      // Leaving mid-race keeps stake in pot as committed funds
      slot.connected = false;
      if (room.simulation) {
        room.simulation.racerConnectedByPlayerId.set(client.playerId, false);
      }
      client.send({
        type: 'room:state',
        room: null,
        notice: 'Left active race — committed stake remains in the match pot',
      });
      this.broadcastRoomState(room, nowMs);
      return;
    }

    this.clearSlot(slot);
    this.reassignHostIfNeeded(room);
    client.send({ type: 'room:state', room: null });
    this.cleanupOrBroadcastRoom(room, nowMs);
  }

  private handleSelectColor(
    client: ConnectedClientSession,
    rawHex: string,
    nowMs: number,
  ): void {
    if (!client.roomCode) {
      client.preferredColor = normalizePaintHex(rawHex);
      return;
    }
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'lobby') return;

    const mySlot = room.slots.find((s) => s.playerId === client.playerId);
    if (!mySlot) return;

    const targetColor = normalizePaintHex(rawHex);
    const holder = room.slots.find(
      (s) =>
        s.status !== 'waiting' &&
        s.playerId !== client.playerId &&
        normalizePaintHex(s.paintColor) === targetColor,
    );
    if (holder) {
      client.send({
        type: 'room:error',
        code: 'COLOR_OCCUPIED',
        message: `Color already occupied by ${holder.slotCode} (${holder.displayName})`,
      });
      client.send({
        type: 'room:state',
        room: this.serializeRoom(room, nowMs),
      });
      return;
    }

    mySlot.paintColor = targetColor;
    client.preferredColor = targetColor;
    this.broadcastRoomState(room, nowMs);
  }

  private handleSetStakeTier(
    client: ConnectedClientSession,
    stakeTierUsdc: string,
    nowMs: number,
  ): void {
    if (!client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'lobby') return;

    const anyStaked = room.slots.some((s) => s.status === 'staked');
    if (anyStaked) {
      client.send({
        type: 'room:error',
        code: 'ALREADY_STARTED',
        message: 'Stake tier cannot be changed after a player has locked funds',
      });
      return;
    }
    const clean = (stakeTierUsdc || '').trim();
    const check = this.ledger.computeRequiredLockUsdc6(clean);
    if (!check.ok) {
      client.send({
        type: 'room:error',
        code: 'INVALID_STAKE',
        message: check.error ?? 'Invalid stake amount',
      });
      return;
    }
    room.stakeTierUsdc = clean || '0';
    this.broadcastRoomState(room, nowMs);
  }

  private handleLockStake(client: ConnectedClientSession, nowMs: number): void {
    if (!client.roomCode) {
      client.send({
        type: 'room:error',
        code: 'NOT_IN_ROOM',
        message: 'Join or create a room before locking your stake',
      });
      return;
    }
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'lobby') return;

    const slot = room.slots.find((s) => s.playerId === client.playerId);
    if (!slot || slot.status === 'staked') return;

    const debit = this.ledger.debitStake(
      client.walletAddress,
      room.roomCode,
      room.stakeTierUsdc,
    );
    if (!debit.ok) {
      client.send({
        type: 'room:error',
        code: 'INSUFFICIENT_BALANCE',
        message: debit.error ?? 'Insufficient USDC balance',
      });
      return;
    }

    slot.status = 'staked';
    slot.stakeUsdc6 = debit.stakeUsdc6;
    slot.relayerRewardUsdc6 = debit.relayerRewardUsdc6;
    slot.totalDebitUsdc6 = debit.totalDebitUsdc6;

    client.send({
      type: 'wallet:state',
      wallet: debit.wallet,
    });

    if (room.escrowExpiresAt === null) {
      room.escrowExpiresAt = nowMs + this.lobbyEscrowTimeoutMs;
      room.escrowStatus = 'locking';
    }

    // Check dynamic 2..4 human player quorum:
    // Start countdown once >= 2 live human players are in the room and ALL connected players have locked stakes.
    const occupiedSlots = room.slots.filter((s) => s.status !== 'waiting');
    const stakedSlots = occupiedSlots.filter((s) => s.status === 'staked');

    if (occupiedSlots.length >= 2 && stakedSlots.length === occupiedSlots.length) {
      this.startRoomCountdown(room, nowMs);
      return;
    }

    this.broadcastRoomState(room, nowMs);
  }

  private handleUnlockStake(client: ConnectedClientSession, nowMs: number): void {
    if (!client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'lobby') return;

    const slot = room.slots.find((s) => s.playerId === client.playerId);
    if (!slot || slot.status !== 'staked' || !slot.walletAddress) return;

    const wallet = this.ledger.refundStake(slot.walletAddress, slot.totalDebitUsdc6);
    slot.status = 'connected';
    slot.stakeUsdc6 = 0n;
    slot.relayerRewardUsdc6 = 0n;
    slot.totalDebitUsdc6 = 0n;

    client.send({
      type: 'wallet:state',
      wallet,
      notice: 'Stake unlocked and refunded',
    });

    this.checkIfLobbyStillHasStakes(room);
    this.broadcastRoomState(room, nowMs);
  }

  private handleLaneHopInput(
    client: ConnectedClientSession,
    targetLaneIndex: 0 | 1 | 2 | 3,
  ): void {
    if (!client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'playing' || !room.simulation) return;

    if (!Number.isInteger(targetLaneIndex) || targetLaneIndex < 0 || targetLaneIndex > 3) {
      return;
    }
    const sim = room.simulation;
    const racer = sim.racers.find((r) => r.id === client.playerId);
    if (!racer || racer.eliminated) return;

    const currentLane = sim.racerTargetLaneByPlayerId.get(client.playerId) ??
      (findNearestHighwayLaneIndex(racer.x) as 0 | 1 | 2 | 3);

    // Server anti-cheat clamp: allow moving at most 1 adjacent lane per hop event
    const clampedTarget = Math.max(
      0,
      Math.min(3, currentLane + Math.sign(targetLaneIndex - currentLane)),
    ) as 0 | 1 | 2 | 3;

    sim.racerTargetLaneByPlayerId.set(client.playerId, clampedTarget);
  }

  private startRoomCountdown(room: InternalRoom, nowMs: number): void {
    room.status = 'countdown';
    room.escrowExpiresAt = null;
    room.escrowStatus = 'locked_in_race';
    room.countdownEndsAt = nowMs + this.countdownDurationMs;

    const seedInfo = this.ledger.generateOrionSeed(room.roomCode);
    room.trafficSeed = seedInfo.trafficSeed;
    room.orionRound = seedInfo.orionRound;
    room.orionRandomnessHash = seedInfo.orionRandomnessHash;

    this.broadcastRoomState(room, nowMs, 'All players locked in — race starting!');
  }

  private launchActiveRace(room: InternalRoom, nowMs: number): void {
    const stakedSlots = room.slots.filter(
      (s) => s.status === 'staked' && s.playerId && s.walletAddress,
    );
    if (stakedSlots.length < 2) {
      // Safety guard: refund if fewer than 2 players remain
      this.refundLobbyEscrow(room, nowMs, 'refunded_timeout');
      return;
    }

    const activeConfigs = stakedSlots.map((s) => ({
      playerId: s.playerId!,
      displayName: s.displayName,
      laneIndex: s.laneIndex,
      paintColor: s.paintColor,
      isLocalPlayer: false,
      chassis: DEFAULT_CAR_CONFIG.chassis,
    }));

    const racers = createOnlineHumanRacers('olympic_circuit', activeConfigs);
    const traffic = createInitialTraffic('olympic_circuit', 28, room.trafficSeed);

    const racerWalletByPlayerId = new Map<string, string>();
    const racerLaneByPlayerId = new Map<string, 0 | 1 | 2 | 3>();
    const racerTargetLaneByPlayerId = new Map<string, 0 | 1 | 2 | 3>();
    const racerConnectedByPlayerId = new Map<string, boolean>();
    let totalPotUsdc6 = 0n;
    const participantWallets: string[] = [];

    for (const s of stakedSlots) {
      racerWalletByPlayerId.set(s.playerId!, s.walletAddress!);
      racerLaneByPlayerId.set(s.playerId!, s.laneIndex);
      racerTargetLaneByPlayerId.set(s.playerId!, s.laneIndex);
      racerConnectedByPlayerId.set(s.playerId!, s.connected);
      totalPotUsdc6 += s.stakeUsdc6;
      participantWallets.push(s.walletAddress!);
    }

    const seedInfo = this.ledger.generateOrionSeed(room.roomCode);
    const escrowTxHash = seedInfo.escrowTxHash;

    room.status = 'playing';
    room.countdownEndsAt = null;
    room.escrowStatus = 'locked_in_race';
    room.simulation = {
      racers,
      racerWalletByPlayerId,
      racerLaneByPlayerId,
      racerTargetLaneByPlayerId,
      racerConnectedByPlayerId,
      traffic,
      elapsedSec: 0,
      serverTick: 0,
      potUsdc6: totalPotUsdc6,
      participantWallets,
      escrowTxHash,
    };

    const startPayload: MatchStartPayload = {
      roomCode: room.roomCode,
      trafficSeed: room.trafficSeed,
      orionRound: room.orionRound,
      orionRandomnessHash: room.orionRandomnessHash,
      escrowTxHash,
      stakePerPlayerUsdc: Amount.fromRaw(stakedSlots[0].stakeUsdc6, 6).toFixed(2),
      potUsdc6: totalPotUsdc6.toString(),
      potFormatted: Amount.fromRaw(totalPotUsdc6, 6).toFixed(2),
      activeRacers: this.serializeSimulationRacers(room.simulation),
    };

    this.broadcastToRoom(room, { type: 'match:start', payload: startPayload });
    this.broadcastRoomState(room, nowMs);
  }

  /**
   * Advances all lobby 60-second escrow timers, pre-race countdowns, and 60 Hz active highway simulations.
   */
  stepAllRooms(dtSeconds: number, nowMs = Date.now()): void {
    for (const room of [...this.rooms.values()]) {
      // 1. Check 60-second pre-race lobby escrow timeout
      if (
        room.status === 'lobby' &&
        room.escrowExpiresAt !== null &&
        nowMs >= room.escrowExpiresAt
      ) {
        this.refundLobbyEscrow(room, nowMs, 'refunded_timeout');
        continue;
      }

      // 2. Check 3-second pre-race countdown completion
      if (
        room.status === 'countdown' &&
        room.countdownEndsAt !== null &&
        nowMs >= room.countdownEndsAt
      ) {
        this.launchActiveRace(room, nowMs);
        continue;
      }

      // 3. Step 60 Hz authoritative physics & seeded traffic for playing rooms
      if (room.status === 'playing' && room.simulation) {
        this.stepPlayingRoom(room, dtSeconds, nowMs);
      }
    }
  }

  private stepPlayingRoom(
    room: InternalRoom,
    dt: number,
    nowMs: number,
  ): void {
    const sim = room.simulation;
    if (!sim) return;

    sim.elapsedSec += dt;
    sim.serverTick += 1;

    const activeLeader = sim.racers.find((r) => !r.eliminated) ?? sim.racers[0];
    const pace = computeProgressiveHighwayPace(
      activeLeader ? activeLeader.speedMs : 27.0,
      sim.elapsedSec,
      false,
      0,
    );
    const progressiveFinalDrive = Math.max(
      3.3,
      DEFAULT_CAR_CONFIG.finalDriveRatio - Math.max(0, sim.elapsedSec - 18) * 0.02,
    );
    const sharedCfg: CarConfig = {
      ...DEFAULT_CAR_CONFIG,
      finalDriveRatio: progressiveFinalDrive,
    };

    // 1. Step seeded deterministic highway traffic
    stepTrafficVehicles(
      sim.traffic,
      sim.racers,
      'olympic_circuit',
      dt,
      sim.elapsedSec,
      room.trafficSeed,
    );

    // 2. Step each human racer (disconnected racers continue straight on their last target lane)
    for (const r of sim.racers) {
      if (r.eliminated) continue;
      const targetLaneIdx = sim.racerTargetLaneByPlayerId.get(r.id) ?? 1;
      const targetLaneX = HIGHWAY_WORLD_LANE_X[targetLaneIdx] ?? 1.9;
      stepSingleRacerPhysics(
        r,
        {
          throttle: pace.throttle,
          brake: 0,
          steer: 0,
          handbrake: false,
          nitrous: false,
          desiredLaneX: targetLaneX,
        },
        sharedCfg,
        'olympic_circuit',
        dt,
        sim.elapsedSec,
      );
      stepLaneHopKinematics(r, targetLaneX, dt);
      r.isBoosting = false;
      r.exhaustFlameIntensity = 0;
    }

    syncFourPlayerHighwayPack(sim.racers, sim.elapsedSec, dt);
    resolveRacerCollisions(sim.racers, 'olympic_circuit');

    // 3. Authoritative traffic collision detection & eliminations
    for (const r of sim.racers) {
      if (r.eliminated) continue;
      const hit = checkRacerTrafficCollision(r, sim.traffic);
      if (hit.collided) {
        r.eliminated = true;
        r.eliminatedAtSec = sim.elapsedSec;
        r.finished = true;
        r.finishTimeSec = sim.elapsedSec;
        const laneIdx = findNearestHighwayLaneIndex(r.x) as 0 | 1 | 2 | 3;
        this.broadcastToRoom(room, {
          type: 'match:eliminated',
          roomCode: room.roomCode,
          playerId: r.id,
          laneIndex: laneIdx,
          z: r.z,
          survivalTimeMs: Math.round(sim.elapsedSec * 1000),
        });
      }
    }

    // 4. Broadcast 20 Hz state snapshots (every 3rd 60 Hz physics tick)
    if (sim.serverTick % 3 === 0) {
      this.broadcastToRoom(room, {
        type: 'match:tick',
        roomCode: room.roomCode,
        serverTick: sim.serverTick,
        elapsedMs: Math.round(sim.elapsedSec * 1000),
        racers: this.serializeSimulationRacers(sim),
      });
    }

    // 5. Evaluate Last Player Standing settlement
    const status = evaluateFourPlayerSessionStatus(sim.racers);
    if (status.isSessionOver && status.winner) {
      this.finishAndSettleRoom(room, status.winner, nowMs);
    }
  }

  private finishAndSettleRoom(
    room: InternalRoom,
    winnerRacer: RacerState,
    nowMs: number,
  ): void {
    const sim = room.simulation;
    if (!sim) return;

    const winnerWallet =
      sim.racerWalletByPlayerId.get(winnerRacer.id) ??
      room.slots.find((s) => s.playerId === winnerRacer.id)?.walletAddress ??
      '0x0000000000000000000000000000000000000000';

    const settlement = this.ledger.settlePotToWinner(
      winnerWallet,
      sim.participantWallets,
      sim.potUsdc6,
      room.roomCode,
    );

    const sortedRacers = [...sim.racers].sort((a, b) => {
      if (!a.eliminated && b.eliminated) return -1;
      if (a.eliminated && !b.eliminated) return 1;
      const tDiff = (b.eliminatedAtSec ?? sim.elapsedSec) - (a.eliminatedAtSec ?? sim.elapsedSec);
      if (Math.abs(tDiff) > 0.0001) return tDiff;
      return b.z - a.z;
    });

    const rankings: MatchRankingEntry[] = sortedRacers.map((r, idx) => ({
      playerId: r.id,
      displayName: r.name,
      walletAddress: sim.racerWalletByPlayerId.get(r.id) ?? '',
      laneIndex: sim.racerLaneByPlayerId.get(r.id) ?? 1,
      paintColor: r.paintColor,
      placement: idx + 1,
      eliminated: Boolean(r.eliminated),
      survivalTimeMs: Math.round((r.eliminatedAtSec ?? sim.elapsedSec) * 1000),
      connected: sim.racerConnectedByPlayerId.get(r.id) ?? false,
    }));

    const winnerLaneIndex = sim.racerLaneByPlayerId.get(winnerRacer.id) ?? 1;
    const payload: MatchFinishedPayload = {
      roomCode: room.roomCode,
      winnerPlayerId: winnerRacer.id,
      winnerWalletAddress: normalizeWalletAddress(winnerWallet),
      winnerDisplayName: winnerRacer.name,
      winnerLaneIndex,
      payoutUsdc6: sim.potUsdc6.toString(),
      payoutFormatted: settlement.payoutFormatted,
      settlementTxHash: settlement.settlementTxHash,
      orionRound: room.orionRound,
      orionRandomnessHash: room.orionRandomnessHash,
      rankings,
    };

    room.status = 'finished';
    room.escrowStatus = 'settled';
    room.simulation = null;

    this.broadcastToRoom(room, { type: 'match:finished', payload });

    // Send updated wallet snapshots to every connected participant & reset connected slots back to lobby
    for (const slot of room.slots) {
      if (!slot.playerId) continue;
      const client = this.clients.get(slot.playerId);
      if (client && slot.connected) {
        client.send({
          type: 'wallet:state',
          wallet: this.ledger.getWalletSnapshot(client.walletAddress),
        });
        slot.status = 'connected';
        slot.stakeUsdc6 = 0n;
        slot.relayerRewardUsdc6 = 0n;
        slot.totalDebitUsdc6 = 0n;
      } else {
        this.clearSlot(slot);
      }
    }

    // Reset room back to lobby for remaining connected human players (or remove if empty)
    room.status = 'lobby';
    room.escrowExpiresAt = null;
    this.reassignHostIfNeeded(room);
    this.cleanupOrBroadcastRoom(room, nowMs);
  }

  private refundLobbyEscrow(
    room: InternalRoom,
    nowMs: number,
    reasonStatus: EscrowRoomStatus,
  ): void {
    for (const slot of room.slots) {
      if (slot.status === 'staked' && slot.walletAddress) {
        const wallet = this.ledger.refundStake(
          slot.walletAddress,
          slot.totalDebitUsdc6,
        );
        slot.status = 'connected';
        slot.stakeUsdc6 = 0n;
        slot.relayerRewardUsdc6 = 0n;
        slot.totalDebitUsdc6 = 0n;

        if (slot.playerId) {
          const client = this.clients.get(slot.playerId);
          client?.send({
            type: 'wallet:state',
            wallet,
            notice: '60s lobby timer expired — locked USDC stake automatically refunded',
          });
        }
      }
    }
    room.status = 'lobby';
    room.escrowExpiresAt = null;
    room.countdownEndsAt = null;
    room.escrowStatus = reasonStatus;
    this.broadcastRoomState(
      room,
      nowMs,
      'Lobby timeout (60s): all locked stakes refunded automatically',
    );
  }

  private checkIfLobbyStillHasStakes(room: InternalRoom): void {
    const anyStaked = room.slots.some((s) => s.status === 'staked');
    if (!anyStaked) {
      room.escrowExpiresAt = null;
      room.escrowStatus = 'idle';
    }
  }

  private clearSlot(slot: InternalRoomSlot): void {
    slot.playerId = null;
    slot.displayName = 'Open Slot';
    slot.walletAddress = null;
    slot.status = 'waiting';
    slot.stakeUsdc6 = 0n;
    slot.relayerRewardUsdc6 = 0n;
    slot.totalDebitUsdc6 = 0n;
    slot.connected = false;
    slot.pingMs = null;
  }

  private reassignHostIfNeeded(room: InternalRoom): void {
    const currentHostPresent = room.slots.some(
      (s) => s.playerId && s.playerId === room.hostPlayerId && s.connected,
    );
    if (currentHostPresent) return;
    const next = room.slots.find((s) => s.playerId && s.connected);
    room.hostPlayerId = next?.playerId ?? null;
  }

  private cleanupOrBroadcastRoom(
    room: InternalRoom,
    nowMs: number,
    notice?: string,
  ): void {
    const hasConnectedPlayers = room.slots.some((s) => s.playerId && s.connected);
    if (!hasConnectedPlayers && room.status === 'lobby') {
      this.rooms.delete(room.roomCode);
      return;
    }
    this.broadcastRoomState(room, nowMs, notice);
  }

  private serializeSimulationRacers(
    sim: ActiveSimulationState,
  ): SerializedRacerState[] {
    return sim.racers.map((r) => ({
      playerId: r.id,
      displayName: r.name,
      walletAddress: sim.racerWalletByPlayerId.get(r.id) ?? '',
      laneIndex: sim.racerLaneByPlayerId.get(r.id) ?? 1,
      targetLaneIndex: sim.racerTargetLaneByPlayerId.get(r.id) ?? 1,
      paintColor: r.paintColor,
      x: r.x,
      z: r.z,
      speedMs: r.speedMs,
      speedKmh: r.speedKmh,
      hopStartX: r.hopStartX ?? r.x,
      hopTargetX: r.hopTargetX ?? r.x,
      hopProgress: r.hopProgress ?? 1,
      hopHeightY: r.hopHeightY ?? 0,
      hopPitchRad: r.hopPitchRad ?? 0,
      hopRollRad: r.hopRollRad ?? 0,
      hopYawRad: r.hopYawRad ?? 0,
      hopLandingCompressionY: r.hopLandingCompressionY ?? 0,
      eliminated: Boolean(r.eliminated),
      eliminatedAtMs:
        r.eliminatedAtSec !== undefined ? Math.round(r.eliminatedAtSec * 1000) : null,
      connected: sim.racerConnectedByPlayerId.get(r.id) ?? false,
    }));
  }

  private serializeRoom(
    room: InternalRoom,
    nowMs: number,
  ): SerializedRoomState {
    const stakeInfo = this.ledger.computeRequiredLockUsdc6(room.stakeTierUsdc);
    const stakedSlots = room.slots.filter((s) => s.status === 'staked');
    const connectedSlots = room.slots.filter((s) => s.status !== 'waiting');

    const activePotCount = BigInt(
      Math.max(stakedSlots.length, Math.max(2, connectedSlots.length)),
    );
    const livePotUsdc6 =
      stakedSlots.length > 0
        ? stakedSlots.reduce((acc, s) => acc + s.stakeUsdc6, 0n)
        : stakeInfo.stakeUsdc6 * activePotCount;

    const slotsTuple: [
      SerializedLobbySlot,
      SerializedLobbySlot,
      SerializedLobbySlot,
      SerializedLobbySlot,
    ] = [
      this.serializeSlot(room.slots[0]),
      this.serializeSlot(room.slots[1]),
      this.serializeSlot(room.slots[2]),
      this.serializeSlot(room.slots[3]),
    ];

    return {
      roomCode: room.roomCode,
      isPublicQuickMatch: room.isPublicQuickMatch,
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      stakeTierUsdc: room.stakeTierUsdc,
      relayerRewardUsdc: Amount.fromRaw(stakeInfo.relayerRewardUsdc6, 6).toFixed(2),
      potUsdc6: livePotUsdc6.toString(),
      potFormatted: Amount.fromRaw(livePotUsdc6, 6).toFixed(2),
      stakedCount: stakedSlots.length,
      connectedCount: connectedSlots.length,
      escrowExpiresAt: room.escrowExpiresAt,
      escrowStatus: room.escrowStatus,
      countdownRemainingMs:
        room.countdownEndsAt !== null
          ? Math.max(0, room.countdownEndsAt - nowMs)
          : null,
      trafficSeed: room.trafficSeed,
      orionRound: room.orionRound,
      orionRandomnessHash: room.orionRandomnessHash,
      slots: slotsTuple,
    };
  }

  private serializeSlot(slot: InternalRoomSlot): SerializedLobbySlot {
    return {
      laneIndex: slot.laneIndex,
      slotCode: slot.slotCode,
      playerId: slot.playerId,
      displayName: slot.displayName,
      walletAddress: slot.walletAddress,
      paintColor: slot.paintColor,
      status: slot.status,
      stakeUsdcFormatted: Amount.fromRaw(slot.stakeUsdc6, 6).toFixed(2),
      connected: slot.connected,
      pingMs: slot.pingMs,
    };
  }

  private broadcastToRoom(
    room: InternalRoom,
    msg: ServerToClientMessage,
  ): void {
    for (const slot of room.slots) {
      if (!slot.playerId || !slot.connected) continue;
      const client = this.clients.get(slot.playerId);
      client?.send(msg);
    }
  }

  private broadcastRoomState(
    room: InternalRoom,
    nowMs: number,
    notice?: string,
  ): void {
    const serialized = this.serializeRoom(room, nowMs);
    this.broadcastToRoom(room, {
      type: 'room:state',
      room: serialized,
      notice,
    });
  }
}
