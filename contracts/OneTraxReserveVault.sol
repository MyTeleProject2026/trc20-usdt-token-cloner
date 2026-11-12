// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Tron Transfer 1TRAX native TRX reserve vault
/// @notice Holds native TRX separately from the 1TRAX token contract.
/// @dev No owner withdrawal path exists. Only the linked 1TRAX contract can release reserve TRX.
contract OneTraxReserveVault {
    address public immutable owner;
    address public authorizedToken;

    event ReserveFunded(address indexed funder, uint256 amount);
    event ReserveReleased(address indexed recipient, uint256 amount, bytes32 indexed redemptionReference);
    event TokenContractAuthorized(address indexed tokenContract);

    modifier onlyOwner() { require(msg.sender == owner, "owner-only"); _; }

    constructor() { owner = msg.sender; }

    function reserveBalance() external view returns (uint256) { return address(this).balance; }

    function setAuthorizedToken(address tokenContract) external onlyOwner {
        require(authorizedToken == address(0), "token-already-authorized");
        require(tokenContract != address(0) && tokenContract.code.length > 0, "invalid-token-contract");
        authorizedToken = tokenContract;
        emit TokenContractAuthorized(tokenContract);
    }

    function releaseForRedemption(address payable recipient, uint256 amount, bytes32 redemptionReference)
        external returns (bool)
    {
        require(msg.sender == authorizedToken && authorizedToken != address(0), "token-contract-only");
        require(recipient != address(0) && amount > 0, "invalid-redemption");
        require(redemptionReference != bytes32(0), "reference-required");
        require(address(this).balance >= amount, "insufficient-reserve");
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "native-trx-transfer-failed");
        emit ReserveReleased(recipient, amount, redemptionReference);
        return true;
    }

    receive() external payable { emit ReserveFunded(msg.sender, msg.value); }
}
