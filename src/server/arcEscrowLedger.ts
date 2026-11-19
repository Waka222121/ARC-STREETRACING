import crypto from 'node:crypto';
import {
  ARC_TESTNET_CHAIN_ID,
  ORION_HUB_V2_ADDRESS,
} from '../onchain-facts';
import {
  Amount,
  parseAmount,
  usdcToGasToken,
} from '../onchain-money';
import {
  calculateTargetRoundForRequest,
  DEFAULT_RELAYER_REWARD_USDC,
  ORION_MIN_REWARD_USDC,
} from '../game/arcOrionClient';
import { AuthoritativeWalletSnapshot } from '../shared/multiplayerProtocol';

const INITIAL_BALANCE_USDC6 = parseAmount(ARC_TESTNET_CHAIN_ID, '100').raw;
const FAUCET_CREDIT_USDC6 = parseAmount(ARC_TESTNET_CHAIN_ID, '50').raw;

export function normalizeWalletAddress(raw: string): string {
  const trimmed = (raw || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(trimmed)) {
    return trimmed;
  }
  const digest = crypto.createHash('sha256').update(trimmed || 'anon').digest('hex');
  return `0x${digest.slice(0, 40)}`;
}

export function parseStakeUsdc6(stakeStr: string): bigint | null {
  try {
    const cleaned = (stakeStr || '').trim();
    if (!cleaned || cleaned === '.') return 0n;
    const amt = parseAmount(ARC_TESTNET_CHAIN_ID, cleaned);
    if (amt.isNegative()) return null;
    return amt.raw;
  } catch {
    return null;
  }
}

export class ArcEscrowLedger {
  private readonly balances = new Map<string, bigint>();
  private readonly lockedRooms = new Map<string, string>();
  private orionRequestCounter = 1000;

  ensureWallet(rawAddress: string): string {
    const address = normalizeWalletAddress(rawAddress);
    if (!this.balances.has(address)) {
      this.balances.set(address, INITIAL_BALANCE_USDC6);
    }
    return address;
  }

  getBalanceUsdc6(rawAddress: string): bigint {
    const address = this.ensureWallet(rawAddress);
    return this.balances.get(address) ?? INITIAL_BALANCE_USDC6;
  }

  getWalletSnapshot(rawAddress: string): AuthoritativeWalletSnapshot {
    const address = this.ensureWallet(rawAddress);
    const raw6 = this.balances.get(address) ?? INITIAL_BALANCE_USDC6;
    const amt6 = Amount.fromRaw(raw6, 6);
    const amt18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, amt6);
    return {
      walletAddress: address,
      chainId: ARC_TESTNET_CHAIN_ID,
      balanceUsdc6: amt6.raw.toString(),
      balanceFormatted: amt6.toFixed(2),
      balanceNativeGas18: amt18.raw.toString(),
      lockedInRoomCode: this.lockedRooms.get(address) ?? null,
    };
  }

  requestFaucet(rawAddress: string): {
    ok: boolean;
    wallet: AuthoritativeWalletSnapshot;
    error?: string;
  } {
    const address = this.ensureWallet(rawAddress);
    if (this.lockedRooms.has(address)) {
      return {
        ok: false,
        wallet: this.getWalletSnapshot(address),
        error: 'Cannot mint faucet USDC while funds are locked in an active escrow',
      };
    }
    const prev = this.balances.get(address) ?? INITIAL_BALANCE_USDC6;
    this.balances.set(address, prev + FAUCET_CREDIT_USDC6);
    return {
      ok: true,
      wallet: this.getWalletSnapshot(address),
    };
  }

  computeRequiredLockUsdc6(stakeTierUsdc: string): {
    ok: boolean;
    stakeUsdc6: bigint;
    relayerRewardUsdc6: bigint;
    totalDebitUsdc6: bigint;
    error?: string;
  } {
    const stakeUsdc6 = parseStakeUsdc6(stakeTierUsdc);
    if (stakeUsdc6 === null) {
      return {
        ok: false,
        stakeUsdc6: 0n,
        relayerRewardUsdc6: 0n,
        totalDebitUsdc6: 0n,
        error: 'Invalid USDC stake amount',
      };
    }
    if (stakeUsdc6 === 0n) {
      return {
        ok: true,
        stakeUsdc6: 0n,
        relayerRewardUsdc6: 0n,
        totalDebitUsdc6: 0n,
      };
    }
    const minReward = parseAmount(ARC_TESTNET_CHAIN_ID, ORION_MIN_REWARD_USDC).raw;
    const defaultReward = parseAmount(ARC_TESTNET_CHAIN_ID, DEFAULT_RELAYER_REWARD_USDC).raw;
    const relayerRewardUsdc6 = defaultReward >= minReward ? defaultReward : minReward;
    return {
      ok: true,
      stakeUsdc6,
      relayerRewardUsdc6,
      totalDebitUsdc6: stakeUsdc6 + relayerRewardUsdc6,
    };
  }

  debitStake(
    rawAddress: string,
    roomCode: string,
    stakeTierUsdc: string,
  ): {
    ok: boolean;
    stakeUsdc6: bigint;
    relayerRewardUsdc6: bigint;
    totalDebitUsdc6: bigint;
    wallet: AuthoritativeWalletSnapshot;
    error?: string;
  } {
    const address = this.ensureWallet(rawAddress);
    const req = this.computeRequiredLockUsdc6(stakeTierUsdc);
    if (!req.ok) {
      return {
        ...req,
        wallet: this.getWalletSnapshot(address),
      };
    }
    const current = this.balances.get(address) ?? INITIAL_BALANCE_USDC6;
    if (current < req.totalDebitUsdc6) {
      return {
        ok: false,
        stakeUsdc6: req.stakeUsdc6,
        relayerRewardUsdc6: req.relayerRewardUsdc6,
        totalDebitUsdc6: req.totalDebitUsdc6,
        wallet: this.getWalletSnapshot(address),
        error: `Insufficient USDC balance (need ${Amount.fromRaw(req.totalDebitUsdc6, 6).toFixed(2)} USDC)`,
      };
    }
    this.balances.set(address, current - req.totalDebitUsdc6);
    if (req.totalDebitUsdc6 > 0n) {
      this.lockedRooms.set(address, roomCode);
    }
    return {
      ok: true,
      stakeUsdc6: req.stakeUsdc6,
      relayerRewardUsdc6: req.relayerRewardUsdc6,
      totalDebitUsdc6: req.totalDebitUsdc6,
      wallet: this.getWalletSnapshot(address),
    };
  }

  refundStake(
    rawAddress: string,
    totalDebitUsdc6: bigint,
  ): AuthoritativeWalletSnapshot {
    const address = this.ensureWallet(rawAddress);
    const current = this.balances.get(address) ?? INITIAL_BALANCE_USDC6;
    if (totalDebitUsdc6 > 0n) {
      this.balances.set(address, current + totalDebitUsdc6);
    }
    this.lockedRooms.delete(address);
    return this.getWalletSnapshot(address);
  }

  releaseEscrowLockMarker(rawAddress: string): void {
    const address = this.ensureWallet(rawAddress);
    this.lockedRooms.delete(address);
  }

  settlePotToWinner(
    winnerRawAddress: string,
    participantRawAddresses: ReadonlyArray<string>,
    totalPotUsdc6: bigint,
    roomCode: string,
  ): {
    settlementTxHash: string;
    payoutFormatted: string;
    winnerWallet: AuthoritativeWalletSnapshot;
  } {
    const winnerAddress = this.ensureWallet(winnerRawAddress);
    for (const addr of participantRawAddresses) {
      this.lockedRooms.delete(normalizeWalletAddress(addr));
    }
    if (totalPotUsdc6 > 0n) {
      const current = this.balances.get(winnerAddress) ?? INITIAL_BALANCE_USDC6;
      this.balances.set(winnerAddress, current + totalPotUsdc6);
    }
    const amt6 = Amount.fromRaw(totalPotUsdc6, 6);
    const txHash =
      '0x' +
      crypto
        .createHash('sha256')
        .update(
          `arc_settle:${ARC_TESTNET_CHAIN_ID}:${ORION_HUB_V2_ADDRESS}:${roomCode}:${winnerAddress}:${totalPotUsdc6.toString()}:${Date.now()}`,
        )
        .digest('hex');
    return {
      settlementTxHash: txHash,
      payoutFormatted: amt6.toFixed(2),
      winnerWallet: this.getWalletSnapshot(winnerAddress),
    };
  }

  generateOrionSeed(roomCode: string): {
    trafficSeed: number;
    orionRound: number;
    orionRandomnessHash: string;
    escrowTxHash: string;
  } {
    this.orionRequestCounter += 1;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const orionRound = Number(calculateTargetRoundForRequest(nowSec));
    const entropy = crypto.randomBytes(16).toString('hex');
    const hashBuf = crypto
      .createHash('sha256')
      .update(
        `orion_v2:${ARC_TESTNET_CHAIN_ID}:${ORION_HUB_V2_ADDRESS}:${roomCode}:${orionRound}:${this.orionRequestCounter}:${entropy}`,
      )
      .digest();
    const orionRandomnessHash = '0x' + hashBuf.toString('hex');
    const trafficSeed = hashBuf.readUInt32BE(0) || 1337;
    const escrowTxHash =
      '0x' +
      crypto
        .createHash('sha256')
        .update(`escrow_lock:${roomCode}:${orionRandomnessHash}`)
        .digest('hex');

    return {
      trafficSeed,
      orionRound,
      orionRandomnessHash,
      escrowTxHash,
    };
  }
}
