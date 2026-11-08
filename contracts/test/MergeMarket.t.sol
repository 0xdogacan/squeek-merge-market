// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MergeMarket, ISqueek} from "../src/MergeMarket.sol";
import {MockSqueek} from "./MockSqueek.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract Reenterer {
    MergeMarket public market;
    uint256 public target;
    bool public tried;
    bool public reentered;

    constructor(MergeMarket m) {
        market = m;
    }

    function buy(uint256 id) external payable {
        target = id;
        market.buy{value: msg.value}(id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!tried) {
            tried = true;
            try market.cancel(target) {
                reentered = true;
            } catch {}
        }
        return this.onERC721Received.selector;
    }
}

contract MergeMarketTest is Test {
    MockSqueek squeek;
    MergeMarket market;
    address royalty = makeAddr("royalty");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        squeek = new MockSqueek(royalty, 500); // 5%
        market = new MergeMarket(ISqueek(address(squeek)));
        squeek.mint(alice, 1, 1);
        squeek.mint(alice, 2, 3);
        squeek.mint(bob, 3, 3);
        squeek.mint(bob, 4, 1);
        squeek.mint(carol, 5, 3);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.prank(alice);
        squeek.setApprovalForAll(address(market), true);
        vm.prank(bob);
        squeek.setApprovalForAll(address(market), true);
        vm.prank(carol);
        squeek.setApprovalForAll(address(market), true);
    }

    // ------------------------------------------------------------------ sell

    function test_SellPaysSellerAndRoyalty() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        assertTrue(market.isFillable(id));

        vm.prank(bob);
        market.buy{value: 1 ether}(id);

        assertEq(squeek.ownerOf(2), bob);
        assertEq(royalty.balance, 0.05 ether);
        assertEq(alice.balance, 10 ether + 0.95 ether);
        assertFalse(market.getOrder(id).active);
        assertFalse(market.isFillable(id));
    }

    function test_BuyRequiresExactPrice() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.BadPrice.selector);
        market.buy{value: 0.9 ether}(id);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.BadPrice.selector);
        market.buy{value: 1.1 ether}(id);
    }

    function test_CannotListSomeoneElsesSqueek() public {
        vm.prank(alice);
        vm.expectRevert(MergeMarket.NotOwner.selector);
        market.listForSale(3, 1 ether, 0);
    }

    function test_ZeroPriceRejected() public {
        vm.prank(alice);
        vm.expectRevert(MergeMarket.BadPrice.selector);
        market.listForSale(2, 0, 0);
    }

    function test_CannotBuyOwnListing() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(alice);
        vm.expectRevert(MergeMarket.SelfFill.selector);
        market.buy{value: 1 ether}(id);
    }

    function test_ListingDiesWhenSellerMovesTheSqueek() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(alice);
        squeek.transferFrom(alice, carol, 2);
        assertFalse(market.isFillable(id));
        vm.prank(bob);
        vm.expectRevert();
        market.buy{value: 1 ether}(id);
        assertEq(squeek.ownerOf(2), carol);
        assertEq(bob.balance, 10 ether);
    }

    function test_ListingDiesWhenApprovalRevoked() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(alice);
        squeek.setApprovalForAll(address(market), false);
        assertFalse(market.isFillable(id));
        vm.prank(bob);
        vm.expectRevert();
        market.buy{value: 1 ether}(id);
    }

    function test_SingleTokenApprovalCountsAsFillable() public {
        vm.startPrank(alice);
        squeek.setApprovalForAll(address(market), false);
        squeek.approve(address(market), 2);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.stopPrank();
        assertTrue(market.isFillable(id));
        vm.prank(bob);
        market.buy{value: 1 ether}(id);
        assertEq(squeek.ownerOf(2), bob);
    }

    function test_ListingDiesWhenSqueekIsMergedAway() public {
        squeek.mint(alice, 6, 3);
        vm.prank(alice);
        uint256 id = market.listForSale(6, 1 ether, 0);
        vm.prank(alice);
        squeek.merge(2, 6); // 6 is burned
        assertFalse(market.isFillable(id));
    }

    function test_ExpiredListing() public {
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        assertFalse(market.isFillable(id));
        vm.prank(bob);
        vm.expectRevert(MergeMarket.Expired.selector);
        market.buy{value: 1 ether}(id);
    }

    function test_ExpiryInThePastRejected() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        vm.expectRevert(MergeMarket.Expired.selector);
        market.listForSale(2, 1 ether, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ swap

    function test_SwapForAnySqueekOfLevel() public {
        vm.prank(alice);
        uint256 id = market.offerSwap(1, 3, 0, 0); // alice gives L1 #1, wants any L3
        vm.prank(bob);
        market.acceptSwap(id, 3);
        assertEq(squeek.ownerOf(1), bob);
        assertEq(squeek.ownerOf(3), alice);
    }

    function test_SwapThenMerge() public {
        // alice holds L3 #2 and wants a merge partner; bob takes her L1 #1 for his L3 #3.
        vm.prank(alice);
        uint256 id = market.offerSwap(1, 3, 0, 0);
        vm.prank(bob);
        market.acceptSwap(id, 3);
        vm.prank(alice);
        squeek.merge(2, 3);
        assertEq(squeek.level(2), 4);
    }

    function test_SwapRejectsWrongLevel() public {
        vm.prank(alice);
        uint256 id = market.offerSwap(2, 3, 0, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.BadLevel.selector);
        market.acceptSwap(id, 4); // L1
    }

    function test_SwapForSpecificSqueek() public {
        vm.prank(alice);
        uint256 id = market.offerSwap(1, 0, 5, 0); // wants carol's #5 exactly
        vm.prank(bob);
        vm.expectRevert(MergeMarket.WrongToken.selector);
        market.acceptSwap(id, 3);
        vm.prank(carol);
        market.acceptSwap(id, 5);
        assertEq(squeek.ownerOf(5), alice);
        assertEq(squeek.ownerOf(1), carol);
    }

    function test_SwapTakerMustOwnToken() public {
        vm.prank(alice);
        uint256 id = market.offerSwap(1, 3, 0, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.NotOwner.selector);
        market.acceptSwap(id, 5); // carol's
    }

    function test_SwapNeedsTakerApproval() public {
        vm.prank(alice);
        uint256 id = market.offerSwap(1, 3, 0, 0);
        vm.prank(bob);
        squeek.setApprovalForAll(address(market), false);
        vm.prank(bob);
        vm.expectRevert();
        market.acceptSwap(id, 3);
        // Nothing moved.
        assertEq(squeek.ownerOf(1), alice);
        assertEq(squeek.ownerOf(3), bob);
        assertTrue(market.getOrder(id).active);
    }

    function test_SwapValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(MergeMarket.BadLevel.selector);
        market.offerSwap(1, 0, 0, 0);
        vm.expectRevert(MergeMarket.WrongToken.selector);
        market.offerSwap(1, 0, 1, 0);
        vm.expectRevert(MergeMarket.NotOwner.selector);
        market.offerSwap(3, 3, 0, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- bid

    function test_BidEscrowAndAccept() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 2 ether}(3, 0);
        assertEq(address(market).balance, 2 ether);
        assertTrue(market.isFillable(id));

        vm.prank(bob);
        market.acceptBid(id, 3);

        assertEq(squeek.ownerOf(3), alice);
        assertEq(royalty.balance, 0.1 ether);
        assertEq(bob.balance, 10 ether + 1.9 ether);
        assertEq(address(market).balance, 0);
    }

    function test_BidRejectsWrongLevel() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 1 ether}(3, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.BadLevel.selector);
        market.acceptBid(id, 4);
    }

    function test_BidSellerMustOwnToken() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 1 ether}(3, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.NotOwner.selector);
        market.acceptBid(id, 5);
    }

    function test_CancelBidRefunds() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 2 ether}(3, 0);
        vm.prank(alice);
        market.cancel(id);
        assertEq(alice.balance, 10 ether);
        assertEq(address(market).balance, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.Inactive.selector);
        market.acceptBid(id, 3);
    }

    function test_OnlyMakerCancels() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 1 ether}(3, 0);
        vm.prank(bob);
        vm.expectRevert(MergeMarket.NotMaker.selector);
        market.cancel(id);
    }

    function test_CannotCancelTwice() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 1 ether}(3, 0);
        vm.prank(alice);
        market.cancel(id);
        vm.prank(alice);
        vm.expectRevert(MergeMarket.Inactive.selector);
        market.cancel(id);
        assertEq(alice.balance, 10 ether);
    }

    function test_ExpiredBidCanStillBeCancelled() public {
        vm.prank(alice);
        uint256 id = market.placeBid{value: 1 ether}(3, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 10);
        vm.prank(alice);
        market.cancel(id);
        assertEq(alice.balance, 10 ether);
    }

    function test_BidValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(MergeMarket.BadLevel.selector);
        market.placeBid{value: 1 ether}(0, 0);
        vm.expectRevert(MergeMarket.BadPrice.selector);
        market.placeBid(3, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------- royalties and payouts

    function test_RoyaltyCappedAtTenPercent() public {
        squeek.setRoyalty(royalty, 5_000); // 50%
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(bob);
        market.buy{value: 1 ether}(id);
        assertEq(royalty.balance, 0.1 ether);
        assertEq(alice.balance, 10.9 ether);
    }

    function test_UndeliverablePaymentIsCredited() public {
        RejectsEth seller = new RejectsEth();
        squeek.mint(address(seller), 7, 2);
        vm.startPrank(address(seller));
        squeek.setApprovalForAll(address(market), true);
        uint256 id = market.listForSale(7, 1 ether, 0);
        vm.stopPrank();

        vm.prank(bob);
        market.buy{value: 1 ether}(id);
        assertEq(squeek.ownerOf(7), bob);
        assertEq(market.credit(address(seller)), 0.95 ether);
        assertEq(address(market).balance, 0.95 ether);
    }

    function test_WithdrawCredit() public {
        // A royalty receiver that rejects ETH gets credited, then withdraws once it can.
        RejectsEth bad = new RejectsEth();
        squeek.setRoyalty(address(bad), 500);
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(bob);
        market.buy{value: 1 ether}(id);
        assertEq(market.credit(address(bad)), 0.05 ether);
        vm.prank(address(bad));
        vm.expectRevert(MergeMarket.TransferFailed.selector);
        market.withdraw();
        assertEq(market.credit(address(bad)), 0.05 ether);
    }

    function test_ReentrancyBlocked() public {
        Reenterer r = new Reenterer(market);
        vm.deal(address(r), 1 ether);
        vm.prank(alice);
        uint256 id = market.listForSale(2, 1 ether, 0);
        vm.prank(address(r));
        r.buy{value: 1 ether}(id);
        assertTrue(r.tried());
        assertFalse(r.reentered());
        assertEq(squeek.ownerOf(2), address(r));
    }

    // ------------------------------------------------------------------ read

    function test_GetOrdersNewestFirstWithFillable() public {
        vm.prank(alice);
        market.listForSale(2, 1 ether, 0);
        vm.prank(bob);
        market.offerSwap(4, 3, 0, 0);
        vm.prank(carol);
        market.placeBid{value: 1 ether}(1, 0);
        vm.prank(alice);
        squeek.setApprovalForAll(address(market), false);

        MergeMarket.OrderView[] memory page = market.getOrders(100, 10);
        assertEq(page.length, 3);
        assertEq(page[0].id, 3);
        assertEq(page[2].id, 1);
        assertTrue(page[0].fillable);
        assertTrue(page[1].fillable);
        assertFalse(page[2].fillable); // alice revoked approval

        MergeMarket.OrderView[] memory tail = market.getOrders(1, 10);
        assertEq(tail.length, 1);
        assertEq(market.getOrders(0, 10).length, 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_SellSplitsExactly(uint96 price, uint96 bps) public {
        vm.assume(price > 0 && price < 1_000 ether);
        bps = uint96(bound(bps, 0, 10_000));
        squeek.setRoyalty(royalty, bps);
        vm.deal(bob, uint256(price));
        vm.prank(alice);
        uint256 id = market.listForSale(2, price, 0);
        uint256 before = alice.balance;
        vm.prank(bob);
        market.buy{value: price}(id);
        uint256 r = royalty.balance;
        assertLe(r, (uint256(price) * 1_000) / 10_000);
        assertEq(alice.balance - before + r, price);
        assertEq(address(market).balance, 0);
    }
}
