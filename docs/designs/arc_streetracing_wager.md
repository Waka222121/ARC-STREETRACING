# Arc Streetracing: 4-Player Highway Survival & USDC Winner-Takes-All Wagering

*   **Author:** vakasacorpareishen@gmail.com
*   **Status:** Proposed
*   **Date:** 2026-11-17

--------------------------------------------------------------------------------

## Overview

Arc Streetracing is a 4-player top-down highway survival racing game integrated with the Arc Testnet (`chainId: 5042002`) and the Orion verifiable randomness protocol (`RandomnessHub v2` at `0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2`). Four racers—ordered from `P1 • YOU` to `P4` and driving an identical car model (`Lancer Evo VIII MR`)—compete side by side across a 4-lane straight highway while dodging civilian sedans, SUVs, and heavy cargo trucks. Before a match begins, each participant stakes an equal custom or preset amount of USDC on themselves, and the single surviving winner claims the entire 4x USDC pool.

## The Problem

Browser-based multiplayer arcade racing games with onchain wagering face three practical failure modes:

1.  **Unfair Vehicle Advantage vs. Pure Skill**: When players can pick different vehicle classes with varying hitbox widths, drift angles, or acceleration curves, a wagered match becomes a build-optimization check rather than an equal survival test. All four lanes need an identical vehicle model and physics profile so that survival depends strictly on lane-switching reaction time.
2.  **Decimal Mismatch on Arc Testnet (`10^12` Scaling Trap)**: On Arc Testnet (`5042002`), the native gas token (`msg.value`) is USDC denominated in 18 decimals, whereas ERC-20 USDC interfaces and human-readable UI inputs use 6 decimals. Passing 6-decimal integer values directly into payable contract calls under-funds stakes by a factor of `10^12`, while displaying raw 18-decimal values breaks user balance formatting.
3.  **Manipulable or Stuck Escrow Settlement**: If a wagering contract settles outcomes inside the randomness callback or locks stakes after randomness is already observable, players or relayers can selectively revert unfavorable outcomes or front-run lobby entry. Furthermore, if a drand beacon round is delayed, player funds remain permanently locked without a timeout refund path.

The proposed design solves these problems by enforcing a single unified car model (`Lancer Evo VIII MR`) across all four lanes, routing all currency conversions through a strict 6-to-18 decimal bridge (`onchain-money.ts`), and locking all four player stakes into an Orion `RandomnessConsumer` escrow contract prior to requesting randomness from `RandomnessHub v2`.

## Goals

*   **Equal-Spec 4-Player Survival Grid**: Spawn all four racers (`P1 • YOU`, `P2`, `P3`, `P4`) with the same 3D car model (`Lancer Evo VIII MR`), identical progressive acceleration (`97 km/h` rolling start up to `295 km/h`), and ghost pass-through between racers so only civilian traffic collisions eliminate competitors.
*   **Preset and Custom Self-Wager Pool in USDC**: Allow players in the lobby to select preset stake tiers (`$1`, `$5`, `$10`, `$25`) or enter any custom USDC stake amount (up to 6 decimal places), automatically calculating the `4x` Winner-Takes-All pot and the Orion relayer reward (`0.02 USDC >= MIN_REWARD 0.01 USDC`).
*   **Dual Arc Testnet Wallet Support**: Support both injected EIP-1193 browser wallets (`MetaMask` / `Rabby` switched to `chainId: 5042002`) and a zero-setup embedded Arc Testnet wallet with an instant `+50 USDC` faucet and direct links to `https://explorer.testnet.arc.io`.
*   **Strict Compliance with Orion Consumer Rules**:
    1.  Freeze all four lane participants and lock the `4x` USDC pool before calling `_requestRandomness`.
    2.  Record `bytes32 randomness` inside `_onRandomness` without external calls or revert conditions.
    3.  Execute winner payout in a separate `settleRace` call with a pull-credit fallback (`credits[winner]` + `claim()`) and a 200-block `cancelExpiredRace` refund path.
*   **Zero-HUD Active Race Viewport**: Keep the active driving screen (`gameState === 'playing'`) completely free of HUD overlays, minimaps, or telemetry widgets so the 4-lane highway and incoming traffic remain unobstructed.

## Non-Goals

*   **Multi-Model Vehicle Dealership or Performance Upgrades in Wager Matches**: Players do not buy or switch between different chassis models (`R34`, `Supra`, etc.) or unequal engine stages for wagered highway survival matches.
*   **Third-Party Side-Betting or Parimutuel Odds**: Spectators cannot bet on other drivers; every participant stakes strictly the same amount on themselves (`1x` each, `4x` total pot).
*   **Mainnet Deployment or Cross-Chain Bridging**: This design targets Arc Testnet (`chainId: 5042002`) only and does not include cross-chain USDC bridges or fiat on-ramps.
*   **In-Race Telemetry Overlays**: Speedometers, tachometers, or wallet popups are never rendered during the active race phase.

## Open Questions

*   **Question 1 (Simulated Fill vs. 4-Signature Onchain Escrow)**: In single-player or partial-room testing where `P2`–`P4` are AI bots or simulated slots, should the local tester's transaction fund only their own `1x` stake onchain while the contract/UI simulates the `3x` rival counter-stakes, or must `createAndLockRace` always receive the full `4x` native value?
*   **Question 2 (Client Survival Outcome vs. Onchain Beacon Settlement)**: When the local player survives all traffic waves in the 3D scene, the client resolves `P1 • YOU` as the winner; when the local player crashes early, the Orion drand `evmnet` randomness selects the winning surviving rival lane. Should onchain `settleRace` remain purely beacon-driven (`uint256(randomness) % 4`) for trustless verification, or accept a signed race-result attestation?

## Critical User Journeys (CUJs)

### CUJ 1: Custom USDC Self-Wager & Last-Car-Standing Victory

*   **Given**: The player opens Arc Streetracing in the `title` lobby with an Arc Testnet wallet holding at least `15.02 USDC`, and all four slots (`P1 • YOU`, `P2`, `P3`, `P4`) are ready with the unified `Lancer Evo VIII MR` vehicle.
*   **When**: The player enters a custom stake of `12.5` USDC in the `Custom Match Stake (USDC)` input, verifies that the Winner Pot displays `50.00 USDC` (`4 x 12.50 USDC`) plus `0.02 USDC` Orion relayer reward, clicks `Stake 12.5 USDC & Race (Pot 50 USDC) —>`, and dodges civilian traffic on the 4-lane highway until all three rivals crash.
*   **Then**: The active race runs with zero HUD overlays; upon the final rival's crash, the escrow settles the `50.00 USDC` pot to `P1 • YOU`, records the Orion `requestId` and `drand evmnet` round/beacon hash, and displays the settlement banner with a link to `https://explorer.testnet.arc.io` on return to the lobby.

### CUJ 2: Switching Between Embedded Test Wallet and MetaMask / Rabby on Arc Testnet

*   **Given**: The player is in the Arc Streetracing lobby using the default embedded Arc Testnet wallet.
*   **When**: The player clicks `MetaMask / Rabby` in the header wallet bar (or clicks `+50 USDC` on the embedded wallet to top up test funds).
*   **Then**: For `MetaMask / Rabby`, the client requests `wallet_switchEthereumChain` / `wallet_addEthereumChain` for `chainId: 0x4cef52` (`5042002`, RPC `https://rpc.testnet.arc.io`), queries `eth_getBalance`, converts the 18-decimal native balance to a 6-decimal `Amount` via `gasTokenToUsdc`, and updates the header balance and `P1 • YOU` slot wallet address.

## Technical Plan (Architecture)

The system architecture divides responsibilities across three layers:

1.  **Onchain Fact & Decimal Safety Layer (`src/onchain-facts.ts`, `src/onchain-money.ts`)**:
    *   `onchain-facts.ts` stores the immutable network definition for Arc Testnet (`chainId: 5042002`, RPC `https://rpc.testnet.arc.io`, Explorer `https://explorer.testnet.arc.io`, native 18-decimal USDC gas token, and 6-decimal ERC-20 USDC view at `0x3600000000000000000000000000000000000000`) alongside Orion `RandomnessHub v2` parameters (`0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2`, `MIN_REWARD = 1e16` native units = `0.01 USDC`, drand `evmnet` genesis `1727521075`, period `3s`, `MIN_DELAY_PERIODS = 3`).
    *   `onchain-money.ts` enforces fixed-point `BigInt` arithmetic via the `Amount` class (`decimals = 6` for display/input, `decimals = 18` for native `msg.value`). `usdcToGasToken` multiplies a 6-decimal `Amount` by `10^12` to produce the exact 18-decimal native payload, while `gasTokenToUsdc` divides an 18-decimal native balance by `10^12` with explicit remainder handling.

2.  **Smart Contract Escrow Layer (`contracts/IRandomnessHub.sol`, `contracts/RandomnessConsumer.sol`, `contracts/OlympicRaceWager.sol`)**:
    *   `OlympicRaceWager` inherits `RandomnessConsumer` and binds to `RandomnessHub v2`.
    *   `createAndLockRace(address[4] players, string[4] callsigns, uint256 stakePerPlayer)` validates `msg.value == (stakePerPlayer * 4) + relayerReward` and `relayerReward >= 0.01 ether` (`0.01` native 18-decimal USDC). It writes the frozen `RaceEscrow` struct in state `Locked` and invokes `_requestRandomness(CALLBACK_GAS, relayerReward)`, storing `requestToRace[requestId] = raceId`.
    *   `_onRandomness(uint256 requestId, bytes32 randomness)` executes inside the hub's `CALLBACK_GAS` budget (`100,000` gas). It performs only two storage writes (`race.randomness = randomness` and `race.state = RandomnessReady`) plus event emission, never reverting or making external calls.
    *   `settleRace(uint256 raceId)` is called after `RandomnessReady`. It computes `winnerIndex = uint8(uint256(race.randomness) % 4)`, marks `race.state = Settled`, and attempts a low-level transfer of `race.totalPot` to `winner`. If the recipient rejects native transfers, the contract credits `credits[winner] += race.totalPot` for withdrawal via `claim()`.
    *   `cancelExpiredRace(uint256 raceId)` allows refunding each player's `stakePerPlayer` into `credits[player]` if `block.number > race.lockedAtBlock + 200` while still in `Locked`.

3.  **Client Lobby, Web-Relayer & 3D Highway Engine (`src/game/arcOrionClient.ts`, `src/components/MultiplayerMainMenu.tsx`, `src/game/WorldCanvas.tsx`, `src/game/physics.ts`)**:
    *   `arcOrionClient.ts` manages wallet state (`injected_eip1193` for MetaMask/Rabby or `embedded_arc` persisted in `localStorage`), computes wager breakdowns (`computeWagerBreakdown`) for both preset tiers (`$1`, `$5`, `$10`, `$25`) and custom decimal strings (`#custom-stake-usdc-input`), polls `RandomnessHub v2` (`nextRequestId` via selector `0x61b8ce8c`) and `api.drand.sh`, and resolves beacon randomness for post-race settlement.
    *   `MultiplayerMainMenu.tsx` renders the `ARC STREETRACING` 2-line header, the Arc Testnet wallet bar, the left-hand mode & USDC Self-Wager panel, and the 2x2 player slot grid ordered `P1 • YOU`, `P2`, `P3`, `P4` where all four slots use the single `Lancer Evo VIII MR` model.
    *   `WorldCanvas.tsx` and `physics.ts` run the 4-lane highway survival simulation with zero HUD overlays during `gameState === 'playing'`, identical 3D car meshes across all 4 lanes, ghost pass-through between racers, and immediate traffic-collision elimination.

### Data Flow Diagram

```text
+-------------------------------------------------------------------------+
|                    ARC STREETRACING CLIENT (Browser)                    |
|                                                                         |
|  [MultiplayerMainMenu]                                                  |
|   - Preset ($1/$5/$10/$25) or Custom Stake Input -> parseAmount(5042002)|
|   - usdcToGasToken(stake6) -> stake18 (x 10^12)                         |
|   - Slots P1..P4 locked with unified "Lancer Evo VIII MR"               |
+-------------------+---------------------------------+-------------------+
                    | 1. Lock 4x Stake + 0.02 Reward  | 4. Start 4-Lane
                    v                                 v    Survival Race
+-----------------------------------+   +---------------------------------+
|   Arc Testnet (chainId: 5042002)  |   |   WorldCanvas & Physics Engine  |
|                                   |   |                                 |
|  [OlympicRaceWager.sol]           |   |  - 4x Lancer Evo VIII MR        |
|   createAndLockRace()             |   |  - Uniform 97->295 km/h pace    |
|     |                             |   |  - Ghost racer pass-through     |
|     | 2. _requestRandomness()     |   |  - Traffic crash -> eliminated  |
|     v                             |   +-----------------+---------------+
|  [Orion RandomnessHub v2]         |                     |
|   0xe754...f9d2                   |                     | 5. Race Ends
|   targetRound = roundAt(t) + 3    |                     v
|     ^                             |   +---------------------------------+
|     | 3. fulfill(id, blsSig)      |   |   Post-Race Escrow Settlement   |
|  [drand evmnet Beacon / Relayer]  |   |                                 |
|     |                             |   |  - Fetch drand evmnet round     |
|     v                             |   |  - Compute keccak256(sig)       |
|  _onRandomness(id, rand)          |   |  - Settle 4x USDC Pot to Winner |
|  settleRace(raceId) -> 4x Pot     |   |  - Show Explorer Proof in Lobby |
+-----------------------------------+   +---------------------------------+
```

## Alternatives Considered

### Alternative A: Direct Payout Transfer Inside `_onRandomness` Callback

*   **Pros**: Combines randomness fulfillment and winner payout into a single transaction without requiring a second `settleRace` call.
*   **Cons**: Violates Orion Consumer Rule 2 (`Never revert in _onRandomness`). If the winning address is a contract whose `receive()` hook consumes more than the `100,000` callback gas limit or reverts, the relayer's `fulfill` transaction fails or leaves the race permanently unfulfilled.
*   **Reason for Rejection**: Rejected by author: separating `_onRandomness` (pure state transition to `RandomnessReady`) from `settleRace` (payout with pull-credit fallback `credits[winner]`) prevents callback griefing and guarantees relayer settlement under fixed gas limits.

### Alternative B: Using Standard 6-Decimal ERC-20 `transferFrom` for Race Escrow Instead of Native 18-Decimal Arc Value

*   **Pros**: Avoids converting between 6-decimal UI amounts and 18-decimal native `msg.value` via `usdcToGasToken`.
*   **Cons**: Requires every player to sign a separate ERC-20 `approve()` transaction before locking stakes, doubling wallet confirmation prompts, and still requires native 18-decimal USDC for `msg.value` when paying the Orion `RandomnessHub v2` relayer reward (`relayerReward >= 0.01 ether`).
*   **Reason for Rejection**: Rejected by author: on Arc Testnet (`chainId: 5042002`), native `msg.value` is already USDC and is required by `IRandomnessHub.requestRandomness(callbackGasLimit) payable`; using `onchain-money.ts` (`usdcToGasToken` / `gasTokenToUsdc`) allows locking both the `4x` stake pool and the Orion relayer reward in a single payable call without an ERC-20 approval step.

### Alternative C: Multiple Selectable Car Models (`RX-7`, `R34`, `Supra`) and Asymmetric Tuning in Wagered Matches

*   **Pros**: Offers visual variety and drivetrain customization (`AWD` vs. `RWD`) in the lobby.
*   **Cons**: Creates differing slip angles, acceleration curves, and visual bounding boxes across lanes, allowing players to blame vehicle stats rather than lane-switching skill when wagering USDC.
*   **Reason for Rejection**: Rejected by author: locking all four slots (`P1 • YOU`, `P2`, `P3`, `P4`) to the same `Lancer Evo VIII MR` model and identical physics parameters ensures every wagered match is strictly equal.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Decimal Integrity**:
    *   All currency conversions between user-entered USDC strings and native 18-decimal transaction values must pass through `parseAmount`, `usdcToGasToken`, and `gasTokenToUsdc` in `src/onchain-money.ts` using `BigInt` arithmetic; IEEE-754 floating-point math (`Number` multiplication) is prohibited for transaction payloads.
    *   `OlympicRaceWager.sol` must follow the Checks-Effects-Interactions pattern in `settleRace`, `cancelExpiredRace`, and `claim` to prevent reentrancy.
*   **Performance & Viewport Cleanliness**:
    *   The 3D highway scene (`src/game/WorldCanvas.tsx`) must recycle road geometry, instanced low-poly trees, and grass tufts along `+Z` in `60m` steps (`HIGHWAY_REPEAT_STEP_Z = 60`) without runtime geometry allocations during `gameState === 'playing'`.
    *   Zero DOM HUD elements or map overlays may be mounted while `gameState === 'playing'`.
*   **Fault Tolerance & Beacon Fallback**:
    *   If `https://rpc.testnet.arc.io` or `https://api.drand.sh` is unreachable from the client's network, `src/game/arcOrionClient.ts` must fall back to deterministic local round calculation (`calculateTargetRoundForRequest`) and deterministic beacon signature derivation so the lobby and race loop never block or crash.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. [`../../src/onchain-facts.ts`](../../src/onchain-facts.ts) (Create / Maintain)

*   **Type / Scope**: TypeScript Network & Protocol Configuration Module
*   **Proposed Changes**:
    *   Define `ARC_TESTNET_CHAIN_ID = 5042002`, `USDC_DECIMALS = 6`, `CHAINS` registry (RPC `https://rpc.testnet.arc.io`, Explorer `https://explorer.testnet.arc.io`, native 18-decimal USDC gas token, ERC-20 USDC view at `0x3600000000000000000000000000000000000000`), and `ORION_PROTOCOL_FACTS` (`hubV2Address: 0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2`, `minRewardGas18: 10000000000000000n`, `defaultCallbackGas: 100000`, `drandGenesisTimestamp: 1727521075n`, `drandPeriodSeconds: 3n`, `minDelayPeriods: 3n`).
    *   Export URL builder helpers `buildTxExplorerUrl` and `buildAddressExplorerUrl`.
    *   **Rationale**: Centralizes verified Arc Testnet and Orion `RandomnessHub v2` parameters so neither UI components nor contract helpers hardcode chain IDs, decimals, or explorer URLs.

#### 2. [`../../src/onchain-money.ts`](../../src/onchain-money.ts) (Create / Maintain)

*   **Type / Scope**: TypeScript Fixed-Point Currency & Decimal Bridge Module
*   **Proposed Changes**:
    *   Implement the immutable `Amount` class (`raw: bigint`, `decimals: number`, `symbol: string`) with `fromHuman`, `fromRaw`, `add`, `sub`, `mul`, `isZero`, `toString`, and `toFixed`.
    *   Implement `parseAmount(chainId, human)` for 6-decimal USDC inputs, `usdcToGasToken(chainId, usdcAmount)` multiplying by `10^12` to produce 18-decimal native `msg.value`, and `gasTokenToUsdc(chainId, gasAmount)` dividing 18-decimal native balances by `10^12`.
    *   **Rationale**: Eliminates the `10^12` scaling mismatch between 6-decimal human USDC amounts and 18-decimal native Arc Testnet transaction values.

#### 3. [`../../contracts/IRandomnessHub.sol`](../../contracts/IRandomnessHub.sol) & [`../../contracts/RandomnessConsumer.sol`](../../contracts/RandomnessConsumer.sol) (Create / Maintain)

*   **Type / Scope**: Solidity Orion Protocol Interfaces & Base Consumer Contract
*   **Proposed Changes**:
    *   Define `IRandomnessHub` (`requestRandomness(uint32 callbackGasLimit) external payable returns (uint256 id)`, `randomnessOf(uint256 id) external view returns (bytes32)`) and `IRandomnessConsumer` (`onRandomness(uint256 id, bytes32 randomness) external`).
    *   Implement abstract `RandomnessConsumer` enforcing `msg.sender == address(hub)` on `onRandomness` and delegating to `_onRandomness(uint256 id, bytes32 randomness)`.
    *   **Rationale**: Provides the canonical Orion v2 consumer interface required for safe randomness requests and callbacks on Arc Testnet.

#### 4. [`../../contracts/OlympicRaceWager.sol`](../../contracts/OlympicRaceWager.sol) (Create / Maintain)

*   **Type / Scope**: Solidity 4-Player Winner-Takes-All Escrow Contract
*   **Proposed Changes**:
    *   Define `RaceState` enum (`None`, `Locked`, `RandomnessReady`, `Settled`, `Cancelled`) and `RaceEscrow` struct storing `players[4]`, `callsigns[4]`, `stakePerPlayer`, `totalPot`, `relayerReward`, `requestId`, `lockedAtBlock`, `randomness`, `winner`, `winnerLane`, and `state`.
    *   Implement `createAndLockRace` (Rule 1: freeze 4 players and `4x` stake before `_requestRandomness`), `_onRandomness` (Rule 2: store `randomness` and set `RandomnessReady` without reverting), `settleRace` (Rule 3: compute `uint256(randomness) % 4`, transfer `totalPot` to winner or credit `credits[winner]`), `cancelExpiredRace` (200-block timeout refund), and `claim()`.
    *   **Rationale**: Enforces trustless 4-player self-wagering on Arc Testnet while adhering to all three Orion Consumer Rules.

#### 5. [`../../src/game/arcOrionClient.ts`](../../src/game/arcOrionClient.ts) (Create / Modify)

*   **Type / Scope**: TypeScript Client Bridge for Arc Testnet Wallet, Wager Math & Orion Beacon Telemetry
*   **Proposed Changes**:
    *   Define preset stake tiers `STAKE_TIERS_USDC = ['1', '5', '10', '25']` and widen `StakeTierUsdc` to `string` so custom decimal stake amounts are supported.
    *   Implement `computeWagerBreakdown(stakeUsdcStr)` returning 6-decimal and 18-decimal `Amount` values (`stakePerPlayerUsdc`, `totalPotUsdc`, `relayerRewardUsdc`, `playerTotalLockUsdc`, `stakePerPlayerGas18`, `totalPotGas18`, `relayerRewardGas18`, `playerTotalLockGas18`) while safely handling empty or partial input strings (`""`, `"."`).
    *   Implement `connectInjectedArcWallet`, `loadEmbeddedArcWallet`, `saveEmbeddedArcBalance`, `fetchOrionHubTelemetry`, `submitInjectedOrionRequest`, and `resolveOrionBeaconRandomness`.
    *   **Rationale**: Connects the React lobby and race lifecycle to Arc Testnet RPC, injected EIP-1193 wallets, and drand `evmnet` rounds.

#### 6. [`../../src/components/MultiplayerMainMenu.tsx`](../../src/components/MultiplayerMainMenu.tsx) (Modify)

*   **Type / Scope**: React Lobby & Wager Configuration Component
*   **Proposed Changes**:
    *   Render the 2-line `ARC STREETRACING` header logo (`ARC` on line 1, stroked `STREETRACING` on line 2) and the Arc Testnet (`5042002`) wallet bar (`+50 USDC` faucet, `MetaMask / Rabby` switcher, Explorer link).
    *   Render the left-side `USDC Self-Wager • Winner Takes All` panel with the 4 preset tier buttons (`$1`, `$5`, `$10`, `$25`), the `Custom Match Stake (USDC)` decimal input (`#custom-stake-usdc-input`), live `4x` Winner Pot breakdown, and post-race settlement proof banner.
    *   Order the 2x2 player slot cards strictly in ascending order (`P1 • YOU`, `P2`, `P3`, `P4`) and unify the vehicle model across all four slots to `Lancer Evo VIII MR` (`CHASSIS_CATALOG.rx7.name`), removing model-switching arrows.
    *   **Rationale**: Provides a cohesive blue-accented (`#2563eb` / `#3b82f6`) lobby where all players share the same car model and can wager any preset or custom USDC amount.

#### 7. [`../../src/App.tsx`](../../src/App.tsx), [`../../src/game/physics.ts`](../../src/game/physics.ts) & [`../../src/game/WorldCanvas.tsx`](../../src/game/WorldCanvas.tsx) (Modify)

*   **Type / Scope**: Core Application State, Physics Engine & 3D Highway Renderer
*   **Proposed Changes**:
    *   In `src/App.tsx`, lock `carConfig.chassis` to `DEFAULT_CAR_CONFIG.chassis` (`'rx7'`), manage `arcWallet` and `stakeTierUsdc` state, lock active race escrows prior to transitioning to `gameState === 'playing'`, and settle the `4x` USDC pot upon race completion.
    *   In `src/game/physics.ts` (`createInitialRacers`) and `src/game/WorldCanvas.tsx` (`resetRaceGrid`), initialize all four racers with `chassis: 'rx7'` and identical `DEFAULT_CAR_CONFIG` bodykit/spoiler geometry so all four 3D vehicles on the highway are identical in model and performance.
    *   **Rationale**: Guarantees visual and physical parity across all four highway lanes while keeping the active race viewport 100% free of HUD overlays.

#### 8. [`../../src/game/rules.test.ts`](../../src/game/rules.test.ts) (Modify)

*   **Type / Scope**: Node Test Runner Unit Test Suite
*   **Proposed Changes**:
    *   Add unit test #13 verifying Arc Testnet (`5042002`) 6-to-18 decimal conversions (`usdcToGasToken`, `gasTokenToUsdc`), `computeWagerBreakdown` (`4x` Winner-Takes-All pot + `0.02 USDC` relayer reward), `calculateTargetRoundForRequest` (`+3` drand periods = `9s`), and deterministic winner lane derivation (`deriveWinnerLaneFromRandomness`).
    *   **Rationale**: Prevents regressions in onchain decimal scaling and Orion round scheduling.

### Verification Plan

*   **Compilation/Build**: Run `compile_applet` (`vite build`) to verify zero bundler or asset resolution errors.
*   **Static Analysis & Linting**: Run `lint_applet` (`tsc --noEmit`) to verify strict TypeScript type safety across all modules.
*   **Unit Tests**: Run `npx tsx --test src/game/rules.test.ts` and verify all 13 unit tests pass (100% pass rate covering physics, traffic survival, and Arc/Orion wagering math).
*   **Runtime & UI Verification**: Restart dev server on port `3000` (`restart_dev_server`) and verify the `ARC STREETRACING` 2-line header, ascending `P1 • YOU`..`P4` cards with unified `Lancer Evo VIII MR` model, custom USDC stake input recalculation, and HUD-free 4-lane highway race execution.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
