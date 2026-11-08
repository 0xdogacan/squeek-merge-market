// Deployment settings. MARKET is filled in after the contract is deployed (see /deploy.html).
// A ?market=0x… query parameter overrides it, which the deploy page uses for a first look.
const params = new URLSearchParams(location.search);

export const CONFIG = {
  chainId: 11155111,
  chainName: "Sepolia",
  explorer: "https://sepolia.etherscan.io",
  // Read calls go through this site's /api/rpc proxy (public Sepolia RPCs behind it).
  rpc: params.get("rpc") || `${location.origin}/api/rpc`,
  squeek: params.get("squeek") || "0xC4C7982657f00509548F3a3a41db7FA439a6856B",
  staking: params.get("staking") || "0x50fd1780526C3186A0c037c7622203bC4fb611ca",
  market: params.get("market") || "0x64eFD359CF2Eea11D9A91759E434BBF8a6DbdcDF",
  multicall: params.get("multicall") || "0xcA11bde05977b3631167028862bE2a173976CA11",
  squeekchainApi: "https://api.squeekchain.com",
};
