import { ethers } from "/assets/ethers.min.js";
import { CONFIG } from "/assets/config.js";

const $ = (id) => document.getElementById(id);
const KIND = { SELL: 0, SWAP: 1, BID: 2 };
const PAGE = 60;

const SQUEEK_ABI = [
  "function level(uint256) view returns (uint8)",
  "function nextMergeHeight(uint256) view returns (uint64)",
  "function mergesOpen() view returns (bool)",
  "function tokenURI(uint256) view returns (string)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
  "function merge(uint256 survivor, uint256 donor)",
];
const STAKING_ABI = [
  "function basePower(address collection, uint8 level) view returns (uint64)",
  "function mergeDeposited(address collection, uint256 survivor, uint256 donor)",
];
const MULTICALL_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
];

const read = new ethers.JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true, batchMaxCount: 1 });
const squeekR = new ethers.Contract(CONFIG.squeek, SQUEEK_ABI, read);
const stakingR = new ethers.Contract(CONFIG.staking, STAKING_ABI, read);
const multicall = new ethers.Contract(CONFIG.multicall, MULTICALL_ABI, read);
let marketAbi = null;
let marketI = null;
let marketR = null;

const S = {
  account: null,
  signer: null,
  chainOk: false,
  head: 0,
  maxLevel: 10,
  mergesOpen: true,
  completedHeight: null,
  basePower: {},
  tokens: new Map(),        // id -> { id, owner, level, staked }
  ownersCount: 0,
  burned: 0,
  orders: [],
  sells: new Map(),         // tokenId -> cheapest fillable sell order
  credit: 0n,
  nextMerge: new Map(),     // my token id -> nextMergeHeight
  activity: [],
  volume: 0n,
  minBlock: 0,
  tab: "items",
  status: "all",          // all | listed | unlisted
  stake: "",              // "" | staked | unstaked
  levels: new Set(),
  traits: new Map(),      // category index -> Set of value indexes
  sort: "price",
  cols: "6",
  page: 1,
  offerKind: "all",
  offerLevel: "",
  loaded: false,
};

/* ================================================================ helpers */

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const lc = (a) => (a || "").toLowerCase();
const fmt = (n) => Number(n).toLocaleString("en-US");
const ethNum = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const eth = (wei) => `${ethNum(wei)} ETH`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const powerOf = (lvl) => S.basePower[lvl] ?? null;
const isMine = (t) => S.account && t.owner === S.account;
const who = (a) => (S.account && a === S.account ? "You" : short(a));
const addrLink = (a) => `<a href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${who(a)}</a>`;
const txLink = (hash, label = "view transaction") => `<a href="${CONFIG.explorer}/tx/${hash}" target="_blank" rel="noopener">${label}</a>`;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

function toast(html, kind = "", ms = 6000) {
  const t = $("toast");
  t.className = `toast ${kind}`;
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function reason(err) {
  const msg = err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
  if (/user rejected|denied/i.test(msg)) return "You cancelled it in your wallet.";
  const named = err?.revert?.name || (msg.match(/custom error '(\w+)/) || [])[1];
  const known = {
    NotOwner: "You don't own that Squeek (or it is staked).",
    BadLevel: "That Squeek is not the level this order wants.",
    WrongToken: "This swap asks for a different Squeek.",
    BadPrice: "The price does not match.",
    Inactive: "This order is no longer open.",
    Expired: "This order has expired.",
    SelfFill: "You can't fill your own order.",
    NotApproved: "The maker no longer lets the market move that Squeek.",
  };
  return known[named] || msg.replace(/\(action=.*$/, "").slice(0, 160);
}

async function aggregate(calls, size = 150) {
  if (!calls.length) return [];
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size);
    const res = await multicall.aggregate3.staticCall(chunk.map((c) => ({
      target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args),
    })));
    res.forEach((r, j) => {
      const c = chunk[j];
      try { out.push(r.success ? c.iface.decodeFunctionResult(c.fn, r.returnData) : null); } catch { out.push(null); }
    });
  }
  return out;
}

function ago(block) {
  if (!S.head || !block) return "—";
  const s = Math.max(0, (S.head - block) * 12);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/* ================================================================ images */
// Squeek art comes from the Squeekchain API (raster card image when there is one),
// falling back to the on-chain tokenURI. Images are only ever used as <img src>,
// never injected as markup.

const META = new Map();     // id -> { src, name, attrs }
const WAIT = new Map();     // id -> Promise
let apiFails = 0;
let apiActive = 0;
const apiQueue = [];
let chainQueue = [];
let chainTimer = null;

function safeSrc(s) {
  if (typeof s !== "string") return "";
  if (s.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${s.slice(7)}`;
  if (/^data:image\//.test(s) || /^https:\/\//.test(s)) return s;
  return "";
}

function decodeTokenURI(uri) {
  let json;
  if (uri.startsWith("data:application/json;base64,")) {
    const bin = atob(uri.slice(29));
    json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } else if (uri.startsWith("data:application/json")) {
    json = decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
  } else return null;
  const j = JSON.parse(json);
  return {
    src: safeSrc(j.image || j.image_data || ""),
    name: j.name || "",
    attrs: (j.attributes || []).map((a) => ({ k: a.trait_type ?? a.traitType ?? "", v: a.value })),
  };
}

function pumpApi() {
  while (apiActive < 6 && apiQueue.length) {
    const { id, resolve } = apiQueue.shift();
    apiActive++;
    fetch(`${CONFIG.squeekchainApi}/v1/squeeks/${id}`, { signal: AbortSignal.timeout(7000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => {
        const m = j?.status === "available" ? j.metadata : null;
        const src = m && m.status !== "pending" ? safeSrc(m.cardImageUrl || m.imageDataUri) : "";
        if (!src) throw new Error("no image");
        apiFails = 0;
        resolve({ src, name: m.name || "", attrs: (m.attributes || []).map((a) => ({ k: a.traitType ?? a.trait_type ?? "", v: a.value })) });
      })
      .catch(() => { apiFails++; fromChain(id).then(resolve); })
      .finally(() => { apiActive--; setTimeout(pumpApi, 40); });
  }
}

function fromChain(id) {
  return new Promise((resolve) => {
    chainQueue.push({ id, resolve });
    clearTimeout(chainTimer);
    chainTimer = setTimeout(flushChain, 30);
  });
}

async function flushChain() {
  const batch = chainQueue;
  chainQueue = [];
  const iface = squeekR.interface;
  for (let i = 0; i < batch.length; i += 6) {
    const chunk = batch.slice(i, i + 6);
    let res = [];
    try { res = await aggregate(chunk.map((b) => ({ target: CONFIG.squeek, iface, fn: "tokenURI", args: [b.id] }))); } catch { /* fall through */ }
    chunk.forEach((b, j) => {
      let m = null;
      try { m = res[j] ? decodeTokenURI(res[j][0]) : null; } catch { m = null; }
      b.resolve(m || { src: "", name: "", attrs: [] });
    });
  }
}

function meta(id) {
  if (META.has(id)) return Promise.resolve(META.get(id));
  if (WAIT.has(id)) return WAIT.get(id);
  const p = new Promise((resolve) => {
    if (CONFIG.squeekchainApi && apiFails < 4) { apiQueue.push({ id, resolve }); pumpApi(); } else fromChain(id).then(resolve);
  }).then((m) => { META.set(id, m); WAIT.delete(id); return m; });
  WAIT.set(id, p);
  return p;
}

// Images come from /api/art (cached on the CDN for good); if that fails, the API/tokenURI path.
const artSrc = (id) => `/api/art?id=${id}`;

function loadArt(img, id, onOk) {
  img.decoding = "async";
  img.onload = () => onOk?.();
  img.onerror = () => {
    img.onerror = null;
    meta(id).then((m) => { if (m.src) img.src = m.src; });
  };
  img.src = artSrc(id);
}

function artImg(id, alt = "") {
  const i = new Image();
  i.alt = alt;
  loadArt(i, id);
  return i;
}

function artBox(id, level) {
  const box = el("div", "art", `<span class="ph">#${id}</span><img alt="Squeek #${id}" loading="lazy">`);
  const img = box.querySelector("img");
  const ph = box.querySelector(".ph");
  loadArt(img, id, () => { img.classList.add("on"); ph.classList.add("hide"); });
  if (level) box.prepend(el("span", `badge-lvl l${level}`, `LV ${level}`));
  return box;
}

function thumb(id) {
  const t = el("span", "thumb");
  const i = artImg(id);
  i.loading = "lazy";
  t.append(i);
  return t;
}

/* ================================================================ wallet */

async function connect() {
  if (!window.ethereum) {
    toast("No wallet found. Install a browser wallet such as Rabby, MetaMask or Rainbow.", "bad");
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    S.signer = await provider.getSigner();
    S.account = lc(await S.signer.getAddress());
    const net = await provider.getNetwork();
    S.chainOk = Number(net.chainId) === CONFIG.chainId;
    $("net-warn").hidden = S.chainOk;
    $("connect").textContent = short(S.account);
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
    await loadMine();
    renderAll();
  } catch (err) {
    toast(reason(err), "bad");
  }
}

async function switchNetwork() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ethers.toQuantity(CONFIG.chainId) }] });
  } catch (err) {
    toast(reason(err), "bad");
  }
}

async function ensureReady() {
  if (!S.signer) { await connect(); if (!S.signer) return false; }
  if (!S.chainOk) { await switchNetwork(); return false; }
  return true;
}

async function send(label, fn) {
  toast(`${label}: confirm in your wallet…`, "", 0);
  try {
    const tx = await fn();
    toast(`${label}: waiting for Sepolia… ${txLink(tx.hash)}`, "", 0);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("Transaction failed");
    S.minBlock = Math.max(S.minBlock, rc.blockNumber);
    toast(`${label}: done. ${txLink(tx.hash)}`, "good");
    return rc;
  } catch (err) {
    toast(`${label}: ${reason(err)}`, "bad", 9000);
    throw err;
  }
}

async function ensureApproval() {
  if (await squeekR.isApprovedForAll(S.account, CONFIG.market)) return;
  const squeek = new ethers.Contract(CONFIG.squeek, SQUEEK_ABI, S.signer);
  await send("Allow Merge Market to move your Squeeks when they trade", () => squeek.setApprovalForAll(CONFIG.market, true));
}

const marketW = () => new ethers.Contract(CONFIG.market, marketAbi, S.signer);

/* ================================================================ data */

async function loadBasics() {
  const sIface = stakingR.interface;
  const levels = Array.from({ length: S.maxLevel }, (_, i) => i + 1);
  const [open, ...powers] = await aggregate([
    { target: CONFIG.squeek, iface: squeekR.interface, fn: "mergesOpen", args: [] },
    ...levels.map((l) => ({ target: CONFIG.staking, iface: sIface, fn: "basePower", args: [CONFIG.squeek, l] })),
  ]);
  if (open) S.mergesOpen = open[0];
  levels.forEach((l, i) => { if (powers[i]) S.basePower[l] = Number(powers[i][0]); });
  if (CONFIG.squeekchainApi) {
    fetch(`${CONFIG.squeekchainApi}/v1/status`, { cache: "no-store", signal: AbortSignal.timeout(6000) })
      .then((r) => r.json())
      .then((st) => { const h = Number(st?.builder?.anchor?.blockHeight ?? NaN); S.completedHeight = Number.isFinite(h) ? h : null; if (S.tab === "merge") renderMerge(); })
      .catch(() => {});
  }
}

async function loadCollection() {
  const r = await fetch(`/api/collection${S.minBlock ? `?min=${S.minBlock}` : ""}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "collection unavailable");
  S.maxLevel = j.maxLevel || 10;
  S.burned = j.burned || 0;
  S.ownersCount = j.owners.length;
  const m = new Map();
  for (const [id, oi, level, staked] of j.t) m.set(id, { id, owner: j.owners[oi], level, staked: Boolean(staked) });
  S.tokens = m;
}

async function loadOrders() {
  S.orders = [];
  S.sells = new Map();
  if (!CONFIG.market) return;
  if (!marketAbi) { marketAbi = (await (await fetch("/assets/MergeMarket.json")).json()).abi; marketI = new ethers.Interface(marketAbi); }
  marketR ??= new ethers.Contract(CONFIG.market, marketAbi, read);
  const count = Number(await marketR.orderCount());
  const out = [];
  for (let from = count; from > 0 && out.length < 2000; from -= 200) {
    for (const v of await marketR.getOrders(from, 200)) {
      const o = v.order;
      out.push({
        id: Number(v.id), fillable: v.fillable, maker: lc(o.maker), kind: Number(o.kind), active: o.active,
        wantLevel: Number(o.wantLevel), expiry: Number(o.expiry), tokenId: Number(o.tokenId),
        wantTokenId: Number(o.wantTokenId), price: o.price,
      });
    }
  }
  S.orders = out.filter((o) => o.active);
  for (const o of S.orders) {
    if (o.kind !== KIND.SELL || !o.fillable) continue;
    const cur = S.sells.get(o.tokenId);
    if (!cur || o.price < cur.price) S.sells.set(o.tokenId, o);
  }
  S.credit = S.account ? await marketR.credit(S.account) : 0n;
}

async function loadActivity() {
  S.activity = [];
  S.volume = 0n;
  if (!CONFIG.market || !marketI) return;
  S.head = await read.getBlockNumber();
  const logs = [];
  for (let from = CONFIG.marketFromBlock; from <= S.head; from += 2000) {
    logs.push(...await read.getLogs({ address: CONFIG.market, fromBlock: from, toBlock: Math.min(from + 1999, S.head) }));
  }
  const created = new Map();
  const rows = [];
  for (const l of logs) {
    let ev;
    try { ev = marketI.parseLog(l); } catch { continue; }
    if (!ev) continue;
    const a = ev.args;
    const base = { block: l.blockNumber, tx: l.transactionHash };
    if (ev.name === "OrderCreated") {
      const o = { id: Number(a.id), maker: lc(a.maker), kind: Number(a.kind), tokenId: Number(a.tokenId), wantLevel: Number(a.wantLevel), wantTokenId: Number(a.wantTokenId), price: a.price };
      created.set(o.id, o);
      rows.push({ ...base, type: ["listed", "swap-offer", "bid"][o.kind], order: o, from: o.maker });
    } else if (ev.name === "OrderFilled") {
      const o = created.get(Number(a.id)) || { kind: -1 };
      const price = a.price;
      S.volume += price;
      rows.push({ ...base, type: ["sale", "swap", "bid-filled"][o.kind] || "sale", order: o, from: lc(a.maker), to: lc(a.taker), price,
        makerTokenId: Number(a.makerTokenId), takerTokenId: Number(a.takerTokenId) });
    } else if (ev.name === "OrderCancelled") {
      const o = created.get(Number(a.id));
      if (o) rows.push({ ...base, type: "cancelled", order: o, from: o.maker });
    }
  }
  S.activity = rows.reverse();
}

// Traits come from assets/traits.json, built by a GitHub Action from Squeek metadata.
const TR = { categories: [], rows: new Map(), loaded: false };
async function loadTraits() {
  if (TR.loaded) return;
  TR.loaded = true;
  try {
    const r = await fetch("/assets/traits.json");
    if (!r.ok) return;
    const j = await r.json();
    TR.categories = j.categories || [];
    for (const row of j.t || []) TR.rows.set(row[0], row);
  } catch { /* no trait filters */ }
}

async function loadMine() {
  S.nextMerge = new Map();
  if (!S.account) return;
  const mine = [...S.tokens.values()].filter(isMine);
  const res = await aggregate(mine.map((t) => ({ target: CONFIG.squeek, iface: squeekR.interface, fn: "nextMergeHeight", args: [t.id] })));
  mine.forEach((t, i) => S.nextMerge.set(t.id, res[i] ? Number(res[i][0]) : 0));
  if (marketR) S.credit = await marketR.credit(S.account);
}

async function refreshAll({ quiet = false } = {}) {
  try {
    // Grid first (collection, orders, traits in parallel); wallet and activity after.
    await Promise.all([
      S.loaded ? null : loadBasics().catch((e) => console.warn("basics", e)),
      loadCollection(), loadOrders(), loadTraits(),
    ]);
    S.loaded = true;
    renderAll();
    await Promise.all([loadMine(), loadActivity().catch((e) => console.warn("activity", e))]);
  } catch (err) {
    console.error(err);
    if (!quiet) toast(`Could not load everything: ${reason(err)}`, "bad");
  }
  renderAll();
}

/* ================================================================ derived */

function cooldownLeft(id) {
  const h = S.nextMerge.get(id) || 0;
  if (!h) return 0;
  if (S.completedHeight === null) return null;
  return Math.max(0, h - S.completedHeight);
}

function bestBid(level) {
  let best = null;
  for (const o of S.orders) if (o.kind === KIND.BID && o.fillable && o.wantLevel === level && o.maker !== S.account && (!best || o.price > best.price)) best = o;
  return best;
}

function myTokens() { return [...S.tokens.values()].filter(isMine).sort((a, b) => b.level - a.level || a.id - b.id); }

function canFillSwap(o) {
  return myTokens().filter((t) => !t.staked && t.id !== o.tokenId && (o.wantTokenId ? t.id === o.wantTokenId : t.level === o.wantLevel));
}

function mergeGain(level) {
  const p = powerOf(level), q = powerOf(level + 1);
  if (!p || !q) return "";
  return `${fmt(2 * p)} → ${fmt(q)} power (+${Math.round(((q - 2 * p) / (2 * p)) * 100)}%)`;
}

/* ================================================================ render: header */

function renderHeader() {
  const sells = [...S.sells.values()];
  const floor = sells.reduce((m, o) => (m === null || o.price < m ? o.price : m), null);
  const bids = S.orders.filter((o) => o.kind === KIND.BID && o.fillable);
  const top = bids.reduce((m, o) => (!m || o.price > m.price ? o : m), null);
  $("st-floor").innerHTML = floor !== null ? `${ethNum(floor)} <small>ETH</small>` : "—";
  $("st-bid").innerHTML = top ? `${ethNum(top.price)} <small>ETH · LV ${top.wantLevel}</small>` : "—";
  $("st-volume").innerHTML = `${ethNum(S.volume)} <small>ETH</small>`;
  $("st-listed").textContent = fmt(sells.length);
  $("st-owners").textContent = S.tokens.size ? fmt(S.ownersCount) : "—";
  $("st-merged").textContent = fmt(S.burned);
  $("chip-items").textContent = `${fmt(S.tokens.size)} ITEMS`;
  $("chip-max").textContent = S.maxLevel;
  $("count-offers").textContent = S.orders.filter((o) => o.kind !== KIND.SELL && o.fillable).length || "";
  $("foot-block").textContent = S.head ? fmt(S.head) : "—";
  const link = $("market-link");
  if (CONFIG.market) { link.href = `${CONFIG.explorer}/address/${CONFIG.market}#code`; link.textContent = short(CONFIG.market); }
  renderBanner();
}

let bannerDone = false;
function renderBanner() {
  if (bannerDone || !S.tokens.size) return;
  bannerDone = true;
  const ids = [...S.tokens.keys()];
  const pick = [...S.sells.keys()].slice(0, 8);
  for (let i = 0; pick.length < 24 && i < 400; i++) {
    const id = ids[Math.floor((i * 7919 + 13) % ids.length)];
    if (!pick.includes(id)) pick.push(id);
  }
  const art = $("banner-art");
  art.replaceChildren(...pick.map((id) => {
    return artImg(id);
  }));
  loadArt($("avatar"), pick[0] ?? ids[0]);
}

/* ================================================================ render: items */

function filtered() {
  let list = [...S.tokens.values()];
  if (S.status === "listed") list = list.filter((t) => S.sells.has(t.id));
  else if (S.status === "unlisted") list = list.filter((t) => !S.sells.has(t.id));
  if (S.stake === "staked") list = list.filter((t) => t.staked);
  else if (S.stake === "unstaked") list = list.filter((t) => !t.staked);
  if (S.levels.size) list = list.filter((t) => S.levels.has(t.level));
  if (S.traits.size) {
    const want = [...S.traits.entries()];
    list = list.filter((t) => {
      const row = TR.rows.get(t.id);
      return row && want.every(([c, vals]) => vals.has(row[1 + c]));
    });
  }
  const price = (t) => S.sells.get(t.id)?.price;
  const byPrice = (dir) => (a, b) => {
    const pa = price(a), pb = price(b);
    if (pa !== undefined && pb !== undefined) return pa === pb ? a.id - b.id : (pa < pb ? -dir : dir);
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.id - b.id;
  };
  if (S.sort === "price") list.sort(byPrice(1));
  else if (S.sort === "price-desc") list.sort(byPrice(-1));
  else if (S.sort === "level") list.sort((a, b) => b.level - a.level || a.id - b.id);
  else list.sort((a, b) => a.id - b.id);
  return list;
}

function itemCard(t) {
  const c = el("button", "card");
  c.type = "button";
  c.append(artBox(t.id, t.level));
  const art = c.firstChild;
  if (isMine(t)) art.append(el("span", "flag you", "YOURS"));
  else if (t.staked) art.append(el("span", "flag staked", "STAKED"));
  const sell = S.sells.get(t.id);
  const bid = !sell ? bestBid(t.level) : null;
  c.append(el("div", "card-body", `
    <div class="card-name"><span>SQUEEK #${t.id}</span><span>${powerOf(t.level) ? `${fmt(powerOf(t.level))} PW` : ""}</span></div>
    ${sell ? `<div class="card-price">${eth(sell.price)}</div>`
      : `<div class="card-price none">${bid ? `<span class="bid">Bid ${eth(bid.price)}</span>` : "Not listed"}</div>`}`));
  c.addEventListener("click", () => openItem(t.id));
  return c;
}

function renderLevels() {
  const counts = new Map();
  for (const t of S.tokens.values()) counts.set(t.level, (counts.get(t.level) || 0) + 1);
  const ul = $("levels");
  // Only levels that exist (plus any still selected) are worth a row.
  const shown = Array.from({ length: S.maxLevel }, (_, i) => i + 1).filter((l) => counts.get(l) || S.levels.has(l));
  ul.replaceChildren(...shown.map((l) => {
    const li = el("li", "", `<label><input type="checkbox" value="${l}" ${S.levels.has(l) ? "checked" : ""}>
      <span>Level ${l}</span> <span class="pw">${powerOf(l) ? fmt(powerOf(l)) : ""}</span><span class="n">${fmt(counts.get(l) || 0)}</span></label>`);
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) S.levels.add(l); else S.levels.delete(l);
      resetItems(); $("levels-clear").hidden = !S.levels.size;
    });
    return li;
  }));
  $("levels-clear").hidden = !S.levels.size;
}

// Infinite scroll: S.page is how many pages of PAGE items are on screen. Filter and
// sort changes reset it to 1; background refreshes keep it, so the grid doesn't jump.
let itemList = [];

function renderItems() {
  const grid = $("grid");
  grid.dataset.cols = S.cols;
  if (!S.loaded && !S.tokens.size) {
    grid.replaceChildren(...Array.from({ length: 12 }, () => el("div", "skel")));
    return;
  }
  itemList = filtered();
  S.page = Math.max(1, Math.min(S.page, Math.ceil(itemList.length / PAGE)));
  if (!itemList.length) {
    const msg = S.status === "listed" && !S.levels.size && !S.traits.size && !S.stake
      ? `Nothing listed yet. Own a Squeek? Open it and list it, or post a level bid.`
      : "No Squeeks match these filters.";
    grid.innerHTML = `<div class="empty">${msg}</div>`;
    grid.querySelector("[data-act=connect]")?.addEventListener("click", connect);
  } else {
    grid.replaceChildren(...itemList.slice(0, S.page * PAGE).map(itemCard));
  }
  updateShowing();
  renderActiveFilters();
}

function renderActiveFilters() {
  const box = $("active-f");
  const chips = [];
  const chip = (label, onRemove) => {
    const b = el("button", "", `${label} <span>×</span>`);
    b.type = "button";
    b.addEventListener("click", () => { onRemove(); syncFilterControls(); resetItems(); });
    chips.push(b);
  };
  for (const l of [...S.levels].sort((a, b) => a - b)) chip(`Level ${l}`, () => S.levels.delete(l));
  if (S.stake) chip(S.stake === "staked" ? "Staked" : "Not staked", () => { S.stake = ""; });
  for (const [c, vals] of S.traits) for (const v of vals) {
    const cat = TR.categories[c];
    chip(`${esc(cat.name)}: ${esc(cat.values[v])}`, () => { vals.delete(v); if (!vals.size) S.traits.delete(c); });
  }
  box.hidden = !chips.length;
  if (chips.length > 1) {
    const all = el("button", "clear-all", "Clear all");
    all.type = "button";
    all.addEventListener("click", () => { S.levels.clear(); S.stake = ""; S.traits.clear(); syncFilterControls(); resetItems(); });
    chips.push(all);
  }
  box.replaceChildren(...chips);
}

function syncFilterControls() {
  pressSeg($("stake-seg"), "stake", S.stake);
  renderLevels();
  renderTraitFilters();
}

/* Trait filters: one collapsible list per category, with counts over live Squeeks. */
const openCats = new Set();
const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

function renderTraitFilters() {
  const group = $("traits-group");
  group.hidden = !TR.categories.length;
  if (!TR.categories.length) return;
  const counts = TR.categories.map(() => new Map());
  for (const id of S.tokens.keys()) {
    const row = TR.rows.get(id);
    if (!row) continue;
    for (let c = 0; c < TR.categories.length; c++) {
      const v = row[1 + c];
      if (v >= 0) counts[c].set(v, (counts[c].get(v) || 0) + 1);
    }
  }
  const box = $("traits-f");
  box.replaceChildren(...TR.categories.map((cat, c) => {
    const sel = S.traits.get(c);
    const wrap = el("div", `tcat${openCats.has(c) ? " open" : ""}`);
    const head = el("button", "", `<span>${esc(cat.name)}</span>${sel?.size ? `<span class="sel">${sel.size} selected</span>` : ""}<span class="n">${fmt(counts[c].size)}</span>${CHEVRON}`);
    head.type = "button";
    head.setAttribute("aria-expanded", String(openCats.has(c)));
    const body = el("div", "tcat-body");
    head.addEventListener("click", () => {
      const open = wrap.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
      if (open) { openCats.add(c); if (!body.childElementCount) fillTraitBody(body, cat, c, counts[c]); } else openCats.delete(c);
    });
    if (openCats.has(c)) fillTraitBody(body, cat, c, counts[c]);
    wrap.append(head, body);
    return wrap;
  }));
  $("traits-clear").hidden = !S.traits.size;
}

function fillTraitBody(body, cat, c, counts) {
  const values = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(cat.values[a[0]]).localeCompare(String(cat.values[b[0]])));
  const LIMIT = 80;
  const list = el("ul");
  const note = el("div", "more-v");
  const draw = (q = "") => {
    const ql = q.trim().toLowerCase();
    const match = ql ? values.filter(([v]) => String(cat.values[v]).toLowerCase().includes(ql)) : values;
    // Selected values stay visible even when they fall outside the first LIMIT.
    const sel = S.traits.get(c) || new Set();
    const shown = match.slice(0, LIMIT);
    for (const v of sel) if (!shown.some(([x]) => x === v) && counts.has(v)) shown.unshift([v, counts.get(v)]);
    list.replaceChildren(...shown.map(([v, n]) => {
      const li = el("li", "", `<label><input type="checkbox" ${sel.has(v) ? "checked" : ""}><span title="${esc(cat.values[v])}">${esc(cat.values[v])}</span><span class="n">${fmt(n)}</span></label>`);
      li.querySelector("input").addEventListener("change", (e) => {
        let set = S.traits.get(c);
        if (e.target.checked) { if (!set) { set = new Set(); S.traits.set(c, set); } set.add(v); }
        else if (set) { set.delete(v); if (!set.size) S.traits.delete(c); }
        const headSel = body.parentElement.querySelector(":scope > button .sel");
        const size = S.traits.get(c)?.size || 0;
        if (headSel) headSel.textContent = size ? `${size} selected` : "";
        else if (size) body.parentElement.querySelector(":scope > button .n").insertAdjacentHTML("beforebegin", `<span class="sel">${size} selected</span>`);
        $("traits-clear").hidden = !S.traits.size;
        resetItems();
      });
      return li;
    }));
    note.textContent = match.length > LIMIT ? `${fmt(match.length - LIMIT)} more: type to search` : "";
  };
  if (values.length > 10) {
    const q = el("input");
    q.type = "search";
    q.placeholder = `Search ${cat.name.toLowerCase()}`;
    q.addEventListener("input", () => draw(q.value));
    body.append(q);
  }
  body.append(list, note);
  draw();
}

function resetItems() {
  S.page = 1;
  renderItems();
  const top = $("tab-items").getBoundingClientRect().top;
  if (top < 0) window.scrollBy({ top: top - 70 });
}

function updateShowing() {
  const shown = Math.min(S.page * PAGE, itemList.length);
  $("showing").textContent = itemList.length ? `Showing ${fmt(shown)} of ${fmt(itemList.length)} items` : "No items";
  $("more").hidden = shown >= itemList.length;
}

function loadMore() {
  const shown = S.page * PAGE;
  if (shown >= itemList.length || S.tab !== "items") return;
  S.page++;
  $("grid").append(...itemList.slice(shown, S.page * PAGE).map(itemCard));
  updateShowing();
  // The observer only fires on changes; keep going while the loader is still near the viewport.
  requestAnimationFrame(() => {
    const m = $("more");
    if (!m.hidden && m.getBoundingClientRect().top < innerHeight + 900) loadMore();
  });
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { rootMargin: "900px" }).observe($("more"));

/* ================================================================ render: offers */

function describeWant(o) {
  if (o.kind === KIND.SELL) return "ETH";
  if (o.kind === KIND.BID) return `Any Level ${o.wantLevel}`;
  return o.wantTokenId ? `Squeek #${o.wantTokenId}` : `Any Level ${o.wantLevel}`;
}

function orderAction(o) {
  const b = el("button", "btn btn-sm");
  b.type = "button";
  if (o.maker === S.account) {
    b.className = "btn btn-sm btn-ghost";
    b.textContent = "Cancel";
    b.addEventListener("click", () => doCancel(o));
  } else if (o.kind === KIND.SELL) {
    b.className = "btn btn-sm btn-dark";
    b.textContent = "Buy";
    b.addEventListener("click", () => openBuy(o));
  } else if (o.kind === KIND.SWAP) {
    b.textContent = "Accept swap";
    if (S.account && !canFillSwap(o).length) { b.disabled = true; b.title = o.wantTokenId ? `Needs Squeek #${o.wantTokenId}` : `Needs a Level ${o.wantLevel} Squeek in your wallet`; }
    b.addEventListener("click", () => openAcceptSwap(o));
  } else {
    b.textContent = "Sell into bid";
    if (S.account && !myTokens().some((t) => !t.staked && t.level === o.wantLevel)) { b.disabled = true; b.title = `Needs a Level ${o.wantLevel} Squeek in your wallet`; }
    b.addEventListener("click", () => openAcceptBid(o));
  }
  if (!o.fillable && o.maker !== S.account) b.disabled = true;
  return b;
}

function renderOffers() {
  const sel = $("offer-level");
  if (sel.options.length !== S.maxLevel + 1) {
    sel.innerHTML = `<option value="">All levels</option>${Array.from({ length: S.maxLevel }, (_, i) => `<option value="${i + 1}">Level ${i + 1}</option>`).join("")}`;
  }
  sel.value = S.offerLevel;
  const lvlOf = (o) => (o.kind === KIND.BID ? o.wantLevel : S.tokens.get(o.tokenId)?.level);
  const list = S.orders.filter((o) => (o.fillable || o.maker === S.account) &&
    (S.offerKind === "all" ? true : o.kind === Number(S.offerKind)) &&
    (!S.offerLevel || lvlOf(o) === Number(S.offerLevel)))
    .sort((a, b) => (a.kind === KIND.BID && b.kind === KIND.BID ? (b.price > a.price ? 1 : -1) : b.id - a.id));
  const body = $("offers-table").querySelector("tbody");
  body.replaceChildren(...list.map((o) => {
    const tr = el("tr");
    const kindName = ["sell", "swap", "bid"][o.kind];
    const label = ["FOR SALE", "SWAP", "LEVEL BID"][o.kind];
    tr.append(el("td", "", `<span class="kind ${kindName}">${label}</span>`));
    const item = el("td");
    const wrap = el("div", "titem");
    if (o.kind === KIND.BID) {
      wrap.append(el("span", "thumb any", `L${o.wantLevel}`), el("span", "", `Any Level ${o.wantLevel}`));
      wrap.style.cursor = "default";
    } else {
      const t = S.tokens.get(o.tokenId);
      wrap.append(thumb(o.tokenId), el("span", "", `#${o.tokenId}${t ? ` <span class="muted">· LV ${t.level}</span>` : ""}`));
      wrap.addEventListener("click", () => openItem(o.tokenId));
    }
    item.append(wrap);
    tr.append(item);
    tr.append(el("td", "", o.kind === KIND.SWAP ? esc(describeWant(o)) : o.kind === KIND.BID ? "Squeek" : "ETH"));
    tr.append(el("td", "num", o.kind === KIND.SWAP ? "—" : eth(o.price)));
    tr.append(el("td", "", addrLink(o.maker)));
    tr.append(el("td", "", o.expiry ? new Date(o.expiry * 1000).toLocaleDateString() : "Never"));
    const act = el("td", "act");
    act.append(orderAction(o));
    tr.append(act);
    return tr;
  }));
  $("offers-table").parentElement.hidden = !list.length;
  const empty = $("offers-empty");
  empty.hidden = Boolean(list.length);
  empty.innerHTML = `No open offers${S.offerLevel ? ` at Level ${S.offerLevel}` : ""}. <br><button class="btn btn-dark" type="button">Make a level bid</button>`;
  empty.querySelector("button").onclick = () => openBid(S.offerLevel ? Number(S.offerLevel) : null);
}

/* ================================================================ render: merge */

function mini(id) {
  const d = el("div", "mini");
  d.append(artImg(id, `Squeek #${id}`));
  d.addEventListener("click", () => openItem(id));
  return d;
}

function renderMerge() {
  const box = $("merge-body");
  if (!S.account) {
    box.innerHTML = `<div class="empty"><b>Find the partner your Squeek needs.</b><br>Connect your wallet to see which of your Squeeks can merge now, and which need a partner from the market.<br><button class="btn btn-dark" type="button">Connect wallet</button></div>`;
    box.querySelector("button").addEventListener("click", connect);
    return;
  }
  const mine = myTokens();
  const totalPower = mine.reduce((s, t) => s + (powerOf(t.level) || 0), 0);
  const byLevel = new Map();
  for (const t of mine) { if (!byLevel.has(t.level)) byLevel.set(t.level, []); byLevel.get(t.level).push(t); }
  const pairs = [];
  const lonely = [];
  for (const [level, list] of [...byLevel.entries()].sort((a, b) => b[0] - a[0])) {
    if (level >= S.maxLevel) continue;
    const used = new Set();
    for (const staked of [false, true]) {
      const ready = list.filter((t) => t.staked === staked && cooldownLeft(t.id) === 0);
      for (let i = 0; i + 1 < ready.length; i += 2) { pairs.push([ready[i], ready[i + 1]]); used.add(ready[i].id); used.add(ready[i + 1].id); }
    }
    const rest = list.filter((t) => !used.has(t.id));
    if (rest.length % 2 === 1) lonely.push(rest[rest.length - 1]);
  }

  box.replaceChildren();
  box.append(el("dl", "merge-head", `
    <div><dt>YOUR SQUEEKS</dt><dd>${fmt(mine.length)}</dd></div>
    <div><dt>TOTAL POWER</dt><dd>${fmt(totalPower)}</dd></div>
    <div><dt>READY PAIRS</dt><dd>${fmt(pairs.length)}</dd></div>
    <div><dt>NEED A PARTNER</dt><dd>${fmt(lonely.length)}</dd></div>`));

  if (!mine.length) {
    box.append(el("div", "empty", `No Squeeks in this wallet on Sepolia yet. Browse <b>ITEMS</b> to buy one, or post a level bid and let sellers come to you.`));
  }

  if (pairs.length) {
    box.append(el("h3", "sec-title", `READY TO MERGE <span class="muted">same level, off cooldown</span>`));
    const g = el("div", "pairs");
    for (const [a, b] of pairs) {
      const p = el("div", "pair");
      p.append(mini(a.id), el("span", "op", "+"), mini(b.id), el("span", "op", "→"), el("div", "result", `LV ${a.level + 1}`));
      const info = el("div", "info", `<div><b>#${a.id} + #${b.id}</b><span>${mergeGain(a.level)}${a.staked ? " · inside Staking" : ""}</span></div>`);
      const btn = el("button", "btn btn-sm btn-dark", "Merge");
      btn.type = "button";
      btn.disabled = !S.mergesOpen;
      if (!S.mergesOpen) btn.title = "Merges are closed on Squeekchain right now";
      btn.addEventListener("click", () => doMerge(a, b));
      info.append(btn);
      p.append(info);
      g.append(p);
    }
    box.append(g);
  }

  if (lonely.length) {
    box.append(el("h3", "sec-title", `NEEDS A PARTNER <span class="muted">matching Squeeks on the market</span>`));
    for (const t of lonely) {
      const sec = el("div", "need");
      const head = el("div", "need-head");
      const left = cooldownLeft(t.id);
      head.append(mini(t.id), el("div", "txt", `<b>Squeek #${t.id} · Level ${t.level}</b>
        <div>${mergeGain(t.level) ? `Merging gives ${mergeGain(t.level)}` : ""}${t.staked ? " · staked" : ""}${left ? ` · cooldown ${fmt(left)} blocks` : ""}</div>`));
      const btns = el("div", "btns");
      const bid = el("button", "btn btn-sm btn-dark", `Bid for a Level ${t.level}`);
      bid.type = "button";
      bid.addEventListener("click", () => openBid(t.level));
      btns.append(bid);
      const others = myTokens().filter((m) => !m.staked && m.level !== t.level);
      if (others.length) {
        const sw = el("button", "btn btn-sm", "Offer a swap");
        sw.type = "button";
        sw.addEventListener("click", () => openSwap(others[0].id, { wantLevel: t.level }));
        btns.append(sw);
      }
      head.append(btns);
      sec.append(head);
      const body = el("div", "need-body");
      const candidates = [...S.tokens.values()].filter((c) => c.level === t.level && !isMine(c) && S.sells.has(c.id))
        .sort((a, b) => (S.sells.get(a.id).price < S.sells.get(b.id).price ? -1 : 1)).slice(0, 8);
      const swaps = S.orders.filter((o) => o.kind === KIND.SWAP && o.fillable && o.maker !== S.account && S.tokens.get(o.tokenId)?.level === t.level && canFillSwap(o).length);
      if (candidates.length) {
        const g = el("div", "grid");
        g.append(...candidates.map(itemCard));
        body.append(g);
      }
      if (swaps.length) body.append(el("p", "note", `${swaps.length} swap offer${swaps.length > 1 ? "s" : ""} for a Level ${t.level} you can accept. See OFFERS.`));
      if (!candidates.length && !swaps.length) body.append(el("p", "none", `No Level ${t.level} on sale right now. A bid tells every Level ${t.level} owner you're buying.`));
      sec.append(body);
      box.append(sec);
    }
  }

  const ladder = el("div", "ladder");
  for (let l = 1; l <= S.maxLevel; l++) ladder.append(el("div", "", `<span>LEVEL ${l}</span>${powerOf(l) ? fmt(powerOf(l)) : "—"}`));
  const lt = el("h3", "sec-title", `POWER BY LEVEL <span class="muted">from Staking · each merge ×2.2</span>`);
  lt.style.marginTop = "34px";
  ladder.style.marginTop = "0";
  box.append(lt, ladder);
}

/* ================================================================ render: activity */

const EVENT_LABEL = {
  listed: ["sell", "LISTED"], "swap-offer": ["swap", "SWAP OFFER"], bid: ["bid", "LEVEL BID"],
  sale: ["sale", "SALE"], swap: ["swap", "SWAPPED"], "bid-filled": ["sale", "SOLD TO BID"], cancelled: ["cancel", "CANCELLED"],
};

function renderActivity() {
  const body = $("activity-table").querySelector("tbody");
  const rows = S.activity.slice(0, 200);
  body.replaceChildren(...rows.map((r) => {
    const tr = el("tr");
    const [cls, label] = EVENT_LABEL[r.type] || ["cancel", r.type.toUpperCase()];
    tr.append(el("td", "", `<span class="kind ${cls}">${label}</span>`));
    const o = r.order || {};
    const tokenId = r.type === "bid-filled" ? r.takerTokenId : (o.tokenId || r.makerTokenId);
    const td = el("td");
    const wrap = el("div", "titem");
    if (tokenId) {
      wrap.append(thumb(tokenId), el("span", "", `#${tokenId}${r.type === "swap" && r.takerTokenId ? ` <span class="muted">⇄ #${r.takerTokenId}</span>` : ""}`));
      wrap.addEventListener("click", () => openItem(tokenId));
    } else {
      wrap.append(el("span", "thumb any", `L${o.wantLevel || "?"}`), el("span", "", `Any Level ${o.wantLevel || "?"}`));
    }
    td.append(wrap);
    tr.append(td);
    const price = r.price !== undefined ? r.price : o.price;
    tr.append(el("td", "num", price && price > 0n ? eth(price) : "—"));
    tr.append(el("td", "", r.from ? addrLink(r.from) : "—"));
    tr.append(el("td", "", r.to ? addrLink(r.to) : "—"));
    tr.append(el("td", "", txLink(r.tx, ago(r.block))));
    return tr;
  }));
  $("activity-table").parentElement.hidden = !rows.length;
  $("activity-empty").hidden = Boolean(rows.length);
  $("activity-empty").textContent = CONFIG.market ? "No market activity yet." : "The market contract is not set.";
}

/* ================================================================ item detail */

let currentItem = null;

function openItem(id) {
  const t = S.tokens.get(id);
  if (!t) { toast(`Squeek #${id} doesn't exist: it was merged away (burned) or never issued.`, "bad"); return; }
  currentItem = id;
  const dlg = $("item");
  const img = $("item-img");
  img.removeAttribute("src");
  loadArt(img, id);
  if (TR.rows.has(id)) renderTraits(id, null);
  else meta(id).then((m) => { if (currentItem === id) renderTraits(id, m); });
  renderItemBody(t);
  if (!dlg.open) dlg.showModal();
}

function renderTraits(id, m) {
  const box = $("item-traits");
  let attrs = (m?.attrs || []).filter((a) => a.k !== "" && a.v !== undefined && a.v !== null);
  const row = TR.rows.get(id);
  if (!attrs.length && row) attrs = TR.categories.map((c, i) => ({ k: c.name, v: c.values[row[1 + i]] })).filter((a) => a.v !== undefined);
  box.innerHTML = attrs.length ? `<h4>TRAITS</h4><div class="traits">${attrs.map((a) => `<div><span>${esc(a.k)}</span><b>${esc(a.v)}</b></div>`).join("")}</div>` : "";
}

function renderItemBody(t) {
  const mine = isMine(t);
  const sell = S.sells.get(t.id);
  const mySell = S.orders.find((o) => o.kind === KIND.SELL && o.tokenId === t.id && o.maker === S.account);
  const left = mine ? cooldownLeft(t.id) : 0;
  $("item-eyebrow").textContent = `SQUEEKS · LEVEL ${t.level}`;
  $("item-title").textContent = `Squeek #${t.id}`;
  $("item-owner").innerHTML = `Owned by ${addrLink(t.owner)}${t.staked ? " · in Staking" : ""}`;
  $("item-kv").innerHTML = `
    <div><span>LEVEL</span><b>${t.level} / ${S.maxLevel}</b></div>
    <div><span>POWER</span><b>${powerOf(t.level) ? fmt(powerOf(t.level)) : "—"}</b></div>
    <div><span>${mine ? "MERGE" : "STATUS"}</span><b>${mine ? (t.level >= S.maxLevel ? "Max level" : left === null ? "—" : left ? `${fmt(left)} blocks` : "Ready") : (t.staked ? "Staked" : sell ? "Listed" : "Not listed")}</b></div>`;

  const bid = bestBid(t.level);
  const pb = $("item-price");
  if (sell) pb.innerHTML = `<span>PRICE</span><b>${eth(sell.price)}</b><small>Listed by ${who(sell.maker)}${sell.expiry ? ` · until ${new Date(sell.expiry * 1000).toLocaleDateString()}` : ""}</small>`;
  else if (bid) pb.innerHTML = `<span>BEST LEVEL ${t.level} BID</span><b>${eth(bid.price)}</b><small>Any Level ${t.level} Squeek can sell into it</small>`;
  else pb.innerHTML = "";

  const acts = $("item-actions");
  acts.replaceChildren();
  const add = (label, cls, fn, opts = {}) => {
    const b = el("button", `btn ${cls}`, label);
    b.type = "button";
    if (opts.disabled) { b.disabled = true; b.title = opts.title || ""; }
    b.addEventListener("click", fn);
    acts.append(b);
    return b;
  };
  if (!CONFIG.market) {
    acts.append(el("p", "note", "Trading opens once the market contract is set."));
  } else if (mine && t.staked) {
    acts.append(el("p", "note", "This Squeek is in Staking. Withdraw it on Squeekchain to trade it; you can still merge it with another staked Squeek of the same level."));
  } else if (mine) {
    if (mySell) add("Cancel listing", "btn-ghost", () => doCancel(mySell));
    else add("List for sale", "btn-dark", () => openSell(t));
    add("Offer a swap", "", () => openSwap(t.id, {}));
    if (bid) add(`Sell to bid · ${eth(bid.price)}`, "btn-accent", () => openAcceptBid(bid, t.id));
  } else {
    if (sell) add(`Buy for ${eth(sell.price)}`, "btn-dark", () => openBuy(sell));
    const myWallet = myTokens().filter((m) => !m.staked);
    add("Offer a swap for it", sell ? "" : "btn-dark", () => openSwap(myWallet[0]?.id, { wantTokenId: t.id }),
      { disabled: S.account && !myWallet.length, title: "You need a Squeek in your wallet to offer a swap" });
    add(`Bid on any Level ${t.level}`, "", () => openBid(t.level));
  }

  // Merge context.
  const mbox = $("item-merge");
  mbox.replaceChildren();
  if (S.account && t.level < S.maxLevel) {
    const partners = myTokens().filter((m) => m.id !== t.id && m.level === t.level);
    if (mine && partners.length) {
      mbox.append(el("h4", "", `MERGE WITH <span class="muted">${mergeGain(t.level)}</span>`));
      const row = el("div", "partners");
      for (const p of partners) {
        const b = el("button", "", `<span>#${p.id}${p.staked !== t.staked ? " ·⚠" : ""}</span>`);
        b.type = "button";
        b.title = p.staked !== t.staked ? "One is staked and one isn't: both must be in the same place to merge" : `Merge #${t.id} + #${p.id}`;
        b.prepend(artImg(p.id));
        b.addEventListener("click", () => { if (p.staked === t.staked) doMerge(t, p); else toast(b.title, "bad"); });
        row.append(b);
      }
      mbox.append(row);
    } else if (!mine && partners.length) {
      mbox.append(el("div", "callout", `You own a Level ${t.level} (${partners.map((p) => `#${p.id}`).join(", ")}). Get this one and you can merge them: <b>${mergeGain(t.level)}</b>.`));
    } else if (mine) {
      const onSale = [...S.sells.values()].filter((o) => S.tokens.get(o.tokenId)?.level === t.level && o.maker !== S.account).length;
      mbox.append(el("div", "callout", `No Level ${t.level} partner in your wallet. ${onSale ? `<b>${onSale}</b> on sale right now, see MERGE.` : "Post a level bid to find one."}`));
    }
  }

  // Open orders touching this Squeek.
  const rel = S.orders.filter((o) => (o.tokenId === t.id && o.kind !== KIND.BID) || o.wantTokenId === t.id);
  const obox = $("item-orders");
  obox.replaceChildren();
  if (rel.length) {
    obox.append(el("h4", "", "OPEN ORDERS"));
    const list = el("div", "olist");
    for (const o of rel) {
      const txt = o.kind === KIND.SELL ? `For sale · ${eth(o.price)}` : o.tokenId === t.id ? `Swap for ${describeWant(o)}` : `Swap: #${o.tokenId} offered for this one`;
      const row = el("div", "orow", `<span class="kind ${["sell", "swap", "bid"][o.kind]}">${["SALE", "SWAP", "BID"][o.kind]}</span><span class="grow">${esc(txt)} · ${who(o.maker)}${o.fillable ? "" : " · not fillable"}</span>`);
      if (o.fillable || o.maker === S.account) row.append(orderAction(o));
      list.append(row);
    }
    obox.append(list);
  }
}

$("item").addEventListener("click", (e) => { if (e.target === $("item") || e.target.closest("[data-close]")) $("item").close(); });
$("item").addEventListener("close", () => { currentItem = null; });

/* ================================================================ forms */

let onSubmit = null;
function openSheet(title, body, goLabel, handler) {
  $("sheet-title").textContent = title;
  $("sheet-body").innerHTML = body;
  $("sheet-error").hidden = true;
  $("sheet-go").textContent = goLabel;
  $("sheet-go").disabled = false;
  onSubmit = handler;
  $("sheet").showModal();
}
const closeSheet = () => $("sheet").close();
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet-x").addEventListener("click", closeSheet);
$("sheet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!onSubmit) return;
  $("sheet-go").disabled = true;
  try {
    const ok = await onSubmit(new FormData(e.target));
    if (ok !== false) { closeSheet(); await afterTx(); }
  } catch (err) {
    $("sheet-error").textContent = reason(err);
    $("sheet-error").hidden = false;
  } finally {
    $("sheet-go").disabled = false;
  }
});

async function afterTx() {
  await refreshAll({ quiet: true });
  if (currentItem !== null && $("item").open) {
    const t = S.tokens.get(currentItem);
    if (t) renderItemBody(t); else $("item").close();
  }
}

const EXPIRY = `<label>Open for<select name="expiry"><option value="7">7 days</option><option value="1">1 day</option><option value="30">30 days</option><option value="0">Until I cancel</option></select></label>`;
const expiryFrom = (fd) => { const d = Number(fd.get("expiry")); return d ? BigInt(Math.floor(Date.now() / 1000) + d * 86400) : 0n; };
function parseEth(v) { const x = String(v || "").trim().replace(",", "."); if (!x || !(Number(x) > 0)) throw new Error("Enter a price above 0."); return ethers.parseEther(x); }
const levelOptions = () => Array.from({ length: S.maxLevel }, (_, i) => `<option value="${i + 1}">Level ${i + 1}${powerOf(i + 1) ? ` · ${fmt(powerOf(i + 1))} power` : ""}</option>`).join("");
const myOptions = (filter) => myTokens().filter((t) => !t.staked && filter(t)).map((t) => `<option value="${t.id}">Squeek #${t.id} · Level ${t.level}</option>`).join("");

function previewFor(level) {
  const have = myTokens().filter((t) => t.level === level).length;
  if (have % 2 === 1 && level < S.maxLevel) return `<div class="preview">You already have a Level ${level}. After this you can merge them: <b>${mergeGain(level)}</b></div>`;
  return "";
}

function openSell(t) {
  const bid = bestBid(t.level);
  openSheet(`List Squeek #${t.id}`, `
    <label>Price (Sepolia ETH)<input type="text" name="price" inputmode="decimal" placeholder="0.01" required autofocus></label>
    ${EXPIRY}
    ${bid ? `<p class="note">There's a Level ${t.level} bid of ${eth(bid.price)} you could sell into right away.</p>` : ""}
    <p class="note">Your Squeek stays in your wallet until someone buys it. Merge Market takes no fee; the collection royalty (if any) comes out of the price.</p>`,
  "List for sale", async (fd) => {
    if (!(await ensureReady())) return false;
    const price = parseEth(fd.get("price"));
    await ensureApproval();
    await send(`List #${t.id}`, () => marketW().listForSale(t.id, price, expiryFrom(fd)));
  });
}

function openSwap(giveId, { wantLevel = null, wantTokenId = null } = {}) {
  if (!S.account) { connect(); return; }
  const own = myOptions(() => true);
  if (!own) { toast("You need a Squeek in your wallet (not staked) to offer a swap.", "bad"); return; }
  openSheet(wantTokenId ? `Offer a swap for #${wantTokenId}` : "Offer a swap", `
    <label>You give<select name="give">${own}</select></label>
    <label>You want<select name="mode"><option value="level">Any Squeek of a level</option><option value="token">A specific Squeek</option></select></label>
    <label id="want-level-l">Level<select name="wantLevel">${levelOptions()}</select></label>
    <label id="want-token-l" hidden>Squeek number<input type="number" name="wantToken" min="1" placeholder="1234"></label>
    ${EXPIRY}
    <p class="note">The trade happens only when the other side accepts, in one transaction.</p>`,
  "Post swap offer", async (fd) => {
    if (!(await ensureReady())) return false;
    const give = Number(fd.get("give"));
    const byToken = fd.get("mode") === "token";
    const want = byToken ? Number(fd.get("wantToken")) : 0;
    if (byToken && !(want > 0)) throw new Error("Enter the Squeek number you want.");
    await ensureApproval();
    await send("Post swap offer", () => marketW().offerSwap(give, byToken ? 0 : Number(fd.get("wantLevel")), want, expiryFrom(fd)));
  });
  const f = $("sheet-form");
  const sync = () => { const tok = f.mode.value === "token"; $("want-level-l").hidden = tok; $("want-token-l").hidden = !tok; };
  if (giveId) f.give.value = String(giveId);
  if (wantLevel) f.wantLevel.value = String(wantLevel);
  if (wantTokenId) { f.mode.value = "token"; f.wantToken.value = String(wantTokenId); }
  f.mode.addEventListener("change", sync);
  sync();
}

function openBid(level) {
  if (!CONFIG.market) return;
  openSheet("Make a level bid", `
    <label>Level you want<select name="level">${levelOptions()}</select></label>
    <label>Your offer (Sepolia ETH)<input type="text" name="price" inputmode="decimal" placeholder="0.01" required></label>
    ${EXPIRY}
    <p class="note">Any owner of a Squeek at that level can sell into your bid. The ETH waits in the contract until then, or until you cancel and take it back.</p>`,
  "Post bid", async (fd) => {
    if (!(await ensureReady())) return false;
    const value = parseEth(fd.get("price"));
    await send("Post bid", () => marketW().placeBid(Number(fd.get("level")), expiryFrom(fd), { value }));
  });
  if (level) $("sheet-form").level.value = String(level);
}

function openBuy(o) {
  const t = S.tokens.get(o.tokenId);
  openSheet(`Buy Squeek #${o.tokenId}`, `
    <p>Level ${t?.level ?? "?"} · from ${who(o.maker)}</p>
    <p style="font-size:26px;font-weight:500">${eth(o.price)}</p>
    ${t ? previewFor(t.level) : ""}
    <p class="note">The Squeek moves to your wallet in the same transaction. Merge Market takes no fee.</p>`,
  "Buy now", async () => {
    if (!(await ensureReady())) return false;
    await send(`Buy #${o.tokenId}`, () => marketW().buy(o.id, { value: o.price }));
  });
}

function openAcceptSwap(o) {
  if (!S.account) { connect(); return; }
  const t = S.tokens.get(o.tokenId);
  const opts = canFillSwap(o).map((m) => `<option value="${m.id}">Squeek #${m.id} · Level ${m.level}</option>`).join("");
  openSheet(`Swap for Squeek #${o.tokenId}`, `
    <label>You give<select name="give">${opts}</select></label>
    ${t ? previewFor(t.level) : ""}
    <p class="note">One transaction: #${o.tokenId} comes to you, your Squeek goes to ${who(o.maker)}.</p>`,
  "Swap", async (fd) => {
    if (!(await ensureReady())) return false;
    await ensureApproval();
    await send(`Swap for #${o.tokenId}`, () => marketW().acceptSwap(o.id, Number(fd.get("give"))));
  });
}

function openAcceptBid(o, preferId) {
  if (!S.account) { connect(); return; }
  const opts = myOptions((t) => t.level === o.wantLevel);
  openSheet(`Sell into a Level ${o.wantLevel} bid`, `
    <p style="font-size:26px;font-weight:500">${eth(o.price)}</p>
    <label>You sell<select name="give">${opts}</select></label>
    <p class="note">Bid from ${who(o.maker)}. The collection royalty (if any) comes out of the price; Merge Market takes nothing.</p>`,
  "Sell", async (fd) => {
    if (!(await ensureReady())) return false;
    await ensureApproval();
    await send("Sell into bid", () => marketW().acceptBid(o.id, Number(fd.get("give"))));
  });
  if (preferId) $("sheet-form").give.value = String(preferId);
}

async function doCancel(o) {
  if (!(await ensureReady())) return;
  try { await send(o.kind === KIND.BID ? "Cancel bid and refund" : "Cancel order", () => marketW().cancel(o.id)); await afterTx(); } catch { /* toast shown */ }
}

async function doMerge(a, b) {
  if (!(await ensureReady())) return;
  try {
    if (a.staked) {
      const staking = new ethers.Contract(CONFIG.staking, STAKING_ABI, S.signer);
      await send(`Merge #${a.id} + #${b.id}`, () => staking.mergeDeposited(CONFIG.squeek, a.id, b.id));
    } else {
      const squeek = new ethers.Contract(CONFIG.squeek, SQUEEK_ABI, S.signer);
      await send(`Merge #${a.id} + #${b.id}`, () => squeek.merge(a.id, b.id));
    }
    META.delete(a.id);
    await afterTx();
  } catch { /* toast shown */ }
}

/* ================================================================ wiring */

function renderAll() {
  renderHeader();
  renderLevels();
  renderTraitFilters();
  renderItems();
  if (S.tab === "offers") renderOffers();
  if (S.tab === "merge") renderMerge();
  if (S.tab === "activity") renderActivity();
  if (S.credit > 0n && !$("credit-note")) {
    const n = el("div", "netwarn", `You have ${eth(S.credit)} waiting from a trade. <button class="link" type="button">Withdraw</button>`);
    n.id = "credit-note";
    n.querySelector("button").addEventListener("click", async () => {
      if (!(await ensureReady())) return;
      try { await send("Withdraw", () => marketW().withdraw()); n.remove(); await afterTx(); } catch { /* toast shown */ }
    });
    $("net-warn").after(n);
  }
}

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  for (const t of ["items", "offers", "merge", "activity"]) $(`tab-${t}`).hidden = t !== tab;
  if (tab === "offers") renderOffers();
  if (tab === "merge") renderMerge();
  if (tab === "activity") renderActivity();
  if (tab === "items") requestAnimationFrame(() => { if (!$("more").hidden && $("more").getBoundingClientRect().top < innerHeight + 900) loadMore(); });
  history.replaceState(null, "", tab === "items" ? location.pathname + location.search : `#${tab}`);
}

function pressSeg(seg, attr, value) {
  seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));
}

document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("status-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.status = b.dataset.status;
  pressSeg($("status-seg"), "status", S.status);
  resetItems();
});
$("cols-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.cols = b.dataset.cols; pressSeg($("cols-seg"), "cols", S.cols);
  try { localStorage.setItem("mm-cols", S.cols); } catch { /* ignore */ }
  renderItems();
});
$("offer-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.offerKind = b.dataset.kind; pressSeg($("offer-seg"), "kind", S.offerKind); renderOffers();
});
$("offer-level").addEventListener("change", (e) => { S.offerLevel = e.target.value; renderOffers(); });
$("sort").addEventListener("change", (e) => { S.sort = e.target.value; resetItems(); });
$("levels-clear").addEventListener("click", () => { S.levels.clear(); renderLevels(); resetItems(); });
$("filters-toggle").addEventListener("click", () => $("filters").classList.toggle("open"));
$("refresh").addEventListener("click", () => refreshAll());
$("connect").addEventListener("click", () => { if (!S.account) connect(); else setTab("merge"); });
$("stake-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.stake = S.stake === b.dataset.stake ? "" : b.dataset.stake; // one at a time; click again to clear
  pressSeg($("stake-seg"), "stake", S.stake);
  resetItems();
});
$("traits-clear").addEventListener("click", () => { S.traits.clear(); renderTraitFilters(); resetItems(); });
$("switch-net").addEventListener("click", switchNetwork);
$("post-bid").addEventListener("click", () => openBid(S.levels.size === 1 ? [...S.levels][0] : null));
$("theme").addEventListener("click", () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("mm-theme", next); } catch { /* ignore */ }
});
$("search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const id = Number(String(e.target.value).replace(/[^0-9]/g, ""));
  if (id > 0) openItem(id);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/input|select|textarea/i.test(document.activeElement?.tagName || "")) { e.preventDefault(); $("search").focus(); }
});

try { const c = localStorage.getItem("mm-cols"); if (c) { S.cols = c; pressSeg($("cols-seg"), "cols", c); } } catch { /* ignore */ }
if (!CONFIG.market) $("post-bid").disabled = true;
const startTab = location.hash.slice(1);
if (["offers", "merge", "activity"].includes(startTab)) setTab(startTab);
renderItems();
refreshAll().then(() => {
  window.ethereum?.request({ method: "eth_accounts" }).then((a) => { if (a?.length) connect(); }).catch(() => {});
});
setInterval(() => { if (!document.hidden && !$("sheet").open) refreshAll({ quiet: true }); }, 60_000);
