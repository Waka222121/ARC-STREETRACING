# Online Multiplayer Authoritative Server & Arc Studio USDC Escrow (`Arc Streetracing`)

*   **Author:** vakasacorpareishen
*   **Status:** Draft
*   **Date:** 2026-11-18

--------------------------------------------------------------------------------

## Overview

This design transitions `Arc Streetracing` (`Olympic Underground`) from a single-browser simulation driven by `BroadcastChannel` and browser `localStorage` into an online multiplayer game powered by an authoritative Node.js and WebSocket server running on port `3000`. Two to four live human players connect from separate browsers or devices into public matchmaking (`Quick Match 4P`) or private 6-character rooms (`Create Room` / `Join by Code`), with zero AI bots. Each connected human player reserves a unique car paint color from the 6-color lobby palette (`LOBBY_PAINT_SWATCHES`), locks an equal USDC self-stake via the Arc Studio 6/18-decimal currency bridge (`src/onchain-facts.ts` and `src/onchain-money.ts`) on Arc Testnet (`chainId: 5042002`) with Orion `RandomnessHub v2` (`0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`), and competes on a server-synchronized 4-lane straight highway (`FOUR_LANE_OFFSETS = [-5.7, -1.9, 1.9, 5.7]`).

If a player disconnects after the race enters active gameplay (`playing`), their locked stake remains committed to the match pot and their car stays on its current lane until eliminated by civilian traffic. If a lobby fails to transition into active gameplay within 60 seconds after a player locks a stake, the server automatically refunds all locked stakes in that lobby and releases the escrow lock.

## The Problem

The current implementation of `Arc Streetracing` has four structural defects that prevent real online multiplayer competition:

1.  **Single-Browser Isolation & Simulated Matchmaking**: `src/components/MultiplayerMainMenu.tsx` uses browser-local `BroadcastChannel('arc_underground_lobby_v1')` for same-machine tab discovery and falls back to synthetic `setTimeout` slot fills when fewer than four tabs are open. Players on separate devices or browsers cannot discover or join the same room.
2.  **Non-Deterministic Traffic Waves (`src/game/traffic.ts`)**: Civilian traffic spawning and lane-corridor adjustments in `createInitialTraffic` and `stepTrafficVehicles` rely on unseeded `Math.random()`. Even if two clients start a match at the same timestamp, each browser spawns cargo trucks, SUVs, and sedans in different lanes, making shared survival judgment impossible without a deterministic seed and an authoritative server loop.
3.  **Client-Trusted Wallet Balances & Missing Disconnect Rules (`src/game/arcOrionClient.ts`)**: Embedded Arc Testnet wallet balances (`100.00 USDC` initial balance and `+50.00 USDC` faucet credits) are stored purely in browser `localStorage`, and match settlement trusts the local client. Furthermore, there is no server-side distinction between a player leaving during lobby staking (which requires a refund) and a player disconnecting mid-race (where the stake must remain committed in the pot so losing players cannot disconnect right before a collision to save their wager).
4.  **Network Race Conditions on Paint Color Reservation**: While `getPaintColorOccupancy` and `resolveUniqueLanePaintColors` in `src/game/physics.ts` prevent duplicate color choices locally, two remote players can click the same available paint swatch within the same network round-trip window unless an authoritative server locks paint colors atomically per room.

**Proposed Solution**: Introduce a full-stack Express + Vite + WebSocket (`ws`) server (`server.ts`) on port `3000` that manages authoritative rooms (`2..4` live human players, zero bots), enforces atomic First-Write-Wins paint color reservation across `LOBBY_PAINT_SWATCHES`, runs a 60 Hz authoritative physics and seeded-traffic simulation loop in memory, maintains an authoritative Arc Testnet USDC balance and escrow ledger (`6`-decimal ERC-20 display/ledger bridged to `18`-decimal native gas via `src/onchain-money.ts`), forfeits disconnected players' stakes into the pot once the race starts, and refunds locked stakes automatically after a 60-second unstarted lobby timeout.

## Goals

*   **Single-Port Full-Stack Node.js + WebSocket Server (`server.ts` on Port 3000)**: Run an Express server on `0.0.0.0:3000` mounting Vite middleware in development (`"dev": "tsx server.ts"`), static build artifacts in production (`"start": "tsx server.ts"`), REST wallet/health endpoints (`/api/health`, `/api/wallet/:address`, `/api/faucet`), and a WebSocket room server (`/ws`).
*   **Human-Only Matchmaking & Private Rooms (`2..4` Players, Zero AI Bots)**: Support public `Quick Match` queueing and 6-character private room codes (`XXX-XXX`) across separate browsers and devices. Allow matches to launch once `N` (`2 <= N <= 4`) connected human players lock their equal USDC stake and mark `READY`, scaling the winner pot to `N × Stake`.
*   **Atomic Unique Paint Color Reservation**: Enforce server-authoritative First-Write-Wins color locking across the 6 swatches in `LOBBY_PAINT_SWATCHES` (`Blue #2563eb`, `Gold #fbb124`, `Cyan #06b6d4`, `Crimson #f43f5e`, `Emerald #10b981`, `Violet #a855f7`) so no two players in a room or on the 3D highway grid ever occupy the same paint color.
*   **Deterministic Seeded Traffic & Server-Authoritative Physics**: Replace all `Math.random()` calls in `src/game/traffic.ts` with a pure seeded PRNG (`mulberry32(seed)`) driven by the room's Orion `RandomnessHub v2` / `drand evmnet` seed (`orionDrandSeed`), and execute authoritative `60 Hz` lane-hop kinematics (`stepLaneHopKinematics`) and bounding-box collision checks (`checkRacerTrafficCollision`) on the server while broadcasting `20 Hz` compact racer state snapshots and immediate elimination events.
*   **Arc Studio 6/18-Decimal USDC Escrow, Mid-Race Stake Forfeiture & 60s Lobby Refund**: Maintain an authoritative server-side wallet and escrow ledger using `src/onchain-facts.ts` (`chainId: 5042002`, USDC `0x3600000000000000000000000000000000000000`, Orion Hub v2 `0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`) and `src/onchain-money.ts` (`parseUsdc`, `formatUsdc`, `usdcToGasToken`, `gasTokenToUsdc`). Enforce automatic refund of locked stakes if a lobby does not start within `60_000 ms`, and keep locked stakes committed in the pot if a player disconnects during `playing`.

## Non-Goals

*   **AI Bot Competitors in Online Matches**: No AI-controlled vehicles will fill empty player slots (`P2..P4`) in online rooms. Unoccupied slots remain empty on the highway grid.
*   **In-Race HUD, Speedometer, or Minimap Overlays**: Active gameplay (`gameState === 'playing'`) remains 100% free of HUD overlays, telemetry readouts, or minimaps.
*   **External Relational Database (PostgreSQL / Cloud SQL)**: Room state, active race loops, and the Arc Testnet session ledger run in server memory without requiring an external SQL database instance.
*   **Modifications to Immutable Arc Studio Contracts**: `src/onchain-facts.ts` and `src/onchain-money.ts` remain read-only reference modules and will not be altered.

## Open Questions

*   None. All functional, architectural, and economic questions were resolved during the `/egm-brainstorm` phase:
    *   *Server authority*: Node.js + WebSocket (`ws`) on port 3000 (`server.ts`).
    *   *Bot policy*: Live human players only (`2..4` players, zero AI bots).
    *   *Color reservation*: Strictly unique per player across the 6 swatches in `LOBBY_PAINT_SWATCHES`.
    *   *Mid-race disconnect*: Locked stake remains in the active pot as committed funds; disconnected car continues on its current lane until eliminated by civilian traffic.
    *   *Pre-race lobby timeout*: Automatic refund if the match does not transition to `playing` within 60 seconds of stake lock.

## Critical User Journeys (CUJs)

### CUJ 1: Public Quick Match & Atomic Unique Paint Color Selection Across Browsers

*   **Given**: Two human players (`Player A` and `Player B`) open `Arc Streetracing` in two independent browser sessions connected to `ws://localhost:3000/ws`.
*   **When**: Both players click `Quick Match 4P` in `MultiplayerMainMenu`. `Player A` joins Lane 1 (`P1`) with default `Blue (#2563eb)` and selects `Emerald (#10b981)`. Within the same second, `Player B` joins Lane 2 (`P2`, assigned `Gold (#fbb124)`) and attempts to click `Emerald (#10b981)`.
*   **Then**: The server processes `Player A`'s `room:select_color` message first, assigns `#10b981` to Lane 1, rejects `Player B`'s duplicate request for `#10b981`, and broadcasts an authoritative `room:state` snapshot where `#10b981` is marked occupied/disabled (`data-occupied="true"`) on `Player B`'s swatch bar and rendered on Lane 1's 3D highway preview car.

### CUJ 2: Arc Studio USDC Stake Lock, 2–4 Human Quorum Launch & Seeded Survival Race

*   **Given**: `Player A` (Lane 1) and `Player B` (Lane 2) are in room `ARC-777` with `10.00 USDC` selected as the room stake tier (`6`-decimal `10_000_000n` / `18`-decimal `10_000_000_000_000_000_000n` gas units via `src/onchain-money.ts`) and each holds `100.00 USDC` in the server ledger. Slots `P3` and `P4` are empty (`waiting`).
*   **When**: Both `Player A` and `Player B` click `Lock 10 USDC & Ready`.
*   **Then**: The server debits `10.00 USDC` from each player's authoritative wallet balance (`90.00 USDC` remaining), records a `20.00 USDC` room escrow pot (`2 × 10.00 USDC`), generates an Orion `RandomnessHub v2` room seed (`orionDrandSeed`), transitions the room through a 3-second countdown into `playing`, and spawns only the 2 human racers on the 4-lane highway (`FOUR_LANE_OFFSETS = [-5.7, -1.9, 1.9, 5.7]`) against identical seeded civilian traffic waves with zero HUD overlays.

### CUJ 3: Mid-Race Disconnect Forfeiture & Last-Player-Standing Settlement

*   **Given**: `Player A` and `Player B` are racing in `playing` state with a locked `20.00 USDC` pot (`10.00 USDC` committed by each player).
*   **When**: `Player B` closes their browser tab or loses their WebSocket connection at `t = 4.0s` into the race.
*   **Then**: The server keeps `Player B`'s `10.00 USDC` stake locked in the `20.00 USDC` pot, flags `Player B`'s racer as disconnected without steering input, and keeps stepping `Player B`'s car forward on its current lane at `60 Hz`. When `Player B`'s car collides with a civilian vehicle (or when `Player A` remains the last non-eliminated survivor), the server settles the full `20.00 USDC` pot to `Player A`'s wallet (`90.00 + 20.00 = 110.00 USDC`) and broadcasts the `match:finished` settlement receipt.

### CUJ 4: 60-Second Pre-Race Lobby Escrow Timeout Refund

*   **Given**: `Player A` joins a room, locks a `25.00 USDC` stake (`75.00 USDC` remaining available balance), and waits while `Player B` has connected to the lobby but has not locked their stake.
*   **When**: `60` seconds (`LOBBY_ESCROW_TIMEOUT_MS = 60_000`) elapse without all connected lobby players locking their stakes to launch the race.
*   **Then**: The server cancels the pending escrow round, refunds `25.00 USDC` back to `Player A`'s authoritative balance (`100.00 USDC` restored), resets `Player A`'s slot status from `staked` to `connected`, and broadcasts an updated `room:state` notification with `escrowStatus: 'refunded_timeout'`.

## Technical Plan (Architecture)

### 1. System Topology & Single-Port Runtime (`server.ts` on Port 3000)

The application switches from a client-only Vite dev server to a single-port (`0.0.0.0:3000`) Node.js HTTP server (`server.ts`) hosting three layers:

1.  **Express REST API (`/api/*`)**:
    *   `GET /api/health`: Returns active room count, connected WebSocket client count, and Arc Testnet chain configuration (`chainId: 5042002`).
    *   `GET /api/wallet/:address`: Returns the authoritative Arc Testnet USDC balance for a player address (`balanceUsdc6`, `balanceFormatted`, `balanceNativeGas18`, `lockedInRoomCode`). Initializes new wallets with `100.00 USDC` (`100_000_000n` in 6-decimal ERC-20 units).
    *   `POST /api/faucet`: Credits `+50.00 USDC` (`50_000_000n` in 6-decimal units) to the specified wallet address if the player is not currently locked in an active escrow pot, returning the updated balance receipt.
2.  **WebSocket Authoritative Room & Physics Server (`/ws` via `ws` library)**:
    *   Upgrades HTTP connections at path `/ws` onto a `WebSocketServer` attached to the underlying Node.js `http.Server`.
    *   Routes JSON messages to `MultiplayerRoomManager` (`src/server/multiplayerRoomManager.ts`), which manages matchmaking rooms, atomic paint color reservation, Arc Studio USDC stake locks, 60-second pre-race timeout timers, and the 60 Hz authoritative highway simulation loop.
3.  **Frontend Asset Delivery**:
    *   In development (`NODE_ENV !== 'production'`), mounts Vite in middleware mode (`createViteServer({ server: { middlewareMode: true, hmr: false } })`).
    *   In production (`NODE_ENV === 'production'`), serves static build files from `dist/` with SPA fallback to `dist/index.html`.

```text
+-----------------------+          WebSocket (/ws) & REST (/api/*)          +--------------------------------------------------+
| Browser Client 1..4   | <===============================================> | Node.js Server on Port 3000 (server.ts)          |
|                       |   Client -> Server:                               |                                                  |
| - MultiplayerMainMenu |   - room:quick_match / room:create / room:join    | +----------------------------------------------+ |
| - useOnlineMultiplayer|   - room:select_color { paintColor }              | | MultiplayerRoomManager                       | |
| - WorldCanvas (3D)    |   - room:lock_stake { stakeTierUsdc }             | | - Rooms Map<RoomCode, RoomState>             | |
|   (Seeded Traffic +   |   - input:lane_hop { targetLaneIndex, seq }       | | - Atomic Paint Color Lock (6 Swatches)       | |
|    Optimistic Hop)    |                                                   | | - 60s Pre-Race Escrow Timeout Timer          | |
|                       |   Server -> Client:                               | | - 60 Hz Physics & Seeded Traffic Tick Loop   | |
|                       |   - room:state (slots, locked colors, pot, timer) | | - 20 Hz State Snapshot Broadcaster           | |
|                       |   - match:countdown / match:start { seed }        | +----------------------+-----------------------+ |
|                       |   - match:tick (20 Hz racer states)               |                        |                         |
|                       |   - match:eliminated / match:finished { payout }  | +----------------------v-----------------------+ |
+-----------------------+                                                   | | Authoritative Arc USDC Escrow Ledger         | |
                                                                            | | - src/onchain-facts.ts (Chain 5042002)       | |
                                                                            | | - src/onchain-money.ts (6/18-decimal bridge) | |
                                                                            | | - Wallet Map<Address, Usdc6Balance>          | |
                                                                            | +----------------------------------------------+ |
                                                                            +--------------------------------------------------+
```

### 2. Shared Data Structures & Wire Protocol (`src/shared/multiplayerProtocol.ts`)

Client and server share strict TypeScript message union types in `src/shared/multiplayerProtocol.ts`:

*   **Room Lifecycle States**:
    *   `'lobby'`: Players join slots `0..3` (`P1..P4`), select unique paint colors from `LOBBY_PAINT_SWATCHES`, and lock their USDC stakes.
    *   `'countdown'`: Triggered as soon as `N` (`2 <= N <= 4`) connected human players in the room have all locked the room's stake tier (`status === 'staked'`). Runs a 3.0-second server countdown (`3..2..1..GO!`) and binds the room's deterministic 32-bit `trafficSeed` derived from the Orion `RandomnessHub v2` round hash.
    *   `'playing'`: Active 60 Hz server simulation loop. Empty slots (`waiting`) spawn zero racers on the highway. Disconnected racers remain in the simulation on their current lane without steering input and their stakes stay in the pot.
    *   `'finished'`: Triggered when only 1 human racer remains uneliminated (or on tie-breaker by furthest longitudinal `z` coordinate if the final survivors collide on the exact same 60 Hz tick). Credits `Winner Pot = N × Stake` to the winner's wallet and broadcasts the settlement receipt.

*   **Client-to-Server Events (`ClientToServerMessage`)**:
    *   `{ type: 'auth:hello'; clientId: string; walletAddress: string; displayName: string; preferredColor: string }`
    *   `{ type: 'room:quick_match'; stakeTierUsdc: number }`
    *   `{ type: 'room:create'; stakeTierUsdc: number }`
    *   `{ type: 'room:join'; roomCode: string }`
    *   `{ type: 'room:leave' }`
    *   `{ type: 'room:select_color'; paintColor: string }`
    *   `{ type: 'room:set_stake_tier'; stakeTierUsdc: number }` (allowed before any player in the room has locked a stake)
    *   `{ type: 'room:lock_stake' }`
    *   `{ type: 'input:lane_hop'; targetLaneIndex: number; clientSeq: number }`
    *   `{ type: 'wallet:faucet' }`

*   **Server-to-Client Events (`ServerToClientMessage`)**:
    *   `{ type: 'wallet:state'; walletAddress: string; balanceUsdc6: string; balanceFormatted: string; balanceNativeGas18: string }`
    *   `{ type: 'room:state'; room: SerializedRoomState }`
    *   `{ type: 'room:error'; code: 'COLOR_OCCUPIED' | 'ROOM_FULL' | 'ROOM_NOT_FOUND' | 'INSUFFICIENT_BALANCE' | 'ALREADY_STARTED'; message: string }`
    *   `{ type: 'match:start'; roomCode: string; trafficSeed: number; orionRound: number; orionRandomnessHash: string; escrowTxHash: string; potUsdc6: string; potFormatted: string; activeRacers: SerializedRacerState[] }`
    *   `{ type: 'match:tick'; serverTick: number; elapsedMs: number; racers: SerializedRacerDelta[] }`
    *   `{ type: 'match:eliminated'; playerId: string; laneIndex: number; z: number; survivalTimeMs: number }`
    *   `{ type: 'match:finished'; winnerPlayerId: string; winnerWalletAddress: string; winnerDisplayName: string; payoutUsdc6: string; payoutFormatted: string; settlementTxHash: string; rankings: MatchRankingEntry[] }`

### 3. Atomic Paint Color Reservation Across `LOBBY_PAINT_SWATCHES`

Every room maintains 4 slots (`laneIndex: 0 | 1 | 2 | 3`) and enforces strict color uniqueness across the 6 swatches in `LOBBY_PAINT_SWATCHES` (`#2563eb`, `#fbb124`, `#06b6d4`, `#f43f5e`, `#10b981`, `#a855f7`):

1.  **On Join**: When a human player joins a room slot, the server inspects the set of colors currently held by all occupied slots (`status !== 'waiting'`) in that room. If the joining player's `preferredColor` is valid and unoccupied, it is assigned; otherwise, the server assigns the first unoccupied swatch from `LOBBY_PAINT_SWATCHES` in deterministic order.
2.  **On `room:select_color`**: The server checks on the single-threaded Node.js event loop whether any other occupied slot in the room holds `normalizePaintHex(paintColor)`.
    *   If occupied, the server returns `{ type: 'room:error', code: 'COLOR_OCCUPIED' }` to the requester and leaves room state unchanged.
    *   If free, the server updates the requester's slot `paintColor` and immediately broadcasts `room:state` to all room members.
3.  **3D Preview Synchronization**: Only occupied slots (`status !== 'waiting'`) lock their chosen swatch. For any unoccupied slot (`status === 'waiting'`) rendered on the lobby background highway, `resolveUniqueLanePaintColors` assigns a distinct fallback swatch from the remaining free swatches so all 4 preview cars on the 3D grid maintain 4 distinct colors.

### 4. Deterministic Seeded Traffic & 60 Hz Authoritative Simulation Loop

To synchronize 28 civilian vehicles (`sedan`, `suv`, `truck`) without sending 28 vehicle transforms over WebSocket every frame:

1.  **Seeded PRNG (`createSeededRng(seed: number)` in `src/game/traffic.ts`)**:
    *   Implements a pure 32-bit `mulberry32` generator returning deterministic floats in `[0, 1)`.
    *   `createInitialTraffic(playerZ, seed)` and `stepTrafficVehicles(vehicles, playerZ, playerSpeed, dt, rng)` accept the deterministic RNG state rather than calling `Math.random()`.
    *   Because the highway is straight (`getTrackPointAtS(s).x === 0`, `z === s`) and all active racers travel at the uniform cruise speed profile (`stepRacerPhysics`), the longitudinal scroll coordinate `anchorZ` is deterministic at every tick `t = serverTick * (1 / 60)`.
2.  **Authoritative Server Loop (`60 Hz` Physics, `20 Hz` Network Broadcast)**:
    *   Every `16.67 ms` (`60 Hz`), the server steps each active room in `'playing'` state:
        *   Advances `anchorZ` and steps all active (non-eliminated) human racers via `stepRacerPhysics` and `stepLaneHopKinematics`.
        *   Steps the room's 28 civilian traffic vehicles using the room's seeded RNG via `stepTrafficVehicles`.
        *   Runs `checkRacerTrafficCollision(racer, trafficVehicles)` for each active human racer.
        *   If a collision occurs, marks `racer.eliminated = true`, records `racer.eliminatedAtMs = elapsedMs`, and immediately broadcasts `match:eliminated`.
    *   Every 3rd physics tick (`20 Hz` / `50 ms`), broadcasts a compact `match:tick` packet containing `{ playerId, laneIndex, targetLaneIndex, lateralOffset, hopProgress, hopVerticalOffset, z, speed, eliminated }` for each human racer in the room.
    *   On the client, `WorldCanvas.tsx` steps the identical seeded traffic wave locally at render framerate for smooth 60+ FPS visuals, applies optimistic lane-hop prediction for the local player's car, and reconciles remote racers' `lateralOffset` and `hopProgress` from the `20 Hz` server snapshots.

### 5. Arc Studio 6/18-Decimal USDC Escrow, Mid-Race Disconnect Forfeiture & 60s Timeout Refund

```text
[Lobby: Player Connects]
       |
       |  room:lock_stake (Debits Stake from Wallet Ledger via Amount.parseUsdc)
       v
[Slot: STAKED] ---> Starts/Resets 60s Room Escrow Timer (LOBBY_ESCROW_TIMEOUT_MS = 60_000)
       |
       +---> (A) Player disconnects in LOBBY OR 60s Timer expires before quorum ready:
       |         -> Refund locked stake to player wallet ledger
       |         -> Reset slot / release paint color lock
       |
       +---> (B) All N (2..4) connected human players in room lock stake:
                 -> Cancel 60s timeout timer
                 -> Lock Total Pot = N * Stake (non-refundable)
                 -> Transition to COUNTDOWN (3s) -> PLAYING
                        |
                        +---> Player disconnects during PLAYING:
                        |     -> Stake remains in Total Pot (forfeited as committed funds)
                        |     -> Car stays on current lane without steering until traffic collision
                        |
                        +---> Last Surviving Player determined:
                              -> Credit Total Pot (N * Stake) to Winner Wallet Ledger
                              -> Broadcast match:finished with Arc Testnet settlement receipt
```

All currency arithmetic uses `src/onchain-money.ts` and `src/onchain-facts.ts`:
*   **Stake Debit**: When a player locks a stake tier (`5`, `10`, `25`, or `50 USDC`), the server converts the tier via `Amount.parseUsdc(String(stakeTierUsdc))` (`6` decimals) and computes its native Arc Testnet gas representation via `usdcToGasToken(stakeAmount)` (`18` decimals).
*   **60-Second Pre-Race Escrow Timeout**: When the first player in a lobby locks their stake, the room sets `escrowExpiresAt = Date.now() + 60_000`. If the room does not transition to `'countdown'` before `escrowExpiresAt`, the server refunds every `'staked'` player in that room and resets their slot status to `'connected'`.
*   **Mid-Race Disconnect Forfeiture**: Once the room enters `'countdown'` / `'playing'`, `potLocked = true`. Any `ws.on('close')` event during `'countdown'` or `'playing'` marks `racer.connected = false` without refunding their stake. Their car continues driving forward in its current lane until eliminated by a civilian vehicle, and their stake is paid out to the match winner as part of `Winner Pot = N × Stake`.

## Alternatives Considered

### Alternative A: Peer-to-Peer WebRTC / BroadcastChannel Mesh Without an Authoritative Server

*   **Pros**:
    *   Zero server simulation loop CPU overhead; all physics and traffic collisions execute solely inside each player's browser.
    *   Direct peer-to-peer messages avoid routing hops through a central Node.js process when two tabs are on the same local machine.
*   **Cons**:
    *   `BroadcastChannel` cannot communicate across separate devices, browsers, or networks.
    *   Peer-to-peer WebRTC still requires a central signaling server for room discovery (`Quick Match` and 6-character room codes) and fails behind symmetric NATs without TURN relays.
    *   Lacks authoritative anti-cheat: any modified client can ignore local traffic collisions, spoof survival status, or manipulate `localStorage` USDC balances to claim the match pot.
*   **Reason for Rejection**: Rejected by author: lacks cross-device discovery and authoritative anti-cheat for wagered Arc Testnet USDC matches.

### Alternative B: Filling Unoccupied Online Room Slots with Server-Driven AI Bots

*   **Pros**:
    *   Guarantees that all 4 highway lanes (`P1..P4`) always contain an active racer even when only 2 or 3 human players join a room.
    *   Reuses existing AI lane-avoidance heuristics (`stepRivalAiSteering`) from single-browser practice mode.
*   **Cons**:
    *   Violates the self-wager escrow pool invariant (`Winner Pot = N × Stake`) because an AI bot does not own an independent player wallet or fund a real USDC stake.
    *   Either requires the server to subsidize synthetic bot stakes (exposing the house ledger to farming) or allows an AI bot to eliminate or outlast human players for a pot it did not fund.
*   **Reason for Rejection**: Rejected by author: online matches must be strictly between live human players (`2..4` players, zero AI bots).

### Alternative C: Refunding a Player's Locked Stake on Mid-Race Disconnect

*   **Pros**:
    *   Protects a player who experiences an accidental network drop during an active race from losing their committed USDC wager.
*   **Cons**:
    *   Creates an exploit where any player about to collide with a civilian cargo truck at `295 km/h` can close their browser tab or disconnect their socket milliseconds before impact to trigger a refund and deny the surviving opponents their full `N × Stake` pot.
*   **Reason for Rejection**: Rejected by author: mid-race disconnect must forfeit the committed stake into the active pot ("ставка сохраняется в игре и расценивается как уже внесённые средства"), while pre-race lobby timeouts (`60` seconds before start) refund automatically.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Anti-Cheat Authority**:
    *   The client is never trusted for wallet balance mutations, paint color reservation, traffic collision survival, or payout settlement.
    *   All `input:lane_hop` payloads are validated on the server to ensure `targetLaneIndex` is an integer in `0..3` and differs from the racer's current `laneIndex` by at most `1` lane per hop initiation.
    *   Wallet addresses are normalized to lowercase 42-character hexadecimal format (`^0x[a-f0-9]{40}$`).
*   **Performance & Latency Budget**:
    *   The server executes the physics and traffic collision tick at `60 Hz` (`16.67 ms` step) per active `'playing'` room and broadcasts compact racer delta packets at `20 Hz` (`50 ms` interval), keeping per-client downstream WebSocket bandwidth under `4 KB/s`.
    *   The client renders local and remote cars at native monitor refresh rate (`60+ FPS`) by interpolating remote `lateralOffset` and `hopProgress` between `20 Hz` snapshots and stepping the shared deterministic traffic generator (`mulberry32`) locally.
*   **Rollout & Backward Compatibility**:
    *   `server.ts` serves both the WebSocket endpoint (`/ws`), REST API (`/api/*`), and the Vite frontend on port `3000`, complying with the runtime environment's single-port constraint.
    *   Existing unit tests (`src/game/rules.test.ts`) continue to pass alongside new deterministic traffic, atomic color reservation, and escrow disconnect/timeout tests.

--------------------------------------------------------------------------------

### Additional Resources

*   [`./online_multiplayer_launch.md`](./online_multiplayer_launch.md) — Brainstorming RFC and 7-lens Goldfish analysis.
*   [`../../src/onchain-facts.ts`](../../src/onchain-facts.ts) — Immutable Arc Testnet (`chainId: 5042002`) USDC (`0x3600000000000000000000000000000000000000`) and Orion `RandomnessHub v2` (`0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`) contract registry.
*   [`../../src/onchain-money.ts`](../../src/onchain-money.ts) — Immutable `Amount` utility for 6-decimal ERC-20 USDC and 18-decimal native gas token conversion (`parseUsdc`, `formatUsdc`, `usdcToGasToken`, `gasTokenToUsdc`).

### Future Improvements

*   **Reconnect Window During Lobby Countdown**: Allow a player whose WebSocket drops briefly during the 3-second pre-race countdown to reclaim their active racer slot via `clientId` session token so they can resume steering in `'playing'` state.
*   **Spectator Camera Switching After Elimination**: Allow an eliminated human player waiting for the remaining survivors in the same room to cycle their 3D chase camera across the surviving human cars until `match:finished` fires.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `package.json` ([Modify])

*   **Type / Scope**: Build & Runtime Configuration
*   **Rationale**: The application requires the `ws` WebSocket server library (plus `@types/ws`) and must launch `server.ts` on port `3000` for both development (`npm run dev`) and production (`npm start`).
*   **Proposed Changes**:
    *   Add runtime dependency `ws` and type definitions `@types/ws`.
    *   Update `"scripts.dev"` from `"vite --port=3000 --host=0.0.0.0"` to `"tsx server.ts"`.
    *   Add `"scripts.start"` set to `"NODE_ENV=production tsx server.ts"`.

#### 2. `src/shared/multiplayerProtocol.ts` ([Create])

*   **Type / Scope**: Shared TypeScript Wire Protocol & Domain Types
*   **Rationale**: Both the Node.js server (`server.ts`, `src/server/*`) and browser client (`src/game/useOnlineMultiplayer.ts`, `src/components/MultiplayerMainMenu.tsx`) need identical type definitions for rooms, player slots, racer telemetry deltas, and WebSocket message envelopes.
*   **Proposed Changes**:
    *   Define `RoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished'`.
    *   Define `SlotStatus = 'waiting' | 'connected' | 'staked'`.
    *   Define `SerializedLobbySlot` (`laneIndex: 0 | 1 | 2 | 3`, `playerId: string | null`, `displayName: string`, `walletAddress: string | null`, `paintColor: string`, `status: SlotStatus`, `stakeAmountUsdc: number`, `connected: boolean`).
    *   Define `SerializedRoomState` (`roomCode: string`, `isPublicQuickMatch: boolean`, `status: RoomStatus`, `stakeTierUsdc: number`, `potUsdc6: string`, `potFormatted: string`, `escrowExpiresAt: number | null`, `escrowStatus: 'idle' | 'locking' | 'locked_in_race' | 'refunded_timeout' | 'settled'`, `countdownRemainingMs: number | null`, `trafficSeed: number`, `orionRound: number`, `orionRandomnessHash: string`, `slots: [SerializedLobbySlot, SerializedLobbySlot, SerializedLobbySlot, SerializedLobbySlot]`).
    *   Define `SerializedRacerDelta` (`playerId: string`, `laneIndex: number`, `targetLaneIndex: number`, `lateralOffset: number`, `hopProgress: number`, `hopVerticalOffset: number`, `z: number`, `speed: number`, `eliminated: boolean`, `eliminatedAtMs: number | null`, `connected: boolean`).
    *   Define discriminated unions `ClientToServerMessage` and `ServerToClientMessage`.

#### 3. `src/game/traffic.ts` ([Modify])

*   **Type / Scope**: Shared Deterministic Traffic Generator
*   **Rationale**: `createInitialTraffic` and `stepTrafficVehicles` currently call `Math.random()`, causing traffic waves to diverge across clients and server. Replacing `Math.random()` with a seeded PRNG (`mulberry32`) ensures identical traffic vehicle lanes, speeds, and longitudinal `z` coordinates on the server and all connected clients.
*   **Proposed Changes**:
    *   Export `SeededRng = () => number` and `createSeededRng(seed: number): SeededRng` implementing deterministic 32-bit `mulberry32`.
    *   Update `createInitialTraffic(playerZ: number, rng?: SeededRng): TrafficVehicle[]` and `stepTrafficVehicles(vehicles: TrafficVehicle[], playerZ: number, playerSpeed: number, dt: number, rng?: SeededRng): void` to draw all random numbers from `rng ?? Math.random`.

#### 4. `src/game/physics.ts` ([Modify])

*   **Type / Scope**: Shared Highway Physics & Human-Only Racer Initialization
*   **Rationale**: Online matches include `2..4` live human players with zero AI bots. `createInitialRacers` and the physics step helpers must support spawning only the active human slots from an online room while preserving each player's server-locked paint color and highway lane offset (`FOUR_LANE_OFFSETS`).
*   **Proposed Changes**:
    *   Add `ActiveOnlineSlotConfig` (`playerId: string`, `displayName: string`, `laneIndex: 0 | 1 | 2 | 3`, `paintColor: string`, `isLocalPlayer: boolean`).
    *   Export `createOnlineHumanRacers(trackId: TrackId, activeSlots: ActiveOnlineSlotConfig[]): RacerState[]` which creates `RacerState` instances strictly for the `2..4` human players present in the room (zero AI bots), placing each racer on their assigned `FOUR_LANE_OFFSETS[slot.laneIndex]` with their reserved unique `paintColor`.

#### 5. `src/server/arcEscrowLedger.ts` ([Create])

*   **Type / Scope**: Authoritative Server-Side Arc Testnet USDC Wallet & Escrow Ledger
*   **Rationale**: Client `localStorage` balances can be tampered with. The server must track each wallet address's available balance and room escrow lock using `src/onchain-facts.ts` and `src/onchain-money.ts` (`6`-decimal ERC-20 units and `18`-decimal native gas conversion).
*   **Proposed Changes**:
    *   Export class `ArcEscrowLedger` backed by an in-memory `Map<string, bigint>` (defaulting new addresses to `parseUsdc('100.00')` = `100_000_000n`).
    *   Expose `getWalletSnapshot(address: string)` returning `{ walletAddress, balanceUsdc6, balanceFormatted, balanceNativeGas18 }` using `formatUsdc` and `usdcToGasToken`.
    *   Expose `requestFaucet(address: string, isLockedInEscrow: boolean)` crediting `parseUsdc('50.00')` (`50_000_000n`) when not locked in an active escrow pot.
    *   Expose atomic escrow operations:
        *   `debitStake(address: string, stakeTierUsdc: number): { ok: boolean; error?: string }`
        *   `refundStake(address: string, stakeTierUsdc: number): void`
        *   `settlePotToWinner(winnerAddress: string, totalPotUsdc6: bigint): { settlementTxHash: string; payoutFormatted: string }`
        *   `generateOrionSeed(roomCode: string): { trafficSeed: number; orionRound: number; orionRandomnessHash: string; escrowTxHash: string }` referencing `ARC_ORION_CONTRACTS.randomnessHubV2` (`0xe754e552FAe5Ba55726f0e97a196ee9E19E2F9D2`) and `ARC_CHAIN_FACTS.chainId` (`5042002`).

#### 6. `src/server/multiplayerRoomManager.ts` ([Create])

*   **Type / Scope**: Authoritative Room Lifecycle, Atomic Color Lock & 60 Hz Physics Engine
*   **Rationale**: Central coordinator for public `Quick Match` queues, private 6-character room codes, atomic First-Write-Wins paint color locks, 60-second pre-race stake lock timeout refunds, mid-race disconnect stake forfeiture, and the 60 Hz authoritative simulation loop.
*   **Proposed Changes**:
    *   Export class `MultiplayerRoomManager` parameterized with `ArcEscrowLedger` and configurable `lobbyEscrowTimeoutMs = 60_000`.
    *   Implement room discovery and slot allocation (`handleQuickMatch`, `handleCreateRoom`, `handleJoinRoom`, `handleLeaveRoom`).
    *   Implement `handleSelectColor(clientId: string, paintColor: string)`:
        *   Normalizes `paintColor` via `normalizePaintHex`.
        *   Checks if any other occupied slot (`status !== 'waiting'`) in the room already holds that swatch.
        *   Rejects duplicates with `COLOR_OCCUPIED`; otherwise updates the slot and broadcasts `room:state`.
    *   Implement `handleLockStake(clientId: string)`:
        *   Debits `room.stakeTierUsdc` via `ArcEscrowLedger.debitStake`.
        *   Starts the room's 60-second pre-race escrow timer (`LOBBY_ESCROW_TIMEOUT_MS = 60_000`) when the first stake is locked.
        *   When `stakedCount >= 2` and `stakedCount === connectedHumanCount`, cancels the 60-second timeout timer, marks `potLocked = true` (`Winner Pot = stakedCount × Stake`), transitions the room to `'countdown'` (`3000 ms`), and then to `'playing'`.
    *   Implement `handleExpiryTimeout(roomCode: string)`:
        *   If the room is still in `'lobby'` after `60_000 ms`, refunds all `'staked'` players via `ArcEscrowLedger.refundStake`, resets their slots to `'connected'`, sets `escrowStatus = 'refunded_timeout'`, and broadcasts `room:state`.
    *   Implement `handleDisconnect(clientId: string)`:
        *   If `room.status === 'lobby'`, refunds the player's locked stake (if `'staked'`), clears the slot back to `'waiting'`, releases their paint color lock, and broadcasts `room:state`.
        *   If `room.status === 'countdown' | 'playing'`, retains the player's locked stake in the match pot (forfeited as committed funds), sets `racer.connected = false`, and leaves their car running on its current lane until eliminated by civilian traffic.
    *   Implement `stepActiveRooms(dtSeconds: number)` (`60 Hz` tick loop, `20 Hz` snapshot broadcast) using `createInitialTraffic(0, createSeededRng(room.trafficSeed))`, `stepTrafficVehicles`, `stepRacerPhysics`, `stepLaneHopKinematics`, and `checkRacerTrafficCollision`.

#### 7. `server.ts` ([Create])

*   **Type / Scope**: Node.js + Express + Vite + WebSocket Entry Point (Port 3000)
*   **Rationale**: Provides the single-port (`3000`) full-stack runtime combining REST wallet APIs, the `/ws` WebSocket server, and Vite frontend delivery.
*   **Proposed Changes**:
    *   Create an Express app and HTTP server listening on `0.0.0.0:3000`.
    *   Mount JSON REST routes `GET /api/health`, `GET /api/wallet/:address`, and `POST /api/faucet`.
    *   Attach `WebSocketServer({ server, path: '/ws' })` connected to `MultiplayerRoomManager`.
    *   Run a `16.67 ms` (`60 Hz`) interval timer invoking `roomManager.stepActiveRooms(1 / 60)`.
    *   Mount Vite middleware in development or static `dist/` in production.

#### 8. `src/game/arcOrionClient.ts` ([Modify])

*   **Type / Scope**: Client Wallet Identity & Server Ledger Synchronization
*   **Rationale**: Preserves local deterministic wallet address generation (`0x...`) in `localStorage` so each browser profile keeps a persistent identity, while syncing actual USDC balances and faucet credits with `/api/wallet/:address` and the WebSocket `wallet:state` feed.
*   **Proposed Changes**:
    *   Add `fetchAuthoritativeWalletBalance(address: string)` and `requestAuthoritativeFaucet(address: string)` calling `/api/wallet/:address` and `/api/faucet`, falling back gracefully in offline unit test environments.

#### 9. `src/game/useOnlineMultiplayer.ts` ([Create])

*   **Type / Scope**: React WebSocket Client Hook
*   **Rationale**: Encapsulates the WebSocket connection to `ws(s)://<host>/ws`, automatic reconnection, lobby actions (`quickMatch`, `createRoom`, `joinRoom`, `selectColor`, `setStakeTier`, `lockStake`, `requestFaucet`), and real-time race callbacks (`onMatchStart`, `onMatchTick`, `onMatchEliminated`, `onMatchFinished`).
*   **Proposed Changes**:
    *   Export `useOnlineMultiplayer(options)` managing connection status, current `roomState`, `walletState`, latest `roomError`, and outbound command senders.

#### 10. `src/components/MultiplayerMainMenu.tsx` ([Modify])

*   **Type / Scope**: Multiplayer Lobby UI Component
*   **Rationale**: Replaces browser-only `BroadcastChannel` and fake `setTimeout` matchmaking with live server room state from `useOnlineMultiplayer`, displays only live human players (`2..4` players, zero AI bots), enforces server-authoritative paint color locks across `LOBBY_PAINT_SWATCHES`, and shows the 60-second pre-race escrow countdown timer.
*   **Proposed Changes**:
    *   Remove `BroadcastChannel` and synthetic bot/rival `setTimeout` timers.
    *   Bind `Quick Match 4P`, `Create Room`, `Join by Code`, paint swatch buttons, stake tier buttons, `+50 USDC Faucet`, and `Lock Stake & Ready` directly to `useOnlineMultiplayer` actions.
    *   Display the live winner pot (`N × Stake`, where `N` is the number of staked/connected human players in the room) and remaining 60-second pre-race escrow timer when stakes are locked.

#### 11. `src/game/WorldCanvas.tsx` ([Modify])

*   **Type / Scope**: 3D Three.js Highway Renderer & Client Prediction/Reconciliation Engine
*   **Rationale**: During online races, `WorldCanvas` must spawn only the `2..4` live human racers from `match:start` (zero AI bots), seed `createInitialTraffic` and `stepTrafficVehicles` with the server's `trafficSeed`, send `input:lane_hop` on `ArrowLeft`/`ArrowRight` (`KeyA`/`KeyD`) alongside optimistic local hop feedback, and reconcile racer positions/eliminations from `match:tick`, `match:eliminated`, and `match:finished`.
*   **Proposed Changes**:
    *   Accept optional `onlineMatchSession` props (`trafficSeed`, `activeSlots`, `localPlayerId`, `serverTickStream`, `onSendLaneHop`).
    *   Initialize deterministic traffic using `createSeededRng(trafficSeed)`.
    *   Spawn only the active human racers via `createOnlineHumanRacers` (no AI rival steering in online matches).
    *   Keep `gameState === 'playing'` 100% free of HUD or map overlays.

#### 12. `src/App.tsx` ([Modify])

*   **Type / Scope**: Root Application State & Settlement Screen Coordinator
*   **Rationale**: Connects `useOnlineMultiplayer` across `MultiplayerMainMenu`, `WorldCanvas`, and the post-race `finished` settlement modal so server-settled payouts (`payoutFormatted`, `settlementTxHash`, `winnerDisplayName`) update the player's authoritative wallet balance.
*   **Proposed Changes**:
    *   Instantiate `useOnlineMultiplayer` at the top level of `App.tsx` and pass live room state, slot paint colors, and race telemetry streams down to `MultiplayerMainMenu` and `WorldCanvas`.

#### 13. `src/game/rules.test.ts` ([Modify])

*   **Type / Scope**: Automated Unit & Integration Test Suite (`node:test`)
*   **Rationale**: Verifies deterministic seeded traffic waves, human-only (`2..4` player, zero bot) racer creation, atomic First-Write-Wins paint color locking, 60-second pre-race escrow timeout refunds, and mid-race disconnect stake forfeiture.
*   **Proposed Changes**:
    *   Add unit tests covering:
        1.  Deterministic seeded traffic (`createSeededRng` produces identical traffic vehicle positions across two independent instances for the same seed).
        2.  Atomic server room paint color reservation (`MultiplayerRoomManager` rejects concurrent duplicate color selection with `COLOR_OCCUPIED`).
        3.  Human-only quorum launch (`2..4` human players launch with zero AI bots and scale pot to `N × Stake`).
        4.  Mid-race disconnect stake forfeiture (disconnecting during `'playing'` retains the disconnected player's stake in the pot and awards the full `N × Stake` pot to the surviving winner).
        5.  60-second pre-race lobby timeout refund (locked stakes in an unstarted `'lobby'` automatically refund to the authoritative ledger when `60_000 ms` elapses).

### Verification Plan

*   **Compilation/Build**: `npm run build` (`compile_applet`) passes with zero TypeScript or Vite bundling errors.
*   **Unit Tests**: `npx --yes tsx --test src/game/rules.test.ts` passes all existing 16 tests plus the 5 new online multiplayer, seeded traffic, atomic color lock, and escrow disconnect/refund tests (`21/21` passing).
*   **Static Analysis & Linting**: `npm run lint` (`lint_applet` / `tsc --noEmit`) passes with zero errors.
*   **Test Coverage Requirement**: 100% pass rate across all pure physics, seeded traffic, paint color reservation, and `MultiplayerRoomManager` escrow state transitions.
*   **E2E/Integration**: Headless Playwright (`playwright-cli`) multi-page verification on `http://localhost:3000` confirming:
    *   `GET /api/health` and `GET /api/wallet/:address` return valid JSON on port `3000`.
    *   Two concurrent browser contexts join the same room over WebSocket (`/ws`), observe real-time atomic color locking (`data-occupied="true"`), lock stakes, enter a human-only HUD-free 3D highway race, and settle the pot.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
