// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Independent TRC-20 token
 * @notice This is an independent token, not official Tether USDT.
 * @dev Fixed 18-decimal supply, minted once to the deployment recipient.
 */
contract IndependentTRC20 {
    string public name = "TRC20";
    string public symbol = "VTRC";
    uint8 public constant decimals = 18;
    uint256 private _totalSupply;
    address public immutable owner;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialWholeTokenSupply, address recipient) {
        require(initialWholeTokenSupply > 0, "supply must be positive");
        require(recipient != address(0), "zero recipient");
        owner = msg.sender;
        uint256 scale = 10 ** uint256(decimals);
        require(initialWholeTokenSupply <= type(uint256).max / scale, "supply overflow");
        _totalSupply = initialWholeTokenSupply * scale;
        _balances[recipient] = _totalSupply;
        emit Transfer(address(0), recipient, _totalSupply);
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address tokenOwner, address spender) external view returns (uint256) {
        return _allowances[tokenOwner][spender];
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0), "zero recipient");
        require(_balances[msg.sender] >= amount, "insufficient balance");
        _balances[msg.sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "zero spender");
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0), "zero recipient");
        require(_balances[sender] >= amount, "insufficient balance");
        require(_allowances[sender][msg.sender] >= amount, "allowance exceeded");
        _allowances[sender][msg.sender] -= amount;
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
        return true;
    }
}
