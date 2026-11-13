// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "./MetaTxContext.sol";

interface IRestrictedTraxPayout {
    function mintForPayout(address recipient, uint256 amount, bytes32 payoutReference) external;
}
interface INativeTrxPayoutTreasury {
    function pay(address payable recipient, uint256 amount, bytes32 reference) external;
}

/// @notice Performs native TRX payout and TRӾ issuance atomically.
/// @dev It is called through the trusted forwarder with an owner signature.
/// The TRX payout treasury and TRӾ reserve vault are intentionally separate.
contract TronTransferPayoutRouter is MetaTxContext {
    address public immutable owner;
    address public immutable traxToken;
    address public immutable nativeTreasury;
    mapping(bytes32 => bool) public processedReferences;
    bool private _entered;

    event CombinedPayout(address indexed recipient, uint256 nativeTrxAmount, uint256 traxAmount, bytes32 indexed reference);

    modifier onlyOwner() { require(_msgSender() == owner, "owner-only"); _; }
    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(address initialOwner, address trustedForwarder_, address token_, address treasury_)
        MetaTxContext(trustedForwarder_)
    {
        require(initialOwner != address(0) && token_ != address(0) && treasury_ != address(0), "zero-address");
        require(token_.code.length > 0 && treasury_.code.length > 0, "contracts-not-deployed");
        owner = initialOwner;
        traxToken = token_;
        nativeTreasury = treasury_;
    }

    function isTrustedForwarder(address forwarder) external view returns (bool) { return forwarder == trustedForwarder; }

    function payoutBoth(address recipient, uint256 nativeTrxAmount, uint256 traxAmount, bytes32 reference)
        external onlyOwner nonReentrant
    {
        require(recipient != address(0), "zero-recipient");
        require(nativeTrxAmount > 0 && traxAmount > 0, "zero-amount");
        require(reference != bytes32(0) && !processedReferences[reference], "invalid-or-duplicate-reference");
        processedReferences[reference] = true;

        // If either external call reverts, all state and native-TRX movement reverts.
        INativeTrxPayoutTreasury(nativeTreasury).pay(payable(recipient), nativeTrxAmount, reference);
        IRestrictedTraxPayout(traxToken).mintForPayout(recipient, traxAmount, reference);
        emit CombinedPayout(recipient, nativeTrxAmount, traxAmount, reference);
    }
}
