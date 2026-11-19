import { useCallback, useEffect, useRef, useState } from 'react';
import { MultiplayerMainMenu } from './components/MultiplayerMainMenu';
import {
  appendRecentRaceSession,
  loadRecentRacesFromStorage,
  RECENT_RACES_STORAGE_KEY,
} from './components/RecentRacesDashboard';
import { StatusModalOverlay } from './components/StatusModalOverlay';
import {
  ActiveRaceEscrow,
  ARC_TESTNET_CHAIN_ID,
  ArcWalletState,
  connectInjectedArcWallet,
  loadEmbeddedArcWallet,
  saveEmbeddedArcBalance,
  StakeTierUsdc,
} from './game/arcOrionClient';
import { soundEngine } from './game/audio';
import { DEFAULT_CAR_CONFIG } from './game/tuning';
import { TRACK_CATALOG } from './game/track';
import {
  CameraPreset,
  CarConfig,
  GameState,
  RaceCameraMode,
  RaceSummary,
  RecentRaceSession,
  RivalDifficulty,
  TrackId,
} from './game/types';
import { useOnlineMultiplayer } from './game/useOnlineMultiplayer';
import { LiveHudSnapshot, WorldCanvas } from './game/WorldCanvas';
import {
  AuthoritativeWalletSnapshot,
  MatchFinishedPayload,
  MatchStartPayload,
  SerializedRacerState,
} from './shared/multiplayerProtocol';

const INITIAL_HUD: LiveHudSnapshot = {
  speedKmh: 0,
  rpm: 1100,
  redlineRpm: 9000,
  gear: 1,
  turboBoostBar: -0.3,
  nitrousRemaining: 100,
  isDrifting: false,
  isBoosting: false,
  currentDriftScore: 0,
  totalDriftScore: 0,
  driftMultiplier: 1,
  position: 1,
  totalRacers: 2,
  lap: 1,
  totalLaps: 3,
  elapsedSec: 0,
  cameraMode: 'top_down',
  aliveRacers: 2,
  trafficNearMisses: 0,
  racerPositions: [],
  trafficPositions: [],
};

export default function App() {
  const [gameState, setGameState] = useState<GameState>(() => {
    if (typeof document !== 'undefined') {
      document.body.dataset.state = 'title';
    }
    return 'title';
  });

  const [playerNickname, setPlayerNickname] = useState<string>(() => {
    try {
      return localStorage.getItem('olympic_mp_nickname') || 'RACER_01';
    } catch {
      return 'RACER_01';
    }
  });

  const [carConfig, setCarConfig] = useState<CarConfig>(() => {
    try {
      const saved = localStorage.getItem('olympic_underground_car_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_CAR_CONFIG,
          ...parsed,
          chassis: DEFAULT_CAR_CONFIG.chassis,
        };
      }
    } catch {
      // Fallback to default
    }
    return DEFAULT_CAR_CONFIG;
  });

  const [lobbySlotOccupancy, setLobbySlotOccupancy] = useState<
    [boolean, boolean, boolean, boolean]
  >([false, true, false, false]);
  const [lobbySlotColors, setLobbySlotColors] = useState<
    [string, string, string, string]
  >(['#2563eb', '#fbb124', '#06b6d4', '#f43f5e']);

  // Arc Testnet Wallet + Authoritative Server Escrow states
  const [arcWallet, setArcWallet] = useState<ArcWalletState>(() =>
    loadEmbeddedArcWallet(),
  );
  const [stakeTierUsdc, setStakeTierUsdc] = useState<StakeTierUsdc>('5');
  const [walletStatusMessage, setWalletStatusMessage] = useState<string | null>(
    null,
  );
  const [lastSettledEscrow, setLastSettledEscrow] =
    useState<ActiveRaceEscrow | null>(null);

  const [activeOnlineMatch, setActiveOnlineMatch] =
    useState<MatchStartPayload | null>(null);
  const onlineRacersSnapshotRef = useRef<SerializedRacerState[] | null>(null);
  const onlinePlayerIdRef = useRef<string | null>(null);

  const [trackId] = useState<TrackId>('olympic_circuit');
  const [rivalDifficulty] = useState<RivalDifficulty>('pro');
  const [garageCameraPreset] = useState<CameraPreset>('overview');
  const [raceCameraMode, setRaceCameraMode] =
    useState<RaceCameraMode>('top_down');
  const [raceSessionId, setRaceSessionId] = useState<number>(1);
  const [, setHudSnapshot] = useState<LiveHudSnapshot>(INITIAL_HUD);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [raceSummary, setRaceSummary] = useState<RaceSummary | null>(null);
  const [lastWinningsUsdc, setLastWinningsUsdc] = useState<string>('10.00');
  const [recentRaces, setRecentRaces] = useState<RecentRaceSession[]>(() =>
    loadRecentRacesFromStorage(),
  );

  useEffect(() => {
    document.body.dataset.state = gameState;
  }, [gameState]);

  useEffect(() => {
    try {
      localStorage.setItem('olympic_mp_nickname', playerNickname);
    } catch {
      // Ignore storage errors
    }
  }, [playerNickname]);

  useEffect(() => {
    try {
      localStorage.setItem(
        'olympic_underground_car_v1',
        JSON.stringify(carConfig),
      );
    } catch {
      // Ignore storage errors
    }
  }, [carConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(
        RECENT_RACES_STORAGE_KEY,
        JSON.stringify(recentRaces),
      );
    } catch {
      // Ignore storage errors
    }
  }, [recentRaces]);

  const handleWalletSync = useCallback(
    (wallet: AuthoritativeWalletSnapshot, notice?: string) => {
      const rawUsdc6 = BigInt(wallet.balanceUsdc6);
      const rawGas18 = BigInt(wallet.balanceNativeGas18);
      setArcWallet((prev) => {
        if (prev.mode === 'embedded_arc') {
          saveEmbeddedArcBalance(rawUsdc6);
        }
        return {
          ...prev,
          balanceUsdc: wallet.balanceFormatted,
          balanceRawUsdc6: rawUsdc6,
          balanceRawGas18: rawGas18,
        };
      });
      if (notice) {
        setWalletStatusMessage(notice);
      }
    },
    [],
  );

  const handleOnlineMatchStart = useCallback((payload: MatchStartPayload) => {
    setActiveOnlineMatch(payload);
    onlineRacersSnapshotRef.current = payload.activeRacers;
    setRaceSummary(null);
    setLastWinningsUsdc(payload.potFormatted);
    document.body.dataset.state = 'playing';
    setRaceSessionId((prev) => prev + 1);
    setGameState('playing');
  }, []);

  const handleOnlineMatchFinished = useCallback(
    (payload: MatchFinishedPayload) => {
      const localId = onlinePlayerIdRef.current;
      const localRanking =
        payload.rankings.find((r) => r.playerId === localId) ??
        payload.rankings[0];
      const placement = localRanking?.placement ?? payload.rankings.length;
      const isVictory =
        localId !== null
          ? payload.winnerPlayerId === localId
          : placement === 1;
      const totalRacers = payload.rankings.length;
      const aliveCount = payload.rankings.filter((r) => !r.eliminated).length;
      const survivalSec = (localRanking?.survivalTimeMs ?? 0) / 1000;
      const trackSpec = TRACK_CATALOG[trackId];

      const summary: RaceSummary = {
        placement,
        totalRacers,
        finishTimeSec: survivalSec,
        bestLapSec: survivalSec,
        topSpeedReachedKmh: 220,
        totalDriftScore: 0,
        cashEarned: isVictory ? Math.round(Number(payload.payoutFormatted) * 100) : 0,
        reputationEarned: isVictory ? 150 : 40,
        trackName: trackSpec.name,
        isVictory,
        eliminatedByTraffic: Boolean(localRanking?.eliminated),
        aliveCount,
        trafficNearMisses: 0,
      };

      const lockedNames: [string, string, string, string] = [
        payload.rankings.find((r) => r.laneIndex === 0)?.displayName ?? 'Open',
        payload.rankings.find((r) => r.laneIndex === 1)?.displayName ?? 'Open',
        payload.rankings.find((r) => r.laneIndex === 2)?.displayName ?? 'Open',
        payload.rankings.find((r) => r.laneIndex === 3)?.displayName ?? 'Open',
      ];
      const lockedAddrs: [string, string, string, string] = [
        payload.rankings.find((r) => r.laneIndex === 0)?.walletAddress ?? '',
        payload.rankings.find((r) => r.laneIndex === 1)?.walletAddress ?? '',
        payload.rankings.find((r) => r.laneIndex === 2)?.walletAddress ?? '',
        payload.rankings.find((r) => r.laneIndex === 3)?.walletAddress ?? '',
      ];

      setLastSettledEscrow({
        raceId: Date.now() % 100000,
        requestId: String(payload.orionRound),
        targetDrandRound: payload.orionRound,
        stakePerPlayerUsdc: stakeTierUsdc,
        totalPotUsdc: payload.payoutFormatted,
        relayerRewardUsdc: '0.01',
        lockedRacers: lockedNames,
        lockedAddresses: lockedAddrs,
        txHash: payload.settlementTxHash,
        lockedAtMs: Date.now(),
        status: 'settled',
        randomnessHex: payload.orionRandomnessHash,
        winnerLane: payload.winnerLaneIndex,
        winnerCallsign: payload.winnerDisplayName,
        winnerAddress: payload.winnerWalletAddress,
        playerWon: isVictory,
      });

      setLastWinningsUsdc(payload.payoutFormatted);
      setRaceSummary(summary);
      setRecentRaces((prev) =>
        appendRecentRaceSession(prev, {
          id: `session-${Date.now()}`,
          trackId,
          trackName: trackSpec.name,
          placement,
          totalRacers,
          earningsUsdc: isVictory ? payload.payoutFormatted : '0.00',
          cashEarned: summary.cashEarned,
          isVictory,
          finishedAtMs: Date.now(),
        }),
      );

      soundEngine.stopDrivingLoop();
      soundEngine.playRaceFanfare(isVictory);
      document.body.dataset.state = 'gameover';
      setGameState('gameover');
    },
    [stakeTierUsdc, trackId],
  );

  const online = useOnlineMultiplayer({
    walletAddress: arcWallet.address,
    displayName: playerNickname,
    preferredColor: carConfig.paintColor,
    onWalletSync: handleWalletSync,
    onMatchStart: handleOnlineMatchStart,
    onMatchTick: (tick) => {
      onlineRacersSnapshotRef.current = tick.racers;
    },
    onMatchEliminated: (ev) => {
      const current = onlineRacersSnapshotRef.current;
      if (current) {
        onlineRacersSnapshotRef.current = current.map((r) =>
          r.playerId === ev.playerId ? { ...r, eliminated: true } : r,
        );
      }
    },
    onMatchFinished: handleOnlineMatchFinished,
  });

  useEffect(() => {
    onlinePlayerIdRef.current = online.playerId;
  }, [online.playerId]);

  const handleConnectInjectedWallet = useCallback(async () => {
    try {
      setWalletStatusMessage(
        `Connecting to Arc Testnet (${ARC_TESTNET_CHAIN_ID})...`,
      );
      const connected = await connectInjectedArcWallet();
      setArcWallet(connected);
      setWalletStatusMessage('Connected to MetaMask / Rabby on Arc Testnet');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not connect browser wallet';
      setWalletStatusMessage(msg);
    }
  }, []);

  const handleSwitchToEmbeddedWallet = useCallback(() => {
    setArcWallet(loadEmbeddedArcWallet());
    setWalletStatusMessage('Switched to Embedded Arc Testnet Wallet');
  }, []);

  const handleFaucetTopUpUsdc = useCallback(() => {
    online.requestFaucet();
  }, [online.requestFaucet]);

  const handleReturnToLobby = useCallback(() => {
    setActiveOnlineMatch(null);
    onlineRacersSnapshotRef.current = null;
    setRaceSummary(null);
    document.body.dataset.state = 'title';
    setGameState('title');
  }, []);

  const handleCycleRaceCamera = useCallback(() => {
    setRaceCameraMode((prev) =>
      prev === 'top_down'
        ? 'chase'
        : prev === 'chase'
          ? 'hood'
          : prev === 'hood'
            ? 'far'
            : 'top_down',
    );
  }, []);

  const handleToggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      soundEngine.setMuted(next);
      return next;
    });
  }, []);

  // Global keyboard shortcut for Mute [M] (ignored while typing in an input)
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'KeyM') {
        handleToggleMute();
      }
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [handleToggleMute]);

  return (
    <main className="relative w-full h-full overflow-hidden bg-[#56cc5c] select-none">
      <WorldCanvas
        gameState={gameState}
        carConfig={carConfig}
        trackId={trackId}
        rivalDifficulty={rivalDifficulty}
        garageCameraPreset={garageCameraPreset}
        raceCameraMode={raceCameraMode}
        raceSessionId={raceSessionId}
        lobbySlotOccupancy={lobbySlotOccupancy}
        lobbySlotColors={lobbySlotColors}
        onlineMatch={activeOnlineMatch}
        onlineRacersSnapshotRef={onlineRacersSnapshotRef}
        localOnlinePlayerId={online.playerId}
        onSendOnlineLaneHop={online.sendLaneHop}
        onHudUpdate={setHudSnapshot}
        onRaceFinish={setRaceSummary}
        onTogglePause={handleReturnToLobby}
        onCycleRaceCamera={handleCycleRaceCamera}
        onStartFromKey={() => {
          if (!online.roomState) {
            online.quickMatch(stakeTierUsdc);
          }
        }}
      />

      {gameState === 'title' && (
        <MultiplayerMainMenu
          carConfig={carConfig}
          onUpdateCarConfig={setCarConfig}
          playerNickname={playerNickname}
          onChangePlayerNickname={setPlayerNickname}
          online={online}
          onSlotOccupancyChange={setLobbySlotOccupancy}
          onSlotColorsChange={setLobbySlotColors}
          arcWallet={arcWallet}
          stakeTierUsdc={stakeTierUsdc}
          onSelectStakeTier={setStakeTierUsdc}
          onConnectInjectedWallet={handleConnectInjectedWallet}
          onSwitchToEmbeddedWallet={handleSwitchToEmbeddedWallet}
          onFaucetTopUpUsdc={handleFaucetTopUpUsdc}
          lastSettledEscrow={lastSettledEscrow}
          walletStatusMessage={walletStatusMessage}
          recentRaces={recentRaces}
          isMuted={isMuted}
          onToggleMute={handleToggleMute}
        />
      )}

      <StatusModalOverlay
        gameState={gameState}
        raceSummary={raceSummary}
        winningsUsdc={lastWinningsUsdc}
        onReturnToMenu={handleReturnToLobby}
      />
    </main>
  );
}
