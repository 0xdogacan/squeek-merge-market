// GET /api/collection — every live Squeek in one compact payload:
// { scannedTo, maxLevel, burned, owners: [address…], t: [[id, ownerIndex, level, staked]…] }
// The owner of a staked Squeek is its depositor. ?min=<block> waits until that block
// is indexed (the site passes it right after a trade).
import { getIndex, STAKING_ADDRESS } from "./_lib/indexer.js";

export default async function handler(req, res) {
  try {
    const minBlock = Number(req.query.min) || 0;
    const s = await getIndex({ minBlock });
    const owners = [];
    const idx = new Map();
    const t = [];
    for (const [id, holder] of s.holder) {
      const staked = holder === STAKING_ADDRESS && s.depositor.has(id);
      const owner = staked ? s.depositor.get(id) : holder;
      if (!idx.has(owner)) { idx.set(owner, owners.length); owners.push(owner); }
      t.push([id, idx.get(owner), s.level.get(id) ?? 1, staked ? 1 : 0]);
    }
    t.sort((a, b) => a[0] - b[0]);
    res.setHeader("cache-control", minBlock ? "no-store" : "public, s-maxage=10, stale-while-revalidate=30");
    res.status(200).json({ scannedTo: s.scannedTo, maxLevel: s.maxLevel, burned: s.burns, owners, t });
  } catch (err) {
    res.status(503).json({ error: "Could not read the collection right now.", detail: String(err?.message || err) });
  }
}
