/*
 * Onchain facts for this app. GENERATED — do not edit.
 *
 * Arc Studio writes this file from its onchain facts registry, so the values here are
 * the ones Arc Studio itself deploys and links against. Edits are overwritten.
 *
 * Import a fact instead of typing one:
 *
 *   import { getUsdc, requireChain, buildTxExplorerUrl } from './onchain-facts';
 *
 * A chain's gas token and its ERC-20 USDC are separate facts. On Arc both are
 * USDC, at different decimal counts: 'nativeCurrency' for the gas token,
 * 'usdc' for the ERC-20. Mixing the two is a 10^12 error on a money path.
 */

export const USDC_DECIMALS = 6;
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ORION_HUB_V2_ADDRESS = '0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2';
export const ORION_DEMO_V2_ADDRESS = '0x1e4861248142748d37b3778aae40df133e0ad5d2';

export interface TokenFact {
  symbol: string;
  address: string;
  decimals: number;
}

export interface NativeCurrencyFact {
  symbol: string;
  decimals: number;
  /** True when the gas token IS USDC, which makes 'decimals' above the gas decimals. */
  isUsdc: boolean;
}

export interface OnchainChain {
  chainId: number;
  name: string;
  isTestnet: boolean;
  /** Rollup / alt-EVM family. Absent for an L1 and for a chain in no shared-stack family. */
  family?: string;
  explorerBase: string;
  rpcUrls: string[];
  nativeCurrency: NativeCurrencyFact;
  /** Absent when no USDC contract is deployed on the chain. */
  usdc?: TokenFact;
  cctpDomain?: number;
  /** Circle SCP blockchain enum. Absent unless the deploy tool supports the chain. */
  scpBlockchain?: string;
}

export interface ProtocolContractFact {
  name: string;
  address: string;
  protocol: 'CCTP' | 'Gateway';
  networkKind?: 'testnet' | 'mainnet';
}

interface OnchainFacts {
  chains: OnchainChain[];
  protocolContracts: ProtocolContractFact[];
}

const FACTS: OnchainFacts = {
  chains: [
    {
      chainId: 5042002,
      name: 'Arc Testnet',
      isTestnet: true,
      family: 'arc',
      explorerBase: 'https://explorer.testnet.arc.io',
      rpcUrls: ['https://rpc.testnet.arc.io'],
      nativeCurrency: {
        symbol: 'USDC',
        decimals: 18,
        isUsdc: true,
      },
      usdc: {
        symbol: 'USDC',
        address: '0x3600000000000000000000000000000000000000',
        decimals: 6,
      },
      cctpDomain: 26,
      scpBlockchain: 'ARC-TESTNET',
    },
    {
      chainId: 5042,
      name: 'Arc',
      isTestnet: false,
      family: 'arc',
      explorerBase: 'https://explorer.arc.io',
      rpcUrls: ['https://rpc.mainnet.arc.io'],
      nativeCurrency: {
        symbol: 'USDC',
        decimals: 18,
        isUsdc: true,
      },
      usdc: {
        symbol: 'USDC',
        address: '0x3600000000000000000000000000000000000000',
        decimals: 6,
      },
      cctpDomain: 26,
    },
  ],
  protocolContracts: [],
};

export const ONCHAIN_CHAINS: readonly OnchainChain[] = FACTS.chains;

export const TESTNET_ONCHAIN_CHAINS: readonly OnchainChain[] = FACTS.chains.filter((chain) => chain.isTestnet);

export const EVM_PROTOCOL_CONTRACTS: readonly ProtocolContractFact[] = FACTS.protocolContracts;

const BY_CHAIN_ID = new Map(ONCHAIN_CHAINS.map((chain) => [chain.chainId, chain]));

const BY_SCP_BLOCKCHAIN = new Map(
  ONCHAIN_CHAINS.flatMap((chain) => (chain.scpBlockchain ? [[chain.scpBlockchain, chain] as const] : [])),
);

export function getChain(chainId: number): OnchainChain | undefined {
  return BY_CHAIN_ID.get(chainId);
}

export function requireChain(chainId: number): OnchainChain {
  const chain = getChain(chainId);

  if (!chain) {
    throw new Error('Unknown chain ID ' + chainId + ' — ask Arc Studio to add it to its onchain facts registry');
  }

  return chain;
}

export function getChainByScpBlockchain(blockchain: string): OnchainChain | undefined {
  return BY_SCP_BLOCKCHAIN.get(blockchain);
}

export function requireChainByScpBlockchain(blockchain: string): OnchainChain {
  const chain = getChainByScpBlockchain(blockchain);

  if (!chain) {
    throw new Error(
      "No chain for SCP blockchain '" + blockchain + "' — ask Arc Studio to add it to its onchain facts registry",
    );
  }

  return chain;
}

export function getUsdc(chainId: number): TokenFact | undefined {
  return getChain(chainId)?.usdc;
}

export function buildAddressExplorerUrl(chainId: number, address: string): string {
  return requireChain(chainId).explorerBase + '/address/' + address;
}

export function buildTxExplorerUrl(chainId: number, txHash: string): string {
  return requireChain(chainId).explorerBase + '/tx/' + txHash;
}
