// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BurnAdapter} from "../src/BurnAdapter.sol";
import {V3Adapter} from "../src/V3Adapter.sol";

contract Tok is IERC20 {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// A token that refuses to be sent to the graveyard. Some really do this.
contract RefusesGraveyard is Tok {
    function transferFrom(address, address to, uint256) external pure override returns (bool) {
        require(to != 0x000000000000000000000000000000000000dEaD, "no burn");
        return true;
    }
}

contract BurnAdapterTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BurnAdapter burner;
    Tok tok;

    function setUp() public {
        burner = new BurnAdapter();
        tok = new Tok();
        tok.mint(address(this), 1000e18);
        tok.approve(address(burner), type(uint256).max);
    }

    function test_BurnSendsToGraveyardAndReturnsZero() public {
        uint256 before = tok.balanceOf(DEAD);
        uint256 got = burner.sell(address(tok), 100e18, 0, "");

        assertEq(got, 0, "burn must report zero proceeds");
        assertEq(tok.balanceOf(DEAD) - before, 100e18, "tokens did not reach the graveyard");
        assertEq(tok.balanceOf(address(this)), 900e18);
    }

    function test_AdapterHoldsNothing() public {
        burner.sell(address(tok), 100e18, 0, "");
        assertEq(tok.balanceOf(address(burner)), 0, "adapter kept the token");
    }

    /// THE property. A leg built to sell carries a non-zero minOut, so it
    /// cannot be routed into a burn even if the front end sends it here.
    function test_RefusesALegThatExpectedProceeds() public {
        vm.expectRevert(BurnAdapter.BurnYieldsNothing.selector);
        burner.sell(address(tok), 100e18, 1, "");
    }

    /// And the mirror: V3Adapter refuses minOut == 0, so a leg built to
    /// burn cannot silently become a sale. The two are mutually exclusive
    /// by construction, not by front-end discipline.
    function test_MirrorV3AdapterRefusesABurnShapedLeg() public {
        V3Adapter v3 = new V3Adapter(address(0x1111), address(0xBEEF));
        vm.expectRevert(V3Adapter.NoSlippageBound.selector);
        v3.sell(address(tok), 100e18, 0, "");
    }

    function test_RevertsOnZeroAmount() public {
        vm.expectRevert(BurnAdapter.ZeroAmount.selector);
        burner.sell(address(tok), 0, 0, "");
    }

    /// A token that blocks the graveyard must revert cleanly, so the
    /// Sweeper's try/catch hands it back instead of eating it.
    function test_RevertsCleanlyWhenTokenBlocksTheGraveyard() public {
        RefusesGraveyard bad = new RefusesGraveyard();
        bad.mint(address(this), 100e18);
        bad.approve(address(burner), type(uint256).max);
        vm.expectRevert();
        burner.sell(address(bad), 100e18, 0, "");
    }

    function test_EmitsBurned() public {
        vm.expectEmit(true, true, false, true);
        emit BurnAdapter.Burned(address(tok), address(this), 100e18);
        burner.sell(address(tok), 100e18, 0, "");
    }
}
