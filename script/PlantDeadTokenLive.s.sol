// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A plain, transferable ERC20 with no pool anywhere. Genuinely
///         worthless, genuinely movable: the exact shape the furnace exists
///         to destroy.
contract LiveDeadToken is ERC20 {
    constructor(string memory n, string memory s, address to, uint256 amount) ERC20(n, s) {
        _mint(to, amount);
    }
}

/// @notice Mints worthless tokens ON MAINNET so the furnace has something
///         real to burn.
///
/// WHY THIS EXISTS, AND WHY IT IS A SEPARATE FILE FROM PlantDeadToken.s.sol.
///
/// The furnace only accepts `noQuote` tokens: worthless, but movable. Jake's
/// wallet had exactly one no-route token and it was the `willNotMove` class,
/// which nobody can transfer at all, so there was nothing to feed it. You
/// cannot buy a truly dead token either -- if it had a pool to buy it from,
/// it would not be dead. Minting one is the only way to get a controlled
/// fixture on a live chain.
///
/// `PlantDeadToken.s.sol` is guarded `FORK_FIXTURE=1` and its header says in
/// as many words not to remove that guard or export the var in a real shell.
/// That guard is correct and it is untouched. This is a different script with
/// a different name, a different env var, and its own guard, because the
/// intent here is genuinely different: these tokens are MEANT to exist on
/// mainnet.
///
/// THE HONESTY REQUIREMENT. These are named so that anyone who finds them on
/// the explorer understands immediately what they are. Do not rename them to
/// something that reads like an organic dead memecoin. The first burn being a
/// self-minted test token is fine and disclosable; the first burn being a
/// self-minted test token DRESSED UP as somebody's lost bag is the one thing
/// this project cannot survive.
///
/// Run:
///   export HOLDER=<the wallet you will connect in the browser>
///   export LIVE_FIXTURE=1
///   export COUNT=6          # optional, default 6, max 20
///   export TAG=FURNTEST     # optional, separates one batch from the next
///   forge script script/PlantDeadTokenLive.s.sol:PlantDeadTokenLive \
///     --rpc-url rhc --broadcast --slow -g 150 \
///     --ledger --mnemonic-derivation-paths "m/44'/60'/1'/0/0" \
///     --sender 0x5dCD1D1DD0F797a24Cc509fDd0Df9e8747bBD01b
contract PlantDeadTokenLive is Script {
    uint256 constant CHAIN_ID = 4663;

    function run() external {
        require(block.chainid == CHAIN_ID, "wrong chain: expected 4663");
        require(vm.envUint("LIVE_FIXTURE") == 1, "LIVE_FIXTURE=1 required");

        address holder = vm.envAddress("HOLDER");
        require(holder != address(0), "HOLDER is unset or zero");

        // COUNT lets one run stock the wallet for several rounds of
        // testing. Burning is destructive by definition, so every test
        // consumes its fixtures and the natural batch size is "more than
        // you think". TAG separates batches on screen when you mint again.
        uint256 count = vm.envOr("COUNT", uint256(6));
        require(count > 0 && count <= 20, "COUNT must be 1..20");
        string memory tag = vm.envOr("TAG", string("FURNTEST"));

        address[] memory minted = new address[](count);

        vm.startBroadcast();
        for (uint256 i; i < count; ++i) {
            // Varied supplies so the amount column has something to show
            // and the rows are told apart at a glance.
            uint256 supply = (1_000 + (i + 1) * 137_000) * 1 ether;
            string memory n = string.concat(tag, "-", vm.toString(i + 1));
            minted[i] = address(new LiveDeadToken(n, n, holder, supply));
        }
        vm.stopBroadcast();

        for (uint256 i; i < count; ++i) {
            require(LiveDeadToken(minted[i]).balanceOf(holder) > 0, "mint failed");
        }

        console.log("");
        console.log("Minted to", holder);
        for (uint256 i; i < count; ++i) {
            console.log(minted[i]);
        }
        console.log("");
        console.log("If Blockscout has not indexed them yet, force them in:");
        console.log("  cd app && VITE_HELD_TOKENS=<the three above, comma separated> npm run dev");
        console.log("");
        console.log("VITE_HELD_TOKENS does NOT change the RPC, so this is still mainnet");
        console.log("and the 'local fork' badge should stay off. If it appears, stop.");
    }
}
