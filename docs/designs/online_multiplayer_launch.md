# Online Multiplayer Authoritative Server & Arc Studio USDC Escrow (`Arc Streetracing`)

* **Author:** vakasacorpareishen
* **Date:** 2026-11-18

## Overview

This feature transitions `Arc Streetracing` (`Olympic Underground`) from a single-browser simulation using `BroadcastChannel` and `localStorage` into an online multiplayer game backed by an authoritative Node.js and WebSocket server on port `3000`. Up to four live human players connect from separate browsers or devices into public matchmaking (`Quick Match 4P`) or private 6-character rooms (`Create Room` / `Join by Code`), with zero AI bots. Each active player reserves a unique car paint color from the 6-color lobby palette (`LOBBY_PAINT_SWATCHES`), locks an equal USDC self-stake via the Arc Studio 6/18-decimal currency bridge (`src/onchain-facts.ts` and `src/onchain-money.ts`) on Arc Testnet (`chainId: 5042002`) with Orion `RandomnessHub v2` (`0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`), and competes on a server-synchronized 4-lane straight highway (`FOUR_LANE_OFFSETS = [-5.7, -1.9, 1.9, 5.7]`). If a player disconnects after the race starts, their locked stake remains in the match pot and their car continues along its current lane until eliminated by civilian traffic; if a lobby fails to start within 60 seconds after a player locks a stake, the server refunds the locked stake automatically.

## Analysis

### 1. Inventive Contradictions & TRIZ Pattern Resolutions (`egm-inventive-catalyst`)

* **Contradiction 1 (Instant 0-ms Lane-Hop Responsiveness vs. Server-Authoritative Anti-Cheat)**:
  * **Conflict**: At highway speeds up to `295 km/h` (`82.0 m/s`), waiting for a WebSocket round-trip (`30–120 ms` RTT) before starting a `0.20s` parabolic lane hop (`stepLaneHopKinematics`) makes dodging civilian trucks feel sluggish. Conversely, trusting the client to report its own lane position or collision survival allows a modified client to spoof coordinates and steal the 4x USDC pot.
  * **Inventive Resolution Pattern**: **Inversion + Preliminary Action** (Client-Side Optimistic Lane-Hop Prediction with Server-Authoritative Input Tick Validation). The client begins the visual `0.20s` lane-hop animation immediately on `ArrowLeft`/`ArrowRight` (`KeyA`/`KeyD`) and sends a timestamped `{ type: 'input:lane_hop', targetLaneIndex, clientTick }` event to the server. The server validates that `targetLaneIndex` is an adjacent valid lane (`0..3`), steps the authoritative kinematics (`stepLaneHopKinematics`) and traffic collision checks (`checkRacerTrafficCollision`), and broadcasts compact 20 Hz state snapshots.
  * **Secondary Operational Trade-offs**: Requires client reconciliation when a packet drops or when the server detects a traffic collision `1–2` ticks before the client's local render frame.
* **Contradiction 2 (28-Vehicle 60 Hz 3D Traffic Bandwidth vs. Low-Latency WebSocket Payload Budget)**:
  * **Conflict**: Broadcasting full 3D transforms for 28 civilian vehicles (`sedan`, `suv`, `truck`) and 4 racers at `60 Hz` across 4 WebSocket connections per room generates high JSON serialization overhead and GC pauses on the Node.js event loop.
  * **Inventive Resolution Pattern**: **Extraction / Preliminary Action** (Seeded Deterministic Traffic Wave Generator + Event-Driven Delta Snapshots). Both the Node.js server and the clients run the exact same deterministic traffic generator seeded by the room's `orionDrandSeed` (derived from `RandomnessHub v2` / `drand evmnet`). The server runs the authoritative `60 Hz` simulation loop in memory to judge collisions and eliminations, while broadcasting only `20 Hz` compact racer state deltas (`laneIndex`, `hopProgress`, `z`, `eliminated`) and authoritative elimination events.
  * **Secondary Operational Trade-offs**: `src/game/traffic.ts` must replace all `Math.random()` calls with a pure seeded PRNG (`mulberry32(seed)`) shared between server and client so traffic waves never diverge.
* **Contradiction 3 (Human-Only Matchmaking vs. Partial Lobby Stalls)**:
  * **Conflict**: Removing AI bots guarantees 100% human competition, but a strict 4-player gate stalls indefinitely when only 2 or 3 human players are online, while trapping already-locked USDC stakes.
  * **Inventive Resolution Pattern**: **Beforehand Cushioning + Dynamics** (Dynamic `2..4` Human Player Quorum with `N × Stake` Pot Scaling and 60-Second Lobby Escrow Expiry). Rooms can launch as soon as 2 to 4 live human players lock their stakes and mark `READY` (scaling `Winner Pot = N × Stake`), and any pre-race locked stake automatically refunds if the match does not transition to `playing` within `60` seconds (`LOBBY_ESCROW_TIMEOUT_MS = 60_000`).
  * **Secondary Operational Trade-offs**: The server must maintain an authoritative per-room countdown timer and idempotent refund ledger so reconnecting clients never double-claim a refund.

### 2. Multi-Lens Risk & Architecture Audit (`egm-design`, `egm-codebase-details`, `egm-zoom-out`, `egm-comprehension`, `egm-implementation-readiness`, `egm-structural`)

* **[Blocker] [`egm-codebase-details` / `egm-implementation-readiness`] Non-Deterministic Traffic Spawning (`src/game/traffic.ts`)**:
  * `createInitialTraffic` and `stepTrafficVehicles` currently call `Math.random()` when selecting vehicle archetypes (`sedan`, `suv`, `truck`) and open survival corridors (`enforcePassableCorridorGuarantee`). For online play, traffic generation must accept a deterministic 32-bit integer seed so the server and all connected clients compute identical traffic positions at every longitudinal `z` coordinate.
* **[Blocker] [`egm-design` / `egm-zoom-out`] Client-Trust Vulnerability in Embedded Arc Wallet Balances (`src/game/arcOrionClient.ts`)**:
  * Currently, `loadEmbeddedArcWallet()` and `saveEmbeddedArcBalance()` read and write balances (`100.00 USDC` initial + `+50 USDC` faucet) in browser `localStorage`. In an online room with multiple human players, the Node.js server (`server.ts`) must hold the authoritative balance ledger mapped by normalized wallet address (`0x...`) using `Amount` from `src/onchain-money.ts` (`6` decimals for ERC-20 display/ledger, `18` decimals via `usdcToGasToken` for native Arc Testnet gas/value payloads).
* **[Major] [`egm-design`] Race Condition on Simultaneous Color Selection in Lobby (`src/components/MultiplayerMainMenu.tsx`)**:
  * While `getPaintColorOccupancy` and `resolveUniqueLanePaintColors` in `src/game/physics.ts` prevent selecting an occupied color locally, two online players could click the same free swatch (e.g., `Emerald #10b981`) within the same `50 ms` network window. The server room state must process `room:select_color` atomically (First-Write-Wins) and reject conflicting requests with an authoritative `room:state` broadcast.
* **[Major] [`egm-comprehension` / `egm-zoom-out`] Mid-Race Disconnect vs. Pre-Race Disconnect Semantics**:
  * The state machine must distinguish two disconnect phases:
    1. **`LOBBY` Phase (`status === 'waiting_for_players' | 'staking'`)**: If a player disconnects before race start, or if the room does not start within `60` seconds of stake lock, their locked stake is refunded to their authoritative wallet balance and their slot + paint color are released.
    2. **`RACING` Phase (`status === 'playing'`)**: Once the server transitions the room to `playing` and locks the pot (`Winner Pot = N × Stake`), a disconnected player's stake is non-refundable ("расценивается как уже внесённые средства"). Their car remains active on its current lane without steering input until it collides with civilian traffic (`eliminated = true`).

### 3. Ideal Final Result (IFR)

A single-port (`3000`) full-stack Express + Vite + WebSocket (`ws`) server (`server.ts`) shares the pure TypeScript physics, seeded traffic, unique paint color reservation (`src/game/physics.ts`), and Arc Studio 6/18-decimal money arithmetic (`src/onchain-facts.ts`, `src/onchain-money.ts`) directly with the React client—eliminating `BroadcastChannel`, removing AI bots in online rooms, preventing duplicate car colors atomically, and settling the full `N × Stake` USDC pot to the last surviving human player with zero client-side trust.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * **Full-Stack Express + WebSocket Server on Port 3000 (`server.ts`)**: Serve Vite middleware in development (`"dev": "tsx server.ts"`), static assets in production (`"start": "node server.ts"` or `tsx server.ts`), REST health/wallet endpoints (`/api/wallet/:address`, `/api/faucet`), and a WebSocket room server (`/ws`).
  * **Live Human-Only Rooms (`2..4` Players, Zero AI Bots)**: Remove AI bot slot fillers in online rooms; support `Quick Match` matchmaking and 6-character private room codes (`XXX-XXX`) across independent browsers and devices.
  * **Server-Authoritative Unique Paint Color Reservation**: Enforce atomic color locking per room across the 6 swatches in `LOBBY_PAINT_SWATCHES` (`Blue`, `Gold`, `Cyan`, `Crimson`, `Emerald`, `Violet`) so no two players in the same room can ever hold the same paint color.
  * **Server-Authoritative Highway Physics & Seeded Traffic**: Run deterministic seeded traffic waves and collision checks on the server, broadcasting authoritative player lane hops, eliminations, and Last-Player-Standing victory results.
  * **Arc Studio 6/18-Decimal USDC Escrow & Orion RandomnessHub v2 Integration**: Validate all stakes using `src/onchain-facts.ts` (`chainId: 5042002`, USDC `0x3600000000000000000000000000000000000000`, Orion Hub v2 `0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`) and `src/onchain-money.ts` (`parseUsdc`, `formatUsdc`, `usdcToGasToken`, `gasTokenToUsdc`), enforcing forfeited stakes on mid-race disconnect and automatic 60-second refunds on expired unstarted lobbies.
* **Out-of-Scope Non-Goals:**
  * **AI Bot Competitors in Online Matches**: No AI-controlled racers fill empty slots.
  * **In-Race HUD or Minimap Overlays**: Active gameplay (`gameState === 'playing'`) remains 100% free of HUD, speedometers, or minimap overlays.
  * **External Relational Database (PostgreSQL / Cloud SQL)**: Room state and active race sessions run in authoritative server memory with optional file-backed wallet persistence.

## Alternatives Weighed

* **Peer-to-Peer WebRTC / BroadcastChannel Mesh (Rejected by author: lacks cross-device discovery and authoritative anti-cheat)**: `BroadcastChannel` only works across tabs of the same browser on one machine, and peer-to-peer WebRTC without an authoritative server allows any peer to falsify collision survival when USDC wagers are at stake.
* **Filling Empty Online Slots with AI Bots (Rejected by author: online matches must be strictly between live human players)**: Including AI bots in wagered online rooms distorts the self-wager pool economics because an AI bot does not own an independent player wallet.
* **Refunding Stakes on Mid-Race Disconnect (Rejected by author: mid-race disconnect must forfeit the committed stake into the active pot)**: Allowing a player to disconnect mid-race to recover their stake would let losing players pull their plug right before hitting a cargo truck to avoid losing their wager.

## Key Decisions & Staging for Next Steps

1. **Authoritative Server Entry Point (`server.ts` + `ws` package)**: Switch `package.json` `"dev"` script to `"tsx server.ts"` listening on `0.0.0.0:3000`, attaching a `WebSocketServer` on `/ws` alongside Vite dev middleware.
2. **Deterministic Seeded PRNG in `src/game/traffic.ts`**: Add `createSeededRng(seed: number)` and thread it through `createInitialTraffic` and `stepTrafficVehicles` so server and clients render identical civilian traffic waves from a shared room seed.
3. **Atomic Lobby & Escrow State Machine (`src/server/multiplayerRoomManager.ts`)**: Manage room slots (`0..3`), atomic paint color locks (`LOBBY_PAINT_SWATCHES`), server-side Arc Testnet USDC balance ledger (`src/onchain-money.ts`), 60-second pre-race stake lock timeout refunds, and mid-race disconnect stake forfeiture.
4. **WebSocket Client Hook (`src/game/useOnlineMultiplayer.ts`)**: Replace `BroadcastChannel` and fake `setTimeout` matchmaking in `src/components/MultiplayerMainMenu.tsx` with live WebSocket room state, presence awareness, auto-reconnect, and authoritative race lifecycle events.
