export type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';

export type OnlineSlotStatus = 'waiting' | 'connected' | 'staked';

export type EscrowRoomStatus =
  | 'idle'
  | 'locking'
  | 'locked_in_race'
  | 'refunded_timeout'
  | 'settled';

export type OnlineErrorCode =
  | 'COLOR_OCCUPIED'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'ALREADY_STARTED'
  | 'INVALID_STAKE'
  | 'NOT_IN_ROOM';

export interface SerializedLobbySlot {
  laneIndex: 0 | 1 | 2 | 3;
  slotCode: 'P1' | 'P2' | 'P3' | 'P4';
  playerId: string | null;
  displayName: string;
  walletAddress: string | null;
  paintColor: string;
  status: OnlineSlotStatus;
  stakeUsdcFormatted: string;
  connected: boolean;
  pingMs: number | null;
}

export interface SerializedRoomState {
  roomCode: string;
  isPublicQuickMatch: boolean;
  status: RoomStatus;
  hostPlayerId: string | null;
  stakeTierUsdc: string;
  relayerRewardUsdc: string;
  potUsdc6: string;
  potFormatted: string;
  stakedCount: number;
  connectedCount: number;
  escrowExpiresAt: number | null;
  escrowStatus: EscrowRoomStatus;
  countdownRemainingMs: number | null;
  trafficSeed: number;
  orionRound: number;
  orionRandomnessHash: string;
  slots: [
    SerializedLobbySlot,
    SerializedLobbySlot,
    SerializedLobbySlot,
    SerializedLobbySlot,
  ];
}

export interface SerializedRacerState {
  playerId: string;
  displayName: string;
  walletAddress: string;
  laneIndex: 0 | 1 | 2 | 3;
  targetLaneIndex: 0 | 1 | 2 | 3;
  paintColor: string;
  x: number;
  z: number;
  speedMs: number;
  speedKmh: number;
  hopStartX: number;
  hopTargetX: number;
  hopProgress: number;
  hopHeightY: number;
  hopPitchRad: number;
  hopRollRad: number;
  hopYawRad: number;
  hopLandingCompressionY: number;
  eliminated: boolean;
  eliminatedAtMs: number | null;
  connected: boolean;
}

export interface MatchRankingEntry {
  playerId: string;
  displayName: string;
  walletAddress: string;
  laneIndex: 0 | 1 | 2 | 3;
  paintColor: string;
  placement: number;
  eliminated: boolean;
  survivalTimeMs: number;
  connected: boolean;
}

export interface AuthoritativeWalletSnapshot {
  walletAddress: string;
  chainId: number;
  balanceUsdc6: string;
  balanceFormatted: string;
  balanceNativeGas18: string;
  lockedInRoomCode: string | null;
}

export interface MatchStartPayload {
  roomCode: string;
  trafficSeed: number;
  orionRound: number;
  orionRandomnessHash: string;
  escrowTxHash: string;
  stakePerPlayerUsdc: string;
  potUsdc6: string;
  potFormatted: string;
  activeRacers: SerializedRacerState[];
}

export interface MatchFinishedPayload {
  roomCode: string;
  winnerPlayerId: string;
  winnerWalletAddress: string;
  winnerDisplayName: string;
  winnerLaneIndex: 0 | 1 | 2 | 3;
  payoutUsdc6: string;
  payoutFormatted: string;
  settlementTxHash: string;
  orionRound: number;
  orionRandomnessHash: string;
  rankings: MatchRankingEntry[];
}

export type ClientToServerMessage =
  | {
      type: 'auth:hello';
      clientId: string;
      walletAddress: string;
      displayName: string;
      preferredColor: string;
    }
  | {
      type: 'profile:update';
      displayName: string;
    }
  | {
      type: 'room:quick_match';
      stakeTierUsdc: string;
    }
  | {
      type: 'room:create';
      stakeTierUsdc: string;
    }
  | {
      type: 'room:join';
      roomCode: string;
    }
  | {
      type: 'room:leave';
    }
  | {
      type: 'room:select_color';
      paintColor: string;
    }
  | {
      type: 'room:set_stake_tier';
      stakeTierUsdc: string;
    }
  | {
      type: 'room:lock_stake';
    }
  | {
      type: 'room:unlock_stake';
    }
  | {
      type: 'input:lane_hop';
      targetLaneIndex: 0 | 1 | 2 | 3;
      clientSeq: number;
    }
  | {
      type: 'wallet:faucet';
    }
  | {
      type: 'ping';
      sentAtMs: number;
    };

export type ServerToClientMessage =
  | {
      type: 'auth:welcome';
      playerId: string;
      wallet: AuthoritativeWalletSnapshot;
    }
  | {
      type: 'wallet:state';
      wallet: AuthoritativeWalletSnapshot;
      notice?: string;
    }
  | {
      type: 'room:state';
      room: SerializedRoomState | null;
      notice?: string;
    }
  | {
      type: 'room:error';
      code: OnlineErrorCode;
      message: string;
    }
  | {
      type: 'match:start';
      payload: MatchStartPayload;
    }
  | {
      type: 'match:tick';
      roomCode: string;
      serverTick: number;
      elapsedMs: number;
      racers: SerializedRacerState[];
    }
  | {
      type: 'match:eliminated';
      roomCode: string;
      playerId: string;
      laneIndex: 0 | 1 | 2 | 3;
      z: number;
      survivalTimeMs: number;
    }
  | {
      type: 'match:finished';
      payload: MatchFinishedPayload;
    }
  | {
      type: 'pong';
      sentAtMs: number;
      serverNowMs: number;
    };
