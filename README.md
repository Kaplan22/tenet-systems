# TENET SYSTEMS

**Settlement & Liquidity Orchestration for Institutional Digital Assets**

> *Tenet lets financial institutions trade and settle digital assets automatically from one pool of cash.*

---

## The Problem

Institutional digital asset markets are missing their settlement layer.

Financial institutions entering digital assets must pre-fund separate accounts on every blockchain they operate on. Capital sits locked and idle across multiple positions — none of which can cover the others. There is no delivery-versus-payment infrastructure. No chain-agnostic clearing layer. No equivalent of what DTCC does for traditional markets.

Four structural problems compound each other:

- **Capital inefficiency** — dead capital across every chain an institution operates on
- **No settlement infrastructure** — no institutional-grade DvP for digital assets
- **Operational complexity** — fragmented LP relationships, bridge risk, chain-by-chain management
- **Fragmented liquidity** — no unified routing layer, no best-execution logic across LPs

## The Solution

One intent. One pool of cash. Any asset. Any chain.

Tenet receives a structured trade intent from a financial institution and handles everything that follows — price discovery across a network of institutional liquidity providers, asset delivery to the FI's destination wallet, simultaneous settlement extraction from the FI's pre-funded vault, and LP payout routed to their native chain automatically.

FIs never interact with LPs. LPs never interact with FIs. Tenet is the only counterparty either side ever sees.

---

## Architecture

Tenet's internal architecture consists of four engines coordinated by a proprietary Clearing Ledger.

```
INTENT ARRIVES AT ORCH
│
├─▶ Reservation Engine — Gate 1
│     FI vault balance locked before LP routing begins
│     INSUFFICIENT_BALANCE → order declined (not FAILED)
│
├─▶ ORDER IS IMMEDIATELY LIVE
│
├─▶ Execution Engine — findFills()
│     Spot price determines quantity
│     Pareto elimination → blended cost ranking → fill plan (max 5 legs)
│
├─▶ Reservation Engine — Gate 2
│     LP inventory locked at current spot price
│
├─▶ LIVE → DELIVERING
│     Promise.all([
│       ExecutionEngine.beginDelivery(),     ← asset → FI wallet
│       SettlementEngine.extractSettlement() ← USDC → Tenet vault
│     ])
│     Orchestrated atomicity. No settlement gap.
│
├─▶ AWAITING SETTLEMENT
│     ORCH decides routing: DIRECT / CCTP / EVERCLEAR
│     Settlement Engine executes instruction
│
└─▶ COMPLETED
      All LP reservations released
      Order immutable in Clearing Ledger
```

### The Four Engines

| Engine | Responsibility |
|--------|---------------|
| **Orchestration Engine** | The conductor. Coordinates all engines. Only component that writes to the Clearing Ledger. |
| **Reservation Engine** | Sub-component of ORCH. Dual-gate vault reservation. Eliminates race conditions on concurrent orders. |
| **Execution Engine** | Price discovery, Pareto elimination, fill plan construction, asset delivery. |
| **Settlement Engine** | FI vault extraction, LP payout routing via CCTP, Everclear, or direct transfer. |

### Key Design Principles

- **Engines are stateless** — no engine holds state between calls. Scales horizontally.
- **Only ORCH writes to the Ledger** — single writer, always consistent.
- **Engines never talk to each other** — only upward to ORCH via callbacks.
- **Vault balances are Tenet-internal** — actual custody balance minus active reservations. No on-chain locking required.
- **INSUFFICIENT_BALANCE ≠ FAILED** — pre-execution check vs execution failure. Two different states.

---

## Vault Architecture

Four structurally distinct vault types. No assets flow outside this structure.

| Vault | Owner | Purpose |
|-------|-------|---------|
| FI Settlement Vault | FI + Tenet (2-of-2 multisig) | FI pre-funds once. Tenet reserves and extracts on execution. |
| LP Liquidity Vault | LP + Tenet (2-of-2 multisig) | LP pre-positions assets per chain. Tenet co-signs transfers on order execution. |
| Aggregation Vault | Tenet (ephemeral) | Temporary clearing account for multi-LP orders. Created and destroyed per order. |
| Tenet Settlement Vault | Tenet (sole) | Receives extraction. Routes LP payout. Tenet fee accumulates here. |

---

## Fee Structure

| Order Size | Tenet Fee |
|------------|-----------|
| Up to $10M | 10 basis points |
| $10M — $100M | 7 basis points |
| $100M — $250M | 5 basis points |
| $250M+ | Negotiated |
| Tokenized RWAs (all sizes) | 0.5 basis points flat |

At $1B daily volume — blended annual revenue approximately $200M.

---

## What Is Built

```
tenet-server/
  server.js              ← All four engines + WebSocket server (Node.js)
  package.json
  Dockerfile

tenet-cli.html           ← FI intent submission CLI (browser)
tenet-ledger-client.html ← Real-time Clearing Ledger (browser, connects to server)
tenet-engine-ledger.html ← Unified standalone demo (all engines + ledger, no server needed)
tenet-execution-engine.html ← Execution Engine standalone module
tenet-settlement-engine.html ← Settlement Engine standalone module
```

### Technical Stack

- **Backend** — Node.js + TypeScript
- **Transport** — WebSocket (gRPC planned for production)
- **Custody** — Fireblocks + Copper (VaultProvider abstract interface — mock today, real SDK connects without changing engine logic)
- **USDC Settlement** — Circle CCTP
- **Non-USDC Settlement** — Everclear
- **Price Discovery** — CryptoCompare (primary) + CoinGecko (fallback)
- **Infrastructure** — Docker

---

## Running the Demo

**Start the engine server:**
```bash
cd tenet-server
npm install
node server.js
```

**Open in browser:**
- `tenet-ledger-client.html` — connect to `ws://localhost:8080`, Clearing Ledger goes live
- `tenet-cli.html` — submit intents, watch lifecycle animate in real time

**Submit your first intent:**
```
buy ETH 500000 USDC SOL ETH
```

**Multi-LP split order:**
```
buy ETH 50000000 USDC SOL ETH
```

Watch the LP RESERVATIONS sheet — three vaults lock simultaneously. Watch DELIVERING — assets route through the Aggregation Vault. Watch COMPLETED.

---

## Supported Intent Types

| Intent | Description |
|--------|-------------|
| `buy` | Spend USDC, receive asset on delivery chain |
| `sell` | Sell asset, receive USDC on settlement chain |
| `swap` | Exchange one asset for another across chains |
| `convert` | Fiat → USDC onramp via Circle |
| `schedule` | Batch schedule mode — multiple intents at a specified time |

---

## Documentation

| Document | Description |
|----------|-------------|
| `TenetSystems_Whitepaper_v1.2.docx` | External technical architecture whitepaper |
| `TenetSystems_ArchitectureWhitepaper_v1.0.docx` | Internal architecture reference — how the system actually works |
| `TenetSystems_ExecutionEngine_Spec_v1.docx` | Execution Engine full specification |
| `TenetSystems_SettlementEngine_Spec_v1.docx` | Settlement Engine full specification |

---

## Live Demo

[Watch the 4-minute demo](https://www.loom.com/share/5677deba044f41c682e74c302903bc47)

---

## Status

Pre-seed. Pre-incorporation. Currently onboarding FI design partners and LP relationships.

**Inbox is open:** amosu2019tom@gmail.com

---

*TENET SYSTEMS · Pre-Seed 2026 · Confidential*
