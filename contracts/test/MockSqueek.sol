// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @dev Stand-in for SqueekNFT: unmodified OpenZeppelin ERC721 + ERC2981 with
/// level(tokenId) = 1 until merged, and an owner-only merge that burns the donor.
contract MockSqueek is ERC721, ERC2981 {
    mapping(uint256 => uint8) private _level;

    constructor(address royaltyReceiver, uint96 royaltyBps) ERC721("Squeek", "SQUEEK") {
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    function mint(address to, uint256 id, uint8 lvl) external {
        _mint(to, id);
        _level[id] = lvl;
    }

    function level(uint256 id) external view returns (uint8) {
        _requireOwned(id);
        return _level[id] == 0 ? 1 : _level[id];
    }

    function merge(uint256 survivor, uint256 donor) external {
        require(ownerOf(survivor) == msg.sender && ownerOf(donor) == msg.sender, "owner");
        require(_level[survivor] == _level[donor], "level");
        _burn(donor);
        _level[survivor] = (_level[survivor] == 0 ? 1 : _level[survivor]) + 1;
    }

    function nextMergeHeight(uint256 id) external view returns (uint64) {
        _requireOwned(id);
        return 0;
    }

    function mergesOpen() external pure returns (bool) {
        return true;
    }

    function MAXIMUM_LEVEL() external pure returns (uint8) {
        return 10;
    }

    function setRoyalty(address receiver, uint96 bps) external {
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }
}
