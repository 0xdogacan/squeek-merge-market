// GET /api/art?id=N — a Squeek's image, read from SqueekNFT.tokenURI and served with a
// long CDN cache. Squeek art is fixed after the reveal (a merge keeps the image), so each
// image is rendered on-chain once per CDN region and then served instantly.
const ENDPOINTS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://rpc.sepolia.ethpandaops.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SQUEEK = process.env.SQUEEK_ADDRESS || "0xC4C7982657f00509548F3a3a41db7FA439a6856B";

async function tokenURI(id) {
  const data = `0xc87b56dd${BigInt(id).toString(16).padStart(64, "0")}`;
  let last;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SQUEEK, data }, "latest"] }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json();
      if (j.error) {
        if (j.error.data || /revert|nonexistent/i.test(j.error.message || "")) return null; // burned or never issued
        throw new Error(j.error.message);
      }
      const b = Buffer.from(j.result.slice(2), "hex");
      const off = Number(BigInt(`0x${b.subarray(0, 32).toString("hex")}`));
      const len = Number(BigInt(`0x${b.subarray(off, off + 32).toString("hex")}`));
      return b.subarray(off + 32, off + 32 + len).toString("utf8");
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(",");
  const head = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  const type = head.split(";")[0] || "text/plain";
  const bytes = head.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  return { type, bytes };
}

export default async function handler(req, res) {
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id < 1 || id > 9999) {
    res.status(400).json({ error: "id must be 1-9999" });
    return;
  }
  try {
    const uri = await tokenURI(id);
    if (!uri) {
      res.setHeader("cache-control", "public, s-maxage=300");
      res.status(404).json({ error: "No such Squeek" });
      return;
    }
    const meta = uri.startsWith("data:application/json") ? JSON.parse(decodeDataUri(uri).bytes.toString("utf8")) : null;
    const image = meta?.image || meta?.image_data || "";
    // Sealed (pre-reveal) art is temporary: cache it briefly only.
    const sealed = /sealed/i.test(meta?.name || "");
    const cache = sealed ? "public, max-age=60, s-maxage=60" : "public, max-age=604800, s-maxage=31536000, immutable";
    if (/^https:\/\//.test(image)) {
      res.setHeader("cache-control", cache);
      res.setHeader("location", image);
      res.status(302).end();
      return;
    }
    if (!image.startsWith("data:image/")) throw new Error("no image in metadata");
    const { type, bytes } = decodeDataUri(image);
    if (!/^image\/(svg\+xml|png|webp|gif|jpeg)$/.test(type)) throw new Error(`unsupported image type ${type}`);
    res.setHeader("content-type", type);
    res.setHeader("cache-control", cache);
    res.setHeader("x-content-type-options", "nosniff");
    // On-chain SVG is untrusted: never let it run script if opened directly.
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.status(200).send(bytes);
  } catch (err) {
    res.setHeader("cache-control", "no-store");
    res.status(502).json({ error: "Could not read the image right now.", detail: String(err?.message || err) });
  }
}
