// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Local-chain stand-ins used only for end-to-end checks of the site.
contract MockStaking {
    function depositor(address, uint256) external pure returns (address) {
        return address(0);
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
