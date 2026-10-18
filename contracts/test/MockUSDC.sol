// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local/test fixture with USDC metadata. Not the Base mainnet USDC contract.
contract MockUSDC is ERC20 {
    constructor(address recipient, uint256 supply) ERC20("USD Coin", "USDC") {
        _mint(recipient, supply);
    }

    function decimals() public pure override returns (uint8) { return 6; }
}
