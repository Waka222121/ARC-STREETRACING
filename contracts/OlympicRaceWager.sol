// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RandomnessConsumer} from "./RandomnessConsumer.sol";
import {IRandomnessHub} from "./IRandomnessHub.sol";

/// @title OlympicRaceWager
/// @notice 4-player "Each Stakes on Self — Winner Takes All" race escrow on Arc using Orion (RandomnessHub v2).
/// @dev Strictly follows all three Orion Consumer Rules:
/// (1) Freezes the 4-racer starting grid and total USDC pot BEFORE calling `_requestRandomness`.
/// (2) Never reverts in `_onRandomness`: only stores `bytes32 randomness` onchain.
/// (3) Settles the winner payout in a separate `settleRace` call with bounded-gas `_payOrCredit`
///     fallback (`credits[account]` + `claim()`), and provides `cancelExpiredRace` timeout protection.
/// Native USDC on Arc uses 18 decimals in `msg.value`.
contract OlympicRaceWager is RandomnessConsumer {
    uint32 public constant CALLBACK_GAS = 120_000;
    uint256 public constant MIN_RELAYER_REWARD = 1e16; // 0.01 USDC (Orion Hub v2 minimum)
    uint256 public constant RACE_TIMEOUT = 15 minutes;
    uint256 private constant PAYOUT_GAS = 50_000;

    enum RaceStatus {
        None,
        Open,
        Locked,
        RandomnessReady,
        Settled,
        Cancelled
    }

    struct RacePool {
        uint256 stakePerPlayer;      // Native 18-decimal USDC staked by each racer on themselves
        uint256 relayerReward;       // Native 18-decimal USDC attached for Orion RandomnessHub relayer
        uint256 totalPot;            // Accumulated self-stakes (4 * stakePerPlayer when locked)
        uint256 createdAt;
        uint256 lockedAt;
        uint256 requestId;           // Orion RandomnessHub request ID
        bytes32 randomness;          // Verified 32-byte randomness from Orion
        address[4] racers;           // 4 highway lanes (0: Left, 1: Mid-Left, 2: Mid-Right, 3: Right)
        uint8 joinedCount;
        uint8 winnerLane;
        address winner;
        RaceStatus status;
    }

    uint256 public nextRaceId = 1;
    mapping(uint256 => RacePool) private races;
    mapping(uint256 => uint256) public raceIdByRequestId;
    mapping(address => uint256) public credits;

    bool private locked;

    error Reentrancy();
    error InvalidStake();
    error InvalidRelayerReward();
    error InvalidLane();
    error LaneAlreadyTaken();
    error AlreadyJoined();
    error InvalidRaceStatus();
    error GridNotFull();
    error RandomnessNotReady();
    error TimeoutNotReached();
    error NoCredit();
    error TransferFailed();

    event RaceCreated(
        uint256 indexed raceId,
        address indexed host,
        uint8 hostLane,
        uint256 stakePerPlayer,
        uint256 relayerReward
    );
    event RacerStaked(uint256 indexed raceId, address indexed racer, uint8 lane, uint256 stakeAmount);
    event GridLockedAndRandomnessRequested(
        uint256 indexed raceId,
        uint256 indexed requestId,
        uint256 totalPot,
        uint256 relayerReward
    );
    event RandomnessRecorded(uint256 indexed raceId, uint256 indexed requestId, bytes32 randomness);
    event RaceSettled(
        uint256 indexed raceId,
        uint8 indexed winnerLane,
        address indexed winner,
        uint256 potWon,
        bytes32 randomness
    );
    event RaceCancelled(uint256 indexed raceId, uint256 refundedPerPlayer);
    event PayoutCredited(address indexed recipient, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    /// @param hub_ Deployed Orion RandomnessHub v2 address (`0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2` on Arc Testnet)
    constructor(address hub_) RandomnessConsumer(hub_) {}

    /// @notice Receive refund from RandomnessHub if an expired randomness request is cancelled.
    receive() external payable {}

    /// @notice Create a new 4-player Winner-Takes-All race pool and stake on your own lane.
    /// @dev `msg.value` must equal `stakePerPlayer + relayerReward`.
    function createRace(
        uint256 stakePerPlayer,
        uint256 relayerReward,
        uint8 lane
    ) external payable nonReentrant returns (uint256 raceId) {
        if (stakePerPlayer == 0) revert InvalidStake();
        if (relayerReward < MIN_RELAYER_REWARD) revert InvalidRelayerReward();
        if (lane >= 4) revert InvalidLane();
        if (msg.value != stakePerPlayer + relayerReward) revert InvalidStake();

        raceId = nextRaceId++;
        RacePool storage r = races[raceId];
        r.stakePerPlayer = stakePerPlayer;
        r.relayerReward = relayerReward;
        r.totalPot = stakePerPlayer;
        r.createdAt = block.timestamp;
        r.racers[lane] = msg.sender;
        r.joinedCount = 1;
        r.status = RaceStatus.Open;

        emit RaceCreated(raceId, msg.sender, lane, stakePerPlayer, relayerReward);
        emit RacerStaked(raceId, msg.sender, lane, stakePerPlayer);
    }

    /// @notice Join an open race by staking `stakePerPlayer` on yourself in one of the 4 lanes.
    /// @dev When the 4th racer stakes, the grid immediately freezes and requests Orion randomness (Rule 1).
    function joinAndStake(uint256 raceId, uint8 lane) external payable nonReentrant {
        RacePool storage r = races[raceId];
        if (r.status != RaceStatus.Open) revert InvalidRaceStatus();
        if (lane >= 4) revert InvalidLane();
        if (r.racers[lane] != address(0)) revert LaneAlreadyTaken();
        if (msg.value != r.stakePerPlayer) revert InvalidStake();

        for (uint8 i = 0; i < 4; i++) {
            if (r.racers[i] == msg.sender) revert AlreadyJoined();
        }

        r.racers[lane] = msg.sender;
        r.totalPot += msg.value;
        r.joinedCount += 1;

        emit RacerStaked(raceId, msg.sender, lane, msg.value);

        // Rule 1: As soon as all 4 lanes are filled, freeze inputs and request Orion randomness
        if (r.joinedCount == 4) {
            _freezeAndRequest(raceId, r);
        }
    }

    /// @notice Single-transaction helper for instant 4-player lobby start (locks all 4 lane addresses and stakes).
    /// @dev Freezes all 4 lane participants before calling `_requestRandomness`.
    function createInstantFourPlayerRace(
        address[4] calldata laneRacers,
        uint256 stakePerPlayer,
        uint256 relayerReward
    ) external payable nonReentrant returns (uint256 raceId, uint256 requestId) {
        if (stakePerPlayer == 0) revert InvalidStake();
        if (relayerReward < MIN_RELAYER_REWARD) revert InvalidRelayerReward();
        uint256 totalPot = stakePerPlayer * 4;
        if (msg.value != totalPot + relayerReward) revert InvalidStake();

        for (uint8 i = 0; i < 4; i++) {
            if (laneRacers[i] == address(0)) revert InvalidLane();
        }

        raceId = nextRaceId++;
        RacePool storage r = races[raceId];
        r.stakePerPlayer = stakePerPlayer;
        r.relayerReward = relayerReward;
        r.totalPot = totalPot;
        r.createdAt = block.timestamp;
        r.racers = laneRacers;
        r.joinedCount = 4;
        r.status = RaceStatus.Open;

        requestId = _freezeAndRequest(raceId, r);
    }

    /// @dev Consumer Rule 1: Freeze all inputs before calling `_requestRandomness`.
    function _freezeAndRequest(uint256 raceId, RacePool storage r) private returns (uint256 requestId) {
        if (r.joinedCount != 4) revert GridNotFull();
        r.status = RaceStatus.Locked;
        r.lockedAt = block.timestamp;

        requestId = _requestRandomness(CALLBACK_GAS, r.relayerReward);
        r.requestId = requestId;
        raceIdByRequestId[requestId] = raceId;

        emit GridLockedAndRandomnessRequested(raceId, requestId, r.totalPot, r.relayerReward);
    }

    /// @dev Consumer Rule 2: Never revert in `_onRandomness`. Only store the value.
    function _onRandomness(uint256 requestId, bytes32 randomness) internal override {
        uint256 raceId = raceIdByRequestId[requestId];
        if (raceId == 0) return;

        RacePool storage r = races[raceId];
        if (r.status == RaceStatus.Locked) {
            r.randomness = randomness;
            r.status = RaceStatus.RandomnessReady;
            emit RandomnessRecorded(raceId, requestId, randomness);
        }
    }

    /// @notice Consumer Rule 3: Settle the race in a separate transaction and pay 100% of the pot to the winner.
    /// @dev Also supports pull-reading `hub.randomnessOf(requestId)` if the callback failed or was skipped.
    function settleRace(uint256 raceId) external nonReentrant returns (uint8 winnerLane, address winner) {
        RacePool storage r = races[raceId];
        if (r.status != RaceStatus.RandomnessReady && r.status != RaceStatus.Locked) {
            revert InvalidRaceStatus();
        }

        bytes32 rnd = r.randomness;
        if (rnd == bytes32(0)) {
            // Pull directly from RandomnessHub registry if beacon is already stored
            rnd = hub.randomnessOf(r.requestId);
            if (rnd == bytes32(0)) revert RandomnessNotReady();
            r.randomness = rnd;
        }

        winnerLane = uint8(uint256(rnd) % 4);
        winner = r.racers[winnerLane];
        uint256 pot = r.totalPot;

        r.winnerLane = winnerLane;
        r.winner = winner;
        r.status = RaceStatus.Settled;

        _payOrCredit(winner, pot);
        emit RaceSettled(raceId, winnerLane, winner, pot, rnd);
    }

    /// @notice Consumer Rule 3: Timeout & refund path if a race does not fill or randomness does not arrive in time.
    function cancelExpiredRace(uint256 raceId) external nonReentrant {
        RacePool storage r = races[raceId];
        if (r.status != RaceStatus.Open && r.status != RaceStatus.Locked) {
            revert InvalidRaceStatus();
        }
        uint256 refTime = r.lockedAt != 0 ? r.lockedAt : r.createdAt;
        if (block.timestamp <= refTime + RACE_TIMEOUT) revert TimeoutNotReached();

        RaceStatus prevStatus = r.status;
        r.status = RaceStatus.Cancelled;

        uint256 stake = r.stakePerPlayer;
        for (uint8 i = 0; i < 4; i++) {
            address racer = r.racers[i];
            if (racer != address(0)) {
                _payOrCredit(racer, stake);
            }
        }

        // If the race was never locked with the hub, also refund the relayerReward to the first joined racer
        if (prevStatus == RaceStatus.Open && r.relayerReward > 0) {
            for (uint8 i = 0; i < 4; i++) {
                if (r.racers[i] != address(0)) {
                    _payOrCredit(r.racers[i], r.relayerReward);
                    break;
                }
            }
        }

        emit RaceCancelled(raceId, stake);
    }

    /// @notice Withdraw any credited native-USDC payout or refund.
    function claim() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NoCredit();
        credits[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice View full details of a race pool.
    function getRace(uint256 raceId) external view returns (RacePool memory) {
        return races[raceId];
    }

    function _payOrCredit(address recipient, uint256 amount) private {
        bool success;
        if (recipient != address(0)) {
            uint256 payoutGas = PAYOUT_GAS;
            assembly ("memory-safe") {
                success := call(payoutGas, recipient, amount, 0, 0, 0, 0)
            }
        }
        if (!success) {
            credits[recipient] += amount;
            emit PayoutCredited(recipient, amount);
        }
    }
}
