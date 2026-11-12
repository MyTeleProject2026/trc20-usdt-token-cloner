// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RestrictedTRC20
/// @notice TRC20-compatible restricted credit token; NOT native TRX.
/// @dev Transfers are permitted only when both sender and receiver are
/// allowlisted. The owner cannot seize or arbitrarily burn holder balances.
/// This contract is unaudited and must be reviewed before Mainnet deployment.
contract RestrictedTRC20 {
    string public name = "Tron Transfer Restricted Token";
    string public symbol = "TTRX";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    uint256 public immutable maxSupply;
    address public owner;
    bool public paused;

    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;
    mapping(address => bool) public transferAllowed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event TransferPermissionChanged(address indexed account, bool allowed);
    event PausedChanged(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error TransferRestricted();
    error InsufficientBalance();
    error InsufficientAllowance();
    error SupplyCapExceeded();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address owner_, uint256 maxSupplyWholeTokens) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (maxSupplyWholeTokens == 0 || maxSupplyWholeTokens > type(uint256).max / 10 ** decimals) revert SupplyCapExceeded();
        owner = owner_;
        maxSupply = maxSupplyWholeTokens * 10 ** decimals;
        transferAllowed[owner_] = true;
        emit OwnershipTransferred(address(0), owner_);
        emit TransferPermissionChanged(owner_, true);
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address tokenOwner, address spender) external view returns (uint256) {
        return allowances[tokenOwner][spender];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowances[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowances[from][msg.sender] = allowed - value;
            emit Approval(from, msg.sender, allowances[from][msg.sender]);
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Owner issues restricted credits; minted units are this token only.
    function mint(address to, uint256 value) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (value == 0) revert ZeroAmount();
        if (totalSupply + value > maxSupply) revert SupplyCapExceeded();
        totalSupply += value;
        balances[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// @notice Owner manages which addresses may send/receive this token.
    function setTransferAllowed(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        transferAllowed[account] = allowed;
        emit TransferPermissionChanged(account, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedChanged(value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        transferAllowed[newOwner] = true;
        emit TransferPermissionChanged(newOwner, true);
        emit OwnershipTransferred(previous, newOwner);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (paused) revert Paused();
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (value == 0) revert ZeroAmount();
        if (!transferAllowed[from] || !transferAllowed[to]) revert TransferRestricted();
        if (balances[from] < value) revert InsufficientBalance();
        unchecked {
            balances[from] -= value;
            balances[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
