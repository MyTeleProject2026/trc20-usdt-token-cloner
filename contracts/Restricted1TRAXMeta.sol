// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./MetaTxContext.sol";

interface IOneTraxReserveVaultMeta {
    function reserveBalance() external view returns (uint256);
    function authorizedToken() external view returns (address);
    function releaseForRedemption(address payable recipient, uint256 amount, bytes32 redemptionReference) external returns (bool);
}

/// @notice Meta-transaction-aware TRӾ TRC-20. Separate from the original deployment.
/// @dev Never use a sponsor as initialOwner. All owner checks resolve the signed
/// owner appended by the explicitly trusted forwarder.
contract Restricted1TRAXMeta is MetaTxContext {
    string public constant name = unicode"TRӾ";
    string public constant symbol = "TRX";
    uint8 public constant decimals = 6;

    address public owner;
    address public pendingOwner;
    address public reserveVault;
    address public payoutRouter;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    struct AllowanceData { uint256 amount; uint256 ownerLockNonce; uint256 spenderLockNonce; }
    mapping(address => mapping(address => AllowanceData)) private _allowances;
    mapping(address => uint256) private _lockNonce;
    mapping(address => bool) private _unlocked;

    bool public mintingEnabled;
    bool public paused = true;
    bool private _entered;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 value);
    event RecipientLockChanged(address indexed account, bool locked);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnerRedemption(address indexed holder, address indexed recipient, uint256 amount, bytes32 indexed reference);
    event MintingStatusChanged(bool enabled);
    event PauseStatusChanged(bool paused);
    event ReserveVaultConfigured(address indexed vault);
    event PayoutRouterConfigured(address indexed router);
    event PayoutMint(address indexed recipient, uint256 amount, bytes32 indexed payoutReference);

    modifier onlyOwner() { require(_msgSender() == owner, "owner-only"); _; }
    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(address initialOwner, address trustedForwarder_) MetaTxContext(trustedForwarder_) {
        require(initialOwner != address(0), "zero-owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
        emit PauseStatusChanged(true);
        emit MintingStatusChanged(false);
    }

    function isTrustedForwarder(address forwarder) external view returns (bool) { return forwarder == trustedForwarder; }
    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function isLocked(address account) public view returns (bool) { return !_unlocked[account]; }
    function allowance(address tokenOwner, address spender) public view returns (uint256) {
        AllowanceData storage data = _allowances[tokenOwner][spender];
        if (!_unlocked[tokenOwner] || !_unlocked[spender] ||
            data.ownerLockNonce != _lockNonce[tokenOwner] || data.spenderLockNonce != _lockNonce[spender]) return 0;
        return data.amount;
    }

    function setRecipientLocked(address account, bool locked) external onlyOwner {
        require(account != address(0), "zero-account");
        bool old = !_unlocked[account];
        if (old != locked) _lockNonce[account] += 1;
        _unlocked[account] = !locked;
        emit RecipientLockChanged(account, locked);
    }

    function setReserveVault(address vault) external onlyOwner {
        require(reserveVault == address(0), "reserve-vault-already-set");
        require(vault != address(0) && vault.code.length > 0, "invalid-vault");
        require(IOneTraxReserveVaultMeta(vault).authorizedToken() == address(this), "vault-not-authorized");
        reserveVault = vault;
        emit ReserveVaultConfigured(vault);
    }

    function setPayoutRouter(address router) external onlyOwner {
        require(payoutRouter == address(0), "router-already-set");
        require(router != address(0) && router.code.length > 0, "invalid-router");
        payoutRouter = router;
        emit PayoutRouterConfigured(router);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0) && nextOwner != owner, "invalid-owner");
        address old = owner;
        owner = nextOwner;
        emit OwnershipTransferred(old, nextOwner);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseStatusChanged(value);
    }

    function setMintingEnabled(bool value) external onlyOwner {
        require(!value || (!paused && reserveVault != address(0) && payoutRouter != address(0)), "not-ready");
        mintingEnabled = value;
        emit MintingStatusChanged(value);
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        _mintRestricted(recipient, amount);
    }

    /// @notice Called only by the configured atomic payout router.
    function mintForPayout(address recipient, uint256 amount, bytes32 payoutReference) external {
        require(msg.sender == payoutRouter && payoutRouter != address(0), "router-only");
        require(payoutReference != bytes32(0), "reference-required");
        _mintRestricted(recipient, amount);
        emit PayoutMint(recipient, amount, payoutReference);
    }

    function _mintRestricted(address recipient, uint256 amount) internal {
        require(!paused && mintingEnabled, "minting-disabled");
        require(reserveVault != address(0), "vault-not-configured");
        require(recipient != address(0) && !_unlocked[recipient], "recipient-must-be-locked");
        require(amount > 0 && _totalSupply <= type(uint256).max - amount, "invalid-amount");
        require(_balances[recipient] <= type(uint256).max - amount, "balance-overflow");
        require(IOneTraxReserveVaultMeta(reserveVault).reserveBalance() >= _totalSupply + amount, "insufficient-trx-reserve");
        _totalSupply += amount;
        _balances[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function redeemForOwner(address holder, address payable recipient, uint256 amount, bytes32 reference)
        external onlyOwner nonReentrant
    {
        require(!paused && reserveVault != address(0), "redemption-disabled");
        require(holder != address(0) && recipient != address(0) && amount > 0 && reference != bytes32(0), "invalid-redemption");
        require(_balances[holder] >= amount, "insufficient-holder-balance");
        _balances[holder] -= amount;
        _totalSupply -= amount;
        require(IOneTraxReserveVaultMeta(reserveVault).releaseForRedemption(recipient, amount, reference), "reserve-release-failed");
        emit Transfer(holder, address(0), amount);
        emit OwnerRedemption(holder, recipient, amount, reference);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        address sender = _msgSender();
        require(!paused && _unlocked[sender] && to != address(0) && _unlocked[to], "transfer-disabled");
        require(amount > 0 && _balances[sender] >= amount, "invalid-amount");
        _balances[sender] -= amount; _balances[to] += amount;
        emit Transfer(sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        address sender = _msgSender();
        require(!paused && _unlocked[sender] && spender != address(0) && _unlocked[spender], "approval-disabled");
        _allowances[sender][spender] = AllowanceData(amount, _lockNonce[sender], _lockNonce[spender]);
        emit Approval(sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        address spender = _msgSender();
        require(!paused && from != address(0) && to != address(0), "transfer-disabled");
        require(_unlocked[spender] && _unlocked[from] && _unlocked[to], "account-locked");
        require(amount > 0 && _balances[from] >= amount, "invalid-amount");
        uint256 permitted = allowance(from, spender);
        require(permitted >= amount, "insufficient-allowance");
        _allowances[from][spender].amount = permitted - amount;
        _balances[from] -= amount; _balances[to] += amount;
        emit Transfer(from, to, amount);
        emit Approval(from, spender, permitted - amount);
        return true;
    }
}
