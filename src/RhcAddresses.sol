// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title dustsweep Robinhood Chain (4663) address book
/// @notice Block 1 recon, verified on-chain 2026-09-04.
library RhcAddresses {
    uint256 internal constant CHAIN_ID = 4663;

    // --- Verified on-chain ---
    address internal constant WETH  = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG  = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address internal constant V3_FACTORY   = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant QUOTER_V2    = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    address internal constant PERMIT2      = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Largest dust source: ~63k tokens, halted 11 Jul 2026, front end gone.
    /// @dev Its getDexConfig(0) is identical to Pons V1's. Same adapter path.
    address internal constant NOXA_FACTORY    = 0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB;
    address internal constant PONS_V1_FACTORY = 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB;
    address internal constant PONS_V2_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    /// Noxa and Pons V1 both launch WETH-paired on the 1% tier.
    /// Pools at other tiers can exist afterwards -- quote 10000/3000/500.
    uint24 internal constant LAUNCH_FEE = 10000;

    /// @dev DO NOT use for v3 swaps. Modified fork, v4 encoding only.
    address internal constant UNIVERSAL_ROUTER_V4_ONLY = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
}
