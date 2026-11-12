// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Holds native TRX in time-locked positions for a named beneficiary.
/// @dev This contract does not credit or modify a Bitpie wallet balance. The
/// beneficiary sees this position through contract state / a compatible viewer.
/// Only the configured provider can create positions. Beneficiaries can claim
/// their own positions after the lock expires. There is no admin seizure path.
contract RestrictedTRXEscrow {
    struct Position {
        address beneficiary;
        uint128 amountSun;
        uint64 unlockAt;
        bool claimed;
    }

    address public immutable provider;
    address public immutable operator;
    uint64 public immutable minLockSeconds;
    uint64 public immutable maxLockSeconds;
    bool public depositsPaused;
    uint256 public totalLockedSun;
    mapping(bytes32 => Position) public positions;

    event PositionFunded(
        bytes32 indexed requestId,
        address indexed beneficiary,
        uint256 amountSun,
        uint64 unlockAt
    );
    event PositionClaimed(bytes32 indexed requestId, address indexed beneficiary, uint256 amountSun);
    event DepositsPaused(bool paused);

    error Unauthorized();
    error InvalidRequest();
    error InvalidBeneficiary();
    error InvalidAmount();
    error InvalidLockDuration();
    error DepositsArePaused();
    error AlreadyClaimed();
    error NotBeneficiary();
    error StillLocked();
    error TransferFailed();

    constructor(
        address provider_,
        address operator_,
        uint64 minLockSeconds_,
        uint64 maxLockSeconds_
    ) {
        if (provider_ == address(0) || operator_ == address(0)) revert Unauthorized();
        if (minLockSeconds_ == 0 || maxLockSeconds_ < minLockSeconds_) revert InvalidLockDuration();
        provider = provider_;
        operator = operator_;
        minLockSeconds = minLockSeconds_;
        maxLockSeconds = maxLockSeconds_;
    }

    function fundPosition(
        bytes32 requestId,
        address beneficiary,
        uint64 lockSeconds
    ) external payable {
        if (msg.sender != provider) revert Unauthorized();
        if (depositsPaused) revert DepositsArePaused();
        if (requestId == bytes32(0) || positions[requestId].beneficiary != address(0)) revert InvalidRequest();
        if (beneficiary == address(0) || beneficiary == address(this)) revert InvalidBeneficiary();
        if (msg.value == 0 || msg.value > type(uint128).max) revert InvalidAmount();
        if (lockSeconds < minLockSeconds || lockSeconds > maxLockSeconds) revert InvalidLockDuration();

        uint64 unlockAt = uint64(block.timestamp) + lockSeconds;
        positions[requestId] = Position({
            beneficiary: beneficiary,
            amountSun: uint128(msg.value),
            unlockAt: unlockAt,
            claimed: false
        });
        totalLockedSun += msg.value;
        emit PositionFunded(requestId, beneficiary, msg.value, unlockAt);
    }

    function claim(bytes32 requestId) external {
        Position storage position = positions[requestId];
        if (position.beneficiary == address(0)) revert InvalidRequest();
        if (position.claimed) revert AlreadyClaimed();
        if (msg.sender != position.beneficiary) revert NotBeneficiary();
        if (block.timestamp < position.unlockAt) revert StillLocked();

        uint256 amount = position.amountSun;
        position.claimed = true;
        totalLockedSun -= amount;
        (bool sent,) = payable(position.beneficiary).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit PositionClaimed(requestId, position.beneficiary, amount);
    }

    /// @notice Operator may pause new deposits only; existing beneficiaries
    /// retain the ability to claim after their individual lock expires.
    function setDepositsPaused(bool paused) external {
        if (msg.sender != operator) revert Unauthorized();
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function getPosition(bytes32 requestId)
        external
        view
        returns (address beneficiary, uint256 amountSun, uint64 unlockAt, bool claimed)
    {
        Position memory p = positions[requestId];
        return (p.beneficiary, p.amountSun, p.unlockAt, p.claimed);
    }

    receive() external payable {
        revert InvalidRequest();
    }

    fallback() external payable {
        revert InvalidRequest();
    }
}
