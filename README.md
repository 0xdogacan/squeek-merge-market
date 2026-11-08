# Merge Market

**Find your Squeek's merge partner.** Peer-to-peer trading for [Squeekchain](https://docs.squeekchain.com/) Squeeks, built around merging: two Squeeks of the same level merge into one a level higher with 10% more power, so the hard part is finding the second one.

- **For sale** — list a Squeek for ETH. It stays in your wallet until someone buys it.
- **Swap** — offer your Squeek for a specific Squeek, or for any Squeek of a level. Both move in one transaction.
- **Bid** — escrow ETH for any Squeek of a level ("I need a Level 3"). Cancel any time to get it back.

The site reads your Squeeks (wallet and Staking), levels and merge cooldowns, shows merge-ready pairs with a one-click merge (`SqueekNFT.merge`, or `SqueekStaking.mergeDeposited` for staked pairs), and for every Squeek without a partner, shows matching offers and the power you would have after merging (from `SqueekStaking.basePower`).

## Contract

`contracts/src/MergeMarket.sol` — Solidity 0.8.28, about 250 lines, no dependencies.

- **Ownerless:** no admin, pause, upgrade or fee switch.
- **Non-custodial:** Squeeks never sit in the contract; trades move them wallet to wallet. Orders whose maker moved, merged or un-approved the Squeek simply stop being fillable (`isFillable`, `getOrders`).
- **Fee-free:** only the collection's ERC-2981 royalty is paid on ETH sales, capped at 10%.
- **Safe payouts:** reentrancy guard; ETH that cannot be delivered is credited and withdrawable.

SqueekNFT is an unmodified OpenZeppelin ERC721 + ERC2981 with `level(tokenId)` (1 until first merged), so standard transfers and approvals apply. Staked Squeeks are held by Staking and must be withdrawn before trading.

### Tests

32 Foundry tests (including a 1,000-run fuzz test) cover sales, swaps (by level and by token), bids, cancel and refunds, expiry, stale orders after moves, merges and revoked approvals, royalty caps, undeliverable payouts and reentrancy.

```sh
cd contracts
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test
```

## Site

Plain HTML, CSS and JS modules (ethers v6 vendored), no build step. Vercel functions:

| Endpoint | Purpose |
| --- | --- |
| `api/rpc.js` | Read-only JSON-RPC proxy to public Sepolia endpoints |
| `api/owners.js` | Current owner of every Squeek, indexed from SqueekNFT `Transfer` events |
| `api/verify.js` | Submits source and metadata to Sourcify |

`deploy.html` deploys the contract from the visitor's wallet and verifies it on Sourcify. After deploying, set `market` in `assets/config.js`.

## Addresses (Sepolia)

| | |
| --- | --- |
| SqueekNFT | `0xC4C7982657f00509548F3a3a41db7FA439a6856B` |
| SqueekStaking | `0x50fd1780526C3186A0c037c7622203bC4fb611ca` |
| MergeMarket | [`0x64eFD359CF2Eea11D9A91759E434BBF8a6DbdcDF`](https://sepolia.etherscan.io/address/0x64eFD359CF2Eea11D9A91759E434BBF8a6DbdcDF) |

Independent, open-source tool for Squeekchain; not affiliated with it. Testnet only.
