import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LobbyStartMeta,
  MultiplayerMainMenu,
} from './components/MultiplayerMainMenu';
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
  calculateTargetRoundForRequest,
  computeWagerBreakdown,
  connectInjectedArcWallet,
  connectLinkedArcAddress,
  createDisconnectedArcWallet,
  deriveWinnerLaneFromRandomness,
  disconnectArcWallet,
  DiscoveredWalletProvider,
  fetchArcTestnetUsdcBalance,
  loadEmbeddedArcWallet,
  refreshInjectedArcWallet,
  resolveOrionBeaconRandomness,
  restoreInjectedArcWallet,
  saveEmbeddedArcBalance,
  StakeTierUsdc,
  submitInjectedOrionRequest,
  subscribeDiscoveredWallets,
  subscribeInjectedWalletEvents,
  switchConnectedWalletToArcTestnet,
} from './game/arcOrionClient';
import { soundEngine } from './game/audio';
import { resolveUniqueLanePaintColors } from './game/physics';
import { TRACK_CATALOG } from './game/track';
import { DEFAULT_CAR_CONFIG } from './game/tuning';
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
import { LiveHudSnapshot, WorldCanvas } from './game/WorldCanvas';

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
  totalRacers: 4,
  lap: 1,
  totalLaps: 3,
  elapsedSec: 0,
  cameraMode: 'top_down',
  aliveRacers: 4,
  trafficNearMisses: 0,
  racerPositions: [],
  trafficPositions: [],
};

const FAUCET_MINT_USDC6 = 50_000_000n; // +50.00 USDC (6 decimals)

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
  >([true, true, true, true]);
  const [lobbySlotColors, setLobbySlotColors] = useState<
    [string, string, string, string]
  >(() => resolveUniqueLanePaintColors(DEFAULT_CAR_CONFIG.paintColor));

  // Arc Testnet Wallet + Orion RandomnessHub v2 Escrow states
  // Starts disconnected so every public player connects their own personal wallet (MetaMask, Rabby, etc.)
  const [arcWallet, setArcWallet] = useState<ArcWalletState>(() =>
    createDisconnectedArcWallet(),
  );
  const [discoveredWallets, setDiscoveredWallets] = useState<
    DiscoveredWalletProvider[]
  >([]);
  const [stakeTierUsdc, setStakeTierUsdc] = useState<StakeTierUsdc>('5');
  const [walletStatusMessage, setWalletStatusMessage] = useState<string | null>(
    null,
  );
  const [isLockingEscrow, setIsLockingEscrow] = useState<boolean>(false);
  const [lastSettledEscrow, setLastSettledEscrow] =
    useState<ActiveRaceEscrow | null>(null);
  const activeEscrowRef = useRef<ActiveRaceEscrow | null>(null);
  const restoredOnceRef = useRef<boolean>(false);

  const [trackId] = useState<TrackId>('olympic_circuit');
  const [rivalDifficulty] = useState<RivalDifficulty>('pro');
  const [garageCameraPreset] = useState<CameraPreset>('overview');
  const [raceCameraMode, setRaceCameraMode] =
    useState<RaceCameraMode>('top_down');
  const [raceSessionId, setRaceSessionId] = useState<number>(1);
  const [, setHudSnapshot] = useState<LiveHudSnapshot>(INITIAL_HUD);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [raceSummary, setRaceSummary] = useState<RaceSummary | null>(null);
  const [lastWinningsUsdc, setLastWinningsUsdc] = useState<string>('20.00');
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

  // Discover installed EIP-6963 / EIP-1193 wallets and silently restore an already-authorized session
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeDiscoveredWallets((wallets) => {
      if (!active) return;
      setDiscoveredWallets(wallets);
      if (!restoredOnceRef.current) {
        restoredOnceRef.current = true;
        void restoreInjectedArcWallet(wallets).then((restored) => {
          if (active && restored) {
            setArcWallet(restored);
          }
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Keep player's personal wallet synced if they switch account or network inside MetaMask / Rabby
  useEffect(() => {
    if (arcWallet.mode !== 'injected_eip1193') return;
    let active = true;
    const unsubscribe = subscribeInjectedWalletEvents({
      onAccountsChanged: (accounts) => {
        if (!active) return;
        if (accounts.length === 0) {
          setArcWallet(disconnectArcWallet());
          setWalletStatusMessage('Wallet disconnected');
          return;
        }
        void refreshInjectedArcWallet(accounts[0]).then((updated) => {
          if (active && updated) {
            setArcWallet(updated);
            setWalletStatusMessage('Switched wallet account');
          }
        });
      },
      onChainChanged: (chainId) => {
        if (!active) return;
        if (chainId !== ARC_TESTNET_CHAIN_ID) {
          setWalletStatusMessage(
            `Please switch wallet network to Arc Testnet (${ARC_TESTNET_CHAIN_ID}).`,
          );
        } else {
          setWalletStatusMessage(null);
        }
        void refreshInjectedArcWallet(arcWallet.address).then((updated) => {
          if (active && updated) {
            setArcWallet(updated);
          }
        });
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [arcWallet.mode, arcWallet.address]);

  const handleConnectInjectedWallet = useCallback(
    async (selected?: DiscoveredWalletProvider) => {
      try {
        setWalletStatusMessage(
          `Connecting ${selected?.name ?? 'wallet'} to Arc Testnet (${ARC_TESTNET_CHAIN_ID})...`,
        );
        const connected = await connectInjectedArcWallet(selected);
        setArcWallet(connected);
        if (connected.chainId !== ARC_TESTNET_CHAIN_ID) {
          setWalletStatusMessage(
            `Connected ${connected.providerName ?? 'Wallet'} — click "Switch to Arc" to switch to Arc Testnet (${ARC_TESTNET_CHAIN_ID}).`,
          );
        } else {
          setWalletStatusMessage(
            `Connected ${connected.providerName ?? 'Wallet'} on Arc Testnet`,
          );
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Could not connect browser wallet';
        setWalletStatusMessage(msg);
      }
    },
    [],
  );

  const handleConnectLinkedAddress = useCallback(async (rawAddress: string) => {
    setWalletStatusMessage('Checking Arc Testnet balance...');
    const linked = await connectLinkedArcAddress(rawAddress);
    setArcWallet(linked);
    setWalletStatusMessage('Bound personal Arc Testnet address');
  }, []);

  const handleSwitchToArcTestnet = useCallback(async () => {
    if (arcWallet.mode !== 'injected_eip1193' || !arcWallet.address) return;
    setWalletStatusMessage(
      `Switching wallet to Arc Testnet (${ARC_TESTNET_CHAIN_ID})...`,
    );
    const updated = await switchConnectedWalletToArcTestnet(arcWallet.address);
    if (updated) {
      setArcWallet(updated);
      setWalletStatusMessage(
        updated.chainId === ARC_TESTNET_CHAIN_ID
          ? `Switched to Arc Testnet (${ARC_TESTNET_CHAIN_ID})`
          : `Could not switch automatically — select Arc Testnet (${ARC_TESTNET_CHAIN_ID}) in your wallet.`,
      );
    }
  }, [arcWallet.mode, arcWallet.address]);

  const handleRefreshWalletBalance = useCallback(async () => {
    if (!arcWallet.address) return;
    if (arcWallet.mode === 'injected_eip1193') {
      const updated = await refreshInjectedArcWallet(arcWallet.address);
      if (updated) setArcWallet(updated);
    } else if (arcWallet.mode === 'linked_address') {
      const { amount6, rawGas18 } = await fetchArcTestnetUsdcBalance(
        arcWallet.address,
      );
      setArcWallet((prev) => ({
        ...prev,
        balanceUsdc: amount6.toFixed(2),
        balanceRawUsdc6: amount6.raw,
        balanceRawGas18: rawGas18,
      }));
    }
  }, [arcWallet.mode, arcWallet.address]);

  const handleDisconnectWallet = useCallback(() => {
    setArcWallet(disconnectArcWallet());
    setWalletStatusMessage('Wallet disconnected');
  }, []);

  const handleSwitchToEmbeddedWallet = useCallback(() => {
    setArcWallet(loadEmbeddedArcWallet());
    setWalletStatusMessage('Switched to Local Demo Wallet (Testnet Practice)');
  }, []);

  const handleFaucetTopUpUsdc = useCallback(() => {
    setArcWallet((prev) => {
      if (prev.mode !== 'embedded_arc') return prev;
      return saveEmbeddedArcBalance(prev.balanceRawUsdc6 + FAUCET_MINT_USDC6);
    });
    setWalletStatusMessage('+50.00 Demo USDC added');
  }, []);

  const handleStartRace = useCallback(
    async (meta?: LobbyStartMeta) => {
      if (isLockingEscrow) return;
      const breakdown = computeWagerBreakdown(stakeTierUsdc);

      const colors =
        meta?.slotColors ?? resolveUniqueLanePaintColors(carConfig.paintColor);
      const callsigns: [string, string, string, string] = meta?.slotCallsigns ?? [
        'Vortex_02',
        playerNickname.trim() || 'RACER_01',
        'Kenshin_01',
        'Apex_03',
      ];
      const addresses: [string, string, string, string] = meta?.slotAddresses ?? [
        '0x9a2F4401B7C1120E38c5D8496c1aB02E8F41C202',
        arcWallet.address || '0x0000000000000000000000000000000000000000',
        '0x4eB80219cA7410F93e20A8814d6E319B12D0A103',
        '0xD31c7840E290F4b16A55C2398E71024a91B7F404',
      ];

      setLobbySlotColors(colors);
      setLobbySlotOccupancy([true, true, true, true]);

      if (breakdown.isWagerEnabled) {
        if (arcWallet.mode === 'disconnected') {
          setWalletStatusMessage(
            'Connect your personal wallet to stake USDC, or switch to Free ($0) mode.',
          );
          return;
        }

        if (arcWallet.balanceRawUsdc6 < breakdown.playerTotalLockUsdc.raw) {
          setWalletStatusMessage(
            arcWallet.mode === 'embedded_arc'
              ? 'Insufficient Demo USDC balance — click +50 USDC to top up.'
              : 'Insufficient Arc Testnet USDC — claim free test USDC at faucet.circle.com or play Free ($0).',
          );
          return;
        }

        setIsLockingEscrow(true);
        let txHash: string | null = null;
        try {
          if (arcWallet.mode === 'injected_eip1193') {
            setWalletStatusMessage(
              'Confirm Orion RandomnessHub v2 wager tx in your wallet...',
            );
            txHash = await submitInjectedOrionRequest(
              arcWallet.address,
              breakdown.relayerRewardGas18,
            );
            void refreshInjectedArcWallet(arcWallet.address).then((updated) => {
              if (updated) setArcWallet(updated);
            });
          } else if (arcWallet.mode === 'embedded_arc') {
            const updatedWallet = saveEmbeddedArcBalance(
              arcWallet.balanceRawUsdc6 - breakdown.playerTotalLockUsdc.raw,
            );
            setArcWallet(updatedWallet);
          }

          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          const targetRound = Number(calculateTargetRoundForRequest(nowSec));
          const raceId = Math.floor(10000 + Math.random() * 90000);

          activeEscrowRef.current = {
            raceId,
            requestId: String(raceId),
            targetDrandRound: targetRound,
            stakePerPlayerUsdc: breakdown.stakePerPlayerUsdc.toFixed(2),
            totalPotUsdc: breakdown.totalPotUsdc.toFixed(2),
            relayerRewardUsdc: breakdown.relayerRewardUsdc.toFixed(2),
            lockedRacers: callsigns,
            lockedAddresses: addresses,
            txHash,
            lockedAtMs: Date.now(),
            status: 'locked',
          };
          setLastWinningsUsdc(breakdown.totalPotUsdc.toFixed(2));
          setWalletStatusMessage(null);
        } catch (err) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Escrow lock transaction cancelled';
          setWalletStatusMessage(msg);
          setIsLockingEscrow(false);
          return;
        } finally {
          setIsLockingEscrow(false);
        }
      } else {
        activeEscrowRef.current = null;
        setLastWinningsUsdc('0.00');
      }

      setRaceSummary(null);
      document.body.dataset.state = 'playing';
      setRaceSessionId((prev) => prev + 1);
      setGameState('playing');
    },
    [arcWallet, carConfig.paintColor, isLockingEscrow, playerNickname, stakeTierUsdc],
  );

  const handleRaceFinish = useCallback(
    (summary: RaceSummary) => {
      const isVictory = summary.isVictory || summary.placement === 1;
      const trackSpec = TRACK_CATALOG[trackId];
      const lockedEscrow = activeEscrowRef.current;
      activeEscrowRef.current = null;

      const potStr = lockedEscrow?.totalPotUsdc ?? '0.00';
      setLastWinningsUsdc(potStr);
      setRaceSummary(summary);

      setRecentRaces((prev) =>
        appendRecentRaceSession(prev, {
          id: `session-${Date.now()}`,
          trackId,
          trackName: trackSpec.name,
          placement: summary.placement,
          totalRacers: summary.totalRacers,
          earningsUsdc: isVictory ? potStr : '0.00',
          cashEarned: summary.cashEarned,
          isVictory,
          finishedAtMs: Date.now(),
        }),
      );

      if (lockedEscrow) {
        const potRaw6 = computeWagerBreakdown(
          lockedEscrow.stakePerPlayerUsdc,
        ).totalPotUsdc.raw;

        if (isVictory) {
          setArcWallet((prev) => {
            if (prev.mode !== 'embedded_arc') return prev;
            return saveEmbeddedArcBalance(prev.balanceRawUsdc6 + potRaw6);
          });
        }

        void resolveOrionBeaconRandomness(
          lockedEscrow.targetDrandRound,
          lockedEscrow.requestId,
        ).then(({ drandSignatureHex, randomnessHex }) => {
          const beaconLane = deriveWinnerLaneFromRandomness(randomnessHex);
          const aiLanes: readonly (0 | 2 | 3)[] = [0, 2, 3];
          const winnerLane: 0 | 1 | 2 | 3 = isVictory
            ? 1
            : beaconLane === 1
              ? aiLanes[0]
              : beaconLane;

          setLastSettledEscrow({
            ...lockedEscrow,
            status: 'settled',
            drandSignatureHex,
            randomnessHex,
            winnerLane,
            winnerCallsign: lockedEscrow.lockedRacers[winnerLane],
            winnerAddress: lockedEscrow.lockedAddresses[winnerLane],
            playerWon: isVictory,
          });
        });
      }

      soundEngine.stopDrivingLoop();
      soundEngine.playRaceFanfare(isVictory);
      document.body.dataset.state = 'gameover';
      setGameState('gameover');
    },
    [trackId],
  );

  const handleReturnToLobby = useCallback(() => {
    activeEscrowRef.current = null;
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
    <main className="relative w-full h-full overflow-hidden bg-[#56cc5c] select-none touch-manipulation">
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
        onlineMatch={null}
        onHudUpdate={setHudSnapshot}
        onRaceFinish={handleRaceFinish}
        onTogglePause={handleReturnToLobby}
        onCycleRaceCamera={handleCycleRaceCamera}
        onStartFromKey={() => {
          void handleStartRace();
        }}
      />

      {gameState === 'title' && (
        <MultiplayerMainMenu
          carConfig={carConfig}
          onUpdateCarConfig={setCarConfig}
          playerNickname={playerNickname}
          onChangePlayerNickname={setPlayerNickname}
          onStartRace={handleStartRace}
          onSlotOccupancyChange={setLobbySlotOccupancy}
          onSlotColorsChange={setLobbySlotColors}
          arcWallet={arcWallet}
          discoveredWallets={discoveredWallets}
          stakeTierUsdc={stakeTierUsdc}
          onSelectStakeTier={setStakeTierUsdc}
          onConnectInjectedWallet={handleConnectInjectedWallet}
          onConnectLinkedAddress={handleConnectLinkedAddress}
          onSwitchToArcTestnet={handleSwitchToArcTestnet}
          onRefreshWalletBalance={handleRefreshWalletBalance}
          onDisconnectWallet={handleDisconnectWallet}
          onSwitchToEmbeddedWallet={handleSwitchToEmbeddedWallet}
          onFaucetTopUpUsdc={handleFaucetTopUpUsdc}
          isLockingEscrow={isLockingEscrow}
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
