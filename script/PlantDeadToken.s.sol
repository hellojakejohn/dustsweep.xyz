// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A plain, transferable ERC20 that nobody will ever buy.
/// @dev FORK FIXTURE ONLY. This exists so the "No route out" pile has
///      something burnable in it. `script/BuyDust.s.sol` buys five tokens
///      that all have real pools, so they quote and land in `sweepable`
///      or `underGas`; BOW is the `willNotMove` case and is deliberately
///      unburnable. Without this, the fork has nothing in `noQuote` and
///      the Incinerate button never renders.
contract DeadToken is ERC20 {
    constructor(string memory n, string memory s, address to, uint256 amount) ERC20(n, s) {
        _mint(to, amount);
    }
}

/// @notice Mints a couple of genuinely worthless tokens to a test wallet.
///
/// Run against anvil ONLY:
///   export HOLDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # anvil (0)
///   export FORK_FIXTURE=1
///   forge script script/PlantDeadToken.s.sol:PlantDeadToken \
///     --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// @dev THE GUARD IS NOT DECORATION. A fork of 4663 reports chain id 4663,
///      so there is no on-chain way to tell the fork from mainnet. The
///      env var is the only thing standing between this and a pointless
///      pair of junk tokens deployed to the real chain under an address
///      the project owns. Do not remove it and do not export it in a
///      shell you use for real deploys.
contract PlantDeadToken is Script {
    function run() external {
        require(vm.envUint("FORK_FIXTURE") == 1, "FORK_FIXTURE=1 required: this is a fork-only fixture");

        address holder = vm.envAddress("HOLDER");
        require(holder != address(0), "HOLDER is unset or zero");

        vm.startBroadcast();
        DeadToken a = new DeadToken("Dead Cat Bounce", "DEADCAT", holder, 1_000_000 ether);
        DeadToken b = new DeadToken("Rug Pull Inu", "RUGINU", holder, 5_000_000 ether);
        DeadToken c = new DeadToken("Exit Liquidity", "EXITLIQ", holder, 250_000 ether);
        vm.stopBroadcast();

        require(a.balanceOf(holder) == 1_000_000 ether, "DEADCAT mint failed");

        console.log("");
        console.log("Add these to VITE_HELD_TOKENS in app/.env.local:");
        console.log(address(a));
        console.log(address(b));
        console.log(address(c));
    }
}
