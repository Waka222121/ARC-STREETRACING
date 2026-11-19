// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRandomnessHub} from "./IRandomnessHub.sol";

/// @title RandomnessConsumer
/// @notice Base contract authenticating RandomnessHub callbacks and forwarding request rewards.
/// @dev CONSUMER RULES:
/// (1) Freeze every input affecting the outcome BEFORE calling _requestRandomness: the round
/// value becomes public on drand before it lands onchain.
/// (2) Never revert in the callback: record the value and settle in a separate transaction.
/// (3) Keep your own timeout and refund path because a round can be delayed.
/// The selected hub is immutable. The protocol needs an independent audit before mainnet
/// because its BLS library is unaudited. Native-USDC rewards use 18-decimal units on Arc.
abstract contract RandomnessConsumer {
    IRandomnessHub public immutable hub;

    error ZeroHub();
    error OnlyHub();

    /// @notice Bind this consumer permanently to a nonzero hub address.
    /// @param hub_ Address of the RandomnessHub protocol deployment.
    constructor(address hub_) {
        if (hub_ == address(0)) revert ZeroHub();
        hub = IRandomnessHub(hub_);
    }

    /// @notice Restrict a callback to this consumer's immutable hub.
    modifier onlyHub() {
        if (msg.sender != address(hub)) revert OnlyHub();
        _;
    }

    /// @notice Receive authenticated request-specific randomness from the hub.
    /// @dev Derived contracts should store the value without reverting and settle later.
    /// @param id Identifier returned by the hub when the consumer requested randomness.
    /// @param randomness Verified beacon value bound to the hub, chain and request identifier.
    function onRandomness(uint256 id, bytes32 randomness) external onlyHub {
        _onRandomness(id, randomness);
    }

    /// @notice Request randomness using this contract's native-USDC balance.
    /// @dev Freeze all outcome-affecting inputs before invoking this helper. Derived contracts
    /// must implement their own funding, authorization, timeout and cancellation/refund paths.
    /// @param callbackGas Maximum gas to forward to onRandomness.
    /// @param reward Native-USDC reward in 18-decimal units, forwarded as msg.value.
    /// @return id Unique hub request identifier.
    function _requestRandomness(uint32 callbackGas, uint256 reward) internal returns (uint256 id) {
        return hub.requestRandomness{value: reward}(callbackGas);
    }

    /// @notice Handle a callback after the hub address has been authenticated.
    /// @dev Implement as a non-reverting record step; defer settlement and external payouts.
    /// @param id Hub request identifier.
    /// @param randomness Request-specific randomness.
    function _onRandomness(uint256 id, bytes32 randomness) internal virtual;
}
