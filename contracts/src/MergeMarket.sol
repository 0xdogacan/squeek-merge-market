// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of SqueekNFT this market uses. SqueekNFT is an unmodified
/// OpenZeppelin ERC721 + ERC2981 with a public level(tokenId), 1 until first merge.
interface ISqueek {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function level(uint256 tokenId) external view returns (uint8);
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256);
}

/// @title Merge Market
/// @notice Peer-to-peer trading of Squeeks, built around finding a merge partner.
///  - Sell:  list a Squeek for ETH. It stays in your wallet until someone buys it.
///  - Swap:  offer your Squeek for a specific Squeek, or for any Squeek of a level.
///  - Bid:   escrow ETH for any Squeek of a level ("I need a Level 3 to merge").
/// Ownerless and fee-free: no admin, no pause, no upgrade, no protocol fee.
/// Creator royalties set by the collection (ERC-2981) are paid on ETH sales, capped at 10%.
/// Payments that cannot be delivered are credited and can be withdrawn later.
contract MergeMarket {
    enum Kind {
        Sell,
        Swap,
        Bid
    }

    struct Order {
        address maker;
        Kind kind;
        bool active;
        uint8 wantLevel; // Swap (any of a level) and Bid; 0 when not used
        uint64 expiry; // unix seconds; 0 = never
        uint256 tokenId; // Sell and Swap: the maker's Squeek
        uint256 wantTokenId; // Swap for a specific Squeek; 0 = any of wantLevel
        uint256 price; // Sell: asking price; Bid: escrowed ETH
    }

    /// @notice An order together with whether it can be filled right now.
    struct OrderView {
        uint256 id;
        Order order;
        bool fillable;
    }

    uint256 public constant MAX_ROYALTY_BPS = 1_000;

    ISqueek public immutable squeek;
    uint256 public orderCount;
    mapping(uint256 => Order) private _orders;
    mapping(address => uint256) public credit;

    uint256 private _lock = 1;

    event OrderCreated(uint256 indexed id, address indexed maker, Kind kind, uint256 tokenId, uint8 wantLevel, uint256 wantTokenId, uint256 price, uint64 expiry);
    event OrderCancelled(uint256 indexed id);
    event OrderFilled(uint256 indexed id, address indexed maker, address indexed taker, uint256 makerTokenId, uint256 takerTokenId, uint256 price, uint256 royalty);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error NotOwner();
    error NotMaker();
    error Inactive();
    error Expired();
    error BadLevel();
    error BadPrice();
    error WrongToken();
    error NotApproved();
    error SelfFill();
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ISqueek squeek_) {
        squeek = squeek_;
    }

    // ------------------------------------------------------------------ create

    /// @notice List a Squeek you own for `price` wei. Approve this market first.
    function listForSale(uint256 tokenId, uint256 price, uint64 expiry) external returns (uint256 id) {
        if (squeek.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (price == 0) revert BadPrice();
        id = _create(Order(msg.sender, Kind.Sell, true, 0, expiry, tokenId, 0, price));
    }

    /// @notice Offer your Squeek for a specific Squeek (wantTokenId != 0)
    /// or for any Squeek of wantLevel (wantTokenId == 0). Approve this market first.
    function offerSwap(uint256 tokenId, uint8 wantLevel, uint256 wantTokenId, uint64 expiry) external returns (uint256 id) {
        if (squeek.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (wantTokenId == tokenId) revert WrongToken();
        if (wantTokenId == 0 && wantLevel == 0) revert BadLevel();
        id = _create(Order(msg.sender, Kind.Swap, true, wantTokenId == 0 ? wantLevel : 0, expiry, tokenId, wantTokenId, 0));
    }

    /// @notice Escrow ETH for any Squeek of `wantLevel`.
    function placeBid(uint8 wantLevel, uint64 expiry) external payable returns (uint256 id) {
        if (wantLevel == 0) revert BadLevel();
        if (msg.value == 0) revert BadPrice();
        id = _create(Order(msg.sender, Kind.Bid, true, wantLevel, expiry, 0, 0, msg.value));
    }

    /// @notice Cancel your order. A bid's escrow is returned.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.maker != msg.sender) revert NotMaker();
        if (!o.active) revert Inactive();
        o.active = false;
        emit OrderCancelled(id);
        if (o.kind == Kind.Bid) _pay(o.maker, o.price);
    }

    // -------------------------------------------------------------------- fill

    /// @notice Buy a listed Squeek. Send exactly the asking price.
    function buy(uint256 id) external payable nonReentrant {
        Order storage o = _open(id, Kind.Sell);
        if (msg.value != o.price) revert BadPrice();
        o.active = false;
        address maker = o.maker;
        uint256 tokenId = o.tokenId;
        // Transfer first: it reverts if the maker no longer owns or approved the Squeek.
        squeek.safeTransferFrom(maker, msg.sender, tokenId);
        uint256 royalty = _payWithRoyalty(tokenId, maker, msg.value);
        emit OrderFilled(id, maker, msg.sender, tokenId, 0, msg.value, royalty);
    }

    /// @notice Accept a swap offer with your Squeek `takerTokenId`. Approve this market first.
    function acceptSwap(uint256 id, uint256 takerTokenId) external nonReentrant {
        Order storage o = _open(id, Kind.Swap);
        if (o.wantTokenId != 0) {
            if (takerTokenId != o.wantTokenId) revert WrongToken();
        } else if (squeek.level(takerTokenId) != o.wantLevel) {
            revert BadLevel();
        }
        if (squeek.ownerOf(takerTokenId) != msg.sender) revert NotOwner();
        o.active = false;
        address maker = o.maker;
        uint256 makerTokenId = o.tokenId;
        squeek.safeTransferFrom(maker, msg.sender, makerTokenId);
        squeek.safeTransferFrom(msg.sender, maker, takerTokenId);
        emit OrderFilled(id, maker, msg.sender, makerTokenId, takerTokenId, 0, 0);
    }

    /// @notice Sell your Squeek `tokenId` into a bid. Approve this market first.
    function acceptBid(uint256 id, uint256 tokenId) external nonReentrant {
        Order storage o = _open(id, Kind.Bid);
        if (squeek.level(tokenId) != o.wantLevel) revert BadLevel();
        if (squeek.ownerOf(tokenId) != msg.sender) revert NotOwner();
        o.active = false;
        address maker = o.maker;
        uint256 price = o.price;
        squeek.safeTransferFrom(msg.sender, maker, tokenId);
        uint256 royalty = _payWithRoyalty(tokenId, msg.sender, price);
        emit OrderFilled(id, maker, msg.sender, 0, tokenId, price, royalty);
    }

    /// @notice Withdraw ETH that could not be delivered when an order filled.
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        credit[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // -------------------------------------------------------------------- read

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// @notice Whether an order can be filled now: active, not expired, and for
    /// Sell and Swap, the maker still owns the Squeek and has approved this market.
    function isFillable(uint256 id) public view returns (bool) {
        Order memory o = _orders[id];
        if (!o.active || (o.expiry != 0 && o.expiry < block.timestamp)) return false;
        if (o.kind == Kind.Bid) return true;
        try squeek.ownerOf(o.tokenId) returns (address owner) {
            if (owner != o.maker) return false;
            return squeek.isApprovedForAll(owner, address(this)) || squeek.getApproved(o.tokenId) == address(this);
        } catch {
            return false; // burned, e.g. merged away
        }
    }

    /// @notice A page of orders, newest first, from `fromId` downwards.
    function getOrders(uint256 fromId, uint256 count) external view returns (OrderView[] memory page) {
        if (fromId > orderCount) fromId = orderCount;
        if (count > fromId) count = fromId;
        page = new OrderView[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 id = fromId - i;
            page[i] = OrderView(id, _orders[id], isFillable(id));
        }
    }

    // ---------------------------------------------------------------- internal

    function _create(Order memory o) private returns (uint256 id) {
        if (o.expiry != 0 && o.expiry <= block.timestamp) revert Expired();
        id = ++orderCount;
        _orders[id] = o;
        emit OrderCreated(id, o.maker, o.kind, o.tokenId, o.wantLevel, o.wantTokenId, o.price, o.expiry);
    }

    function _open(uint256 id, Kind kind) private view returns (Order storage o) {
        o = _orders[id];
        if (!o.active || o.kind != kind) revert Inactive();
        if (o.expiry != 0 && o.expiry < block.timestamp) revert Expired();
        if (o.maker == msg.sender) revert SelfFill();
    }

    /// @dev Pays the collection's ERC-2981 royalty (capped) and the rest to `seller`.
    function _payWithRoyalty(uint256 tokenId, address seller, uint256 amount) private returns (uint256 royalty) {
        address receiver;
        try squeek.royaltyInfo(tokenId, amount) returns (address r, uint256 a) {
            receiver = r;
            royalty = a;
        } catch {}
        uint256 cap = (amount * MAX_ROYALTY_BPS) / 10_000;
        if (receiver == address(0)) royalty = 0;
        if (royalty > cap) royalty = cap;
        if (royalty > 0) _pay(receiver, royalty);
        _pay(seller, amount - royalty);
    }

    /// @dev Sends ETH; if the recipient cannot receive it, credits it for withdraw().
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (!ok) {
            credit[to] += amount;
            emit Credited(to, amount);
        }
    }
}
