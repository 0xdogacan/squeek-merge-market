// In-memory index of every live Squeek: owner (the depositor when staked), level and
// staked flag. SqueekNFT is not enumerable, so ownership is rebuilt from Transfer
// events and extended incrementally; levels are re-read with Multicall3 whenever a
// burn (a merge) shows up, and depositors are read for Squeeks that entered Staking.
import { ethers } from "../../assets/ethers.min.js";

const ENDPOINTS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://rpc.sepolia.ethpandaops.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SQUEEK = (process.env.SQUEEK_ADDRESS || "0xC4C7982657f00509548F3a3a41db7FA439a6856B").toLowerCase();
const STAKING = (process.env.STAKING_ADDRESS || "0x50fd1780526C3186A0c037c7622203bC4fb611ca").toLowerCase();
const MULTICALL = process.env.MULTICALL_ADDRESS || "0xcA11bde05977b3631167028862bE2a173976CA11";
const FROM_BLOCK = Number(process.env.SQUEEK_FROM_BLOCK ?? 12057556);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

const squeekI = new ethers.Interface([
  "function level(uint256) view returns (uint8)",
  "function MAXIMUM_LEVEL() view returns (uint8)",
]);
const stakingI = new ethers.Interface(["function depositor(address,uint256) view returns (address)"]);
const multiI = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[]) payable returns ((bool success, bytes returnData)[])",
]);

const state = {
  holder: new Map(),    // id -> address holding the token (may be Staking)
  depositor: new Map(), // id -> depositor, for tokens held by Staking
  level: new Map(),     // id -> level
  maxLevel: 10,
  scannedTo: FROM_BLOCK - 1,
  updatedAt: 0,
  burns: 0,
  levelsAt: 0,
};
let running = null;

async function rpc(method, params) {
  let last;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
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
const topicAddr = (t) => `0x${t.slice(26)}`.toLowerCase();

async function multicall(calls, size = 400) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size);
    const data = multiI.encodeFunctionData("aggregate3", [chunk.map((c) => [c.target, true, c.data])]);
    const raw = await rpc("eth_call", [{ to: MULTICALL, data }, "latest"]);
    const [res] = multiI.decodeFunctionResult("aggregate3", raw);
    res.forEach((r) => out.push(r.success ? r.returnData : null));
  }
  return out;
}

async function scanLogs(head) {
  const touchedStaking = new Set();
  let burned = false;
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
      const from = topicAddr(l.topics[1]);
      const to = topicAddr(l.topics[2]);
      const id = Number(BigInt(l.topics[3]));
      if (to === ZERO) {
        state.holder.delete(id);
        state.depositor.delete(id);
        state.level.delete(id);
        state.burns++;
        burned = true;
        continue;
      }
      state.holder.set(id, to);
      if (from === ZERO && !state.level.has(id)) state.level.set(id, 1);
      if (to === STAKING) { state.depositor.set(id, from); touchedStaking.add(id); }
      else state.depositor.delete(id);
    }
    state.scannedTo = end;
    cursor = end + 1;
  }
  return { touchedStaking, burned };
}

async function refresh() {
  const head = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const first = state.updatedAt === 0;
  const { touchedStaking, burned } = await scanLogs(head);

  if (first) {
    try {
      const [raw] = await multicall([{ target: SQUEEK, data: squeekI.encodeFunctionData("MAXIMUM_LEVEL", []) }]);
      if (raw) state.maxLevel = Number(squeekI.decodeFunctionResult("MAXIMUM_LEVEL", raw)[0]);
    } catch { /* keep default */ }
  }

  // Levels only change through merges, and every merge burns the donor.
  if (first || burned || Date.now() - state.levelsAt > 10 * 60_000) {
    const ids = [...state.holder.keys()];
    const res = await multicall(ids.map((id) => ({ target: SQUEEK, data: squeekI.encodeFunctionData("level", [id]) })));
    ids.forEach((id, i) => { if (res[i]) state.level.set(id, Number(squeekI.decodeFunctionResult("level", res[i])[0])); });
    state.levelsAt = Date.now();
  }

  // The recorded depositor is authoritative for staked Squeeks.
  const staked = first ? [...state.holder.entries()].filter(([, h]) => h === STAKING).map(([id]) => id) : [...touchedStaking];
  if (staked.length) {
    const res = await multicall(staked.map((id) => ({ target: STAKING, data: stakingI.encodeFunctionData("depositor", [SQUEEK, id]) })));
    staked.forEach((id, i) => {
      if (!res[i]) return;
      const d = stakingI.decodeFunctionResult("depositor", res[i])[0].toLowerCase();
      if (d !== ZERO) state.depositor.set(id, d);
    });
  }
  state.updatedAt = Date.now();
}

/** Brings the index up to date (at most every `maxAgeMs`, or until `minBlock` is covered). */
export async function getIndex({ maxAgeMs = 15_000, minBlock = 0 } = {}) {
  if (Date.now() - state.updatedAt > maxAgeMs || state.scannedTo < minBlock) {
    running ??= refresh().finally(() => { running = null; });
    await running;
  }
  return state;
}

export const STAKING_ADDRESS = STAKING;
