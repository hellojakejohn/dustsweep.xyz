// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {V3Adapter} from "../src/V3Adapter.sol";

/// @notice Deploys the pair and wires them together in one broadcast.
///
/// Run:
///   export FEE_SINK=0xYourFeeSinkAddress
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url rhc --broadcast --account <your-keystore-account>
///
/// Use --account with a Foundry keystore, or --ledger / --trezor.
/// Do not paste a raw private key on the command line: it lands in your
/// shell history and in the process list.
contract Deploy is Script {
    // Verified on-chain. See CLAUDE.md.
    address constant PERMIT2        = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH           = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;

    uint256 constant CHAIN_ID = 4663;

    function run() external {
        // Fail before spending gas, not after.
        require(block.chainid == CHAIN_ID, "wrong chain: expected 4663");

        address feeSink = vm.envAddress("FEE_SINK");
        require(feeSink != address(0), "FEE_SINK is unset or zero");

        // Sanity: the addresses we are about to trust must actually have code.
        require(PERMIT2.code.length > 0, "no code at Permit2");
        require(WETH.code.length > 0, "no code at WETH");
        require(SWAP_ROUTER_02.code.length > 0, "no code at SwapRouter02");

        vm.startBroadcast();

        V3Adapter adapter = new V3Adapter(SWAP_ROUTER_02, WETH);
        Sweeper sweeper = new Sweeper(PERMIT2, WETH, feeSink);
        sweeper.setAdapter(address(adapter), true);

        vm.stopBroadcast();

        // Assert the wiring actually took. A deploy that silently half-works
        // is worse than one that reverts.
        require(sweeper.adapterAllowed(address(adapter)), "adapter not whitelisted");
        require(sweeper.feeSink() == feeSink, "feeSink mismatch");
        require(address(sweeper.WETH()) == WETH, "WETH mismatch");
        require(sweeper.maxLegValueWei() == 0.5 ether, "unexpected value ceiling");
        require(address(adapter.ROUTER()) == SWAP_ROUTER_02, "adapter router mismatch");
        require(adapter.WETH() == WETH, "adapter WETH mismatch");

        console.log("Sweeper      ", address(sweeper));
        console.log("V3Adapter    ", address(adapter));
        console.log("feeSink      ", feeSink);
        console.log("maxLegValueWei", sweeper.maxLegValueWei());
        console.log("");
        console.log("Verify with:");
        console.log("  forge verify-contract <addr> src/Sweeper.sol:Sweeper \\");
        console.log("    --verifier blockscout \\");
        console.log("    --verifier-url https://robinhoodchain.blockscout.com/api");
        console.log("");
        console.log("Then put the Sweeper address in app/src/lib/addresses.ts");
    }
}
