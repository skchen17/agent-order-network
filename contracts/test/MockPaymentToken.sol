// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local test fixture only. This is not a network token or a real stablecoin.
contract MockPaymentToken is ERC20 {
    constructor(address recipient, uint256 supply) ERC20("Local Test Payment", "TESTUSD") {
        _mint(recipient, supply);
    }

    function decimals() public pure override returns (uint8) { return 6; }
}
