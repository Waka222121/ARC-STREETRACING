import React, { useEffect, useMemo, useState } from 'react';
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
import {
  DEFAULT_RECENT_RACES,
  RecentRacesDashboard,
} from './RecentRacesDashboard';

export type MultiplayerModeTab = 'quick_match' | 'create_room' | 'join_room';

export interface LobbyStartMeta {
  roomCode: string;
  slotCallsigns: [string, string, string, string];
  slotAddresses: [string, string, string, string];
  slotColors: [string, string, string, string];
}

interface MultiplayerMainMenuProps {
  carConfig: CarConfig;
  onUpdateCarConfig: (updater: (prev: CarConfig) => CarConfig) => void;
  playerNickname: string;
  onChangePlayerNickname: (name: string) => void;
  onStartRace: (meta: LobbyStartMeta) => Promise<void> | void;
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
  isLockingEscrow?: boolean;
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

const AI_RIVAL_SLOTS: Record<
  0 | 2 | 3,
  { slotCode: 'P2' | 'P3' | 'P4'; callsign: string; address: string; pingMs: number }
> = {
  0: {
    slotCode: 'P2',
    callsign: 'Vortex_02',
    address: '0x9a2F4401B7C1120E38c5D8496c1aB02E8F41C202',
    pingMs: 18,
  },
  2: {
    slotCode: 'P3',
    callsign: 'Kenshin_01',
    address: '0x4eB80219cA7410F93e20A8814d6E319B12D0A103',
    pingMs: 24,
  },
  3: {
    slotCode: 'P4',
    callsign: 'Apex_03',
    address: '0xD31c7840E290F4b16A55C2398E71024a91B7F404',
    pingMs: 31,
  },
};

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function generateRoomCode(): string {
  const num = Math.floor(100 + Math.random() * 900);
  return `HWY-${num}`;
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
  onStartRace,
  onSlotOccupancyChange,
  onSlotColorsChange,
  arcWallet,
  stakeTierUsdc,
  onSelectStakeTier,
  onConnectInjectedWallet,
  onSwitchToEmbeddedWallet,
  onFaucetTopUpUsdc,
  isLockingEscrow = false,
  lastSettledEscrow,
  walletStatusMessage,
  recentRaces,
  isMuted = false,
  onToggleMute,
}) => {
  const [activeTab, setActiveTab] = useState<MultiplayerModeTab>('quick_match');
  const [roomCode, setRoomCode] = useState<string>(() => generateRoomCode());
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [joinedRoomCode, setJoinedRoomCode] = useState<string | null>(null);
  const [joinInputError, setJoinInputError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [isLocalReady, setIsLocalReady] = useState<boolean>(true);
  const [orionTelemetry, setOrionTelemetry] =
    useState<OrionHubTelemetry | null>(null);

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

  // Resolve 4 unique paint colors across P1..P4 (P1 = Lane 1, P2 = Lane 0, P3 = Lane 2, P4 = Lane 3)
  const laneColors = useMemo<[string, string, string, string]>(() => {
    return resolveUniqueLanePaintColors(carConfig.paintColor);
  }, [carConfig.paintColor]);

  // Keep 3D preview synchronized with all 4 occupied cars & unique colors
  useEffect(() => {
    onSlotOccupancyChange?.([true, true, true, true]);
  }, [onSlotOccupancyChange]);

  useEffect(() => {
    onSlotColorsChange?.(laneColors);
  }, [laneColors, onSlotColorsChange]);

  const wagerBreakdown = computeWagerBreakdown(stakeTierUsdc);
  const hasEnoughUsdcForWager =
    !wagerBreakdown.isWagerEnabled ||
    arcWallet.balanceRawUsdc6 >= wagerBreakdown.playerTotalLockUsdc.raw;

  const activeRoomDisplayCode =
    activeTab === 'join_room' && joinedRoomCode ? joinedRoomCode : roomCode;

  const getColorHolder = (
    targetHex: string,
  ): { taken: boolean; holderSlotCode?: string; holderName?: string } => {
    const norm = normalizePaintHex(targetHex);
    for (const laneIndex of [0, 2, 3] as const) {
      if (normalizePaintHex(laneColors[laneIndex]) === norm) {
        const ai = AI_RIVAL_SLOTS[laneIndex];
        return {
          taken: true,
          holderSlotCode: ai.slotCode,
          holderName: ai.callsign,
        };
      }
    }
    return { taken: false };
  };

  const handleSelectLocalPaintColor = (targetHex: string) => {
    const norm = normalizePaintHex(targetHex);
    onUpdateCarConfig((prev) => ({
      ...prev,
      paintColor: norm,
      underglowColor: norm,
    }));
  };

  const handleCopyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setCopiedCode(false);
    }
  };

  const handleJoinByCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formatted = normalizeRoomCode(joinCodeInput);
    if (formatted.length < 4) {
      setJoinInputError('Enter a valid 6-character room code first');
      return;
    }
    setJoinInputError(null);
    setJoinedRoomCode(formatted);
  };

  const handleLaunchRace = () => {
    if (isLockingEscrow || !hasEnoughUsdcForWager) return;
    const callsigns: [string, string, string, string] = [
      AI_RIVAL_SLOTS[0].callsign,
      playerNickname.trim() || 'RACER_01',
      AI_RIVAL_SLOTS[2].callsign,
      AI_RIVAL_SLOTS[3].callsign,
    ];
    const addresses: [string, string, string, string] = [
      AI_RIVAL_SLOTS[0].address,
      arcWallet.address,
      AI_RIVAL_SLOTS[2].address,
      AI_RIVAL_SLOTS[3].address,
    ];
    void onStartRace({
      roomCode: activeRoomDisplayCode,
      slotCallsigns: callsigns,
      slotAddresses: addresses,
      slotColors: laneColors,
    });
  };

  const gridSlots = DISPLAY_LANE_ORDER.map((laneIndex) => {
    if (laneIndex === 1) {
      return {
        laneIndex,
        laneLabel: LANE_LABELS[laneIndex],
        slotCode: 'P1 • YOU',
        isLocalPlayer: true,
        nickname: playerNickname,
        walletAddress: shortenAddress(arcWallet.address),
        pingMs: 12,
        chassisName: UNIFIED_CAR_MODEL_NAME,
        paintColor: laneColors[1],
        isReady: isLocalReady,
      };
    }

    const ai = AI_RIVAL_SLOTS[laneIndex];
    return {
      laneIndex,
      laneLabel: LANE_LABELS[laneIndex],
      slotCode: ai.slotCode,
      isLocalPlayer: false,
      nickname: ai.callsign,
      walletAddress: shortenAddress(ai.address),
      pingMs: ai.pingMs,
      chassisName: UNIFIED_CAR_MODEL_NAME,
      paintColor: laneColors[laneIndex],
      isReady: true,
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

  const primaryCtaDisabled = isLockingEscrow || !hasEnoughUsdcForWager;

  const primaryCtaLabel = (() => {
    if (isLockingEscrow) {
      return 'Locking USDC Escrow...';
    }
    if (!hasEnoughUsdcForWager) {
      return 'Insufficient USDC (Use +50 USDC)';
    }
    if (wagerBreakdown.isWagerEnabled) {
      return `Stake ${wagerBreakdown.stakePerPlayerUsdc.toString()} USDC & Race (Pot ${wagerBreakdown.totalPotUsdc.toString()} USDC) —>`;
    }
    return 'Start Free 4P Race —>';
  })();

  return (
    <div
      data-testid="multiplayer-main-menu"
      className="fixed inset-0 z-50 grid h-screen w-screen grid-rows-[auto_1fr] overflow-y-auto lg:overflow-hidden bg-[#0d0d0f]/85 text-[#f8f8f8]"
    >
      {/* SIMULATED PERSPECTIVE VIEWPORT GRID OVERLAY */}
      <div className="viewport-grid-overlay" />

      {/* HEADER */}
      <header className="relative z-10 flex flex-col gap-3 sm:grid sm:grid-cols-[1fr_auto] sm:items-end border-b border-[rgba(248,248,248,0.1)] bg-[#0d0d0f]/85 px-4 py-3.5 sm:px-6 sm:py-4 md:px-8 md:py-6 backdrop-blur-md">
        <div>
          <h1 className="font-['Inter',sans-serif] text-2xl sm:text-3xl md:text-4xl font-black uppercase leading-[0.92] tracking-[-0.03em] text-[#f8f8f8]">
            <span className="block">ARC</span>
            <span className="block brand-stroke">STREETRACING</span>
          </h1>
        </div>

        {/* LOBBY STATUS + GAME MUTE BUTTON + COMPACT ARC TESTNET WALLET BAR */}
        <div className="flex flex-wrap items-center justify-start sm:justify-end gap-2">
          <div
            data-testid="live-room-badge"
            className="bg-[#2563eb] px-3.5 py-1.5 font-['Space_Mono',monospace] text-xs font-bold text-white"
          >
            {activeTab === 'quick_match'
              ? '4P HIGHWAY • 4/4 READY'
              : `ROOM ${activeRoomDisplayCode} • 4/4 READY`}
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
      <main className="relative z-10 grid min-h-0 w-full grid-cols-1 lg:grid-cols-[350px_1fr] gap-[1px] bg-[rgba(248,248,248,0.1)] lg:overflow-hidden">
        {/* LEFT CONTROLS PANEL */}
        <aside className="flex w-full flex-col gap-4 justify-self-start bg-[#0d0d0f] p-4 sm:p-5 md:p-6 lg:h-full lg:overflow-y-auto">
          <div className="grid grid-cols-1 gap-1.5">
            <button
              type="button"
              data-testid="tab-quick-match"
              onClick={() => setActiveTab('quick_match')}
              className={`cursor-pointer border p-3 text-left font-['Space_Mono',monospace] text-xs uppercase transition ${
                activeTab === 'quick_match'
                  ? 'border-[#f8f8f8] bg-[#f8f8f8] text-[#0d0d0f] font-bold'
                  : 'border-[rgba(248,248,248,0.1)] bg-transparent text-[#f8f8f8] hover:border-[rgba(248,248,248,0.35)]'
              }`}
            >
              Quick Match (4P)
            </button>
            <button
              type="button"
              data-testid="tab-create-room"
              onClick={() => setActiveTab('create_room')}
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
              onClick={() => setActiveTab('join_room')}
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
                  Private Room Code
                </span>
                <div className="mt-1.5 flex items-center gap-2">
                  <span
                    data-testid="created-room-code"
                    className="border border-[#2563eb] bg-black px-3 py-1.5 font-['Space_Mono',monospace] text-sm font-bold tracking-[0.2em] text-[#3b82f6]"
                  >
                    {roomCode}
                  </span>
                  <button
                    type="button"
                    data-testid="btn-copy-room-code"
                    onClick={() => void handleCopyRoomCode()}
                    className="cursor-pointer border border-[rgba(248,248,248,0.2)] bg-[#16161a] px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.65rem] uppercase text-[#f8f8f8] hover:border-[#f8f8f8]"
                  >
                    {copiedCode ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    data-testid="btn-new-room"
                    onClick={() => setRoomCode(generateRoomCode())}
                    className="cursor-pointer border border-[rgba(248,248,248,0.2)] bg-[#16161a] px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.65rem] uppercase text-[#f8f8f8] hover:border-[#2563eb]"
                  >
                    New
                  </button>
                </div>
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
              {joinedRoomCode && (
                <div
                  data-testid="join-room-status"
                  className="font-['Space_Mono',monospace] text-xs text-[#4ade80]"
                >
                  Connected to Room #{joinedRoomCode} (3 AI Bots Ready)
                </div>
              )}
              {joinInputError && (
                <div className="font-['Space_Mono',monospace] text-xs text-[#f43f5e]">
                  {joinInputError}
                </div>
              )}
            </form>
          )}

          {/* ARC USDC SELF-WAGER POOL (WINNER TAKES ALL) + ORION PROTOCOL */}
          <div
            data-testid="orion-wager-panel"
            className="border border-[rgba(248,248,248,0.12)] bg-[#16161a] p-3.5 flex flex-col gap-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-['Space_Mono',monospace] text-[0.58rem] font-bold uppercase text-[#3b82f6] whitespace-nowrap">
                USDC Self-Wager • Winner Takes All
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
                const isSelected = stakeTierUsdc.trim() === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    data-testid={`stake-tier-${tier}`}
                    onClick={() => onSelectStakeTier(tier)}
                    className={`cursor-pointer border py-1.5 font-['Space_Mono',monospace] text-xs font-bold transition ${
                      isSelected
                        ? 'border-[#2563eb] bg-[#2563eb] text-white'
                        : 'border-[rgba(248,248,248,0.15)] bg-black text-[#f8f8f8] hover:border-[#2563eb]'
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
                  value={stakeTierUsdc}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9.]/g, '');
                    const parts = raw.split('.');
                    const sanitized =
                      parts.length > 2
                        ? `${parts[0]}.${parts.slice(1).join('').slice(0, 6)}`
                        : parts.length === 2
                          ? `${parts[0]}.${parts[1].slice(0, 6)}`
                          : raw;
                    onSelectStakeTier(sanitized as StakeTierUsdc);
                  }}
                  placeholder="Enter amount (e.g. 5)"
                  className="w-full bg-transparent px-2 py-1.5 font-['Space_Mono',monospace] text-xs font-bold text-white focus:outline-none"
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
                  <span className="opacity-75 font-bold">WINNER POT (4×):</span>
                  <span
                    data-testid="wager-total-pot"
                    className="font-bold text-[#4ade80]"
                  >
                    {wagerBreakdown.totalPotUsdc.toFixed(2)} USDC
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between text-[0.58rem] opacity-55">
                  <span>drand evmnet:</span>
                  <span>
                    {orionTelemetry?.latestDrandRound
                      ? `Round #${orionTelemetry.latestDrandRound}`
                      : '3s Beacon'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="font-['Space_Mono',monospace] text-[0.63rem] opacity-60">
                Free practice mode (0 USDC staked). Enter an amount &gt; 0 to wager.
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
            <button
              type="button"
              data-testid="btn-instant-race"
              disabled={primaryCtaDisabled}
              onClick={handleLaunchRace}
              className={`border-none p-4 text-sm md:text-base font-black uppercase tracking-[0.06em] text-white transition ${
                primaryCtaDisabled
                  ? 'bg-[#16161a] opacity-50 cursor-not-allowed'
                  : 'cursor-pointer bg-[#2563eb] hover:bg-[#3b82f6]'
              }`}
            >
              {primaryCtaLabel}
            </button>
          </div>
        </aside>

        {/* RIGHT 2x2 GRID PANEL + RECENT RACES DASHBOARD */}
        <section className="grid w-full min-h-0 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[repeat(2,minmax(300px,450px))] auto-rows-max content-start justify-center gap-3.5 bg-[#0d0d0f]/40 px-4 py-4 sm:px-6 lg:h-full lg:px-8 lg:overflow-y-auto">
          {gridSlots.map((slot) => (
            <div
              key={slot.laneIndex}
              data-testid={`lobby-slot-${slot.laneIndex}`}
              data-slot-status="ready"
              className={`relative flex w-full max-w-[450px] mx-auto sm:mx-0 min-h-[192px] flex-col justify-between border bg-[#16161a] px-4 sm:px-5 py-4 transition ${
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

                  {wagerBreakdown.isWagerEnabled ? (
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
                      onChange={(e) => onChangePlayerNickname(e.target.value)}
                      className="mt-1 w-full border border-[rgba(248,248,248,0.1)] bg-black px-2.5 py-1.5 font-['Space_Mono',monospace] text-[0.95rem] text-white focus:border-[#2563eb] focus:outline-none"
                    />
                  </div>
                ) : (
                  <div>
                    <span className="block font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-40">
                      AI Rival ({slot.walletAddress})
                    </span>
                    <div className="mt-0.5 text-lg font-bold">
                      {slot.nickname}
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
                          return (
                            <button
                              key={sw.hex}
                              type="button"
                              data-testid={`paint-swatch-${sw.name.toLowerCase()}`}
                              data-occupied={holder.taken ? 'true' : 'false'}
                              aria-label={`Select ${sw.name} paint`}
                              onClick={() => handleSelectLocalPaintColor(sw.hex)}
                              className="relative flex h-[18px] w-[18px] cursor-pointer items-center justify-center transition hover:scale-110"
                              style={{
                                backgroundColor: sw.hex,
                                border: isSelected
                                  ? '2px solid #ffffff'
                                  : '1px solid rgba(255,255,255,0.2)',
                              }}
                              title={
                                holder.taken
                                  ? `${sw.name} — Click to claim (${holder.holderSlotCode} auto-swaps)`
                                  : `${sw.name}`
                              }
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div
                        data-testid={`slot-color-badge-${slot.laneIndex}`}
                        className="mt-1.5 flex items-center gap-2"
                      >
                        <span
                          className="inline-block h-[14px] w-[14px] shrink-0 border border-white/40"
                          style={{ backgroundColor: slot.paintColor }}
                        />
                        <span className="font-['Space_Mono',monospace] text-[0.64rem] uppercase opacity-75">
                          {getPaintSwatchName(slot.paintColor)} • AI Bot
                        </span>
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
                      onClick={() => setIsLocalReady((prev) => !prev)}
                      className={`cursor-pointer border-none px-3.5 py-1 text-xs font-bold uppercase transition ${
                        isLocalReady
                          ? 'bg-[#4ade80] text-black'
                          : 'bg-[#2563eb] text-white hover:bg-[#3b82f6]'
                      }`}
                    >
                      {isLocalReady ? '✓ READY' : 'READY UP'}
                    </button>
                    <span className="font-['Space_Mono',monospace] text-[0.66rem] uppercase opacity-50">
                      {slot.pingMs}ms
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-['Space_Mono',monospace] text-xs uppercase text-[#4ade80]">
                      ● READY • AI BOT
                    </span>
                    <span className="font-['Space_Mono',monospace] text-[0.66rem] uppercase opacity-50">
                      {slot.pingMs}ms
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
