// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRandomnessHub
/// @notice Ownerless drand beacon registry and native-USDC randomness request interface.
interface IRandomnessHub {
    /// @notice Lifecycle of a randomness request; callback failure does not undo its reward payout.
    enum Status { None, Pending, Fulfilled, CallbackFailed, Cancelled }

    /// @notice Immutable request parameters together with the current delivery status.
    struct Request {
        address consumer;
        uint64 round;
        uint32 callbackGas;
        uint128 reward;
        Status status;
    }

    /// @notice Request a future round, paying a native-USDC reward (18-decimal units).
    /// @param callbackGas Maximum gas forwarded to the consumer callback.
    /// @return id Unique request identifier.
    function requestRandomness(uint32 callbackGas) external payable returns (uint256 id);

    /// @notice Pay the caller once and deliver randomness for a pending request.
    /// @param id Pending request identifier.
    /// @param signature G1 signature [x, y]; ignored if the round is already stored.
    function fulfill(uint256 id, uint256[2] calldata signature) external;

    /// @notice Verify and store a round without earning a reward.
    /// @param round Nonzero drand round number.
    /// @param signature G1 signature [x, y].
    function submitBeacon(uint64 round, uint256[2] calldata signature) external;

    /// @notice Retry failed delivery without paying another reward.
    /// @param id Request whose status is CallbackFailed.
    function retryCallback(uint256 id) external;

    /// @notice Refund an expired pending request if its beacon has not been stored.
    /// @param id Request belonging to the caller.
    function cancel(uint256 id) external;

    /// @notice Withdraw the caller's accumulated native-USDC credit; reverts on transfer failure.
    function claim() external;

    /// @notice Get the first round at or after a timestamp, with a minimum of one.
    /// @param timestamp Unix timestamp in seconds.
    /// @return round Calculated round number, before any uint64 narrowing.
    function roundAt(uint256 timestamp) external view returns (uint256 round);

    /// @notice Get the scheduled timestamp genesisTime + round * period.
    /// @param round Round number.
    /// @return timestamp Scheduled Unix timestamp in seconds.
    function roundTime(uint64 round) external view returns (uint256 timestamp);

    /// @notice Read a stored beacon; zero means not stored.
    /// @param round Round number.
    /// @return value keccak256(abi.encode(signature)).
    function beacon(uint64 round) external view returns (bytes32 value);

    /// @notice Read request parameters and status; an unknown identifier returns a zeroed request.
    /// @param id Request identifier.
    /// @return request Stored request.
    function getRequest(uint256 id) external view returns (Request memory request);

    /// @notice Derive request-specific randomness; reverts unless that request's beacon exists.
    /// @param id Existing request identifier.
    /// @return randomness Hash bound to the beacon, hub, chain and request identifier.
    function randomnessOf(uint256 id) external view returns (bytes32 randomness);

    /// @notice Read the immutable G2 key in BLS library order [x0, x1, y0, y1].
    /// @return key Four public-key field elements without reordering.
    function publicKey() external view returns (uint256[4] memory key);

    /// @notice Read the immutable genesis Unix timestamp in seconds.
    function genesisTime() external view returns (uint256);

    /// @notice Read the immutable round period in seconds (three for drand evmnet).
    function period() external view returns (uint256);
}
