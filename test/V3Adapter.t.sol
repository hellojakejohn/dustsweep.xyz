// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {V3Adapter, IV3SwapRouter} from "../src/V3Adapter.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// @dev A token that lies. `transfer` returns false instead of reverting,
///      which is the classic way a batch sweeper silently loses funds.
contract LyingToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }
}

/// Fork tests against Robinhood Chain (4663). Run with:
///   forge test --fork-url rhc -vv
///
/// These hit mainnet state deliberately. Every address is from the Block 1
/// recon and is verified on-chain. See CLAUDE.md.
contract V3AdapterForkTest is Test {
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH   = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;

    // Real dead tokens, WETH-paired on the 1% tier, pools funded.
    address constant NOXA_TOKEN = 0x955b339944CbD4834156366D766C260C80956B44; // 0.585 WETH pool
    address constant PONS_TOKEN = 0x97133372cC4391A4F6889b4d52387649B76BC7EC; // 0.546 WETH pool
    address constant CASHCAT    = 0x020bfC650A365f8BB26819deAAbF3E21291018b4; // has 10000/3000/500

    uint24 constant FEE_1PCT = 10_000;
    uint24 constant FEE_03PCT = 3_000;

    V3Adapter adapter;

    function setUp() public {
        // Requires [rpc_endpoints] rhc in foundry.toml
        vm.createSelectFork(vm.rpcUrl("rhc"));
        adapter = new V3Adapter(ROUTER, WETH);

        vm.deal(address(this), 100 ether);
        IWETH9(WETH).deposit{value: 50 ether}();
    }

    // --- helpers ------------------------------------------------------

    /// Buy dust the honest way: swap WETH for it through the same router
    /// the adapter uses. No storage pokes, so if the pool is broken the
    /// test fails here rather than lying to us later.
    function _buyDust(address token, uint24 fee, uint256 wethIn) internal returns (uint256) {
        IERC20(WETH).approve(ROUTER, wethIn);
        IV3SwapRouter(ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: token,
                fee: fee,
                recipient: address(this),
                amountIn: wethIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        return IERC20(token).balanceOf(address(this));
    }

    function _quote(address token, uint24 fee, uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(QUOTER).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: token,
                tokenOut: WETH,
                amountIn: amountIn,
                fee: fee,
                sqrtPriceLimitX96: 0
            })
        );
    }

    // --- the path that matters ----------------------------------------

    function test_SellRealNoxaToken() public {
        uint256 dust = _buyDust(NOXA_TOKEN, FEE_1PCT, 0.01 ether);
        assertGt(dust, 0, "did not acquire dust");

        uint256 expected = _quote(NOXA_TOKEN, FEE_1PCT, dust);
        uint256 minOut = (expected * 95) / 100; // 5% slippage
        assertGt(minOut, 0, "quote rounded to zero, token belongs in no-route pile");

        uint256 before = IERC20(WETH).balanceOf(address(this));
        IERC20(NOXA_TOKEN).approve(address(adapter), dust);
        uint256 got = adapter.sell(NOXA_TOKEN, dust, minOut, "");
        uint256 delta = IERC20(WETH).balanceOf(address(this)) - before;

        assertEq(got, delta, "return value must equal WETH actually delivered");
        assertGe(got, minOut, "slippage bound violated");
        console.log("noxa dust in :", dust);
        console.log("weth out     :", got);
    }

    function test_SellRealPonsV1Token() public {
        uint256 dust = _buyDust(PONS_TOKEN, FEE_1PCT, 0.01 ether);
        uint256 minOut = (_quote(PONS_TOKEN, FEE_1PCT, dust) * 95) / 100;

        IERC20(PONS_TOKEN).approve(address(adapter), dust);
        uint256 got = adapter.sell(PONS_TOKEN, dust, minOut, "");
        assertGe(got, minOut);
    }

    /// The whole point of the adapter: it must never sit on value.
    function test_AdapterHoldsNothingAfterwards() public {
        uint256 dust = _buyDust(NOXA_TOKEN, FEE_1PCT, 0.01 ether);
        uint256 minOut = (_quote(NOXA_TOKEN, FEE_1PCT, dust) * 95) / 100;

        IERC20(NOXA_TOKEN).approve(address(adapter), dust);
        adapter.sell(NOXA_TOKEN, dust, minOut, "");

        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0, "adapter held WETH");
        assertEq(IERC20(NOXA_TOKEN).balanceOf(address(adapter)), 0, "adapter held token");
        assertEq(
            IERC20(NOXA_TOKEN).allowance(address(adapter), ROUTER), 0, "standing allowance left open"
        );
    }

    function test_ExplicitFeeTierIsHonoured() public {
        // CASHCAT actually traded, so it has a 0.3% pool as well as the
        // 1% launch pool. Forcing the tier must work.
        uint256 dust = _buyDust(CASHCAT, FEE_03PCT, 0.01 ether);
        uint256 minOut = (_quote(CASHCAT, FEE_03PCT, dust) * 95) / 100;

        IERC20(CASHCAT).approve(address(adapter), dust);
        uint256 got = adapter.sell(CASHCAT, dust, minOut, abi.encode(FEE_03PCT));
        assertGe(got, minOut);
    }

    /// Documents the thing worth knowing: the launch tier is not always the
    /// best tier for a token that actually traded.
    function test_FeeTiersCanDisagree() public {
        uint256 amt = 1_000_000e18;
        uint256 q1 = _quote(CASHCAT, FEE_1PCT, amt);
        uint256 q3 = _quote(CASHCAT, FEE_03PCT, amt);
        console.log("cashcat @1.0%:", q1);
        console.log("cashcat @0.3%:", q3);
        assertTrue(q1 > 0 && q3 > 0, "expected both pools to quote");
    }

    // --- guards -------------------------------------------------------

    function test_RevertsWithoutSlippageBound() public {
        uint256 dust = _buyDust(NOXA_TOKEN, FEE_1PCT, 0.01 ether);
        IERC20(NOXA_TOKEN).approve(address(adapter), dust);
        vm.expectRevert(V3Adapter.NoSlippageBound.selector);
        adapter.sell(NOXA_TOKEN, dust, 0, "");
    }

    function test_RevertsOnZeroAmount() public {
        vm.expectRevert(V3Adapter.ZeroAmount.selector);
        adapter.sell(NOXA_TOKEN, 0, 1, "");
    }

    function test_RevertsOnSellingWeth() public {
        vm.expectRevert(V3Adapter.CannotSellWeth.selector);
        adapter.sell(WETH, 1e18, 1, "");
    }

    function test_RevertsOnMalformedFeeData() public {
        vm.expectRevert(V3Adapter.BadFeeData.selector);
        adapter.sell(NOXA_TOKEN, 1e18, 1, hex"dead");
    }

    /// An unreachable minOut must revert, not silently fill short.
    function test_RevertsWhenMinOutUnreachable() public {
        uint256 dust = _buyDust(NOXA_TOKEN, FEE_1PCT, 0.01 ether);
        IERC20(NOXA_TOKEN).approve(address(adapter), dust);
        vm.expectRevert(); // router: "Too little received"
        adapter.sell(NOXA_TOKEN, dust, 100 ether, "");
    }

    /// No pool at this tier for a dead token. Must revert cleanly so the
    /// Sweeper's try/catch returns the token instead of eating it.
    function test_RevertsWhenPoolDoesNotExist() public {
        uint256 dust = _buyDust(NOXA_TOKEN, FEE_1PCT, 0.01 ether);
        IERC20(NOXA_TOKEN).approve(address(adapter), dust);
        vm.expectRevert();
        adapter.sell(NOXA_TOKEN, dust, 1, abi.encode(uint24(500)));
    }

    /// A token whose transferFrom returns false must not produce a phantom
    /// fill. SafeERC20 turns the lie into a revert.
    function test_RevertsOnLyingToken() public {
        LyingToken bad = new LyingToken();
        bad.mint(address(this), 1e18);
        vm.expectRevert();
        adapter.sell(address(bad), 1e18, 1, "");
    }

    receive() external payable {}
}
