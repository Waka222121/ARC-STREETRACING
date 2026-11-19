import React, { useEffect, useState } from 'react';
import {
  ActiveRaceEscrow,
  ARC_TESTNET_CHAIN_ID,
  ArcWalletState,
  buildAddressExplorerUrl,
  buildTxExplorerUrl,
  computeWagerBreakdown,
  fetchOrionHubTelemetry,
  ORION_HUB_V2_ADDRESS,
  OrionHubTelemetry,
  STAKE_TIERS_USDC,
  StakeTierUsdc,
} from '../game/arcOrionClient';
import {
  getPaintSwatchName,
  LOBBY_PAINT_SWATCHES,
  normalizePaintHex,
  resolveUniqueLanePaintColors,
} from '../game/physics';
import { CHASSIS_CATALOG } from '../game/tuning';
import { CarConfig, RecentRaceSession } from '../game/types';
import { OnlineMultiplayerApi } from '../game/useOnlineMultiplayer';
import {
  OnlineSlotStatus,
  SerializedLobbySlot,
} from '../shared/multiplayerProtocol';
import {
  DEFAULT_RECENT_RACES,
  RecentRacesDashboard,
} from './RecentRacesDashboard';

export type MultiplayerModeTab = 'quick_match' | 'create_room' | 'join_room';

interface MultiplayerMainMenuProps {
  carConfig: CarConfig;
  onUpdateCarConfig: (updater: (prev: CarConfig) => CarConfig) => void;
  playerNickname: string;
  onChangePlayerNickname: (name: string) => void;
  online: OnlineMultiplayerApi;
  onSlotOccupancyChange?: (
    occupiedByLane: [boolean, boolean, boolean, boolean],
  ) => void;
  onSlotColorsChange?: (colorsByLane: [string, string, string, string]) => void;
  arcWallet: ArcWalletState;
  stakeTierUsdc: StakeTierUsdc;
  onSelectStakeTier: (tier: StakeTierUsdc) => void;
  onConnectInjectedWallet: () => Promise<void>;
  onSwitchToEmbeddedWallet: () => void;
  onFaucetTopUpUsdc: () => void;
  lastSettledEscrow: ActiveRaceEscrow | null;
  walletStatusMessage: string | null;
  recentRaces?: RecentRaceSession[];
  isMuted?: boolean;
  onToggleMute?: () => void;
}

const UNIFIED_CAR_MODEL_NAME = CHASSIS_CATALOG.rx7.name;
const PAINT_SWATCHES = LOBBY_PAINT_SWATCHES;
const DISPLAY_LANE_ORDER: readonly (0 | 1 | 2 | 3)[] = [1, 0, 2, 3];
const LANE_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: 'Lane 1 • Left',
  1: 'Lane 2 • Mid-Left',
  2: 'Lane 3 • Mid-Right',
  3: 'Lane 4 • Right',
};
const DEFAULT_SLOT_CODES: Record<0 | 1 | 2 | 3, 'P1' | 'P2' | 'P3' | 'P4'> = {
  1: 'P1',
  0: 'P2',
  2: 'P3',
  3: 'P4',
};

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function normalizeRoomCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (cleaned.length > 3) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
  }
  return cleaned;
}

export const MultiplayerMainMenu: React.FC<MultiplayerMainMenuProps> = ({
  carConfig,
  onUpdateCarConfig,
  playerNickname,
  onChangePlayerNickname,
  online,
  onSlotOccupancyChange,
  onSlotColorsChange,
  arcWallet,
  stakeTierUsdc,
  onSelectStakeTier,
  onConnectInjectedWallet,
  onSwitchToEmbeddedWallet,
  onFaucetTopUpUsdc,
  lastSettledEscrow,
  walletStatusMessage,
  recentRaces,
  isMuted = false,
  onToggleMute,
}) => {
  const [activeTab, setActiveTab] = useState<MultiplayerModeTab>('quick_match');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [joinInputError, setJoinInputError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Orion RandomnessHub v2 live telemetry on Arc Testnet
  const [orionTelemetry, setOrionTelemetry] =
    useState<OrionHubTelemetry | null>(null);

  const roomState = online.roomState;

  // Live 250ms clock for countdowns & 60s pre-race lobby escrow timeout
  useEffect(() => {
    if (!roomState || (roomState.escrowExpiresAt === null && roomState.status !== 'countdown')) {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [roomState?.escrowExpiresAt, roomState?.status]);

  // Poll Orion RandomnessHub v2 telemetry from Arc Testnet & drand evmnet
  useEffect(() => {
    let active = true;
    const loadTelemetry = async () => {
      const data = await fetchOrionHubTelemetry();
      if (active) setOrionTelemetry(data);
    };
    void loadTelemetry();
    const interval = window.setInterval(() => {
      void loadTelemetry();
    }, 9000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  // Sync local stake input when server room changes stake tier
  useEffect(() => {
    if (roomState && roomState.stakeTierUsdc !== stakeTierUsdc) {
      onSelectStakeTier(roomState.stakeTierUsdc as StakeTierUsdc);
    }
  }, [roomState?.stakeTierUsdc]);

  const activeStakeStr = roomState ? roomState.stakeTierUsdc : stakeTierUsdc;
  const wagerBreakdown = computeWagerBreakdown(activeStakeStr as StakeTierUsdc);
  const hasEnoughUsdcForWager =
    !wagerBreakdown.isWagerEnabled ||
    arcWallet.balanceRawUsdc6 >= wagerBreakdown.playerTotalLockUsdc.raw;

  const localSlot: SerializedLobbySlot | null =
    roomState && online.playerId
      ? roomState.slots.find((s) => s.playerId === online.playerId) ?? null
      : null;

  // Sync server-assigned unique paint color back into local carConfig
  useEffect(() => {
    if (!localSlot) return;
    const serverHex = normalizePaintHex(localSlot.paintColor);
    if (normalizePaintHex(carConfig.paintColor) !== serverHex) {
      onUpdateCarConfig((prev) => ({ ...prev, paintColor: serverHex }));
    }
  }, [localSlot?.paintColor]);

  // Sync 3D starting grid occupancy (live human players ONLY — zero AI cars)
  const fallbackLaneColors = resolveUniqueLanePaintColors(carConfig.paintColor);
  const laneOccupancy: [boolean, boolean, boolean, boolean] = roomState
    ? [
        roomState.slots[0].status !== 'waiting',
        roomState.slots[1].status !== 'waiting',
        roomState.slots[2].status !== 'waiting',
        roomState.slots[3].status !== 'waiting',
      ]
    : [false, true, false, false];

  const laneColors: [string, string, string, string] = roomState
    ? [
        roomState.slots[0].paintColor,
        roomState.slots[1].paintColor,
        roomState.slots[2].paintColor,
        roomState.slots[3].paintColor,
      ]
    : [
        fallbackLaneColors[0],
        fallbackLaneColors[1],
        fallbackLaneColors[2],
        fallbackLaneColors[3],
      ];

  useEffect(() => {
    onSlotOccupancyChange?.(laneOccupancy);
  }, [
    laneOccupancy[0],
    laneOccupancy[1],
    laneOccupancy[2],
    laneOccupancy[3],
    onSlotOccupancyChange,
  ]);

  useEffect(() => {
    onSlotColorsChange?.(laneColors);
  }, [
    laneColors[0],
    laneColors[1],
    laneColors[2],
    laneColors[3],
    onSlotColorsChange,
  ]);

  const handleSelectTab = (tab: MultiplayerModeTab) => {
    setJoinInputError(null);
    online.clearError();
    setActiveTab(tab);

    if (tab === 'create_room' && !roomState && online.connectionStatus === 'connected') {
      online.createRoom(stakeTierUsdc);
    }
  };

  const handleCopyRoomCode = async () => {
    if (!roomState) return;
    try {
      await navigator.clipboard.writeText(roomState.roomCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    }
  };

  const handleJoinByCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formatted = normalizeRoomCode(joinCodeInput);
    if (formatted.length < 4) {
      setJoinInputError('Enter a valid 6-character room code (e.g. HWY-742)');
      return;
    }
    setJoinInputError(null);
    online.joinRoom(formatted);
  };

  const handleStakeTierChange = (tier: StakeTierUsdc) => {
    onSelectStakeTier(tier);
    if (roomState && roomState.status === 'lobby' && roomState.stakedCount === 0) {
      online.setStakeTier(tier);
    }
  };

  const handleNicknameChange = (nextName: string) => {
    onChangePlayerNickname(nextName);
    if (nextName.trim().length > 0) {
      online.updateProfile(nextName);
    }
  };

  // Atomic First-Write-Wins paint occupancy derived strictly from server roomState
  const getColorHolder = (
    hex: string,
  ): { taken: boolean; holderSlotCode?: string; holderName?: string } => {
    if (!roomState) return { taken: false };
    const norm = normalizePaintHex(hex);
    for (const slot of roomState.slots) {
      if (slot.status === 'waiting') continue;
      if (slot.playerId === online.playerId) continue;
      if (normalizePaintHex(slot.paintColor) === norm) {
        return {
          taken: true,
          holderSlotCode: slot.slotCode,
          holderName: slot.displayName,
        };
      }
    }
    return { taken: false };
  };

  const handleSelectLocalPaintColor = (targetHex: string) => {
    const holder = getColorHolder(targetHex);
    if (holder.taken) return;
    const norm = normalizePaintHex(targetHex);
    onUpdateCarConfig((prev) => ({ ...prev, paintColor: norm }));
    if (roomState) {
      online.selectColor(norm);
    }
  };

  const currentClockMs = Math.max(nowMs, Date.now());
  const escrowRemainingSec =
    roomState?.escrowExpiresAt != null
      ? Math.min(60, Math.max(0, Math.ceil((roomState.escrowExpiresAt - currentClockMs) / 1000)))
      : null;

  const countdownSec =
    roomState?.status === 'countdown' && roomState.countdownRemainingMs != null
      ? Math.max(1, Math.ceil(roomState.countdownRemainingMs / 1000))
      : null;

  const projectedPlayerCount = roomState
    ? Math.max(2, roomState.connectedCount)
    : 4;
  const projectedPotUsdc = roomState
    ? roomState.potFormatted
    : (
        Number(wagerBreakdown.stakePerPlayerUsdc.toFixed(2)) *
        projectedPlayerCount
      ).toFixed(2);

  const isLocalStaked = localSlot?.status === 'staked';
  const stakeEditingLocked =
    Boolean(roomState) &&
    (roomState!.stakedCount > 0 || roomState!.status !== 'lobby');

  const gridSlots = DISPLAY_LANE_ORDER.map((laneIndex) => {
    if (roomState) {
      const s = roomState.slots[laneIndex];
      const isLocal = s.playerId !== null && s.playerId === online.playerId;
      return {
        laneIndex,
        laneLabel: LANE_LABELS[laneIndex],
        slotCode: isLocal ? `${s.slotCode} • YOU` : s.slotCode,
        isLocalPlayer: isLocal,
        nickname: s.displayName,
        walletAddress: s.walletAddress ? shortenAddress(s.walletAddress) : '---',
        pingMs: isLocal ? online.pingMs : s.pingMs,
        chassisName:
          s.status === 'waiting' ? 'Open Slot' : UNIFIED_CAR_MODEL_NAME,
        paintColor: s.paintColor,
        status: s.status as OnlineSlotStatus,
        connected: s.connected,
        stakeUsdcFormatted: s.stakeUsdcFormatted,
      };
    }

    const isLocal = laneIndex === 1;
    return {
      laneIndex,
      laneLabel: LANE_LABELS[laneIndex],
      slotCode: isLocal
        ? `${DEFAULT_SLOT_CODES[laneIndex]} • YOU`
        : DEFAULT_SLOT_CODES[laneIndex],
      isLocalPlayer: isLocal,
      nickname: isLocal ? playerNickname : 'Open Slot',
      walletAddress: isLocal ? shortenAddress(arcWallet.address) : '---',
      pingMs: isLocal ? online.pingMs : null,
      chassisName: isLocal ? UNIFIED_CAR_MODEL_NAME : 'Open Slot',
      paintColor: laneColors[laneIndex],
      status: (isLocal ? 'connected' : 'waiting') as OnlineSlotStatus,
      connected: isLocal,
      stakeUsdcFormatted: '0.00',
    };
  });

  const walletExplorerUrl = buildAddressExplorerUrl(
    ARC_TESTNET_CHAIN_ID,
    arcWallet.address,
  );
  const hubExplorerUrl = buildAddressExplorerUrl(
    ARC_TESTNET_CHAIN_ID,
    ORION_HUB_V2_ADDRESS,
  );

  const handlePrimaryCtaClick = () => {
    if (online.connectionStatus !== 'connected') return;
    if (!roomState) {
      if (activeTab === 'create_room') {
        online.createRoom(stakeTierUsdc);
      } else if (activeTab === 'join_room') {
        const formatted = normalizeRoomCode(joinCodeInput);
        if (formatted.length >= 4) {
          online.joinRoom(formatted);
        } else {
          setJoinInputError('Enter a valid 6-character room code first');
        }
      } else {
        online.quickMatch(stakeTierUsdc);
      }
      return;
    }

    if (roomState.status !== 'lobby') return;
    if (isLocalStaked) {
      online.unlockStake();
    } else {
      online.lockStake();
    }
  };

  const primaryCtaDisabled =
    online.connectionStatus !== 'connected' ||
    roomState?.status === 'countdown' ||
    roomState?.status === 'playing' ||
    (Boolean(roomState) && !isLocalStaked && !hasEnoughUsdcForWager);

  const primaryCtaLabel = (() => {
    if (online.connectionStatus !== 'connected') {
      return 'Connecting to Live Server...';
    }
    if (!roomState) {
      if (activeTab === 'create_room') return 'Create Private Room —>';
      if (activeTab === 'join_room') return 'Join Room by Code —>';
      return `Join Live Lobby (${activeStakeStr} USDC) —>`;
    }
    if (roomState.status === 'countdown') {
      return `Launching in ${countdownSec ?? 3}s...`;
    }
    if (roomState.status === 'playing') {
      return 'Race In Progress...';
    }
    if (isLocalStaked) {
      const needed = Math.max(2, roomState.connectedCount);
      return `✓ Staked (${roomState.stakedCount}/${needed}) — Click to Unlock`;
    }
    if (!hasEnoughUsdcForWager) {
      return 'Insufficient USDC (Use +50 USDC)';
    }
    return `Lock ${wagerBreakdown.stakePerPlayerUsdc.toString()} USDC & Ready Up —>`;
  })();

  return (
    <div
      data-testid="multiplayer-main-menu"
      className="fixed inset-0 z-50 grid h-screen w-screen grid-rows-[auto_1fr] overflow-hidden bg-[#0d0d0f]/85 text-[#f8f8f8]"
    >
      {/* SIMULATED PERSPECTIVE VIEWPORT GRID OVERLAY */}
      <div className="viewport-grid-overlay" />

      {/* HEADER */}
      <header className="relative z-10 grid grid-cols-[1fr_auto] items-end border-b border-[rgba(248,248,248,0.1)] bg-[#0d0d0f]/85 px-6 py-4 md:px-8 md:py-6 backdrop-blur-md">
        <div>
          <h1 className="font-['Inter',sans-serif] text-2xl sm:text-3xl md:text-4xl font-black uppercase leading-[0.92] tracking-[-0.03em] text-[#f8f8f8]">
            <span className="block">ARC</span>
            <span className="block brand-stroke">STREETRACING</span>
          </h1>
        </div>

        {/* LIVE ROOM STATUS + GAME MUTE BUTTON + COMPACT ARC TESTNET WALLET BAR */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div
            data-testid="live-room-badge"
            className={`px-3.5 py-1.5 font-['Space_Mono',monospace] text-xs font-bold ${
              roomState
                ? 'bg-[#2563eb] text-white'
                : 'border border-[rgba(248,248,248,0.18)] bg-[#16161a] text-[#f8f8f8]'
            }`}
          >
            {roomState
              ? `ROOM ${roomState.roomCode} • ${roomState.stakedCount}/${roomState.connectedCount} STAKED`
              : online.connectionStatus === 'connected'
                ? 'LIVE SERVER • 2–4P'
                : 'CONNECTING...'}
          </div>

          <button
            type="button"
            data-testid="btn-toggle-mute"
            onClick={onToggleMute}
            aria-pressed={isMuted}
            aria-label={isMuted ? 'Unmute game audio' : 'Mute game audio'}
            title="Toggle game sound (Shortcut: M)"
            className={`cursor-pointer flex items-center gap-1.5 border px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.66rem] font-bold uppercase transition ${
              isMuted
                ? 'border-[#f43f5e]/60 bg-[#f43f5e]/15 text-[#f43f5e] hover:bg-[#f43f5e]/25'
                : 'border-[rgba(248,248,248,0.15)] bg-[#16161a] text-[#f8f8f8] hover:border-[#2563eb]'
            }`}
          >
            {isMuted ? (
              <svg
                className="h-3.5 w-3.5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg
                className="h-3.5 w-3.5 shrink-0 text-[#4ade80]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
            <span>{isMuted ? 'MUTED' : 'SOUND'}</span>
          </button>

          <div
            data-testid="arc-wallet-bar"
            className="flex items-center gap-2 border border-[rgba(248,248,248,0.15)] bg-[#16161a] px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.66rem]"
          >
            <span
              className="text-[#3b82f6] font-bold"
              title={`Arc Testnet (Chain ID: ${ARC_TESTNET_CHAIN_ID})`}
            >
              ARC
            </span>
            <span className="text-[rgba(248,248,248,0.25)]">|</span>
            <span
              data-testid="arc-wallet-balance"
              className="font-bold text-[#4ade80]"
            >
              {arcWallet.balanceUsdc} USDC
            </span>
            <a
              href={walletExplorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[#f8f8f8] opacity-70 hover:opacity-100 underline"
              title="Open wallet on Arc Testnet Explorer"
            >
              {shortenAddress(arcWallet.address)}
            </a>

            {arcWallet.mode === 'embedded_arc' ? (
              <>
                <button
                  type="button"
                  data-testid="btn-faucet-usdc"
                  onClick={onFaucetTopUpUsdc}
                  className="cursor-pointer border border-[#2563eb] bg-[#2563eb]/20 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-[#3b82f6] hover:bg-[#2563eb] hover:text-white transition"
                  title="Mint +50 Testnet USDC to embedded Arc wallet"
                >
                  +50 USDC
                </button>
                <button
                  type="button"
                  data-testid="btn-connect-metamask"
                  onClick={() => void onConnectInjectedWallet()}
                  className="cursor-pointer border border-[rgba(248,248,248,0.2)] bg-black px-1.5 py-0.5 text-[0.6rem] uppercase text-[#f8f8f8] hover:border-[#2563eb] transition"
                  title="Connect MetaMask or Rabby on Arc Testnet"
                >
                  Wallet
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onSwitchToEmbeddedWallet}
                className="cursor-pointer border border-[rgba(248,248,248,0.2)] bg-black px-1.5 py-0.5 text-[0.6rem] uppercase text-[#f8f8f8] hover:border-[#2563eb] transition"
              >
                Test Wallet
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="relative z-10 grid min-h-0 w-full grid-cols-[300px_1fr] md:grid-cols-[350px_1fr] gap-[1px] bg-[rgba(248,248,248,0.1)] overflow-hidden">
        {/* LEFT CONTROLS PANEL */}
        <aside className="flex h-full w-full flex-col gap-4 justify-self-start bg-[#0d0d0f] p-5 md:p-6 overflow-y-auto">
          <div className="grid grid-cols-1 gap-1.5">
            <button
              type="button"
              data-testid="tab-quick-match"
              onClick={() => handleSelectTab('quick_match')}
              className={`cursor-pointer border p-3 text-left font-['Space_Mono',monospace] text-xs uppercase transition ${
                activeTab === 'quick_match'
                  ? 'border-[#f8f8f8] bg-[#f8f8f8] text-[#0d0d0f] font-bold'
                  : 'border-[rgba(248,248,248,0.1)] bg-transparent text-[#f8f8f8] hover:border-[rgba(248,248,248,0.35)]'
              }`}
            >
              Quick Match (2–4P)
            </button>
            <button
              type="button"
              data-testid="tab-create-room"
              onClick={() => handleSelectTab('create_room')}
              className={`cursor-pointer border p-3 text-left font-['Space_Mono',monospace] text-xs uppercase transition ${
                activeTab === 'create_room'
                  ? 'border-[#f8f8f8] bg-[#f8f8f8] text-[#0d0d0f] font-bold'
                  : 'border-[rgba(248,248,248,0.1)] bg-transparent text-[#f8f8f8] hover:border-[rgba(248,248,248,0.35)]'
              }`}
            >
              Create Room
            </button>
            <button
              type="button"
              data-testid="tab-join-room"
              onClick={() => handleSelectTab('join_room')}
              className={`cursor-pointer border p-3 text-left font-['Space_Mono',monospace] text-xs uppercase transition ${
                activeTab === 'join_room'
                  ? 'border-[#f8f8f8] bg-[#f8f8f8] text-[#0d0d0f] font-bold'
                  : 'border-[rgba(248,248,248,0.1)] bg-transparent text-[#f8f8f8] hover:border-[rgba(248,248,248,0.35)]'
              }`}
            >
              Join by Code
            </button>
          </div>

          {/* ROOM CODE CONTROLS */}

          {activeTab === 'create_room' && (
            <div className="flex flex-col gap-2">
              <div>
                <span className="block font-['Space_Mono',monospace] text-[0.6rem] uppercase opacity-40">
                  Private Room Code (Share With Friends)
                </span>
                {roomState ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      data-testid="created-room-code"
                      className="border border-[#2563eb] bg-black px-3 py-1.5 font-['Space_Mono',monospace] text-sm font-bold tracking-[0.2em] text-[#3b82f6]"
                    >
                      {roomState.roomCode}
                    </span>
                    <button
                      type="button"
                      data-testid="btn-copy-room-code"
                      onClick={handleCopyRoomCode}
                      className="cursor-pointer border border-[rgba(248,248,248,0.2)] bg-[#16161a] px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.65rem] uppercase text-[#f8f8f8] hover:border-[#f8f8f8]"
                    >
                      {copiedCode ? 'Copied!' : 'Copy Code'}
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-[0.74rem] opacity-70">
                    Click below to open a private server room and receive a live invite code.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'join_room' && (
            <form onSubmit={handleJoinByCodeSubmit} className="flex flex-col gap-2">
              <div>
                <label
                  htmlFor="join-room-code-input"
                  className="block font-['Space_Mono',monospace] text-[0.6rem] uppercase opacity-40"
                >
                  Enter 6-Character Room Code
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    id="join-room-code-input"
                    data-testid="input-join-room-code"
                    type="text"
                    value={joinCodeInput}
                    onChange={(e) =>
                      setJoinCodeInput(normalizeRoomCode(e.target.value))
                    }
                    placeholder="HWY-742"
                    maxLength={7}
                    className="w-full border border-[rgba(248,248,248,0.15)] bg-black p-2 font-['Space_Mono',monospace] text-xs uppercase tracking-widest text-white focus:border-[#2563eb] focus:outline-none"
                  />
                  <button
                    type="submit"
                    data-testid="btn-join-room-submit"
                    className="cursor-pointer border border-[#2563eb] bg-transparent px-3 py-2 font-['Space_Mono',monospace] text-xs font-bold uppercase text-[#3b82f6] hover:bg-[#2563eb] hover:text-white transition"
                  >
                    Connect
                  </button>
                </div>
              </div>
              {roomState && (
                <div
                  data-testid="join-room-status"
                  className="font-['Space_Mono',monospace] text-xs text-[#4ade80]"
                >
                  Connected to Room #{roomState.roomCode}
                </div>
              )}
              {joinInputError && (
                <div className="font-['Space_Mono',monospace] text-xs text-[#f43f5e]">
                  {joinInputError}
                </div>
              )}
            </form>
          )}

          {/* SERVER ERROR / NOTICE BANNER */}
          {online.lastError && (
            <div
              data-testid="online-error-banner"
              className="border border-[#f43f5e]/60 bg-[#f43f5e]/15 px-3 py-2 font-['Space_Mono',monospace] text-[0.66rem] text-[#fda4af]"
            >
              {online.lastError}
            </div>
          )}

          {online.lastNotice && !online.lastError && (
            <div
              data-testid="online-notice-banner"
              className="border border-[#2563eb]/40 bg-[#2563eb]/10 px-3 py-1.5 font-['Space_Mono',monospace] text-[0.64rem] text-[#93c5fd]"
            >
              {online.lastNotice}
            </div>
          )}

          {/* ARC USDC SELF-WAGER POOL (WINNER TAKES ALL) + ORION PROTOCOL */}
          <div
            data-testid="orion-wager-panel"
            className="border border-[rgba(248,248,248,0.12)] bg-[#16161a] p-3.5 flex flex-col gap-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-['Space_Mono',monospace] text-[0.58rem] font-bold uppercase text-[#3b82f6] whitespace-nowrap">
                USDC Escrow • Winner Takes All
              </span>
              <a
                href={hubExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-['Space_Mono',monospace] text-[0.56rem] uppercase text-[#f8f8f8] opacity-50 hover:opacity-100 underline whitespace-nowrap"
                title="View Orion RandomnessHub v2 on Arc Testnet Explorer"
              >
                Orion Hub v2 ↗
              </a>
            </div>

            {/* Stake Tier Buttons */}
            <div className="grid grid-cols-4 gap-1">
              {STAKE_TIERS_USDC.map((tier) => {
                const isSelected = activeStakeStr.trim() === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    disabled={stakeEditingLocked}
                    data-testid={`stake-tier-${tier}`}
                    onClick={() => handleStakeTierChange(tier)}
                    className={`border py-1.5 font-['Space_Mono',monospace] text-[0.65rem] font-bold uppercase transition ${
                      stakeEditingLocked
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer'
                    } ${
                      isSelected
                        ? 'border-[#2563eb] bg-[#2563eb] text-white'
                        : 'border-[rgba(248,248,248,0.12)] bg-black text-[#f8f8f8] opacity-75 hover:opacity-100'
                    }`}
                  >
                    ${tier}
                  </button>
                );
              })}
            </div>

            {/* Custom Stake Amount Input */}
            <div>
              <label
                htmlFor="custom-stake-usdc-input"
                className="block font-['Space_Mono',monospace] text-[0.58rem] uppercase opacity-45"
              >
                Custom Match Stake (USDC)
              </label>
              <div className="mt-1 flex items-center border border-[rgba(248,248,248,0.15)] bg-black focus-within:border-[#2563eb]">
                <span className="pl-2.5 font-['Space_Mono',monospace] text-xs font-bold text-[#3b82f6]">
                  $
                </span>
                <input
                  id="custom-stake-usdc-input"
                  data-testid="input-custom-stake-usdc"
                  type="text"
                  inputMode="decimal"
                  disabled={stakeEditingLocked}
                  value={activeStakeStr}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9.]/g, '');
                    const parts = raw.split('.');
                    const sanitized =
                      parts.length > 2
                        ? `${parts[0]}.${parts.slice(1).join('').slice(0, 6)}`
                        : parts.length === 2
                          ? `${parts[0]}.${parts[1].slice(0, 6)}`
                          : raw;
                    handleStakeTierChange(sanitized as StakeTierUsdc);
                  }}
                  placeholder="Enter amount (e.g. 5)"
                  className="w-full bg-transparent px-2 py-1.5 font-['Space_Mono',monospace] text-xs font-bold text-white focus:outline-none disabled:opacity-50"
                />
                <span className="pr-2.5 font-['Space_Mono',monospace] text-[0.6rem] uppercase opacity-50">
                  USDC
                </span>
              </div>
            </div>

            {wagerBreakdown.isWagerEnabled ? (
              <div className="font-['Space_Mono',monospace] text-[0.65rem] flex flex-col gap-1 border-t border-[rgba(248,248,248,0.08)] pt-2">
                <div className="flex justify-between">
                  <span className="opacity-50">EACH STAKES ON SELF:</span>
                  <span className="font-bold text-white">
                    {wagerBreakdown.stakePerPlayerUsdc.toFixed(2)} USDC
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-50">ORION RELAYER REWARD:</span>
                  <span className="text-[#3b82f6]">
                    {wagerBreakdown.relayerRewardUsdc.toFixed(2)} USDC
                  </span>
                </div>
                <div className="flex justify-between border-t border-[rgba(248,248,248,0.08)] pt-1">
                  <span className="opacity-75 font-bold">
                    WINNER POT ({projectedPlayerCount}×):
                  </span>
                  <span
                    data-testid="wager-total-pot"
                    className="font-bold text-[#4ade80]"
                  >
                    {projectedPotUsdc} USDC
                  </span>
                </div>

                {escrowRemainingSec !== null && (
                  <div
                    data-testid="escrow-timeout-banner"
                    className="mt-1 border border-[#fbb124]/40 bg-[#fbb124]/10 px-2 py-1 text-[0.6rem] text-[#fcd34d]"
                  >
                    PRE-RACE TIMER: {escrowRemainingSec}s (auto-refund if lobby does not launch)
                  </div>
                )}

                <div className="mt-0.5 flex justify-between text-[0.58rem] opacity-55">
                  <span>drand evmnet:</span>
                  <span>
                    {roomState
                      ? `Round #${roomState.orionRound}`
                      : orionTelemetry?.latestDrandRound
                        ? `Round #${orionTelemetry.latestDrandRound}`
                        : '3s Beacon'}
                  </span>
                </div>
                <div className="text-[0.56rem] opacity-45">
                  Mid-race disconnect forfeits locked stake to pot.
                </div>
              </div>
            ) : (
              <div className="font-['Space_Mono',monospace] text-[0.63rem] opacity-60">
                Enter a USDC stake amount (&gt; 0) to wager with live players.
              </div>
            )}

            {walletStatusMessage && (
              <div className="font-['Space_Mono',monospace] text-[0.62rem] text-[#3b82f6]">
                {walletStatusMessage}
              </div>
            )}

            {/* LAST SETTLED RACE PAYOUT PROOF */}
            {lastSettledEscrow && (
              <div
                data-testid="orion-settlement-banner"
                className="border border-[#2563eb]/60 bg-black p-2.5 font-['Space_Mono',monospace] text-[0.62rem] flex flex-col gap-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#4ade80]">
                    SETTLED • WINNER: {lastSettledEscrow.winnerCallsign}
                  </span>
                  <span className="font-bold text-white">
                    +{lastSettledEscrow.totalPotUsdc} USDC
                  </span>
                </div>
                <div className="truncate opacity-60">
                  Orion Round #{lastSettledEscrow.targetDrandRound}
                </div>
                {lastSettledEscrow.randomnessHex && (
                  <div className="truncate opacity-50">
                    Beacon: {lastSettledEscrow.randomnessHex.slice(0, 22)}...
                  </div>
                )}
                {lastSettledEscrow.txHash && (
                  <a
                    href={buildTxExplorerUrl(
                      ARC_TESTNET_CHAIN_ID,
                      lastSettledEscrow.txHash,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#3b82f6] underline"
                  >
                    View Tx on Arc Testnet Explorer ↗
                  </a>
                )}
              </div>
            )}
          </div>

          {/* ACTION AREA */}
          <div className="mt-auto flex flex-col gap-2.5">
            {roomState ? (
              <div className="grid grid-cols-2 gap-2">
                {activeTab === 'create_room' && (
                  <button
                    type="button"
                    data-testid="btn-new-room"
                    onClick={() => online.createRoom(stakeTierUsdc)}
                    className="cursor-pointer border border-[#2563eb] bg-transparent p-2.5 text-[0.68rem] font-bold uppercase text-[#3b82f6] transition hover:bg-[#2563eb]/15"
                  >
                    New Room
                  </button>
                )}
                <button
                  type="button"
                  data-testid="btn-leave-room"
                  onClick={() => online.leaveRoom()}
                  className={`cursor-pointer border border-[rgba(248,248,248,0.2)] bg-transparent p-2.5 text-[0.68rem] font-bold uppercase text-[#f8f8f8] transition hover:border-[#f43f5e] hover:text-[#f43f5e] ${
                    activeTab === 'create_room' ? '' : 'col-span-2'
                  }`}
                >
                  Leave Room #{roomState.roomCode}
                </button>
              </div>
            ) : activeTab === 'quick_match' ? (
              <button
                type="button"
                data-testid="btn-search-match"
                disabled={online.connectionStatus !== 'connected'}
                onClick={() => online.quickMatch(stakeTierUsdc)}
                className="cursor-pointer border border-[#2563eb] bg-transparent p-3 text-xs font-bold uppercase text-[#3b82f6] transition hover:bg-[#2563eb]/15 disabled:opacity-40"
              >
                Find Live Room (2–4P)
              </button>
            ) : null}

            <button
              type="button"
              data-testid="btn-instant-race"
              disabled={primaryCtaDisabled}
              onClick={handlePrimaryCtaClick}
              className={`border-none p-4 text-sm md:text-base font-black uppercase tracking-[0.06em] text-white transition ${
                primaryCtaDisabled
                  ? 'bg-[#16161a] opacity-50 cursor-not-allowed'
                  : isLocalStaked
                    ? 'cursor-pointer bg-[#15803d] hover:bg-[#16a34a]'
                    : 'cursor-pointer bg-[#2563eb] hover:bg-[#3b82f6]'
              }`}
            >
              {primaryCtaLabel}
            </button>
          </div>
        </aside>

        {/* RIGHT 2x2 GRID PANEL + RECENT RACES DASHBOARD */}
        <section className="grid h-full min-h-0 grid-cols-[repeat(2,minmax(300px,450px))] auto-rows-max content-start justify-center gap-3.5 bg-[#0d0d0f]/40 px-8 py-4 overflow-y-auto">
          {gridSlots.map((slot) => (
            <div
              key={slot.laneIndex}
              data-testid={`lobby-slot-${slot.laneIndex}`}
              data-slot-status={slot.status}
              className={`relative flex w-full max-w-[450px] min-h-[192px] flex-col justify-between border bg-[#16161a] px-5 py-4 transition ${
                slot.isLocalPlayer
                  ? 'border-[#2563eb] shadow-[0_0_40px_rgba(37,99,235,0.18)]'
                  : 'border-[rgba(248,248,248,0.1)]'
              }`}
            >
              <div>
                {/* SLOT HEADER */}
                <div className="mb-2.5 flex items-center justify-between">
                  <span
                    className={`px-2 py-0.5 font-['Space_Mono',monospace] text-xs font-bold ${
                      slot.isLocalPlayer
                        ? 'bg-[#2563eb] text-white'
                        : 'bg-[rgba(248,248,248,0.1)] text-[#f8f8f8]'
                    }`}
                  >
                    {slot.slotCode}
                  </span>

                  {slot.status === 'staked' ? (
                    <span className="border border-[#4ade80]/50 bg-[#4ade80]/15 px-2 py-0.5 font-['Space_Mono',monospace] text-[0.68rem] font-bold text-[#4ade80]">
                      STAKED: {slot.stakeUsdcFormatted} USDC
                    </span>
                  ) : slot.status !== 'waiting' && wagerBreakdown.isWagerEnabled ? (
                    <span className="border border-[#2563eb]/50 bg-[#2563eb]/15 px-2 py-0.5 font-['Space_Mono',monospace] text-[0.68rem] font-bold text-[#3b82f6]">
                      STAKE: {wagerBreakdown.stakePerPlayerUsdc.toString()} USDC
                    </span>
                  ) : (
                    <span className="font-['Space_Mono',monospace] text-[0.62rem] uppercase opacity-35">
                      {slot.laneLabel}
                    </span>
                  )}
                </div>

                {/* DRIVER / CALLSIGN */}
                {slot.isLocalPlayer ? (
                  <div>
                    <label
                      htmlFor="local-player-nickname"
                      className="block font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-40"
                    >
                      Callsign ({slot.walletAddress})
                    </label>
                    <input
                      id="local-player-nickname"
                      data-testid="input-player-nickname"
                      type="text"
                      value={playerNickname}
                      maxLength={16}
                      onChange={(e) => handleNicknameChange(e.target.value)}
                      className="mt-1 w-full border border-[rgba(248,248,248,0.1)] bg-black px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.95rem] text-white focus:border-[#2563eb] focus:outline-none"
                    />
                  </div>
                ) : (
                  <div>
                    <span className="block font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-40">
                      {slot.status === 'waiting'
                        ? 'Live Human Slot'
                        : `Driver (${slot.walletAddress})`}
                    </span>
                    <div
                      className={`mt-0.5 text-lg font-bold ${
                        slot.status === 'waiting' ? 'opacity-45' : ''
                      }`}
                    >
                      {slot.status === 'waiting'
                        ? 'Waiting for player...'
                        : slot.nickname}
                    </div>
                  </div>
                )}

                {/* VEHICLE & PAINT */}
                <div className="mt-2.5">
                  <div>
                    <span className="block font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-40">
                      Vehicle
                    </span>
                    <div
                      data-testid={
                        slot.isLocalPlayer ? 'local-chassis-name' : undefined
                      }
                      className="mt-0.5 text-[1.08rem] font-bold truncate"
                    >
                      {slot.chassisName}
                    </div>

                    {slot.isLocalPlayer ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        {PAINT_SWATCHES.map((sw) => {
                          const isSelected =
                            normalizePaintHex(slot.paintColor) ===
                            sw.hex.toLowerCase();
                          const holder = getColorHolder(sw.hex);
                          const isLockedByOther = holder.taken && !isSelected;
                          return (
                            <button
                              key={sw.hex}
                              type="button"
                              data-testid={`paint-swatch-${sw.name.toLowerCase()}`}
                              data-occupied={isLockedByOther ? 'true' : 'false'}
                              disabled={isLockedByOther}
                              aria-disabled={isLockedByOther}
                              aria-label={
                                isLockedByOther
                                  ? `${sw.name} (Occupied by ${holder.holderSlotCode})`
                                  : `Select ${sw.name} paint`
                              }
                              onClick={() => handleSelectLocalPaintColor(sw.hex)}
                              className={`relative flex h-[18px] w-[18px] items-center justify-center transition ${
                                isLockedByOther
                                  ? 'cursor-not-allowed opacity-40'
                                  : 'cursor-pointer hover:scale-110'
                              }`}
                              style={{
                                backgroundColor: sw.hex,
                                border: isSelected
                                  ? '2px solid #ffffff'
                                  : isLockedByOther
                                    ? '1px solid rgba(255,255,255,0.25)'
                                    : '1px solid rgba(255,255,255,0.15)',
                              }}
                              title={
                                isLockedByOther
                                  ? `${sw.name} — Occupied by ${holder.holderSlotCode} (${holder.holderName})`
                                  : `${sw.name} (Available)`
                              }
                            >
                              {isLockedByOther && (
                                <span
                                  aria-hidden="true"
                                  className="pointer-events-none select-none font-['Space_Mono',monospace] text-[10px] font-bold leading-none text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.95)]"
                                >
                                  ×
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div
                        data-testid={`slot-color-badge-${slot.laneIndex}`}
                        className="mt-1.5 flex items-center gap-2"
                      >
                        {slot.status !== 'waiting' ? (
                          <>
                            <span
                              className="inline-block h-[14px] w-[14px] shrink-0 border border-white/40"
                              style={{ backgroundColor: slot.paintColor }}
                            />
                            <span className="font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-75">
                              {getPaintSwatchName(slot.paintColor)} • Locked
                            </span>
                          </>
                        ) : (
                          <span className="font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-40">
                            No Color Locked • Zero AI Bots
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* READY STATUS FOOTER */}
              <div className="mt-2.5 flex items-center justify-between border-t border-[rgba(248,248,248,0.1)] pt-2.5">
                {slot.isLocalPlayer ? (
                  <>
                    <button
                      type="button"
                      data-testid="btn-toggle-ready"
                      disabled={
                        !roomState ||
                        roomState.status !== 'lobby' ||
                        (!isLocalStaked && !hasEnoughUsdcForWager)
                      }
                      onClick={() =>
                        isLocalStaked ? online.unlockStake() : online.lockStake()
                      }
                      className={`border-none px-3.5 py-1 text-xs font-bold uppercase transition ${
                        !roomState || roomState.status !== 'lobby'
                          ? 'bg-[rgba(248,248,248,0.12)] text-[#f8f8f8] opacity-55 cursor-not-allowed'
                          : isLocalStaked
                            ? 'cursor-pointer bg-[#4ade80] text-black'
                            : 'cursor-pointer bg-[#2563eb] text-white hover:bg-[#3b82f6]'
                      }`}
                    >
                      {!roomState
                        ? 'JOIN A ROOM'
                        : isLocalStaked
                          ? '✓ STAKED'
                          : 'LOCK STAKE'}
                    </button>
                    <span className="font-['Space_Mono',monospace] text-[0.66rem] uppercase opacity-50">
                      {online.pingMs}ms
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="font-['Space_Mono',monospace] text-xs uppercase"
                      style={{
                        color:
                          slot.status === 'staked'
                            ? '#4ade80'
                            : slot.status === 'connected'
                              ? '#3b82f6'
                              : '#fbb124',
                      }}
                    >
                      ●{' '}
                      {slot.status === 'staked'
                        ? 'STAKED'
                        : slot.status === 'connected'
                          ? 'CONNECTED'
                          : 'OPEN SLOT'}
                    </span>
                    <span className="font-['Space_Mono',monospace] text-[0.66rem] uppercase opacity-50">
                      {slot.pingMs !== null ? `${slot.pingMs}ms` : '---'}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}

          <RecentRacesDashboard sessions={recentRaces ?? DEFAULT_RECENT_RACES} />
        </section>
      </main>
    </div>
  );
};
