// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Bounded, public, content-addressed payload bulletin for low-volume pilots.
/// @dev Payload bytes live in events, not a platform file server. No privacy guarantee.
contract OrderPayloads {
    uint256 public constant MAX_BYTES = 32768;
    mapping(bytes32 => bool) public published;
    error InvalidSize();
    event PayloadPublished(bytes32 indexed digest, address indexed publisher, bytes data);

    function put(bytes calldata data) external returns (bytes32 digest) {
        if (data.length == 0 || data.length > MAX_BYTES) revert InvalidSize();
        digest = keccak256(data);
        if (!published[digest]) {
            published[digest] = true;
            emit PayloadPublished(digest, msg.sender, data);
        }
    }
}
