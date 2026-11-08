// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

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

    /// @dev Test art only: a dot-matrix hamster face tinted by id.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        string memory hue = Strings.toString((id * 47) % 360);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
            '<rect width="24" height="24" fill="hsl(', hue, ',35%,14%)"/>',
            '<rect x="5" y="6" width="14" height="13" fill="hsl(', hue, ',70%,62%)"/>',
            '<rect x="4" y="4" width="4" height="4" fill="hsl(', hue, ',70%,52%)"/><rect x="16" y="4" width="4" height="4" fill="hsl(', hue, ',70%,52%)"/>',
            '<rect x="8" y="10" width="2" height="2" fill="#111"/><rect x="14" y="10" width="2" height="2" fill="#111"/>',
            '<rect x="11" y="13" width="2" height="1" fill="#f8a"/><rect x="8" y="15" width="8" height="3" fill="#fff" opacity=".85"/></svg>'
        );
        string memory json = string.concat(
            '{"name":"Squeek #', Strings.toString(id), '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":[{"trait_type":"Level","value":', Strings.toString(_level[id] == 0 ? 1 : _level[id]), '},{"trait_type":"Fur","value":"Hue ', hue, '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function setRoyalty(address receiver, uint96 bps) external {
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }
}
