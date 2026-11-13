// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./MetaTxContext.sol";

/// @notice Reserve vault for the separately redeemable TRӾ token.
contract OneTraxReserveVaultMeta is MetaTxContext {
    address public immutable owner;
    address public authorizedToken;

    event ReserveFunded(address indexed funder, uint256 amount);
    event ReserveReleased(address indexed recipient, uint256 amount, bytes32 indexed reference);
    event TokenContractAuthorized(address indexed tokenContract);

    modifier onlyOwner() { require(_msgSender() == owner, "owner-only"); _; }

    constructor(address initialOwner, address trustedForwarder_) MetaTxContext(trustedForwarder_) {
        require(initialOwner != address(0), "zero-owner");
        owner = initialOwner;
    }

    function isTrustedForwarder(address forwarder) external view returns (bool) { return forwarder == trustedForwarder; }
    function reserveBalance() external view returns (uint256) { return address(this).balance; }

    function setAuthorizedToken(address tokenContract) external onlyOwner {
        require(authorizedToken == address(0), "token-already-authorized");
        require(tokenContract != address(0) && tokenContract.code.length > 0, "invalid-token");
        authorizedToken = tokenContract;
        emit TokenContractAuthorized(tokenContract);
    }

    function releaseForRedemption(address payable recipient, uint256 amount, bytes32 reference) external returns (bool) {
        require(msg.sender == authorizedToken && authorizedToken != address(0), "token-only");
        require(recipient != address(0) && amount > 0 && reference != bytes32(0), "invalid-redemption");
        require(address(this).balance >= amount, "insufficient-reserve");
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "native-trx-transfer-failed");
        emit ReserveReleased(recipient, amount, reference);
        return true;
    }

    receive() external payable { emit ReserveFunded(msg.sender, msg.value); }
}
