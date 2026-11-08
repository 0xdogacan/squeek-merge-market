// GET /api/owners — current owner of every Squeek, built from SqueekNFT Transfer
// events (SqueekNFT is not enumerable). Cached in memory and extended incrementally.
const ENDPOINTS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://rpc.sepolia.ethpandaops.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SQUEEK = (process.env.SQUEEK_ADDRESS || "0xC4C7982657f00509548F3a3a41db7FA439a6856B").toLowerCase();
const FROM_BLOCK = Number(process.env.SQUEEK_FROM_BLOCK || 12057556);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

const state = { owners: new Map(), scannedTo: FROM_BLOCK - 1, updatedAt: 0 };
let running = null;

async function rpc(method, params) {
  let last;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const hex = (n) => `0x${n.toString(16)}`;
const addr = (topic) => `0x${topic.slice(26)}`.toLowerCase();

async function refresh() {
  const head = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  let step = 2000;
  let cursor = state.scannedTo + 1;
  while (cursor <= head) {
    const end = Math.min(cursor + step - 1, head);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: SQUEEK, fromBlock: hex(cursor), toBlock: hex(end), topics: [TRANSFER] }]);
    } catch (err) {
      if (step > 250) { step = Math.floor(step / 2); continue; }
      throw err;
    }
    logs.sort((a, b) => Number.parseInt(a.blockNumber, 16) - Number.parseInt(b.blockNumber, 16) ||
      Number.parseInt(a.logIndex, 16) - Number.parseInt(b.logIndex, 16));
    for (const l of logs) {
      if (l.topics.length !== 4) continue;
      const to = addr(l.topics[2]);
      const id = BigInt(l.topics[3]).toString();
      if (to === ZERO) state.owners.delete(id);
      else state.owners.set(id, to);
    }
    state.scannedTo = end;
    cursor = end + 1;
  }
  state.updatedAt = Date.now();
}

export default async function handler(req, res) {
  try {
    // ?min=<block> forces a refresh until that block is indexed (used right after a trade).
    const min = Number(req.query.min) || 0;
    if (Date.now() - state.updatedAt > 15_000 || state.scannedTo < min) {
      running ??= refresh().finally(() => { running = null; });
      await running;
    }
    const owner = String(req.query.owner || "").toLowerCase();
    const entries = [...state.owners.entries()];
    const tokens = owner ? entries.filter(([, o]) => o === owner).map(([id]) => id) : null;
    res.setHeader("cache-control", "public, s-maxage=10, stale-while-revalidate=30");
    res.status(200).json({
      scannedTo: state.scannedTo,
      total: entries.length,
      ...(owner ? { tokens } : { owners: Object.fromEntries(entries) }),
    });
  } catch (err) {
    res.status(503).json({ error: "Could not read Squeek ownership right now.", detail: String(err?.message || err) });
  }
}
