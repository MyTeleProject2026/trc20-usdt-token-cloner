// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice ERC-2771-style context for owner-signed TRON meta-transactions.
/// @dev A forwarder must be explicitly trusted; the final 20 calldata bytes are
/// interpreted as the signer only when msg.sender is that trusted forwarder.
abstract contract MetaTxContext {
    address public immutable trustedForwarder;

    constructor(address trustedForwarder_) {
        require(trustedForwarder_ != address(0), "zero-forwarder");
        trustedForwarder = trustedForwarder_;
    }

    function _msgSender() internal view returns (address sender) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
    }

    function _msgData() internal view returns (bytes calldata) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            return msg.data[:msg.data.length - 20];
        }
        return msg.data;
    }
}
