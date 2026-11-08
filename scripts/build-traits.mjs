// Builds assets/traits.json: every Squeek's traits, for the trait filters on the site.
// Squeek art and traits are fixed after the reveal, so this runs rarely (GitHub Actions).
// Source: the Squeekchain API (/v1/squeeks/{id}); falls back to SqueekNFT.tokenURI over RPC.
//
//   node scripts/build-traits.mjs
//
// Env: SQUEEKCHAIN_API, SEPOLIA_RPC_URLS, SQUEEK_ADDRESS, MAX_TOKEN_ID
import { writeFile, readFile } from "node:fs/promises";

const API = process.env.SQUEEKCHAIN_API ?? "https://api.squeekchain.com";
const RPCS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://rpc.sepolia.ethpandaops.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SQUEEK = process.env.SQUEEK_ADDRESS || "0xC4C7982657f00509548F3a3a41db7FA439a6856B";
const MAX_ID = Number(process.env.MAX_TOKEN_ID || 9999);
const OUT = process.env.TRAITS_OUT ? new URL(`file://${process.env.TRAITS_OUT}`) : new URL("../assets/traits.json", import.meta.url);
const SKIP = new Set(["level", "power", "base power"]); // shown elsewhere on the site, and they change

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(attrs) {
  const out = [];
  for (const a of attrs || []) {
    const k = String(a.traitType ?? a.trait_type ?? "").trim();
    if (!k || SKIP.has(k.toLowerCase()) || a.value === undefined || a.value === null) continue;
    out.push([k, String(a.value)]);
  }
  return out;
}

/* ------------------------------------------------------------ API source */

async function fromApi(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${API}/v1/squeeks/${id}`, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "merge-market-traits" } });
    if (r.status === 404) return { gone: true };
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`API ${r.status}`);
    const j = await r.json();
    if (j.status !== "available") { await sleep(1000); continue; }
    if (j.custody?.burned) return { gone: true };
    const m = j.metadata;
    if (!m || m.status === "pending") return { attrs: null };
    return { attrs: normalize(m.attributes) };
  }
  throw new Error("API unavailable");
}

/* ------------------------------------------------------------ RPC source */

let rpcIdx = 0;
async function ethCall(data) {
  let last;
  for (let i = 0; i < RPCS.length * 2; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SQUEEK, data }, "latest"] }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json();
      if (j.error) {
        if (/revert|nonexistent/i.test(j.error.message || "") || j.error.data) return { reverted: true };
        throw new Error(j.error.message);
      }
      rpcIdx = (rpcIdx + i) % RPCS.length;
      return { result: j.result };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function decodeString(hex) {
  const b = Buffer.from(hex.slice(2), "hex");
  const off = Number(BigInt(`0x${b.subarray(0, 32).toString("hex")}`));
  const len = Number(BigInt(`0x${b.subarray(off, off + 32).toString("hex")}`));
  return b.subarray(off + 32, off + 32 + len).toString("utf8");
}

async function fromChain(id) {
  const data = `0xc87b56dd${BigInt(id).toString(16).padStart(64, "0")}`; // tokenURI(uint256)
  const r = await ethCall(data);
  if (r.reverted) return { gone: true };
  const uri = decodeString(r.result);
  let json;
  if (uri.startsWith("data:application/json;base64,")) json = Buffer.from(uri.slice(29), "base64").toString("utf8");
  else if (uri.startsWith("data:application/json")) json = decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
  else return { attrs: null };
  return { attrs: normalize(JSON.parse(json).attributes) };
}

/* ------------------------------------------------------------ main */

async function main() {
  let useApi = Boolean(API);
  if (useApi) {
    try { await fromApi(1); } catch (err) { console.log(`API not usable (${err.message}); using RPC tokenURI`); useApi = false; }
  }
  const concurrency = useApi ? 6 : 8;
  const spacing = useApi ? 380 : 0; // ~15 req/s total against the API's 20/s limit
  const results = new Map();
  let next = 1;
  let done = 0;
  let failures = 0;

  async function worker() {
    while (next <= MAX_ID) {
      const id = next++;
      const t0 = Date.now();
      let r;
      try {
        r = useApi ? await fromApi(id) : await fromChain(id);
      } catch {
        try { r = await fromChain(id); } catch { failures++; r = null; }
      }
      if (r?.attrs) results.set(id, r.attrs);
      if (++done % 500 === 0) console.log(`${done}/${MAX_ID} read, ${results.size} with traits`);
      const wait = spacing - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`done: ${results.size} Squeeks with traits, ${failures} failures`);
  if (results.size === 0) throw new Error("no traits found (not revealed yet?)");

  // Compact: categories with value lists; each token lists one value index per category (-1 = none).
  const cats = new Map();
  for (const attrs of results.values()) for (const [k, v] of attrs) {
    if (!cats.has(k)) cats.set(k, new Map());
    const m = cats.get(k);
    if (!m.has(v)) m.set(v, m.size);
  }
  const names = [...cats.keys()].sort((a, b) => a.localeCompare(b));
  const categories = names.map((n) => ({ name: n, values: [...cats.get(n).keys()] }));
  const t = [...results.entries()].sort((a, b) => a[0] - b[0]).map(([id, attrs]) => {
    const row = [id, ...names.map(() => -1)];
    for (const [k, v] of attrs) row[1 + names.indexOf(k)] = cats.get(k).get(v);
    return row;
  });
  const out = JSON.stringify({ updatedAt: new Date().toISOString(), source: useApi ? "api" : "tokenURI", categories, t });
  let prev = "";
  try { prev = await readFile(OUT, "utf8"); } catch { /* first run */ }
  const strip = (s) => s.replace(/"updatedAt":"[^"]*",/, "");
  if (prev && strip(prev) === strip(out)) { console.log("traits unchanged"); return; }
  await writeFile(OUT, out);
  console.log(`wrote ${OUT.pathname} (${(out.length / 1024).toFixed(0)} KB, ${categories.length} categories)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
