// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title TRON TRANSFER TRӾ owner-issued TRC-20
/// @notice An owner-mintable token with no TRX reserve, collateral, redemption, or price peg.
/// @dev Every mint increases supply without requiring a deposit. Holders can transfer freely unless paused.
contract Restricted1TRAX {
    string public constant name = unicode"TRӾ";
    string public constant symbol = "TRX";
    uint8 public constant decimals = 6;

    address public owner;
    address public pendingOwner;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    bool public paused = true;
    bool public mintingEnabled;

    uint256 public constant MAX_BATCH_CREDITS = 50;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 value);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauseStatusChanged(bool paused);
    event MintingStatusChanged(bool enabled);
    event OwnerCredit(address indexed recipient, uint256 amount, bytes32 indexed reference);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner-only");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit PauseStatusChanged(true);
        emit MintingStatusChanged(false);
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address tokenOwner, address spender) external view returns (uint256) {
        return _allowances[tokenOwner][spender];
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0) && nextOwner != owner, "invalid-pending-owner");
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && pendingOwner != address(0), "not-pending-owner");
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseStatusChanged(value);
    }

    function setMintingEnabled(bool value) external onlyOwner {
        mintingEnabled = value;
        emit MintingStatusChanged(value);
    }

    /// @notice Mint any positive amount directly to one TRON address.
    function mint(address recipient, uint256 amount) external onlyOwner whenNotPaused {
        require(mintingEnabled, "minting-disabled");
        _mint(recipient, amount);
    }

    /// @notice Owner credit with an auditable off-chain reference identifier.
    /// @dev The reference is metadata only; it does not prove an exchange credited its customer ledger.
    function credit(address recipient, uint256 amount, bytes32 reference)
        external onlyOwner whenNotPaused
    {
        require(mintingEnabled, "minting-disabled");
        require(reference != bytes32(0), "reference-required");
        _mint(recipient, amount);
        emit OwnerCredit(recipient, amount, reference);
    }

    /// @notice Credit multiple external TRON addresses in one owner-authorized transaction.
    function batchCredit(address[] calldata recipients, uint256[] calldata amounts, bytes32[] calldata references)
        external onlyOwner whenNotPaused
    {
        require(mintingEnabled, "minting-disabled");
        uint256 length = recipients.length;
        require(length > 0 && length <= MAX_BATCH_CREDITS, "invalid-batch-size");
        require(amounts.length == length && references.length == length, "array-length-mismatch");
        for (uint256 i = 0; i < length; i++) {
            require(references[i] != bytes32(0), "reference-required");
            _mint(recipients[i], amounts[i]);
            emit OwnerCredit(recipients[i], amounts[i], references[i]);
        }
    }

    function _mint(address recipient, uint256 amount) internal {
        require(recipient != address(0), "zero-recipient");
        require(amount > 0, "zero-amount");
        require(_totalSupply <= type(uint256).max - amount, "supply-overflow");
        require(_balances[recipient] <= type(uint256).max - amount, "balance-overflow");
        _totalSupply += amount;
        _balances[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function transfer(address to, uint256 amount) external whenNotPaused returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external whenNotPaused returns (bool) {
        require(spender != address(0), "zero-spender");
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenNotPaused returns (bool) {
        uint256 permitted = _allowances[from][msg.sender];
        require(permitted >= amount, "insufficient-allowance");
        _allowances[from][msg.sender] = permitted - amount;
        emit Approval(from, msg.sender, permitted - amount);
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0) && to != address(0), "zero-address");
        require(amount > 0, "zero-amount");
        require(_balances[from] >= amount, "insufficient-balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
