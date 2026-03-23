'use strict';

// ═══════════════════════════════════════════════════════════════════
// TENET SYSTEMS — Orchestration Engine Server
// v1.1 · WebSocket transport layer
//
// Runs all four engines. Maintains all state.
// Broadcasts every state change to every connected client.
// Accepts intent submissions from CLI clients.
//
// Port: 8080 (configurable via PORT env var)
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// ── UTILITIES ────────────────────────────────────────────────────
const usd2 = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num  = (n, dp=4) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const shrt = () => new Date().toISOString().slice(11, 19);
const wait = ms => new Promise(r => setTimeout(r, ms));
const rnd  = (a, b) => a + Math.random() * (b - a);
function txHash() {
  const h = '0123456789abcdef';
  let s = '0x';
  for (let i = 0; i < 8; i++) s += h[Math.floor(Math.random() * 16)];
  return s + '…' + h[Math.floor(Math.random()*16)] + h[Math.floor(Math.random()*16)] +
         h[Math.floor(Math.random()*16)] + h[Math.floor(Math.random()*16)];
}
let _oc = 93847590;
const nextId = () => 'ORD_' + (++_oc);

// ── CHAIN TIMEOUTS ────────────────────────────────────────────────
const CHAIN_TIMEOUTS = { SOL:15, ARB:30, BASE:30, POLYGON:45, ETH:90, OPTIMISM:30, AVALANCHE:20, DEFAULT:60 };
const chainTimeout = c => CHAIN_TIMEOUTS[c?.toUpperCase()] ?? CHAIN_TIMEOUTS.DEFAULT;
const deriveDeadline = (delivChain, settlChain, fiDeadline=0) =>
  Math.max(Math.max(chainTimeout(delivChain), chainTimeout(settlChain)), fiDeadline);

// ── CHAIN FINALITY TIERS ─────────────────────────────────────────
const CHAIN_TIER = { SOL:1, ARB:2, BASE:2, POLYGON:3, ETH:4 };
const chainTier  = c => CHAIN_TIER[c?.toUpperCase()] ?? 5;

// ── FILL CONSTANTS ────────────────────────────────────────────────
const FILL_EPSILON        = 0.0001;
const MAX_LEGS            = 5;
const RESIDUAL_THRESHOLD  = 0.01;

// ═══════════════════════════════════════════════════════════════════
// REGISTRIES
// ═══════════════════════════════════════════════════════════════════

const VAULT_REGISTRY = {
  'GoldmanSettlementVault':   { type:'FI_SETTLEMENT',   fi:'GoldmanSachs_x800',  balance:100_000_000, reserved:0, reservations:{}, status:'ACTIVE',          custodian:'Fireblocks', lastUpdated:shrt() },
  'JPMorganSettlementVault':  { type:'FI_SETTLEMENT',   fi:'JPMorgan_x240',      balance:250_000_000, reserved:0, reservations:{}, status:'ACTIVE',          custodian:'Fireblocks', lastUpdated:shrt() },
  'FidelitySettlementVault':  { type:'FI_SETTLEMENT',   fi:'Fidelity_x510',      balance:50_000_000,  reserved:0, reservations:{}, status:'PENDING_CUSTODY', custodian:'Copper',     lastUpdated:shrt() },
  'BlackRockSettlementVault': { type:'FI_SETTLEMENT',   fi:'BlackRock_x320',     balance:500_000_000, reserved:0, reservations:{}, status:'ACTIVE',          custodian:'Fireblocks', lastUpdated:shrt() },
  'Wintermute_SOL':     { type:'LP_LIQUIDITY', lp:'Wintermute_x400', chain:'SOL',     asset:'ETH',  balance:25000,      reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Wintermute_ETH':     { type:'LP_LIQUIDITY', lp:'Wintermute_x400', chain:'ETH',     asset:'ETH',  balance:30000,      reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Wintermute_ARB':     { type:'LP_LIQUIDITY', lp:'Wintermute_x400', chain:'ARB',     asset:'ETH',  balance:12000,      reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Galaxy_SOL':         { type:'LP_LIQUIDITY', lp:'Galaxy_x220',     chain:'SOL',     asset:'ETH',  balance:18000,      reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Galaxy_ARB':         { type:'LP_LIQUIDITY', lp:'Galaxy_x220',     chain:'ARB',     asset:'USDC', balance:15_000_000, reserved:0, reservations:{}, status:'ACTIVE', custodian:'Copper',     lastUpdated:shrt() },
  'Galaxy_BASE':        { type:'LP_LIQUIDITY', lp:'Galaxy_x220',     chain:'BASE',    asset:'USDC', balance:12_000_000, reserved:0, reservations:{}, status:'ACTIVE', custodian:'Copper',     lastUpdated:shrt() },
  'Cumberland_SOL':     { type:'LP_LIQUIDITY', lp:'Cumberland_x310', chain:'SOL',     asset:'ETH',  balance:15000,      reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Cumberland_ETH':     { type:'LP_LIQUIDITY', lp:'Cumberland_x310', chain:'ETH',     asset:'BTC',  balance:1200,       reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'Cumberland_POLYGON': { type:'LP_LIQUIDITY', lp:'Cumberland_x310', chain:'POLYGON', asset:'USDC', balance:8_000_000,  reserved:0, reservations:{}, status:'ACTIVE', custodian:'Copper',     lastUpdated:shrt() },
  'Amber_SOL':          { type:'LP_LIQUIDITY', lp:'Amber_x180',      chain:'SOL',     asset:'ETH',  balance:8000,       reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
  'TenetSettlementVault': { type:'TENET_SETTLEMENT', balance:0, reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() },
};

const FI_REGISTRY = {
  'GoldmanSachs_x800': { identity:'Goldman Sachs Asset Mgmt',  vault:'GoldmanSettlementVault',  settlementChain:'ETH', tier:3 },
  'JPMorgan_x240':     { identity:'JPMorgan Asset Management', vault:'JPMorganSettlementVault',  settlementChain:'ETH', tier:3 },
  'Fidelity_x510':     { identity:'Fidelity Investments',      vault:'FidelitySettlementVault',  settlementChain:'ETH', tier:2 },
  'BlackRock_x320':    { identity:'BlackRock Inc.',             vault:'BlackRockSettlementVault', settlementChain:'ETH', tier:3 },
};

const LP_REGISTRY = {
  'Wintermute_x400': { identity:'Wintermute Trading Ltd', settlementChain:'SOL', wallet:'Wintermute_SOL_Wallet' },
  'Galaxy_x220':     { identity:'Galaxy Digital',          settlementChain:'ETH', wallet:'Galaxy_ETH_Wallet'     },
  'Cumberland_x310': { identity:'Cumberland DRW',          settlementChain:'SOL', wallet:'Cumberland_SOL_Wallet' },
  'Amber_x180':      { identity:'Amber Group',             settlementChain:'ARB', wallet:'Amber_ARB_Wallet'      },
};

const LP_ROUTING = [
  { asset:'ETH',  chain:'SOL',     vault:'Wintermute_SOL',    lp:'Wintermute_x400', px:0.99981, tier:1 },
  { asset:'ETH',  chain:'SOL',     vault:'Galaxy_SOL',        lp:'Galaxy_x220',     px:0.99989, tier:1 },
  { asset:'ETH',  chain:'SOL',     vault:'Cumberland_SOL',    lp:'Cumberland_x310', px:0.99995, tier:1 },
  { asset:'ETH',  chain:'SOL',     vault:'Amber_SOL',         lp:'Amber_x180',      px:0.99962, tier:2 },
  { asset:'ETH',  chain:'ETH',     vault:'Wintermute_ETH',    lp:'Wintermute_x400', px:0.99975, tier:1 },
  { asset:'ETH',  chain:'ARB',     vault:'Wintermute_ARB',    lp:'Wintermute_x400', px:0.99988, tier:1 },
  { asset:'USDC', chain:'ARB',     vault:'Galaxy_ARB',        lp:'Galaxy_x220',     px:1.00000, tier:1 },
  { asset:'USDC', chain:'BASE',    vault:'Galaxy_BASE',       lp:'Galaxy_x220',     px:1.00000, tier:1 },
  { asset:'USDC', chain:'POLYGON', vault:'Cumberland_POLYGON',lp:'Cumberland_x310', px:1.00000, tier:1 },
  { asset:'BTC',  chain:'ETH',     vault:'Cumberland_ETH',    lp:'Cumberland_x310', px:0.99982, tier:1 },
];

// Spot prices — mock with jitter
// [INTEGRATION POINT] Replace with CryptoCompare / CoinGecko live feed
const SPOT = { ETH:3318.50, SOL:141.72, BTC:87432.00, USDC:1.00, WBTC:87180.00 };
const spot  = a => (SPOT[a?.toUpperCase()] ?? 1) * (1 + (Math.random() * 0.0018 - 0.0009));

const ORDER_STORE = {};

// ═══════════════════════════════════════════════════════════════════
// CLEARING LEDGER
// ═══════════════════════════════════════════════════════════════════
const LEDGER = {
  LIVE:{}, DELIVERING:{}, AWAITING_SETTLEMENT:{},
  COMPLETED:{}, FAILED:{}, INSUFFICIENT:{}, RECONCILIATION:{},
  events:{},
  totalVol:0, totalFees:0, totalFiReserved:0,

  writeEvent(orderId, src, msg, cls='') {
    if (!this.events[orderId]) this.events[orderId] = [];
    const event = { ts:shrt(), src, msg, cls };
    this.events[orderId].unshift(event);
    broadcast({ type:'order:event', data:{ orderId, event } });
    serverLog(src, msg, cls);
  },

  transition(order, newState) {
    const cur = order.status;
    if (this[cur]) delete this[cur][order.id];
    order.status  = newState;
    order.stateAt = shrt();
    if (!order.transitions) order.transitions = [];
    order.transitions.push({ state:newState, at:shrt() });
    if (this[newState]) this[newState][order.id] = order;
    broadcast({ type:'order:transition', data:{ orderId:order.id, from:cur, to:newState, order:safeOrder(order) } });
    broadcastStats();
  },

  count(p) { return Object.keys(this[p] || {}).length; },
  all(p)   { return Object.values(this[p] || {}); },
};

// ═══════════════════════════════════════════════════════════════════
// VAULT PROVIDER — mock implementation
// [FIREBLOCKS INTEGRATION POINT] — replace with FireblocksVaultProvider
// ═══════════════════════════════════════════════════════════════════
class MockVaultProvider {
  async checkBalance(vaultId) {
    const v = VAULT_REGISTRY[vaultId];
    if (!v) throw new Error('VAULT_NOT_FOUND:' + vaultId);
    await wait(rnd(600, 900));
    return v.balance - v.reserved;
  }
  async reserve(vaultId, amount, orderId) {
    const v = VAULT_REGISTRY[vaultId];
    if (!v) throw new Error('VAULT_NOT_FOUND:' + vaultId);
    await wait(rnd(800, 1200));
    const avail = v.balance - v.reserved;
    if (avail < amount) return { ok:false, available:avail };
    v.reserved += amount;
    v.reservations[orderId] = { amount, at:shrt() };
    v.lastUpdated = shrt();
    broadcast({ type:'vault:update', data:{ vaultId, vault:safeVault(vaultId) } });
    return { ok:true, available:v.balance - v.reserved };
  }
  async release(vaultId, orderId) {
    const v = VAULT_REGISTRY[vaultId];
    if (!v) return;
    await wait(rnd(500, 800));
    const r = v.reservations[orderId];
    if (!r) return;
    v.reserved = Math.max(0, v.reserved - r.amount);
    delete v.reservations[orderId];
    v.lastUpdated = shrt();
    broadcast({ type:'vault:update', data:{ vaultId, vault:safeVault(vaultId) } });
  }
  async cosignTransfer(fromVaultId, toVaultId, amount) {
    const v = VAULT_REGISTRY[fromVaultId];
    if (!v) throw new Error('VAULT_NOT_FOUND:' + fromVaultId);
    await wait(rnd(3000, 4500));      // demo: co-sign + on-chain transfer — stay on DELIVERING
    v.balance -= amount;
    v.lastUpdated = shrt();
    if (VAULT_REGISTRY[toVaultId]) {
      VAULT_REGISTRY[toVaultId].balance += amount;
      VAULT_REGISTRY[toVaultId].lastUpdated = shrt();
      broadcast({ type:'vault:update', data:{ vaultId:toVaultId, vault:safeVault(toVaultId) } });
    }
    broadcast({ type:'vault:update', data:{ vaultId:fromVaultId, vault:safeVault(fromVaultId) } });
    return txHash();
  }
}
const VaultProvider = new MockVaultProvider();

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  RESERVATION ENGINE  —  v1.0
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
class ReservationEngine {
  constructor() { this.name = 'RESV'; }
  _log(id, msg, cls='') { LEDGER.writeEvent(id, this.name, msg, cls); }

  async reserveFI(orderId, tenetAddress, amount, deadline) {
    const fi = FI_REGISTRY[tenetAddress];
    if (!fi) return { ok:false, reason:'FI_NOT_FOUND' };
    const vaultId = fi.vault;
    const vault   = VAULT_REGISTRY[vaultId];
    if (!vault) return { ok:false, reason:'VAULT_NOT_FOUND' };
    if (vault.status === 'PENDING_CUSTODY')
      return { ok:false, reason:'VAULT_PENDING_CUSTODY', msg:`${vaultId} not yet connected to custody` };
    this._log(orderId, `Gate 1 · reserving ${usd2(amount)} USDC from ${vaultId} · deadline ${deadline}s`);
    const res = await VaultProvider.reserve(vaultId, amount, orderId);
    if (!res.ok) {
      this._log(orderId, `INSUFFICIENT_BALANCE · available ${usd2(res.available)} · need ${usd2(amount)}`, 're');
      return { ok:false, reason:'INSUFFICIENT_BALANCE', msg:`vault has ${usd2(res.available)}, need ${usd2(amount)}` };
    }
    ORDER_STORE[orderId].fiReservation = { vaultId, amount, deadline, reservedAt:shrt(), status:'ACTIVE' };
    LEDGER.totalFiReserved += amount;
    this._log(orderId, `Gate 1 confirmed · ${usd2(res.available)} USDC remaining available in ${vaultId}`, 'bb');
    const timer = setTimeout(() => this._expireFI(orderId, vaultId), deadline * 1000);
    ORDER_STORE[orderId]._fiTimer = timer;
    return { ok:true };
  }

  async reserveLP(orderId, fills) {
    this._log(orderId, `Gate 2 · reserving LP inventory · ${fills.length} vault${fills.length>1?'s':''}`);
    const reserved = [];
    for (const f of fills) {
      const qty = f.qty ?? f.amount;  // Execution Engine uses qty
      const res = await VaultProvider.reserve(f.vault, qty, orderId);
      if (!res.ok) {
        for (const r of reserved) await VaultProvider.release(r.vault, orderId);
        this._log(orderId, `Gate 2 FAILED · ${f.vault} · rolling back ${reserved.length} reservation${reserved.length!==1?'s':''}`, 're');
        return { ok:false, reason:'LP_LIQUIDITY_UNAVAILABLE', msg:`reservation failed on ${f.vault}` };
      }
      reserved.push({ ...f, qty });
      this._log(orderId, `reserved ${num(qty,4)} ${ORDER_STORE[orderId]?.asset||''} on ${f.vault} · avail now ${num(res.available,4)}`);
    }
    ORDER_STORE[orderId].lpReservations = fills.map(f => ({ vaultId:f.vault, amount:f.qty??f.amount, reservedAt:shrt(), status:'ACTIVE' }));
    this._log(orderId, `Gate 2 confirmed · ${fills.length} vault${fills.length>1?'s':''} locked`, 'bb');
    return { ok:true };
  }

  async releaseAll(orderId) {
    const order = ORDER_STORE[orderId];
    if (!order) return;
    if (order._fiTimer) { clearTimeout(order._fiTimer); delete order._fiTimer; }
    if (order.fiReservation) {
      await VaultProvider.release(order.fiReservation.vaultId, orderId);
      LEDGER.totalFiReserved = Math.max(0, LEDGER.totalFiReserved - order.fiReservation.amount);
      order.fiReservation.status     = 'RELEASED';
      order.fiReservation.releasedAt = shrt();
      this._log(orderId, `FI reservation released · ${order.fiReservation.vaultId}`);
    }
    if (order.lpReservations) {
      for (const r of order.lpReservations) {
        await VaultProvider.release(r.vaultId, orderId);
        r.status     = 'RELEASED';
        r.releasedAt = shrt();
      }
      this._log(orderId, `LP reservations released · ${order.lpReservations.length} vault${order.lpReservations.length!==1?'s':''}`);
    }
  }

  _expireFI(orderId, vaultId) {
    const order = ORDER_STORE[orderId];
    if (!order || order.status === 'COMPLETED' || order.status === 'FAILED') return;
    this._log(orderId, `RESERVATION EXPIRED · ${vaultId} · CHAIN_TIMEOUT`, 're');
    if (order.fiReservation) order.fiReservation.status = 'STALE';
    // Signal ORCH timeout
    const o = ORDER_STORE[orderId];
    if (o) ORCH._fail(o, 'CHAIN_TIMEOUT', 'reservation deadline exceeded');
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  EXECUTION ENGINE  —  v1.0
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
class ExecutionEngine {
  constructor(vp) { this._vault = vp; this.name = 'EXEC'; }
  _log(id, msg, cls='') { LEDGER.writeEvent(id, this.name, msg, cls); }

  async findFills({ orderId, asset, usdcAmount, delivChain, slipBps, lockedQty }) {
    this._log(orderId, `price discovery · ${asset} on ${delivChain} · ${usd2(usdcAmount)} USDC · qty ${num(lockedQty,4)} · slip ≤${slipBps}bps`);
    const candidates = await this._filterCandidates(orderId, asset, delivChain, slipBps);
    if (!candidates.length) {
      const any = LP_ROUTING.filter(r => r.asset===asset.toUpperCase() && r.chain===delivChain.toUpperCase());
      if (!any.length) return this._fail(orderId, 'LP_LIQUIDITY_UNAVAILABLE', `no LP inventory for ${asset} on ${delivChain}`);
      const tightest = any.reduce((b,r) => r.px > b.px ? r : b, any[0]);
      return this._fail(orderId, 'SLIPPAGE_TOO_TIGHT', `market session cannot fill ${asset} on ${delivChain} within ${slipBps}bps. Tightest: ${((1-tightest.px)*10000).toFixed(1)}bps (${tightest.vault}). Widen tolerance or retry.`);
    }
    this._log(orderId, `candidates: ${candidates.length} · ` + candidates.map(c=>`${c.vault}(${num(c.avail,2)}@${((1-c.px)*10000).toFixed(1)}bps)`).join(' · '));
    const frontier = this._paretoEliminate(orderId, candidates);
    const ranked   = this._rankFrontier(orderId, frontier, lockedQty);
    const { fills, remaining } = this._greedyFill(orderId, ranked, lockedQty, asset);
    if (remaining > FILL_EPSILON) {
      const filled = this._tryResidual(orderId, candidates, frontier, fills, remaining, lockedQty, slipBps, asset);
      if (!filled) {
        const pct = ((lockedQty - remaining) / lockedQty * 100).toFixed(1);
        return this._fail(orderId, 'SLIPPAGE_TOO_TIGHT', `cannot fill ${asset} on ${delivChain} within ${slipBps}bps. Max fillable: ${num(lockedQty-remaining,4)} ${asset} (${pct}%). Widen tolerance or retry.`);
      }
    }
    const blendedSlipBps = this._calcBlendedSlip(fills, lockedQty);
    if (blendedSlipBps > slipBps + 0.1)
      return this._fail(orderId, 'SLIPPAGE_TOO_TIGHT', `blended ${blendedSlipBps.toFixed(2)}bps exceeds tolerance ${slipBps}bps`);
    const totalFilled = fills.reduce((s,f) => s+f.qty, 0);
    fills.forEach(f => { f.pctOfOrder = f.qty / totalFilled * 100; });
    this._log(orderId, `fill plan · ${fills.length} leg${fills.length!==1?'s':''} · blended ${blendedSlipBps.toFixed(2)}bps`, 'bright');
    return { ok:true, fills, blendedSlipBps, reason:null, msg:null };
  }

  async _filterCandidates(orderId, asset, delivChain, slipBps) {
    const assetUp = asset.toUpperCase(), chainUp = delivChain.toUpperCase(), maxSlip = slipBps / 10000;
    const routes = LP_ROUTING.filter(r => r.asset === assetUp && r.chain === chainUp);
    if (!routes.length) return [];
    const withBal = await Promise.all(routes.map(async r => {
      const vault = VAULT_REGISTRY[r.vault];
      if (!vault || vault.status !== 'ACTIVE') return null;
      try { const avail = await this._vault.checkBalance(r.vault); return { ...r, avail }; }
      catch { return null; }
    }));
    return withBal.filter(r => r !== null && r.avail > FILL_EPSILON && (1 - r.px) <= maxSlip);
  }

  _paretoEliminate(orderId, candidates) {
    const dominated = new Set();
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const ci = candidates[i], cj = candidates[j];
        if (cj.px >= ci.px && cj.avail >= ci.avail && (cj.px > ci.px || cj.avail > ci.avail))
          dominated.add(ci.vault);
      }
    }
    const frontier = candidates.filter(c => !dominated.has(c.vault));
    if (dominated.size > 0) this._log(orderId, `pareto: eliminated [${[...dominated].join(', ')}]`, 'dim');
    this._log(orderId, `pareto frontier: ${frontier.map(f=>f.vault).join(', ')}`);
    return frontier;
  }

  _rankFrontier(orderId, frontier, remaining) {
    const scored = frontier.map(lp => {
      const fillable = Math.min(lp.avail, remaining), residual = Math.max(0, remaining - lp.avail);
      return { ...lp, score:(lp.px * fillable + 1.0 * residual) / remaining };
    });
    scored.sort((a, b) => {
      if (Math.abs(a.score-b.score) > 1e-9) return b.score - a.score;
      if (Math.abs(a.avail-b.avail) > 1e-6) return b.avail - a.avail;
      if (chainTier(a.chain) !== chainTier(b.chain)) return chainTier(a.chain) - chainTier(b.chain);
      return a.vault < b.vault ? -1 : 1;
    });
    this._log(orderId, `ranked: ` + scored.map(s=>`${s.vault}(${s.score.toFixed(6)})`).join(' > '));
    return scored;
  }

  _greedyFill(orderId, ranked, lockedQty, asset) {
    let remaining = lockedQty; const fills = [];
    for (const lp of ranked) {
      if (remaining <= FILL_EPSILON) break;
      if (fills.length >= MAX_LEGS) break;
      const fillQty = Math.min(lp.avail, remaining);
      if (fillQty <= FILL_EPSILON) continue;
      fills.push({ vault:lp.vault, lp:lp.lp||lp.vault.split('_')[0], chain:lp.chain, qty:fillQty, px:lp.px, slipBps:parseFloat(((1-lp.px)*10000).toFixed(2)), pctOfOrder:0 });
      remaining -= fillQty;
      this._log(orderId, `  leg ${fills.length}: ${lp.vault}  ${num(fillQty,4)} ${asset}  @ ${lp.px}  (${((1-lp.px)*10000).toFixed(1)}bps)  rem: ${num(remaining,4)}`);
    }
    return { fills, remaining };
  }

  _tryResidual(orderId, candidates, frontier, fills, remaining, lockedQty, slipBps, asset) {
    if (remaining / lockedQty >= RESIDUAL_THRESHOLD) return false;
    if (fills.length >= MAX_LEGS) return false;
    const fv = new Set(frontier.map(f=>f.vault)), uv = new Set(fills.map(f=>f.vault));
    const elim = candidates.filter(c => !fv.has(c.vault) && !uv.has(c.vault) && c.avail >= remaining);
    if (!elim.length) return false;
    elim.sort((a,b) => b.px - a.px);
    const pick = elim[0];
    fills.push({ vault:pick.vault, lp:pick.lp||pick.vault.split('_')[0], chain:pick.chain, qty:remaining, px:pick.px, slipBps:parseFloat(((1-pick.px)*10000).toFixed(2)), pctOfOrder:0 });
    this._log(orderId, `  leg ${fills.length} (residual ${(remaining/lockedQty*100).toFixed(2)}%): ${pick.vault}  ${num(remaining,4)} ${asset} — eliminated LP, within tolerance`);
    return true;
  }

  _calcBlendedSlip(fills, lockedQty) {
    const totalQty   = fills.reduce((s,f) => s+f.qty, 0);
    const weightedPx = fills.reduce((s,f) => s + f.qty * f.px, 0) / totalQty;
    return parseFloat(((1 - weightedPx) * 10000).toFixed(4));
  }

  async beginDelivery(order, orch) {
    const isSplit = order.fills.length > 1;
    this._log(order.id, `delivery · ${isSplit?`SPLIT ${order.fills.length} legs via aggregation vault`:'single LP → destination'}`, isSplit?'or':'');
    try {
      if (!isSplit) {
        const f = order.fills[0];
        const tx = await this._retryWithBackoff(() => this._vault.cosignTransfer(f.vault, order.destWallet, f.qty), 3);
        order.execTx = tx;
        this._log(order.id, `${f.vault} → ${order.destWallet}  ${num(f.qty,4)} ${order.asset}  tx:${tx}`, 'success');
      } else {
        const aggId = `TenetAggregation_${order.id}`;
        VAULT_REGISTRY[aggId] = { type:'TENET_AGGREGATION', balance:0, reserved:0, reservations:{}, status:'ACTIVE', custodian:'Fireblocks', lastUpdated:shrt() };
        this._log(order.id, `aggregation vault created · ${aggId}`);
        await Promise.all(order.fills.map(async f => {
          const tx = await this._retryWithBackoff(() => this._vault.cosignTransfer(f.vault, aggId, f.qty), 3);
          VAULT_REGISTRY[aggId].balance += f.qty;
          this._log(order.id, `${f.vault} → ${aggId}  ${num(f.qty,4)} ${order.asset}  tx:${tx}`);
        }));
        const qty = VAULT_REGISTRY[aggId].balance;
        const delivTx = await this._retryWithBackoff(() => this._vault.cosignTransfer(aggId, order.destWallet, qty), 3);
        order.execTx = delivTx;
        this._log(order.id, `aggregation → ${order.destWallet}  ${num(qty,4)} ${order.asset}  tx:${delivTx}`, 'success');
        delete VAULT_REGISTRY[aggId];
        this._log(order.id, `aggregation vault closed · ${aggId}`);
      }
      orch._onDeliveryConfirmed(order.id);
    } catch(e) {
      this._log(order.id, `delivery FAILED · ${e.message}`, 're');
      orch._onDeliveryFailed(order.id, 'VAULT_CO-SIGN_FAILURE');
    }
  }

  async _retryWithBackoff(fn, maxRetries) {
    let delay = 500;
    for (let i = 1; i <= maxRetries; i++) {
      try { return await fn(); }
      catch(e) { if (i === maxRetries) throw e; await wait(delay); delay *= 2; }
    }
  }

  _fail(orderId, reason, msg) {
    this._log(orderId, `${reason} · ${msg}`, 're');
    return { ok:false, fills:[], blendedSlipBps:0, reason, msg };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  SETTLEMENT ENGINE  —  v1.0
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
class SettlementEngine {
  constructor(vp) { this._vault = vp; this.name = 'SETT'; }
  _log(id, msg, cls='') { LEDGER.writeEvent(id, this.name, msg, cls); }

  async extractSettlement(orderId, tenetAddress, settlementTotal, tenetFee, orch) {
    this._log(orderId, `Moment 1 · extract ${usd2(settlementTotal)} from ${tenetAddress} (fee ${usd2(tenetFee)})`);
    const fi = FI_REGISTRY[tenetAddress];
    if (!fi) { orch._onSettlementFailed(orderId, 'FI_NOT_FOUND'); return; }
    const vaultId = fi.vault;
    const vault   = VAULT_REGISTRY[vaultId];
    if (!vault) { orch._onSettlementFailed(orderId, 'VAULT_NOT_FOUND'); return; }
    if (vault.status === 'PENDING_CUSTODY') { orch._onSettlementFailed(orderId, 'VAULT_PENDING_CUSTODY'); return; }
    this._log(orderId, `co-signing · ${vaultId} → TenetSettlementVault · ${usd2(settlementTotal)} USDC`);
    try {
      const tx = await this._retryWithBackoff(() => this._vault.cosignTransfer(vaultId, 'TenetSettlementVault', settlementTotal), 3);
      if (ORDER_STORE[orderId]) ORDER_STORE[orderId].settlExtractTx = tx;
      this._log(orderId, `extraction confirmed · tx:${tx} · TenetSettlementVault +${usd2(settlementTotal)}`, 'success');
      orch._onSettlementExtracted(orderId);
    } catch(e) {
      this._log(orderId, `VAULT_CO-SIGN_FAILURE · ${e.message}`, 're');
      orch._onSettlementFailed(orderId, 'VAULT_CO-SIGN_FAILURE');
    }
  }

  async routeLPPayout(orderId, payouts, method, orch) {
    const totalNet = payouts.reduce((s,p) => s+p.amount, 0);
    this._log(orderId, `Moment 2 · LP payout · ${payouts.length} LP${payouts.length!==1?'s':''} · ${usd2(totalNet)} net · ${method}`);
    this._log(orderId, `Tenet fee retained in TenetSettlementVault`);
    let allConfirmed = true;
    for (const payout of payouts) {
      const lp = LP_REGISTRY[payout.tenetAddress];
      if (!lp) { this._log(orderId, `LP_NOT_FOUND · ${payout.tenetAddress}`, 're'); allConfirmed = false; continue; }
      this._log(orderId, `routing · ${payout.tenetAddress} · ${usd2(payout.amount)} USDC · ${lp.settlementChain} · ${method}`);
      try {
        let tx;
        switch(method) {
          case 'DIRECT':
            tx = await this._retryWithBackoff(() => this._vault.cosignTransfer('TenetSettlementVault', lp.wallet, payout.amount), 3);
            this._log(orderId, `DIRECT confirmed · ${lp.wallet} · ${usd2(payout.amount)} USDC · tx:${tx}`, 'success');
            break;
          case 'CCTP':
            // [CCTP INTEGRATION POINT] — Circle SDK
            tx = await this._mockCCTP(orderId, lp, payout.amount);
            this._log(orderId, `CCTP confirmed · ${lp.wallet} on ${lp.settlementChain} · tx:${tx}`, 'success');
            break;
          case 'EVERCLEAR':
            // [EVERCLEAR INTEGRATION POINT]
            tx = await this._mockEverclear(orderId, lp, payout.amount);
            this._log(orderId, `Everclear confirmed · ${lp.wallet} on ${lp.settlementChain} · tx:${tx}`, 'success');
            break;
          default: throw new Error(`UNKNOWN_METHOD:${method}`);
        }
        if (ORDER_STORE[orderId]) ORDER_STORE[orderId].settlTx = tx;
      } catch(e) {
        this._log(orderId, `SETTLEMENT_ROUTING_FAILURE · ${payout.tenetAddress} · funds in TenetSettlementVault — never lost`, 're');
        allConfirmed = false;
      }
    }
    if (allConfirmed) {
      this._log(orderId, `all LP payouts confirmed · native chain settlement guaranteed`, 'success');
      orch._onLPPayoutConfirmed(orderId);
    } else {
      orch._onSettlementFailed(orderId, 'SETTLEMENT_ROUTING_FAILURE');
    }
  }

  async _mockCCTP(orderId, lp, amount) {
    this._log(orderId, `CCTP · burning ${usd2(amount)} USDC…`);          await wait(rnd(3000, 4000));
    this._log(orderId, `CCTP · awaiting Circle attestation…`, 'dim');    await wait(rnd(4000, 5000));
    this._log(orderId, `CCTP · minting on ${lp.settlementChain}…`);      await wait(rnd(3000, 4000));
    return txHash();
  }

  async _mockEverclear(orderId, lp, amount) {
    this._log(orderId, `Everclear · posting transfer intent…`);          await wait(rnd(1500, 2500));
    this._log(orderId, `Everclear · clearing in progress…`, 'dim');      await wait(rnd(2500, 4000));
    this._log(orderId, `Everclear · delivery confirmed on ${lp.settlementChain}`); await wait(rnd(1000, 1500));
    return txHash();
  }

  async _retryWithBackoff(fn, maxRetries) {
    let delay = 500;
    for (let i = 1; i <= maxRetries; i++) {
      try { return await fn(); }
      catch(e) { if (i === maxRetries) throw e; await wait(delay); delay *= 2; }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  ORCHESTRATION ENGINE  —  v1.1
//  The conductor. Owns the Reservation Engine.
//  Only component that writes to the Clearing Ledger.
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
class OrchestrationEngine {
  constructor() {
    this.name = 'ORCH';
    this.resv = new ReservationEngine();
    this.exec = new ExecutionEngine(VaultProvider);
    this.sett = new SettlementEngine(VaultProvider);
  }

  _log(id, msg, cls='') { LEDGER.writeEvent(id, this.name, msg, cls); }

  async submitIntent(intent) {
    const { tenetAddress, asset, usdcAmount, delivChain, settlChain, settlAsset='USDC', slipBps=50, intent:iType='buy', deadline:fiDeadline=0 } = intent;
    const fi = FI_REGISTRY[tenetAddress];
    if (!fi) return { error:'UNKNOWN_FI', msg:`${tenetAddress} not registered` };

    const orderId    = nextId();
    const fee        = usdcAmount * 0.001;
    const total      = usdcAmount + fee;
    const destWallet = `${tenetAddress.split('_')[0]}Wallet_${delivChain}`;
    const deadline   = deriveDeadline(delivChain, settlChain, fiDeadline);

    const order = {
      id:orderId, status:'PENDING', intent:iType,
      tenetAddress, fi:fi.identity,
      asset:asset.toUpperCase(), usdcAmount, fee, total,
      delivChain:delivChain.toUpperCase(), settlChain:settlChain.toUpperCase(), settlAsset:settlAsset.toUpperCase(),
      destWallet, slipBps, deadline,
      fills:[], assetQty:null, effSlipBps:null,
      execTx:null, settlExtractTx:null, settlTx:null,
      fiReservation:null, lpReservations:null,
      transitions:[], stateAt:shrt(), _fiTimer:null,
    };
    ORDER_STORE[orderId] = order;

    this._log(orderId, `intent received · ${iType.toUpperCase()} ${usd2(usdcAmount)} USDC of ${asset} on ${delivChain} · slip ${slipBps}bps · deadline ${deadline}s`, 'bb');

    // Gate 1
    const fiResv = await this.resv.reserveFI(orderId, tenetAddress, total, deadline);
    if (!fiResv.ok) {
      if (fiResv.reason === 'INSUFFICIENT_BALANCE') {
        order.failReason = fiResv.reason;
        order.failDetail = fiResv.msg || '';
        LEDGER.transition(order, 'INSUFFICIENT');
        this._log(orderId, `INSUFFICIENT_BALANCE · ${fiResv.msg}`, 're');
      } else {
        this._fail(order, fiResv.reason, fiResv.msg || '');
      }
      return { error:fiResv.reason, msg:fiResv.msg, orderId };
    }

    // Order is immediately LIVE
    LEDGER.transition(order, 'LIVE');
    this._log(orderId, `ORDER LIVE · FI vault reserved · Execution Engine searching for fills`, 'bb');
    broadcastStats();

    // Spot determines quantity
    const assetSpot = spot(asset);
    const lockedQty = usdcAmount / assetSpot;
    order.assetQty  = lockedQty;
    this._log(orderId, `spot ${usd2(assetSpot)} / ${asset} · qty locked at ${num(lockedQty,6)} ${asset}`);

    // Execution Engine finds fill plan (while order is LIVE)
    const plan = await this.exec.findFills({ orderId, asset, usdcAmount, delivChain, slipBps, lockedQty });
    if (!plan.ok) {
      await this.resv.releaseAll(orderId);
      this._fail(order, plan.reason, plan.msg);
      return { error:plan.reason, msg:plan.msg, orderId };
    }
    order.fills      = plan.fills;
    order.effSlipBps = plan.blendedSlipBps;

    // Gate 2
    const lpResv = await this.resv.reserveLP(orderId, plan.fills);
    if (!lpResv.ok) {
      await this.resv.releaseAll(orderId);
      this._fail(order, lpResv.reason, lpResv.msg || '');
      return { error:lpResv.reason, msg:lpResv.msg, orderId };
    }

    // LIVE → DELIVERING
    // Demo: hold on LIVE — finish your sentence, switch tabs, point at Ledger
    await wait(rnd(10000, 12000));
    LEDGER.transition(order, 'DELIVERING');
    this._log(orderId, `DELIVERING · delivery + extraction firing simultaneously`, 'or');

    // Orchestrated atomicity
    Promise.all([
      this.exec.beginDelivery(order, this),
      this.sett.extractSettlement(orderId, tenetAddress, total, fee, this),
    ]);

    return { ok:true, orderId };
  }

  _onDeliveryConfirmed(orderId) {
    const o = ORDER_STORE[orderId];
    if (!o || o.status === 'FAILED') return;
    this._log(orderId, `delivery confirmed  execTx:${o.execTx}`, 'gr');
    this._checkBothLegs(orderId);
  }

  _onDeliveryFailed(orderId, reason) {
    const o = ORDER_STORE[orderId];
    if (o) this._fail(o, reason, 'delivery failed');
  }

  _onSettlementExtracted(orderId) {
    const o = ORDER_STORE[orderId];
    if (!o || o.status === 'FAILED') return;
    this._log(orderId, `extraction confirmed  extractTx:${o.settlExtractTx}`, 'gr');
    this._checkBothLegs(orderId);
  }

  _onSettlementFailed(orderId, reason) {
    const o = ORDER_STORE[orderId];
    if (o) this._fail(o, reason, 'settlement engine reported failure');
  }

  _checkBothLegs(orderId) {
    const o = ORDER_STORE[orderId];
    if (!o || o.status === 'FAILED') return;
    if (o.execTx && o.settlExtractTx) {
      LEDGER.transition(o, 'AWAITING_SETTLEMENT');
      this._log(orderId, `AWAITING_SETTLEMENT · FI delivery complete · ORCH making routing decision`, 'bb');
      // Demo: hold on AWAITING_SETTLEMENT so viewer can read it before LP payout fires
      // Demo: hold on AWAITING SETTLEMENT — narrate it, then LP payout fires
      setTimeout(() => this._routeLPPayout(orderId), rnd(10000, 12000));
    }
  }

  _routeLPPayout(orderId) {
    const o = ORDER_STORE[orderId];
    if (!o) return;
    let method = 'DIRECT';
    const lpChains = [...new Set(o.fills.map(f => { const lp = LP_REGISTRY[f.lp]; return lp ? lp.settlementChain : o.delivChain; }))];
    const allSameChain = lpChains.every(c => c === o.settlChain);
    if (!allSameChain) method = o.settlAsset === 'USDC' ? 'CCTP' : 'EVERCLEAR';
    this._log(orderId, `routing decision · ${method} · settlAsset:${o.settlAsset} · LP chains:[${lpChains.join(',')}]`, 'bb');
    const totalQty = o.fills.reduce((s,f) => s+f.qty, 0);
    const netToLP  = o.usdcAmount - o.fee;
    const byLP     = {};
    o.fills.forEach(f => { if (!byLP[f.lp]) byLP[f.lp]={tenetAddress:f.lp,qty:0}; byLP[f.lp].qty+=f.qty; });
    const payouts  = Object.values(byLP).map(lp => ({ tenetAddress:lp.tenetAddress, amount:netToLP*(lp.qty/totalQty) }));
    payouts.forEach(p => this._log(orderId, `LP share · ${p.tenetAddress} · ${usd2(p.amount)} USDC (${(p.amount/netToLP*100).toFixed(1)}%)`));
    this.sett.routeLPPayout(orderId, payouts, method, this);
  }

  _onLPPayoutConfirmed(orderId) {
    const o = ORDER_STORE[orderId];
    if (!o) return;
    this.resv.releaseAll(orderId);
    LEDGER.transition(o, 'COMPLETED');
    this._log(orderId, `COMPLETED · LP settled on native chain  settlTx:${o.settlTx}`, 'gr');
    LEDGER.totalVol  += o.usdcAmount;
    LEDGER.totalFees += o.fee;
    broadcastStats();
  }

  _fail(order, reason, detail='') {
    order.failReason = reason;
    order.failDetail = detail;
    this.resv.releaseAll(order.id);
    LEDGER.transition(order, 'FAILED');
    this._log(order.id, `FAILED · ${reason}${detail?' — '+detail:''}`, 're');
  }
}

// Singleton
const ORCH = new OrchestrationEngine();

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ port:PORT });
const clients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

function broadcastStats() {
  broadcast({
    type: 'stats:update',
    data: {
      live:        LEDGER.count('LIVE'),
      delivering:  LEDGER.count('DELIVERING'),
      awaiting:    LEDGER.count('AWAITING_SETTLEMENT'),
      completed:   LEDGER.count('COMPLETED'),
      failed:      LEDGER.count('FAILED'),
      insufficient:LEDGER.count('INSUFFICIENT'),
      fiReserved:  LEDGER.totalFiReserved,
      vol:         LEDGER.totalVol,
      fees:        LEDGER.totalFees,
    },
  });
}

// Sanitise order for JSON — remove circular refs and timers
function safeOrder(order) {
  const { _fiTimer, ...safe } = order;
  return safe;
}

function safeVault(vaultId) {
  const v = VAULT_REGISTRY[vaultId];
  if (!v) return null;
  return {
    type:        v.type,
    balance:     v.balance,
    reserved:    v.reserved,
    status:      v.status,
    custodian:   v.custodian,
    lastUpdated: v.lastUpdated,
    chain:       v.chain,
    asset:       v.asset,
    lp:          v.lp,
    fi:          v.fi,
  };
}

function buildFullState() {
  const orders = {};
  ['LIVE','DELIVERING','AWAITING_SETTLEMENT','COMPLETED','FAILED','INSUFFICIENT','RECONCILIATION'].forEach(p => {
    LEDGER.all(p).forEach(o => { orders[o.id] = safeOrder(o); });
  });
  const vaults = {};
  Object.keys(VAULT_REGISTRY).forEach(id => { vaults[id] = safeVault(id); });
  const events = {};
  Object.keys(LEDGER.events).forEach(id => { events[id] = LEDGER.events[id]; });
  return {
    orders, vaults, events,
    stats: {
      live:        LEDGER.count('LIVE'),
      delivering:  LEDGER.count('DELIVERING'),
      awaiting:    LEDGER.count('AWAITING_SETTLEMENT'),
      completed:   LEDGER.count('COMPLETED'),
      failed:      LEDGER.count('FAILED'),
      insufficient:LEDGER.count('INSUFFICIENT'),
      fiReserved:  LEDGER.totalFiReserved,
      vol:         LEDGER.totalVol,
      fees:        LEDGER.totalFees,
    },
    registries: {
      fi: FI_REGISTRY,
      lp: LP_REGISTRY,
      lpRouting: LP_ROUTING,
    },
  };
}

wss.on('connection', (ws, req) => {
  const clientId = `client_${Date.now()}`;
  clients.add(ws);
  console.log(`[${shrt()}] client connected · ${clientId} · total: ${clients.size}`);

  // Send full state snapshot immediately on connection
  ws.send(JSON.stringify({ type:'state:full', data:buildFullState() }));

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { ws.send(JSON.stringify({ type:'error', data:{ msg:'invalid JSON' } })); return; }

    switch(msg.type) {

      case 'intent:submit': {
        const intent = msg.data;
        console.log(`[${shrt()}] intent:submit · ${intent.tenetAddress} · ${intent.asset} · $${intent.usdcAmount}`);
        const result = await ORCH.submitIntent(intent);
        if (result.ok) {
          ws.send(JSON.stringify({ type:'intent:accepted', data:{ orderId:result.orderId } }));
        } else {
          ws.send(JSON.stringify({ type:'intent:rejected', data:{ reason:result.error, msg:result.msg, orderId:result.orderId } }));
        }
        break;
      }

      // [PORTAL WIRING POINT]
      // When FI portal completes registration it sends:
      //   { type: 'fi:register', data: { tenetAddress, identity, vault, settlementChain, tier } }
      case 'fi:register': {
        const { tenetAddress, identity, vault, settlementChain, tier, custodian } = msg.data;
        FI_REGISTRY[tenetAddress] = { identity, vault, settlementChain, tier: tier||2 };
        VAULT_REGISTRY[vault]     = { type:'FI_SETTLEMENT', fi:tenetAddress, balance:0, reserved:0, reservations:{}, status:'ACTIVE', custodian:custodian||'Fireblocks', lastUpdated:shrt() };
        broadcast({ type:'fi:registered', data:{ tenetAddress, identity, vault } });
        broadcast({ type:'vault:update', data:{ vaultId:vault, vault:safeVault(vault) } });
        console.log(`[${shrt()}] FI registered · ${tenetAddress} · ${identity}`);
        ws.send(JSON.stringify({ type:'fi:register:ok', data:{ tenetAddress } }));
        break;
      }

      // [PORTAL WIRING POINT]
      // When LP portal completes registration it sends:
      //   { type: 'lp:register', data: { tenetAddress, identity, settlementChain, wallet, vaults:[{vaultId, chain, asset, custodian}] } }
      case 'lp:register': {
        const { tenetAddress, identity, settlementChain, wallet, vaults:lpVaults } = msg.data;
        LP_REGISTRY[tenetAddress] = { identity, settlementChain, wallet };
        if (lpVaults) {
          lpVaults.forEach(v => {
            VAULT_REGISTRY[v.vaultId] = { type:'LP_LIQUIDITY', lp:tenetAddress, chain:v.chain, asset:v.asset, balance:v.balance||0, reserved:0, reservations:{}, status:'ACTIVE', custodian:v.custodian||'Fireblocks', lastUpdated:shrt() };
            // Add to routing table
            if (v.px) {
              LP_ROUTING.push({ asset:v.asset, chain:v.chain, vault:v.vaultId, lp:tenetAddress, px:v.px, tier:v.tier||2 });
            }
            broadcast({ type:'vault:update', data:{ vaultId:v.vaultId, vault:safeVault(v.vaultId) } });
          });
        }
        broadcast({ type:'lp:registered', data:{ tenetAddress, identity } });
        console.log(`[${shrt()}] LP registered · ${tenetAddress} · ${identity}`);
        ws.send(JSON.stringify({ type:'lp:register:ok', data:{ tenetAddress } }));
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type:'pong', data:{ ts:shrt() } }));
        break;

      default:
        ws.send(JSON.stringify({ type:'error', data:{ msg:`unknown message type: ${msg.type}` } }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[${shrt()}] client disconnected · total: ${clients.size}`);
  });

  ws.on('error', err => {
    console.error(`[${shrt()}] client error · ${err.message}`);
    clients.delete(ws);
  });
});

// ── SERVER LOG ────────────────────────────────────────────────────
function serverLog(src, msg, cls='') {
  const tag = src === 'ORCH' ? '\x1b[36m' : src === 'EXEC' ? '\x1b[32m' : src === 'RESV' ? '\x1b[33m' : '\x1b[35m';
  const reset = '\x1b[0m';
  console.log(`[${shrt()}] ${tag}${src}${reset} ${msg}`);
}

// ── STARTUP ───────────────────────────────────────────────────────
console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║  TENET SYSTEMS — Orchestration Engine Server    ║`);
console.log(`║  v1.1 · WebSocket · Port ${PORT}                   ║`);
console.log(`╚══════════════════════════════════════════════════╝\n`);
console.log(`  Engines:    ORCH · RESV · EXEC · SETT`);
console.log(`  FI vaults:  ${Object.keys(FI_REGISTRY).length} registered`);
console.log(`  LP vaults:  ${Object.values(VAULT_REGISTRY).filter(v=>v.type==='LP_LIQUIDITY').length} registered`);
console.log(`  LP routes:  ${LP_ROUTING.length} entries\n`);
console.log(`  WebSocket:  ws://localhost:${PORT}`);
console.log(`  Ledger:     open tenet-ledger-client.html in browser\n`);
console.log(`  Waiting for connections...\n`);
