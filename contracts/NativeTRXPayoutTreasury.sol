// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./MetaTxContext.sol";

/// @notice Separate, explicitly funded treasury for recipient native-TRX payouts.
/// @dev This treasury is not the TRӾ backing vault and has no owner withdrawal.
contract NativeTRXPayoutTreasury is MetaTxContext {
    address public immutable owner;
    address public payoutRouter;
    mapping(bytes32 => bool) public paidReferences;

    event Funded(address indexed funder, uint256 amount);
    event PayoutRouterConfigured(address indexed router);
    event NativeTRXPaid(address indexed recipient, uint256 amount, bytes32 indexed payoutReference);

    modifier onlyOwner() { require(_msgSender() == owner, "owner-only"); _; }

    constructor(address initialOwner, address trustedForwarder_) MetaTxContext(trustedForwarder_) {
        require(initialOwner != address(0), "zero-owner");
        owner = initialOwner;
    }

    function setPayoutRouter(address router) external onlyOwner {
        require(payoutRouter == address(0), "router-already-set");
        require(router != address(0) && router.code.length > 0, "invalid-router");
        payoutRouter = router;
        emit PayoutRouterConfigured(router);
    }

    function isTrustedForwarder(address forwarder) external view returns (bool) { return forwarder == trustedForwarder; }
    function availableBalance() external view returns (uint256) { return address(this).balance; }

    function pay(address payable recipient, uint256 amount, bytes32 reference) external {
        require(msg.sender == payoutRouter && payoutRouter != address(0), "router-only");
        require(recipient != address(0) && amount > 0 && reference != bytes32(0), "invalid-payout");
        require(!paidReferences[reference], "duplicate-reference");
        require(address(this).balance >= amount, "insufficient-native-trx-treasury");
        paidReferences[reference] = true;
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "native-trx-transfer-failed");
        emit NativeTRXPaid(recipient, amount, reference);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }
}
