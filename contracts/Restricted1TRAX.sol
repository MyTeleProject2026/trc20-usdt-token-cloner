// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOneTraxReserveVault {
    function reserveBalance() external view returns (uint256);
    function authorizedToken() external view returns (address);
    function releaseForRedemption(address payable recipient, uint256 amount, bytes32 redemptionReference) external returns (bool);
}

/// @title Tron Transfer TRӾ Restricted TRX-denominated token
/// @notice A separate 6-decimal TRC-20 token, never native TRX and not the official native TRX asset. Holder transfers and approvals are disabled.
/// @dev Each mint must be fully backed by native TRX in the separately deployed reserve vault.
contract Restricted1TRAX {
    string public constant name = "TRӾ";
    string public constant symbol = "TRX";
    uint8 public constant decimals = 6;
    address public immutable owner;
    address public reserveVault;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    bool public mintingEnabled;
    bool public paused;
    bool private _redemptionEntered;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 value);
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
        emit MintingStatusChanged(false);
        emit PauseStatusChanged(true);
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address, address) external pure returns (uint256) { return 0; }

    function setReserveVault(address vault) external onlyOwner {
        require(reserveVault == address(0), "reserve-vault-already-set");
        require(vault != address(0) && vault.code.length > 0, "invalid-reserve-vault");
        require(IOneTraxReserveVault(vault).authorizedToken() == address(this), "reserve-vault-token-not-authorized");
        IOneTraxReserveVault(vault).reserveBalance();
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

    /// @notice Only the owner can redeem on a holder's behalf; TRX release and token burn are atomic.
    /// @dev Holders cannot invoke redemption themselves. The vault pays native TRX to recipient.
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

    function transfer(address, uint256) external pure returns (bool) { revert("1TRAX-non-transferable"); }
    function approve(address, uint256) external pure returns (bool) { revert("1TRAX-approvals-disabled"); }
    function transferFrom(address, address, uint256) external pure returns (bool) { revert("1TRAX-non-transferable"); }
}
