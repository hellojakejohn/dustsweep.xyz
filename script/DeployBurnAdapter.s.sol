// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {BurnAdapter} from "../src/BurnAdapter.sol";
import {Sweeper} from "../src/Sweeper.sol";

/// @notice Deploys BurnAdapter against the ALREADY-DEPLOYED Sweeper and
///         whitelists it. Two transactions from the owner key, no new
///         Sweeper, no redeploy of anything live.
///
/// Run:
///   export SWEEPER=0x3b0AD85011d082C29C76F75F4aAf4674Dd416Cc2
///   forge script script/DeployBurnAdapter.s.sol:DeployBurnAdapter \
///     --rpc-url rhc --broadcast --slow -g 150 \
///     --ledger --mnemonic-derivation-paths "m/44'/60'/1'/0/0"
///
/// `setAdapter` is onlyOwner, so this MUST be broadcast from the Ledger
/// that owns the Sweeper (0x5dCD1D1D...). Anything else reverts on the
/// second call after paying for the first.
///
/// @dev Why this is a separate script from Deploy.s.sol: that one builds
///      a whole new Sweeper. Running it again would deploy a second
///      Sweeper nobody uses and leave the live one untouched. This one
///      only adds an adapter to the Sweeper that already exists.
contract DeployBurnAdapter is Script {
    uint256 constant CHAIN_ID = 4663;

    function run() external {
        require(block.chainid == CHAIN_ID, "wrong chain: expected 4663");

        address sweeperAddr = vm.envAddress("SWEEPER");
        require(sweeperAddr != address(0), "SWEEPER is unset or zero");
        require(sweeperAddr.code.length > 0, "no code at SWEEPER");

        Sweeper sweeper = Sweeper(payable(sweeperAddr));

        // Fail before spending gas if the broadcasting key is not the
        // owner. `--ledger` picks the derivation path, and picking the
        // wrong one is a live possibility given two devices and two
        // accounts on this project.
        address owner = sweeper.owner();
        console.log("Sweeper owner", owner);
        console.log("broadcaster  ", msg.sender);
        require(owner == msg.sender, "broadcaster is not the Sweeper owner");

        vm.startBroadcast();

        BurnAdapter burner = new BurnAdapter();
        sweeper.setAdapter(address(burner), true);

        vm.stopBroadcast();

        // A deploy that silently half-works is worse than one that reverts.
        require(sweeper.adapterAllowed(address(burner)), "burn adapter not whitelisted");
        require(
            burner.GRAVEYARD() == 0x000000000000000000000000000000000000dEaD,
            "unexpected graveyard"
        );

        console.log("");
        console.log("BurnAdapter  ", address(burner));
        console.log("");
        console.log("Verify:");
        console.log("  forge verify-contract <addr> src/BurnAdapter.sol:BurnAdapter \\");
        console.log("    --verifier blockscout \\");
        console.log("    --verifier-url https://robinhoodchain.blockscout.com/api \\");
        console.log("    --rpc-url rhc");
        console.log("");
        console.log("Then put it in BURN_ADAPTER_DEPLOYED in app/src/lib/addresses.ts");
    }
}
