// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Tron Transfer 1TRAX Restricted Credit
/// @notice A separate token, never native TRX. Holder transfers and approvals are disabled.
contract Restricted1TRAX {
    string public constant name = "Tron Transfer Restricted TRX Credit";
    string public constant symbol = "1TRAX";
    uint8 public constant decimals = 6;
    address public immutable owner;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    bool public mintingEnabled;
    bool public paused;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event OwnerRedemption(address indexed holder, uint256 amount, bytes32 indexed redemptionReference);
    event MintingStatusChanged(bool enabled);
    event PauseStatusChanged(bool paused);
    modifier onlyOwner() { require(msg.sender == owner, "owner-only"); _; }
    constructor() {
        owner = msg.sender;
        mintingEnabled = false;
        paused = true;
        emit MintingStatusChanged(false);
        emit PauseStatusChanged(true);
    }
    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address, address) external pure returns (uint256) { return 0; }
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseStatusChanged(value);
    }
    function setMintingEnabled(bool value) external onlyOwner {
        require(!value || !paused, "unpause-before-enabling-mint");
        mintingEnabled = value;
        emit MintingStatusChanged(value);
    }
    function mint(address recipient, uint256 amount) external onlyOwner {
        require(!paused, "paused");
        require(mintingEnabled, "minting-disabled");
        require(recipient != address(0), "zero-recipient");
        require(amount > 0, "zero-amount");
        require(_totalSupply <= type(uint256).max - amount, "supply-overflow");
        require(_balances[recipient] <= type(uint256).max - amount, "balance-overflow");
        _totalSupply += amount;
        _balances[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }
    /// @notice Owner-only burn after the separate TRX payout is independently verified.
    /// @dev This does not send TRX and does not prove a payout occurred.
    function burnForOwnerRedemption(address holder, uint256 amount, bytes32 redemptionReference) external onlyOwner {
        require(!paused, "paused");
        require(holder != address(0), "zero-holder");
        require(amount > 0, "zero-amount");
        require(redemptionReference != bytes32(0), "reference-required");
        require(_balances[holder] >= amount, "insufficient-holder-balance");
        _balances[holder] -= amount;
        _totalSupply -= amount;
        emit Transfer(holder, address(0), amount);
        emit OwnerRedemption(holder, amount, redemptionReference);
    }
    function transfer(address, uint256) external pure returns (bool) { revert("1TRAX-non-transferable"); }
    function approve(address, uint256) external pure returns (bool) { revert("1TRAX-approvals-disabled"); }
    function transferFrom(address, address, uint256) external pure returns (bool) { revert("1TRAX-non-transferable"); }
}
