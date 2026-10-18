// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Valueless public-testnet fixture, not a stablecoin or proposed network token.
/// @dev Anyone pays their own test gas to claim once; no project faucet server or issuer account.
contract PilotPaymentToken is ERC20 {
    mapping(address => bool) public claimed;
    constructor() ERC20("P2P Pilot Test Payment", "TESTUSD") {
        require(block.chainid == 84532 || block.chainid == 31337, "test networks only");
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function claim() external {
        require(!claimed[msg.sender], "already claimed");
        claimed[msg.sender] = true;
        _mint(msg.sender, 100_000_000);
    }
}
