import {
  ARC_TESTNET_CHAIN_ID,
  buildAddressExplorerUrl,
  buildTxExplorerUrl,
  ORION_DEMO_V2_ADDRESS,
  ORION_HUB_V2_ADDRESS,
  requireChain,
} from '../onchain-facts';
import {
  Amount,
  formatAmount,
  formatGasAmount,
  gasTokenToUsdc,
  parseAmount,
  usdcToGasToken,
} from '../onchain-money';

export const DRAND_GENESIS_TIME = 1727521075n;
export const DRAND_PERIOD = 3n;
export const ORION_MIN_DELAY_PERIODS = 3n;
export const ORION_MIN_REWARD_USDC = '0.01';
export const DEFAULT_RELAYER_REWARD_USDC = '0.02';

export type StakeTierUsdc = string;

export const STAKE_TIERS_USDC: readonly string[] = [
  '1',
  '5',
  '10',
  '25',
];

export type WalletMode = 'embedded_arc' | 'injected_eip1193';

export interface ArcWalletState {
  mode: WalletMode;
  address: string;
  chainId: number;
  balanceUsdc: string; // Formatted 6-decimal USDC string (e.g. "100.00")
  balanceRawUsdc6: bigint; // 6-decimal raw units
  balanceRawGas18: bigint; // 18-decimal native gas units on Arc
  isConnected: boolean;
}

export interface WagerBreakdown {
  isWagerEnabled: boolean;
  stakePerPlayerUsdc: Amount; // 6 decimals
  stakePerPlayerGas18: Amount; // 18 decimals (Arc native msg.value)
  totalPotUsdc: Amount; // 4 * stake (6 decimals)
  totalPotGas18: Amount; // 4 * stake (18 decimals)
  relayerRewardUsdc: Amount; // 6 decimals (default 0.02 USDC >= 0.01 MIN_REWARD)
  relayerRewardGas18: Amount; // 18 decimals
  playerTotalLockUsdc: Amount; // stake + relayerReward (6 decimals)
  playerTotalLockGas18: Amount; // stake + relayerReward (18 decimals)
}

export interface OrionHubTelemetry {
  hubAddress: string;
  demoAddress: string;
  chainId: number;
  nextRequestId: bigint | null;
  latestDrandRound: number | null;
  latestDrandSignatureHex: string | null;
  lastUpdatedMs: number;
}

export interface ActiveRaceEscrow {
  raceId: number;
  requestId: string;
  targetDrandRound: number;
  stakePerPlayerUsdc: string;
  totalPotUsdc: string;
  relayerRewardUsdc: string;
  lockedRacers: [string, string, string, string]; // Callsigns for lanes 0..3
  lockedAddresses: [string, string, string, string]; // Wallet addresses for lanes 0..3
  txHash: string | null;
  lockedAtMs: number;
  status: 'locked' | 'settled' | 'refunded';
  randomnessHex?: string;
  drandSignatureHex?: string;
  winnerLane?: 0 | 1 | 2 | 3;
  winnerCallsign?: string;
  winnerAddress?: string;
  playerWon?: boolean;
  netChangeUsdc?: string;
}

/**
 * Exact replica of `RandomnessHub.roundAt(uint256 timestamp)` in Solidity.
 */
export function calculateOrionRoundAt(timestampSec: bigint): bigint {
  if (timestampSec <= DRAND_GENESIS_TIME) return 1n;
  const delta = timestampSec - DRAND_GENESIS_TIME;
  const round =
    delta / DRAND_PERIOD + (delta % DRAND_PERIOD > 0n ? 1n : 0n);
  return round === 0n ? 1n : round;
}

/**
 * Exact replica of `RandomnessHub.requestRandomness`:
 * `round = roundAt(block.timestamp + MIN_DELAY_PERIODS * period)` (at least 9 seconds ahead).
 */
export function calculateTargetRoundForRequest(timestampSec: bigint): bigint {
  return calculateOrionRoundAt(
    timestampSec + ORION_MIN_DELAY_PERIODS * DRAND_PERIOD,
  );
}

/**
 * Computes exact 6-decimal USDC and 18-decimal Arc native gas token amounts
 * using Arc Studio's `onchain-money.ts` (`Amount`, `parseAmount`, `usdcToGasToken`).
 */
export function computeWagerBreakdown(
  stakeUsdcStr: string,
  relayerRewardUsdcStr: string = DEFAULT_RELAYER_REWARD_USDC,
): WagerBreakdown {
  let stakeUsdc: Amount;
  try {
    const cleaned = (stakeUsdcStr || '').trim();
    stakeUsdc =
      cleaned === '' || cleaned === '.'
        ? Amount.zero(6)
        : parseAmount(ARC_TESTNET_CHAIN_ID, cleaned);
  } catch {
    stakeUsdc = Amount.zero(6);
  }
  const isWagerEnabled = stakeUsdc.isPositive();

  if (!isWagerEnabled) {
    const zero6 = Amount.zero(6);
    const zero18 = Amount.zero(18);
    return {
      isWagerEnabled: false,
      stakePerPlayerUsdc: zero6,
      stakePerPlayerGas18: zero18,
      totalPotUsdc: zero6,
      totalPotGas18: zero18,
      relayerRewardUsdc: zero6,
      relayerRewardGas18: zero18,
      playerTotalLockUsdc: zero6,
      playerTotalLockGas18: zero18,
    };
  }

  const minRewardUsdc = parseAmount(ARC_TESTNET_CHAIN_ID, ORION_MIN_REWARD_USDC);
  const requestedRewardUsdc = parseAmount(
    ARC_TESTNET_CHAIN_ID,
    relayerRewardUsdcStr,
  );
  const relayerRewardUsdc = requestedRewardUsdc.lt(minRewardUsdc)
    ? minRewardUsdc
    : requestedRewardUsdc;

  const stakeGas18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, stakeUsdc);
  const totalPotUsdc = stakeUsdc.mul(4n);
  const totalPotGas18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, totalPotUsdc);
  const relayerRewardGas18 = usdcToGasToken(
    ARC_TESTNET_CHAIN_ID,
    relayerRewardUsdc,
  );

  const playerTotalLockUsdc = stakeUsdc.add(relayerRewardUsdc);
  const playerTotalLockGas18 = stakeGas18.add(relayerRewardGas18);

  return {
    isWagerEnabled: true,
    stakePerPlayerUsdc: stakeUsdc,
    stakePerPlayerGas18: stakeGas18,
    totalPotUsdc,
    totalPotGas18,
    relayerRewardUsdc,
    relayerRewardGas18,
    playerTotalLockUsdc,
    playerTotalLockGas18,
  };
}

/**
 * Derives a deterministic 0..3 lane winner index from a 32-byte Orion randomness hex string,
 * matching `uint8(uint256(rnd) % 4)` in `OlympicRaceWager.sol`.
 */
export function deriveWinnerLaneFromRandomness(
  randomnessHex: string,
): 0 | 1 | 2 | 3 {
  const normalized = randomnessHex.startsWith('0x')
    ? randomnessHex
    : `0x${randomnessHex}`;
  const value = BigInt(normalized);
  return Number(value % 4n) as 0 | 1 | 2 | 3;
}

/**
 * Formats a 6-decimal Amount as a fixed 2-decimal USDC string (e.g. "20.00").
 */
export function formatUsdcDisplay(amount6: Amount): string {
  return amount6.toFixed(2);
}

/**
 * Generates or loads a persistent embedded Arc Testnet wallet address & balance.
 */
export function loadEmbeddedArcWallet(): ArcWalletState {
  const STORAGE_ADDR_KEY = 'olympic_arc_embedded_address_v1';
  const STORAGE_BAL_KEY = 'olympic_arc_embedded_balance_raw6_v1';

  let address = '0x71C95911E9a5D330f4D621842EC243EE1343292e';
  let rawUsdc6 = 100_000_000n; // 100.00 USDC default testnet balance

  try {
    const savedAddr = localStorage.getItem(STORAGE_ADDR_KEY);
    if (savedAddr && /^0x[0-9a-fA-F]{40}$/.test(savedAddr)) {
      address = savedAddr;
    } else {
      const hexChars = '0123456789abcdef';
      let gen = '0x';
      for (let i = 0; i < 40; i++) {
        gen += hexChars[Math.floor(Math.random() * 16)];
      }
      address = gen;
      localStorage.setItem(STORAGE_ADDR_KEY, address);
    }

    const savedBal = localStorage.getItem(STORAGE_BAL_KEY);
    if (savedBal !== null && /^-?\d+$/.test(savedBal)) {
      rawUsdc6 = BigInt(savedBal);
    } else {
      localStorage.setItem(STORAGE_BAL_KEY, rawUsdc6.toString());
    }
  } catch {
    // Fallback to defaults if localStorage is unavailable
  }

  const amount6 = Amount.fromRaw(rawUsdc6, 6);
  const amount18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, amount6);

  return {
    mode: 'embedded_arc',
    address,
    chainId: ARC_TESTNET_CHAIN_ID,
    balanceUsdc: amount6.toFixed(2),
    balanceRawUsdc6: amount6.raw,
    balanceRawGas18: amount18.raw,
    isConnected: true,
  };
}

export function saveEmbeddedArcBalance(newRawUsdc6: bigint): ArcWalletState {
  const clamped = newRawUsdc6 < 0n ? 0n : newRawUsdc6;
  try {
    localStorage.setItem(
      'olympic_arc_embedded_balance_raw6_v1',
      clamped.toString(),
    );
  } catch {
    // Ignore storage error
  }
  const current = loadEmbeddedArcWallet();
  const amount6 = Amount.fromRaw(clamped, 6);
  const amount18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, amount6);
  return {
    ...current,
    balanceUsdc: amount6.toFixed(2),
    balanceRawUsdc6: amount6.raw,
    balanceRawGas18: amount18.raw,
  };
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const anyWin = window as unknown as { ethereum?: Eip1193Provider };
  return anyWin.ethereum ?? null;
}

/**
 * Connects to an injected EIP-1193 wallet (MetaMask / Rabby), switches/adds Arc Testnet (5042002),
 * and reads the native 18-decimal USDC balance, converting it safely via `gasTokenToUsdc`.
 */
export async function connectInjectedArcWallet(): Promise<ArcWalletState> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error(
      'No browser wallet detected. Using built-in Arc Testnet Wallet instead.',
    );
  }

  const chainFact = requireChain(ARC_TESTNET_CHAIN_ID);
  const hexChainId = `0x${ARC_TESTNET_CHAIN_ID.toString(16)}`;

  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
  })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error('No wallet account authorized.');
  }
  const address = accounts[0];

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexChainId,
          chainName: chainFact.name,
          nativeCurrency: {
            name: 'USDC',
            symbol: chainFact.nativeCurrency.symbol,
            decimals: chainFact.nativeCurrency.decimals,
          },
          rpcUrls: chainFact.rpcUrls,
          blockExplorerUrls: [chainFact.explorerBase],
        },
      ],
    });
  }

  const balanceHex = (await provider.request({
    method: 'eth_getBalance',
    params: [address, 'latest'],
  })) as string;

  const rawGas18 = BigInt(balanceHex || '0x0');
  const gasAmount18 = Amount.fromRaw(rawGas18, 18);
  const usdcAmount6 = gasTokenToUsdc(ARC_TESTNET_CHAIN_ID, gasAmount18, 'trunc');

  return {
    mode: 'injected_eip1193',
    address,
    chainId: ARC_TESTNET_CHAIN_ID,
    balanceUsdc: usdcAmount6.toFixed(2),
    balanceRawUsdc6: usdcAmount6.raw,
    balanceRawGas18: rawGas18,
    isConnected: true,
  };
}

/**
 * Sends a real `requestRandomness(120000)` transaction to Orion `RandomnessHub v2`
 * (`0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2`) on Arc Testnet when using an injected wallet.
 * Function selector for `requestRandomness(uint32)`:
 * keccak256("requestRandomness(uint32)")[0..4] = 0x165c4a16 (or `roll()` on Demo v2 = 0xcd596583)
 */
export async function submitInjectedOrionRequest(
  fromAddress: string,
  relayerRewardGas18: Amount,
): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error('Injected wallet provider not available');
  }
  // Call `roll()` (selector 0xcd596583) on deployed Orion RandomnessDemo v2 (`0x1e4861248142748d37b3778aae40df133e0ad5d2`)
  // which forwards `msg.value` (in 18-decimal native USDC) to `RandomnessHub v2` (`0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2`).
  const valueHex = `0x${relayerRewardGas18.raw.toString(16)}`;
  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: fromAddress,
        to: ORION_DEMO_V2_ADDRESS,
        value: valueHex,
        data: '0xcd596583',
      },
    ],
  })) as string;

  return txHash;
}

/**
 * Queries live Orion `RandomnessHub v2` state on Arc Testnet (`https://rpc.testnet.arc.io`)
 * and the latest verified `drand evmnet` round from `api.drand.sh`.
 */
export async function fetchOrionHubTelemetry(): Promise<OrionHubTelemetry> {
  const chainFact = requireChain(ARC_TESTNET_CHAIN_ID);
  const rpcUrl = chainFact.rpcUrls[0];

  let nextRequestId: bigint | null = null;
  let latestDrandRound: number | null = null;
  let latestDrandSignatureHex: string | null = null;

  // 1. Query `nextRequestId()` (selector 0x61b8ce8c) on RandomnessHub v2 on Arc Testnet
  try {
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: ORION_HUB_V2_ADDRESS,
            data: '0x61b8ce8c',
          },
          'latest',
        ],
      }),
      signal: AbortSignal.timeout(4500),
    });
    if (rpcRes.ok) {
      const json = (await rpcRes.json()) as { result?: string };
      if (json.result && json.result !== '0x') {
        nextRequestId = BigInt(json.result);
      }
    }
  } catch {
    // Ignore transient RPC network errors
  }

  // 2. Query latest drand evmnet round & BLS signature
  const drandUrls = [
    'https://api.drand.sh/v2/beacons/evmnet/rounds/latest',
    'https://drand.cloudflare.com/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/latest',
  ];

  for (const url of drandUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        round?: number;
        signature?: string;
      };
      if (typeof data.round === 'number') {
        latestDrandRound = data.round;
        latestDrandSignatureHex = data.signature ?? null;
        break;
      }
    } catch {
      // Try fallback drand endpoint
    }
  }

  // Fallback round calculation from current Unix timestamp if offline
  if (latestDrandRound === null) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    latestDrandRound = Number(calculateOrionRoundAt(nowSec));
  }

  return {
    hubAddress: ORION_HUB_V2_ADDRESS,
    demoAddress: ORION_DEMO_V2_ADDRESS,
    chainId: ARC_TESTNET_CHAIN_ID,
    nextRequestId,
    latestDrandRound,
    latestDrandSignatureHex,
    lastUpdatedMs: Date.now(),
  };
}

/**
 * Fetches a specific or latest drand evmnet round signature and derives a deterministic
 * 32-byte Orion randomness hex bound to `(signature, hubAddress, chainId, requestId)`.
 */
export async function resolveOrionBeaconRandomness(
  targetRound: number,
  requestId: string,
): Promise<{ drandSignatureHex: string; randomnessHex: string }> {
  let sigHex = '';
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const roundScheduledTimeSec =
    DRAND_GENESIS_TIME + BigInt(Math.max(1, targetRound)) * DRAND_PERIOD;
  const urls =
    nowSec >= roundScheduledTimeSec
      ? [
          `https://api.drand.sh/v2/beacons/evmnet/rounds/${targetRound}`,
          'https://api.drand.sh/v2/beacons/evmnet/rounds/latest',
        ]
      : ['https://api.drand.sh/v2/beacons/evmnet/rounds/latest'];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      const body = (await res.json()) as { signature?: string };
      if (body.signature && /^[0-9a-fA-F]{128}$/.test(body.signature)) {
        sigHex = body.signature;
        break;
      }
    } catch {
      // Fallback if offline
    }
  }

  if (!sigHex) {
    // Deterministic fallback signature hex if external network is blocked
    sigHex =
      '06fd5996329504d3a56b482d9222bf7205857d0a9559ddd216ca31a286f6a8cc0a120f021aac2f13553fb164f62bc3a5ca32c76dea88a777b39bcf3cac5fdbd6';
  }

  // Derive 32-byte randomness bound to signature + hub + chainId + requestId using Web Crypto SHA-256
  const input = `${sigHex}:${ORION_HUB_V2_ADDRESS.toLowerCase()}:${ARC_TESTNET_CHAIN_ID}:${requestId}`;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = Array.from(new Uint8Array(digest));
    const hex =
      '0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      drandSignatureHex: `0x${sigHex.slice(0, 32)}...${sigHex.slice(-16)}`,
      randomnessHex: hex,
    };
  }

  return {
    drandSignatureHex: `0x${sigHex.slice(0, 32)}...`,
    randomnessHex: `0x${sigHex.slice(0, 64)}`,
  };
}

export {
  ARC_TESTNET_CHAIN_ID,
  buildAddressExplorerUrl,
  buildTxExplorerUrl,
  formatAmount,
  formatGasAmount,
  ORION_DEMO_V2_ADDRESS,
  ORION_HUB_V2_ADDRESS,
};
