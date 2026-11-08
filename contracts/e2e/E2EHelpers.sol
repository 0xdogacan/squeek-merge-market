// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Local-chain stand-ins used only for end-to-end checks of the site.
interface IMockSqueek {
    function transferFrom(address from, address to, uint256 id) external;
    function merge(uint256 survivor, uint256 donor) external;
}

contract MockStaking {
    mapping(address => mapping(uint256 => address)) public depositor;

    function deposit(address collection, uint256[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) {
            IMockSqueek(collection).transferFrom(msg.sender, address(this), ids[i]);
            depositor[collection][ids[i]] = msg.sender;
        }
    }

    function mergeDeposited(address collection, uint256 survivor, uint256 donor) external {
        require(depositor[collection][survivor] == msg.sender && depositor[collection][donor] == msg.sender, "depositor");
        IMockSqueek(collection).merge(survivor, donor);
        delete depositor[collection][donor];
    }

    function basePower(address, uint8 level) external pure returns (uint64) {
        uint64[10] memory p = [uint64(1000), 2200, 4840, 10648, 23426, 51536, 113380, 249436, 548759, 1207269];
        return level >= 1 && level <= 10 ? p[level - 1] : 0;
    }
}

contract Multicall3Lite {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory out) {
        out = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory data) = calls[i].target.call(calls[i].callData);
            require(ok || calls[i].allowFailure, "call failed");
            out[i] = Result(ok, data);
        }
    }
}
