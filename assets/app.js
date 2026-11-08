import { ethers } from "/assets/ethers.min.js";
import { CONFIG } from "/assets/config.js";

const $ = (id) => document.getElementById(id);
const KIND = { SELL: 0, SWAP: 1, BID: 2 };
const KIND_NAME = ["sell", "swap", "bid"];

const SQUEEK_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function level(uint256) view returns (uint8)",
  "function nextMergeHeight(uint256) view returns (uint64)",
  "function mergesOpen() view returns (bool)",
  "function MAXIMUM_LEVEL() view returns (uint8)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
  "function merge(uint256 survivor, uint256 donor)",
];
const STAKING_ABI = [
  "function depositor(address collection, uint256 tokenId) view returns (address)",
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
let marketR = null;

const S = {
  account: null,
  signer: null,
  chainOk: false,
  maxLevel: 10,
  mergesOpen: true,
  completedHeight: null,
  basePower: {},          // level -> number
  mine: [],               // { id, level, nextMergeHeight, where: "wallet" | "staked" }
  orders: [],             // { id, maker, kind, active, wantLevel, expiry, tokenId, wantTokenId, price, fillable, tokenLevel }
  credit: 0n,
  minBlock: 0,            // block of our latest transaction; ownership must include it
  kindFilter: "all",
  levelFilter: "",
};

/* ---------------------------------------------------------------- helpers */

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei) => `${Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
const fmt = (n) => Number(n).toLocaleString("en-US");
const lc = (a) => (a || "").toLowerCase();
const powerOf = (lvl) => S.basePower[lvl] ?? null;

function toast(html, kind = "", ms = 6000) {
  const t = $("toast");
  t.className = `toast ${kind}`;
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function txLink(hash) {
  return `<a href="${CONFIG.explorer}/tx/${hash}" target="_blank" rel="noopener">view transaction</a>`;
}

function reason(err) {
  const msg = err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
  if (/user rejected|denied/i.test(msg)) return "You cancelled it in your wallet.";
  const named = err?.revert?.name || (msg.match(/reverted with custom error '(\w+)/) || [])[1];
  const known = {
    NotOwner: "You don't own that Squeek (or it is staked).",
    BadLevel: "That Squeek is not the level this order wants.",
    WrongToken: "This swap asks for a different Squeek.",
    BadPrice: "The price does not match.",
    Inactive: "This order is no longer open.",
    Expired: "This order has expired.",
    SelfFill: "You can't fill your own order.",
  };
  return known[named] || msg.replace(/\(action=.*$/, "").slice(0, 160);
}

async function aggregate(calls) {
  // calls: [{ target, iface, fn, args }]
  if (!calls.length) return [];
  const out = [];
  for (let i = 0; i < calls.length; i += 150) {
    const chunk = calls.slice(i, i + 150);
    const res = await multicall.aggregate3.staticCall(chunk.map((c) => ({
      target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args),
    })));
    res.forEach((r, j) => {
      const c = chunk[j];
      out.push(r.success ? c.iface.decodeFunctionResult(c.fn, r.returnData) : null);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ wallet */

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
    await refreshAll();
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

// Sends a transaction and waits for it, with progress toasts.
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
  const ok = await squeekR.isApprovedForAll(S.account, CONFIG.market);
  if (ok) return;
  const squeek = new ethers.Contract(CONFIG.squeek, SQUEEK_ABI, S.signer);
  await send("Allow Merge Market to move your Squeeks when they trade", () => squeek.setApprovalForAll(CONFIG.market, true));
}

/* -------------------------------------------------------------------- data */

async function loadChainBasics() {
  const iface = squeekR.interface;
  const sIface = stakingR.interface;
  const [maxL, open] = await aggregate([
    { target: CONFIG.squeek, iface, fn: "MAXIMUM_LEVEL", args: [] },
    { target: CONFIG.squeek, iface, fn: "mergesOpen", args: [] },
  ]);
  if (maxL) S.maxLevel = Number(maxL[0]);
  if (open) S.mergesOpen = open[0];
  const levels = Array.from({ length: S.maxLevel }, (_, i) => i + 1);
  const powers = await aggregate(levels.map((l) => ({ target: CONFIG.staking, iface: sIface, fn: "basePower", args: [CONFIG.squeek, l] })));
  levels.forEach((l, i) => { if (powers[i]) S.basePower[l] = Number(powers[i][0]); });
  const sel = $("level-filter");
  sel.innerHTML = `<option value="">Any</option>${levels.map((l) => `<option value="${l}">Level ${l}</option>`).join("")}`;
  sel.value = S.levelFilter;
  try {
    const st = await (await fetch(`${CONFIG.squeekchainApi}/v1/status`, { cache: "no-store" })).json();
    S.completedHeight = Number(st?.builder?.anchor?.blockHeight ?? NaN);
    if (!Number.isFinite(S.completedHeight)) S.completedHeight = null;
  } catch { S.completedHeight = null; }
}

async function ownedBy(address) {
  const res = await fetch(`/api/owners?owner=${address}${S.minBlock ? `&min=${S.minBlock}` : ""}`);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "ownership unavailable");
  return j.tokens.map(Number);
}

async function loadMine() {
  if (!S.account) return;
  $("mine-grid").innerHTML = `<p class="muted">Loading your Squeeks…</p>`;
  const [wallet, inStaking] = await Promise.all([ownedBy(S.account), ownedBy(CONFIG.staking).catch(() => [])]);
  const sIface = stakingR.interface;
  const deps = await aggregate(inStaking.map((id) => ({ target: CONFIG.staking, iface: sIface, fn: "depositor", args: [CONFIG.squeek, id] })));
  const staked = inStaking.filter((id, i) => deps[i] && lc(deps[i][0]) === S.account);
  const all = [...wallet.map((id) => ({ id, where: "wallet" })), ...staked.map((id) => ({ id, where: "staked" }))];
  const iface = squeekR.interface;
  const info = await aggregate(all.flatMap((t) => [
    { target: CONFIG.squeek, iface, fn: "level", args: [t.id] },
    { target: CONFIG.squeek, iface, fn: "nextMergeHeight", args: [t.id] },
  ]));
  S.mine = all.map((t, i) => ({
    ...t,
    level: info[2 * i] ? Number(info[2 * i][0]) : null,
    nextMergeHeight: info[2 * i + 1] ? Number(info[2 * i + 1][0]) : 0,
  })).filter((t) => t.level !== null).sort((a, b) => b.level - a.level || a.id - b.id);
}

async function loadOrders() {
  S.orders = [];
  if (!CONFIG.market) return;
  if (!marketAbi) marketAbi = (await (await fetch("/assets/MergeMarket.json")).json()).abi;
  marketR ??= new ethers.Contract(CONFIG.market, marketAbi, read);
  const count = Number(await marketR.orderCount());
  const out = [];
  for (let from = count; from > 0 && out.length < 1000; from -= 200) {
    const page = await marketR.getOrders(from, 200);
    for (const v of page) {
      const o = v.order;
      out.push({
        id: Number(v.id), fillable: v.fillable, maker: lc(o.maker), kind: Number(o.kind), active: o.active,
        wantLevel: Number(o.wantLevel), expiry: Number(o.expiry), tokenId: Number(o.tokenId),
        wantTokenId: Number(o.wantTokenId), price: o.price,
      });
    }
  }
  const iface = squeekR.interface;
  const withToken = out.filter((o) => o.kind !== KIND.BID || o.wantTokenId);
  const lv = await aggregate(withToken.flatMap((o) => [
    { target: CONFIG.squeek, iface, fn: "level", args: [o.tokenId || o.wantTokenId] },
    { target: CONFIG.squeek, iface, fn: "level", args: [o.wantTokenId || o.tokenId] },
  ]));
  withToken.forEach((o, i) => {
    o.tokenLevel = lv[2 * i] ? Number(lv[2 * i][0]) : null;
    o.wantTokenLevel = o.wantTokenId && lv[2 * i + 1] ? Number(lv[2 * i + 1][0]) : null;
  });
  S.orders = out;
  if (S.account) S.credit = await marketR.credit(S.account);
}

async function refreshAll() {
  try {
    await loadChainBasics();
    await Promise.all([loadMine(), loadOrders()]);
  } catch (err) {
    console.error(err);
    toast(`Could not load everything: ${reason(err)}`, "bad");
  }
  render();
}

/* ------------------------------------------------------------------ render */

function cooldownLeft(t) {
  if (!t.nextMergeHeight) return 0;
  if (S.completedHeight === null) return null;
  return Math.max(0, t.nextMergeHeight - S.completedHeight);
}

// Orders that would give me a Squeek of `level` (buy, or swap for something I have).
function partnerOrders(level) {
  return S.orders.filter((o) => o.fillable && o.maker !== S.account && (
    (o.kind === KIND.SELL && o.tokenLevel === level) ||
    (o.kind === KIND.SWAP && o.tokenLevel === level && canFillSwap(o).length > 0)
  ));
}

function canFillSwap(o) {
  return S.mine.filter((t) => t.where === "wallet" && t.id !== o.tokenId &&
    (o.wantTokenId ? t.id === o.wantTokenId : t.level === o.wantLevel));
}

function mergeGain(level) {
  const p = powerOf(level), q = powerOf(level + 1);
  if (!p || !q) return "";
  return `${fmt(2 * p)} → ${fmt(q)} power (+${Math.round(((q - 2 * p) / (2 * p)) * 100)}%)`;
}

function renderMine() {
  const grid = $("mine-grid");
  const pairs = $("pairs");
  pairs.replaceChildren();
  if (!S.account) {
    grid.innerHTML = `<p class="muted">Connect your wallet to see your Squeeks.</p>`;
    return;
  }
  $("mine-meta").textContent = S.mine.length ? `${S.mine.length} Squeek${S.mine.length === 1 ? "" : "s"}` : "";
  if (!S.mine.length) {
    grid.innerHTML = `<p class="muted">No Squeeks in this wallet on Sepolia. Get a test Squeek on <a href="https://sepolia.squeekchain.com" target="_blank" rel="noopener">sepolia.squeekchain.com</a>, then come back.</p>`;
    return;
  }

  // Group by level and location to find merge pairs and lonely Squeeks.
  const byLevel = new Map();
  for (const t of S.mine) {
    if (!byLevel.has(t.level)) byLevel.set(t.level, []);
    byLevel.get(t.level).push(t);
  }
  for (const [level, list] of [...byLevel.entries()].sort((a, b) => b[0] - a[0])) {
    if (level >= S.maxLevel) continue;
    for (const where of ["wallet", "staked"]) {
      const ready = list.filter((t) => t.where === where && cooldownLeft(t) === 0);
      for (let i = 0; i + 1 < ready.length; i += 2) pairs.appendChild(pairRow(ready[i], ready[i + 1], where));
    }
    if (list.length % 2 === 1) pairs.appendChild(needRow(level, list[list.length - 1]));
  }

  grid.replaceChildren(...S.mine.map(card));
}

function pairRow(a, b, where) {
  const el = document.createElement("div");
  el.className = "pair ready";
  el.innerHTML = `<div><div class="what">Merge pair: <b>#${a.id}</b> + <b>#${b.id}</b> · Level ${a.level}</div>
    <div class="sub">${mergeGain(a.level)}${where === "staked" ? " · both staked, merges inside Staking" : ""}</div></div>
    <div class="btns"><button class="btn btn-small">Merge into Level ${a.level + 1}</button></div>`;
  const btn = el.querySelector("button");
  btn.disabled = !S.mergesOpen;
  if (!S.mergesOpen) btn.title = "Merges are closed on Squeekchain right now";
  btn.addEventListener("click", () => doMerge(a, b, where));
  return el;
}

function needRow(level, t) {
  const options = partnerOrders(level);
  const el = document.createElement("div");
  el.className = "pair need";
  el.innerHTML = `<div><div class="what"><b>#${t.id}</b> needs a Level ${level} partner</div>
    <div class="sub">${options.length ? `${options.length} on the market right now` : "None on the market yet"} · merging gives ${mergeGain(level)}</div></div>
    <div class="btns"></div>`;
  const btns = el.querySelector(".btns");
  if (options.length) {
    const see = document.createElement("button");
    see.className = "btn btn-small btn-gold";
    see.textContent = "See partners";
    see.addEventListener("click", () => { S.kindFilter = "all"; S.levelFilter = String(level); syncFilters(); renderOrders(); $("market").scrollIntoView({ behavior: "smooth" }); });
    btns.appendChild(see);
  }
  const bid = document.createElement("button");
  bid.className = "btn btn-small btn-ghost";
  bid.textContent = "Bid for one";
  bid.addEventListener("click", () => openBid(level));
  btns.appendChild(bid);
  if (t.where === "wallet") {
    const sw = document.createElement("button");
    sw.className = "btn btn-small btn-ghost";
    sw.textContent = "Offer a swap";
    sw.addEventListener("click", () => openSwap(S.mine.find((m) => m.where === "wallet" && m.level !== level && m.id !== t.id) || null, level));
    btns.appendChild(sw);
  }
  return el;
}

function card(t) {
  const el = document.createElement("div");
  el.className = "card";
  const left = cooldownLeft(t);
  const status = t.where === "staked" ? `<span class="badge blue">STAKED</span>`
    : left === null ? `<span class="badge">IN WALLET</span>`
    : left > 0 ? `<span class="badge warn">COOLDOWN ${fmt(left)} BLOCKS</span>`
    : `<span class="badge good">MERGE READY</span>`;
  el.innerHTML = `<div class="lvl">LEVEL ${t.level}</div><div class="id">#${t.id}</div>
    <div class="row"><span>Power</span><b>${powerOf(t.level) ? fmt(powerOf(t.level)) : "—"}</b></div>
    <div>${status}</div><div class="acts"></div>`;
  const acts = el.querySelector(".acts");
  if (t.where === "wallet" && CONFIG.market) {
    const sell = document.createElement("button");
    sell.className = "btn btn-small btn-ghost";
    sell.textContent = "Sell";
    sell.addEventListener("click", () => openSell(t));
    const swap = document.createElement("button");
    swap.className = "btn btn-small btn-ghost";
    swap.textContent = "Swap";
    swap.addEventListener("click", () => openSwap(t, null));
    acts.append(sell, swap);
  } else if (t.where === "staked") {
    acts.innerHTML = `<span class="muted small">Withdraw it from Staking to trade it.</span>`;
  }
  return el;
}

function syncFilters() {
  document.querySelectorAll("#kind-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.kind === S.kindFilter)));
  $("level-filter").value = S.levelFilter;
}

function orderLevel(o) {
  return o.kind === KIND.BID ? o.wantLevel : o.tokenLevel;
}

function describe(o) {
  const exp = o.expiry ? ` · until ${new Date(o.expiry * 1000).toLocaleDateString()}` : "";
  if (o.kind === KIND.SELL) return { k: "FOR SALE", main: `<b>#${o.tokenId}</b> · Level ${o.tokenLevel ?? "?"}`, sub: `by ${short(o.maker)}${exp}`, price: eth(o.price) };
  if (o.kind === KIND.SWAP) {
    const want = o.wantTokenId ? `#${o.wantTokenId}${o.wantTokenLevel ? ` (Level ${o.wantTokenLevel})` : ""}` : `any Level ${o.wantLevel}`;
    return { k: "SWAP", main: `<b>#${o.tokenId}</b> · Level ${o.tokenLevel ?? "?"} for ${want}`, sub: `by ${short(o.maker)}${exp}`, price: "swap" };
  }
  return { k: "BID", main: `Wants any Level ${o.wantLevel}`, sub: `by ${short(o.maker)}${exp}`, price: eth(o.price) };
}

function orderRow(o, mine = false) {
  const d = describe(o);
  const el = document.createElement("div");
  el.className = `order${o.fillable ? "" : " dead"}`;
  el.innerHTML = `<span class="k ${KIND_NAME[o.kind]}">${d.k}</span>
    <div><div class="main">${d.main}</div><div class="sub">${d.sub}${o.fillable ? "" : " · not fillable now"}</div></div>
    <div class="side"><div class="price">${d.price}</div></div>`;
  const side = el.querySelector(".side");
  const btn = document.createElement("button");
  btn.className = "btn btn-small";
  if (mine || o.maker === S.account) {
    if (!o.active) return null;
    btn.className = "btn btn-small btn-ghost";
    btn.textContent = "Cancel";
    btn.addEventListener("click", () => doCancel(o));
  } else if (o.kind === KIND.SELL) {
    btn.textContent = "Buy";
    btn.addEventListener("click", () => openBuy(o));
  } else if (o.kind === KIND.SWAP) {
    btn.textContent = "Swap";
    btn.disabled = S.account ? canFillSwap(o).length === 0 : false;
    if (btn.disabled) btn.title = o.wantTokenId ? `Needs Squeek #${o.wantTokenId}` : `You need a Level ${o.wantLevel} Squeek in your wallet`;
    btn.addEventListener("click", () => openAcceptSwap(o));
  } else {
    btn.textContent = "Sell to bid";
    const mineOk = S.mine.some((t) => t.where === "wallet" && t.level === o.wantLevel);
    btn.disabled = S.account ? !mineOk : false;
    if (btn.disabled) btn.title = `You need a Level ${o.wantLevel} Squeek in your wallet`;
    btn.addEventListener("click", () => openAcceptBid(o));
  }
  if (!o.fillable && !(mine || o.maker === S.account)) btn.disabled = true;
  side.appendChild(btn);
  return el;
}

function renderOrders() {
  const box = $("orders");
  if (!CONFIG.market) {
    box.innerHTML = `<p class="muted">Trading opens once the market contract is deployed.</p>`;
    return;
  }
  const list = S.orders.filter((o) => o.active && o.fillable && o.maker !== S.account &&
    (S.kindFilter === "all" || o.kind === Number(S.kindFilter)) &&
    (!S.levelFilter || orderLevel(o) === Number(S.levelFilter)));
  box.replaceChildren(...list.map((o) => orderRow(o)).filter(Boolean));
  if (!list.length) box.innerHTML = `<p class="muted">No open orders${S.levelFilter ? ` at Level ${S.levelFilter}` : ""}. Be the first: list a Squeek or post a bid.</p>`;

  const mine = S.orders.filter((o) => o.active && o.maker === S.account);
  $("my-orders-panel").hidden = !S.account || (!mine.length && S.credit === 0n);
  $("my-orders").replaceChildren(...mine.map((o) => orderRow(o, true)).filter(Boolean));
  $("withdraw").hidden = S.credit === 0n;
  $("withdraw").textContent = `Withdraw ${eth(S.credit)}`;
}

function render() {
  $("no-market").hidden = Boolean(CONFIG.market);
  const link = $("market-link");
  if (CONFIG.market) { link.href = `${CONFIG.explorer}/address/${CONFIG.market}`; link.textContent = short(CONFIG.market); }
  renderMine();
  renderOrders();
}

/* ----------------------------------------------------------------- dialogs */

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
$("sheet-cancel").addEventListener("click", () => $("sheet").close());
$("sheet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!onSubmit) return;
  $("sheet-go").disabled = true;
  try {
    const ok = await onSubmit(new FormData(e.target));
    if (ok !== false) { $("sheet").close(); await refreshAll(); }
  } catch (err) {
    $("sheet-error").textContent = reason(err);
    $("sheet-error").hidden = false;
  } finally {
    $("sheet-go").disabled = false;
  }
});

const EXPIRY = `<label>Open for<select name="expiry"><option value="7">7 days</option><option value="1">1 day</option><option value="30">30 days</option><option value="0">Until I cancel</option></select></label>`;
const expiryFrom = (fd) => { const d = Number(fd.get("expiry")); return d ? BigInt(Math.floor(Date.now() / 1000) + d * 86400) : 0n; };
function marketW() { return new ethers.Contract(CONFIG.market, marketAbi, S.signer); }
function parseEth(v) { const x = String(v || "").trim().replace(",", "."); if (!x || Number(x) <= 0) throw new Error("Enter a price above 0."); return ethers.parseEther(x); }

function myOptions(filter) {
  return S.mine.filter((t) => t.where === "wallet" && filter(t)).map((t) => `<option value="${t.id}">#${t.id} · Level ${t.level}</option>`).join("");
}

function openSell(t) {
  openSheet(`Sell #${t.id} · Level ${t.level}`, `
    <label>Price (Sepolia ETH)<input type="text" name="price" inputmode="decimal" placeholder="0.01" required></label>
    ${EXPIRY}
    <p class="note">Your Squeek stays in your wallet until someone buys it. If you move or merge it, the listing simply stops being fillable.</p>`,
  "List for sale", async (fd) => {
    if (!(await ensureReady())) return false;
    const price = parseEth(fd.get("price"));
    await ensureApproval();
    await send("List for sale", () => marketW().listForSale(t.id, price, expiryFrom(fd)));
  });
}

function openSwap(t, wantLevel) {
  const own = myOptions(() => true);
  if (!own) { toast("You need a Squeek in your wallet to offer a swap.", "bad"); return; }
  openSheet("Offer a swap", `
    <label>You give<select name="give">${own}</select></label>
    <label>You want<select name="mode"><option value="level">Any Squeek of a level</option><option value="token">A specific Squeek</option></select></label>
    <label id="want-level-l">Level<select name="wantLevel">${Array.from({ length: S.maxLevel }, (_, i) => `<option value="${i + 1}">Level ${i + 1}</option>`).join("")}</select></label>
    <label id="want-token-l" hidden>Squeek ID<input type="number" name="wantToken" min="1" placeholder="1234"></label>
    ${EXPIRY}
    <p class="note">The trade happens only when someone accepts, in one transaction: your Squeek goes to them and theirs comes to you.</p>`,
  "Post swap offer", async (fd) => {
    if (!(await ensureReady())) return false;
    const give = Number(fd.get("give"));
    const byToken = fd.get("mode") === "token";
    const wantToken = byToken ? Number(fd.get("wantToken")) : 0;
    if (byToken && !(wantToken > 0)) throw new Error("Enter the Squeek ID you want.");
    await ensureApproval();
    await send("Post swap offer", () => marketW().offerSwap(give, byToken ? 0 : Number(fd.get("wantLevel")), wantToken, expiryFrom(fd)));
  });
  const f = $("sheet-form");
  if (t) f.give.value = String(t.id);
  if (wantLevel) f.wantLevel.value = String(wantLevel);
  f.mode.addEventListener("change", () => {
    const tok = f.mode.value === "token";
    $("want-level-l").hidden = tok;
    $("want-token-l").hidden = !tok;
  });
}

function openBid(level) {
  openSheet("Post a bid", `
    <label>Level you want<select name="level">${Array.from({ length: S.maxLevel }, (_, i) => `<option value="${i + 1}">Level ${i + 1}</option>`).join("")}</select></label>
    <label>Your offer (Sepolia ETH)<input type="text" name="price" inputmode="decimal" placeholder="0.01" required></label>
    ${EXPIRY}
    <p class="note">The ETH is held by the contract until someone sells you a Squeek of that level, or you cancel and get it back.</p>`,
  "Post bid", async (fd) => {
    if (!(await ensureReady())) return false;
    const value = parseEth(fd.get("price"));
    await send("Post bid", () => marketW().placeBid(Number(fd.get("level")), expiryFrom(fd), { value }));
  });
  if (level) $("sheet-form").level.value = String(level);
}

function previewFor(level) {
  const have = S.mine.filter((t) => t.level === level && t.where === "wallet").length;
  if (have % 2 === 1 && level < S.maxLevel) return `<div class="preview">You already have a Level ${level}. After this trade you can merge them: <b>${mergeGain(level)}</b></div>`;
  return "";
}

function openBuy(o) {
  openSheet(`Buy #${o.tokenId} · Level ${o.tokenLevel}`, `
    <p>Price: <b class="mono">${eth(o.price)}</b>, from ${short(o.maker)}.</p>
    ${previewFor(o.tokenLevel)}
    <p class="note">Any collection royalty comes out of the seller's side. Merge Market takes nothing.</p>`,
  `Buy for ${eth(o.price)}`, async () => {
    if (!(await ensureReady())) return false;
    await send(`Buy #${o.tokenId}`, () => marketW().buy(o.id, { value: o.price }));
  });
}

function openAcceptSwap(o) {
  const opts = canFillSwap(o).map((t) => `<option value="${t.id}">#${t.id} · Level ${t.level}</option>`).join("");
  openSheet(`Swap for #${o.tokenId} · Level ${o.tokenLevel}`, `
    <label>You give<select name="give">${opts}</select></label>
    ${previewFor(o.tokenLevel)}
    <p class="note">One transaction: #${o.tokenId} comes to you, your Squeek goes to ${short(o.maker)}.</p>`,
  "Swap", async (fd) => {
    if (!(await ensureReady())) return false;
    await ensureApproval();
    await send(`Swap for #${o.tokenId}`, () => marketW().acceptSwap(o.id, Number(fd.get("give"))));
  });
}

function openAcceptBid(o) {
  const opts = myOptions((t) => t.level === o.wantLevel);
  openSheet(`Sell into a Level ${o.wantLevel} bid`, `
    <p>Bid: <b class="mono">${eth(o.price)}</b> from ${short(o.maker)}.</p>
    <label>You sell<select name="give">${opts}</select></label>
    <p class="note">Any collection royalty comes out of the price. Merge Market takes nothing.</p>`,
  "Sell", async (fd) => {
    if (!(await ensureReady())) return false;
    await ensureApproval();
    await send("Sell into bid", () => marketW().acceptBid(o.id, Number(fd.get("give"))));
  });
}

async function doCancel(o) {
  if (!(await ensureReady())) return;
  try {
    await send(`Cancel order ${o.id}`, () => marketW().cancel(o.id));
    await refreshAll();
  } catch { /* toast shown */ }
}

async function doMerge(a, b, where) {
  if (!(await ensureReady())) return;
  try {
    if (where === "staked") {
      const staking = new ethers.Contract(CONFIG.staking, STAKING_ABI, S.signer);
      await send(`Merge #${a.id} + #${b.id}`, () => staking.mergeDeposited(CONFIG.squeek, a.id, b.id));
    } else {
      const squeek = new ethers.Contract(CONFIG.squeek, SQUEEK_ABI, S.signer);
      await send(`Merge #${a.id} + #${b.id}`, () => squeek.merge(a.id, b.id));
    }
    await refreshAll();
  } catch { /* toast shown */ }
}

/* -------------------------------------------------------------------- boot */

$("connect").addEventListener("click", connect);
$("switch-net").addEventListener("click", switchNetwork);
$("post-bid").addEventListener("click", () => openBid(S.levelFilter ? Number(S.levelFilter) : null));
$("withdraw").addEventListener("click", async () => {
  if (!(await ensureReady())) return;
  try { await send("Withdraw credit", () => marketW().withdraw()); await refreshAll(); } catch { /* toast shown */ }
});
document.querySelectorAll("#kind-tabs button").forEach((b) => b.addEventListener("click", () => { S.kindFilter = b.dataset.kind; syncFilters(); renderOrders(); }));
$("level-filter").addEventListener("change", (e) => { S.levelFilter = e.target.value; renderOrders(); });

if (!CONFIG.market) $("post-bid").disabled = true;
refreshAll();
// Reconnect silently if the wallet already authorised this site.
window.ethereum?.request({ method: "eth_accounts" }).then((a) => { if (a?.length) connect(); }).catch(() => {});
