// POST /api/verify { address } — submits the MergeMarket source and compiler
// metadata to Sourcify so anyone can check the deployed bytecode matches the code.
import { readFile } from "node:fs/promises";
import path from "node:path";

const SOURCIFY = process.env.SOURCIFY_URL || "https://sourcify.dev/server";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const address = String(body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid address." });
    return;
  }
  try {
    const root = process.cwd();
    const [metadata, source] = await Promise.all([
      readFile(path.join(root, "assets/MergeMarket.metadata.json"), "utf8"),
      readFile(path.join(root, "assets/MergeMarket.sol"), "utf8"),
    ]);
    const r = await fetch(`${SOURCIFY}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, chain: "11155111", files: { "metadata.json": metadata, "MergeMarket.sol": source } }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    res.status(r.ok ? 200 : 502).json(j);
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
}
