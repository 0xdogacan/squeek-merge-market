// POST /api/rpc — a read-only JSON-RPC proxy to public Sepolia endpoints, so the
// browser does not depend on any single RPC's CORS or rate limits.
const ENDPOINTS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://rpc.sepolia.ethpandaops.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getLogs", "eth_getBalance",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getCode", "net_version", "eth_getBlockByNumber"]);

let preferred = 0;

async function forward(body) {
  let last;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const url = ENDPOINTS[(preferred + i) % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json();
      const errs = (Array.isArray(j) ? j : [j]).filter((x) => x.error && /rate|limit|timeout|unavailable/i.test(x.error.message || ""));
      if (errs.length) throw new Error(errs[0].error.message);
      preferred = (preferred + i) % ENDPOINTS.length;
      return j;
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("no RPC");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 50 || calls.some((c) => !c || !ALLOWED.has(c.method))) {
    res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } });
    return;
  }
  try {
    res.setHeader("cache-control", "no-store");
    res.status(200).json(await forward(body));
  } catch (err) {
    res.status(502).json({ jsonrpc: "2.0", id: calls[0].id ?? null, error: { code: -32000, message: String(err.message || err) } });
  }
}
