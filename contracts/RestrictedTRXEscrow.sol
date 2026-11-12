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
    address public immutable restrictedBeneficiary;
    uint64 public immutable minLockSeconds;
    uint64 public immutable maxLockSeconds;
    uint128 public immutable maxPositionSun;
    uint128 public immutable maxDailyPrincipalSun;
    uint64 public fundingDay;
    uint128 public dailyPrincipalSun;
    bool public depositsPaused;
    uint256 public totalLockedSun;
    mapping(bytes32 => Position) public positions;
    mapping(address => bytes32[]) private beneficiaryRequestIds;

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
    error PositionLimitExceeded();
    error DailyLimitExceeded();
    error DepositsArePaused();
    error AlreadyClaimed();
    error NotBeneficiary();
    error StillLocked();
    error TransferFailed();

    constructor(
        address provider_,
        address operator_,
        address restrictedBeneficiary_,
        uint64 minLockSeconds_,
        uint64 maxLockSeconds_,
        uint128 maxPositionSun_,
        uint128 maxDailyPrincipalSun_
    ) {
        if (provider_ == address(0) || operator_ == address(0)) revert Unauthorized();
        if (restrictedBeneficiary_ == address(0)) revert InvalidBeneficiary();
        if (minLockSeconds_ == 0 || maxLockSeconds_ < minLockSeconds_) revert InvalidLockDuration();
        if (maxPositionSun_ == 0 || maxDailyPrincipalSun_ < maxPositionSun_) revert PositionLimitExceeded();
        provider = provider_;
        operator = operator_;
        restrictedBeneficiary = restrictedBeneficiary_;
        minLockSeconds = minLockSeconds_;
        maxLockSeconds = maxLockSeconds_;
        maxPositionSun = maxPositionSun_;
        maxDailyPrincipalSun = maxDailyPrincipalSun_;
    }

    function fundPosition(
        bytes32 requestId,
        address beneficiary,
        uint64 lockSeconds
    ) external payable {
        if (msg.sender != provider) revert Unauthorized();
        if (depositsPaused) revert DepositsArePaused();
        if (requestId == bytes32(0) || positions[requestId].beneficiary != address(0)) revert InvalidRequest();
        if (beneficiary == address(0) || beneficiary == address(this) || beneficiary != restrictedBeneficiary) revert InvalidBeneficiary();
        if (msg.value == 0 || msg.value > type(uint128).max) revert InvalidAmount();
        if (msg.value > maxPositionSun) revert PositionLimitExceeded();
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != fundingDay) {
            fundingDay = today;
            dailyPrincipalSun = 0;
        }
        if (uint256(dailyPrincipalSun) + msg.value > maxDailyPrincipalSun) revert DailyLimitExceeded();
        dailyPrincipalSun += uint128(msg.value);
        if (lockSeconds < minLockSeconds || lockSeconds > maxLockSeconds) revert InvalidLockDuration();

        uint64 unlockAt = uint64(block.timestamp) + lockSeconds;
        positions[requestId] = Position({
            beneficiary: beneficiary,
            amountSun: uint128(msg.value),
            unlockAt: unlockAt,
            claimed: false
        });
        totalLockedSun += msg.value;
        beneficiaryRequestIds[beneficiary].push(requestId);
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

    /// @notice Number of escrow positions registered for a beneficiary.
    function getBeneficiaryPositionCount(address beneficiary) external view returns (uint256) {
        return beneficiaryRequestIds[beneficiary].length;
    }

    /// @notice Request IDs are discoverable by the named beneficiary address.
    function getBeneficiaryPositionRequestId(address beneficiary, uint256 index) external view returns (bytes32) {
        return beneficiaryRequestIds[beneficiary][index];
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
