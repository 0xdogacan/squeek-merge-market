// POST /api/verify { address, txHash? } — submits the MergeMarket source and compiler
// metadata to Sourcify (API v2) so anyone can check the deployed bytecode matches the code.
import { readFile } from "node:fs/promises";
import path from "node:path";

const SOURCIFY = process.env.SOURCIFY_URL || "https://sourcify.dev/server";
const CHAIN = "11155111";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const address = String(body.address || "");
  const txHash = String(body.txHash || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid address." });
    return;
  }
  try {
    const root = process.cwd();
    const [metadataText, source] = await Promise.all([
      readFile(path.join(root, "assets/MergeMarket.metadata.json"), "utf8"),
      readFile(path.join(root, "assets/MergeMarket.sol"), "utf8"),
    ]);
    const metadata = JSON.parse(metadataText);
    const sourcePath = Object.keys(metadata.sources)[0]; // "src/MergeMarket.sol"
    const payload = { sources: { [sourcePath]: source }, metadata };
    if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) payload.creationTransactionHash = txHash;

    const r = await fetch(`${SOURCIFY}/v2/verify/metadata/${CHAIN}/${address}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await json(r);
    if (r.status === 409) {
      res.status(200).json({ verified: true, match: "already verified" });
      return;
    }
    if (r.status !== 202 || !j.verificationId) {
      res.status(502).json({ verified: false, error: j.message || j.customCode || `HTTP ${r.status}` });
      return;
    }

    // Poll the verification job (usually done within ~20 s).
    for (let i = 0; i < 20; i++) {
      await sleep(2500);
      const s = await json(await fetch(`${SOURCIFY}/v2/verify/${j.verificationId}`, { signal: AbortSignal.timeout(10_000) }));
      if (!s.isJobCompleted) continue;
      if (s.error) {
        if (s.error.customCode === "already_verified") {
          res.status(200).json({ verified: true, match: "already verified" });
        } else {
          res.status(502).json({ verified: false, error: s.error.message || s.error.customCode });
        }
        return;
      }
      const c = s.contract || {};
      res.status(200).json({ verified: true, match: c.runtimeMatch || c.match || c.creationMatch || "match" });
      return;
    }
    res.status(202).json({ verified: false, pending: true, verificationId: j.verificationId });
  } catch (err) {
    res.status(502).json({ verified: false, error: String(err?.message || err) });
  }
}
