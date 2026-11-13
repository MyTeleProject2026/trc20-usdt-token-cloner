// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice EIP-712 forwarder for explicit owner-authorized TRON transactions.
/// @dev Relayers pay network fees. This contract never holds the owner's key.
/// Calls are target-allowlisted, chain/domain bound, expiring and nonce-protected.
contract TronMetaTxForwarder {
    struct ForwardRequest {
        address from;
        address to;
        uint256 value;
        uint256 gasLimit;
        uint256 nonce;
        uint256 deadline;
        bytes data;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant REQUEST_TYPEHASH =
        keccak256("ForwardRequest(address from,address to,uint256 value,uint256 gasLimit,uint256 nonce,uint256 deadline,bytes32 dataHash)");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable owner;
    mapping(address => uint256) public nonces;
    mapping(address => bool) public allowedTargets;
    bool private _entered;

    event TargetPermissionChanged(address indexed target, bool allowed);
    event MetaTransactionExecuted(address indexed signer, address indexed target, uint256 nonce, bool success, bytes32 dataHash);

    modifier onlyOwner() {
        require(_msgSender() == owner, "owner-only");
        _;
    }

    modifier nonReentrant() {
        require(!_entered, "reentrant");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address initialOwner) {
        require(initialOwner != address(0), "zero-owner");
        owner = initialOwner;
        allowedTargets[address(this)] = true;
        emit TargetPermissionChanged(address(this), true);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes("TRON Transfer Meta Transaction")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function requestDigest(ForwardRequest calldata request) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            REQUEST_TYPEHASH,
            request.from,
            request.to,
            request.value,
            request.gasLimit,
            request.nonce,
            request.deadline,
            keccak256(request.data)
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        require(target != address(0), "zero-target");
        if (target == address(this)) require(allowed, "cannot-disable-self");
        allowedTargets[target] = allowed;
        emit TargetPermissionChanged(target, allowed);
    }

    function execute(ForwardRequest calldata request, bytes calldata signature)
        external payable nonReentrant returns (bool success, bytes memory returnData)
    {
        require(request.from != address(0), "zero-signer");
        require(allowedTargets[request.to], "target-not-allowed");
        require(request.value == 0 && msg.value == 0, "value-not-supported");
        require(block.timestamp <= request.deadline, "request-expired");
        require(request.nonce == nonces[request.from], "invalid-nonce");
        require(request.gasLimit >= 25000 && request.gasLimit <= 5_000_000, "invalid-gas-limit");
        require(_recover(requestDigest(request), signature) == request.from, "invalid-signature");

        // Increment before the external call to prevent replay/reentrancy.
        nonces[request.from] = request.nonce + 1;
        (success, returnData) = request.to.call{gas: request.gasLimit}(
            abi.encodePacked(request.data, request.from)
        );
        // A failed call consumes the signed nonce; relayer cannot replay it.
        emit MetaTransactionExecuted(request.from, request.to, request.nonce, success, keccak256(request.data));
    }

    function _msgSender() internal view returns (address sender) {
        if (msg.sender == address(this) && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "invalid-signature-length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require((v == 27 || v == 28) && uint256(s) <= SECP256K1N_HALF, "invalid-signature");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid-signature");
        return signer;
    }
}
