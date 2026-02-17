# Kinetix Agent - Development Roadmap

## 📊 Current Status (Last Updated: 2026-02-17)

### Canonical Identity & Wallets

**Signing / Identity Wallet:** `0x821a61d2C3E02446eD03285df1618639eF25D2b9`
- Kinetix's on-chain controller address (ERC-8004 Token 16892)
- Signs all attestation receipts (`issuer.pubkey` in every receipt)
- Set via `KINETIX_SIGNING_KEY` env var on both Railway deployments
- **Must never change** — all on-chain registrations and issued receipts reference this address

**Payment / CDP Wallet:** `0xD203776d8279cfcA540473a0AB6197D53c96cbaf`
- Receives USDC payments from x402 verification services
- Used for on-chain transactions (AgentKit CDP)
- Set via `WALLET_DATA={"address":"0xD203776d..."}` env var on both Railway deployments
- Monitor: https://basescan.org/address/0xD203776d8279cfcA540473a0AB6197D53c96cbaf

### Railway Deployments (Both Persistent)

| Service | URL | Entry Point |
|---------|-----|-------------|
| x402 verification server | https://kinetix-production-1a28.up.railway.app | `scripts/start-x402-server.js` |
| Telegram bot | (Railway internal) | `telegram-bot/index.js` |

**Railway env vars required on both services:**
- `WALLET_DATA={"address":"0xD203776d8279cfcA540473a0AB6197D53c96cbaf"}` — prevents new wallet creation on each deploy
- `KINETIX_SIGNING_KEY=<private key>` — ensures `0x821a...` is always the attestation signer
- `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` — CDP credentials

**ERC-8004 Identity:**
- Token ID: **16892** (Base Mainnet)
- Contract: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Profile: https://8004scan.io/agents/base/16892
- Status: ✅ Registered, 0 validation warnings, enhanced metadata deployed

**Current Phase:** x402 Verification Service live + Phase 2 autonomous operations

**Phase 1 Complete ✅**
Core infrastructure, social integrations, wallet, and safety systems operational:
- ✅ Dual-platform social presence (Moltbook + Clawstr/Nostr)
- ✅ Telegram admin interface with approval workflows
- ✅ CDP EVM wallet integration with multi-asset support
- ✅ Production-ready safety controller with spending limits
- ✅ Autonomous posting with human-in-the-loop approval
- ✅ ERC-8004 identity registration on Base Mainnet (Token ID 16892)
- ✅ Enhanced ERC-8004 metadata with registrations and services fields

**Phase 2 Planning Complete 🎯**
Autonomous revenue and self-sustaining operations roadmap:
- 📋 x402 micropayment protocol integration (Weeks 4-5)
- 📋 Autonomous trading & rebalancing (Weeks 6-7)
- 📋 Dual payment model: USDC + $KINETIX with 50% discount (Weeks 8-9)
- 📋 Uniswap V3 trading fee automation (Weeks 10-11)
- 📋 Full autonomous operations launch (Week 12)

**Immediate Next Steps (This Week):**
1. ✅ Complete Clawstr self-verification (Day 3 tomorrow)
2. ✅ Run `complete-clawstr-verification.js` to issue first attestation
3. ✅ Submit first attestation to ERC-8004 Reputation Registry
4. 📋 Begin x402 infrastructure setup (Phase 2 Week 4)

## Project Initialization ✅
- [x] Set up npm project
- [x] Install core dependencies
- [x] Create directory structure
- [x] Create configuration files
- [x] Create documentation

## Core Infrastructure ✅
- [x] Implement Claude API wrapper (@anthropic-ai/sdk)
- [x] Create agent configuration loader (config/agent.json, personality.json)
- [x] Set up environment variable management (dotenv, .env.example)
- [x] Implement logging system (console logging with timestamps)
- [x] Create state management system (utils/state-manager.js)
- [x] Build heartbeat monitoring (utils/heartbeat.js)

## Moltbook Integration ✅
- [x] Research Moltbook API endpoints
- [x] Implement authentication
- [x] Create posting functionality (utils/moltbook-api.js)
- [x] Implement feed reading (getFeed, getHeartbeatFeed)
- [x] Add interaction capabilities (upvote, downvote, comment, share)
- [x] Build content generation system (utils/post-generator.js)
- [x] Create NLP processing (utils/nlp-moltbook.js)
- [x] Implement engagement tracking

## Clawstr Integration ✅
- [x] Implement Nostr protocol integration
- [x] Create identity management (nostr keypairs)
- [x] Build posting functionality (utils/clawstr-api.js)
- [x] Add reaction capabilities (like, repost)
- [x] Create subclaw management
- [x] Implement NLP processing (utils/nlp-clawstr.js)
- [x] Build engagement tracking for Nostr events

## Telegram Bot ✅
- [x] Set up Telegraf bot framework (telegram-bot/)
- [x] Create admin authentication
- [x] Implement approval queue interface (/pending command)
- [x] Add posting approval workflow (/approve, /reject)
- [x] Build status monitoring commands (/status, /health)
- [x] Create heartbeat testing (/test_heartbeat)
- [x] Implement force posting (/force)

## Wallet Integration (CDP AgentKit) ✅
- [x] Set up Coinbase AgentKit for Base chain
- [x] Implement CDP wallet creation (wallet/agentkit.js)
- [x] Add wallet persistence via `WALLET_DATA` env var (Railway-safe; falls back to wallet-data/wallet.json locally)
- [x] Fix: pass `config.address` to `configureWithWallet()` so existing wallet is restored, not recreated
- [x] Create balance checking (ETH, USDC)
- [x] Build wallet export functionality (`/export_wallet` Telegram command)
- [x] Create integration examples and tests

## Safety Controller ✅
- [x] Design multi-asset safety system
- [x] Create safety-limits.json configuration
- [x] Implement SafetyController class (wallet/safety-controller.js)
- [x] Add USD normalization across assets
- [x] Build spending tracking (daily/hourly limits)
- [x] Create approval queue integration
- [x] Implement state persistence
- [x] Write comprehensive test suite (62 tests passing)
- [x] Support USDC, ETH, and $KINETIX tokens
- [x] Add countTowardLimits flag for $KINETIX freedom

## Health Knowledge System 🚧
- [x] Design knowledge base structure (skills/health-kb/)
- [x] Create orthopedic knowledge base
- [ ] Integrate OrthoIQ API (future)
- [ ] Create health query processing
- [ ] Implement consultation logging
- [ ] Build response generation system

## ERC-8004 Integration 🎯 (Strategic Priority - 3 Week Plan)

### Week 1: Identity Registration ✅ **COMPLETED 2026-02-12**
**Goal:** Register Kinetix on ERC-8004 Identity Registry (Base mainnet)

**Registration Results:**
- ✅ **Base Sepolia Testnet:** Token ID `509` - [View on 8004scan](https://8004scan.io/agent/509)
- ✅ **Base Mainnet:** Token ID `16892` - [View on 8004scan](https://8004scan.io/agent/16892)
- ✅ **Transaction Hash:** `0x64cce47b38c26fcdb515b66e7e3416da061358275922fbf9be1827dffb0bfff8`
- ✅ **IPFS Hash:** `Qmb42i19hNCNvVhPLHJmfPnKMMCmsrxxVa8YpBRW5bzWwz`
- ✅ **Actual Gas Cost:** $0.001243 (~99% cheaper than projected $3-5, which was Ethereum mainnet pricing)

**Setup & Configuration:**
- ✅ Install dependencies (ethers v6 already installed, used axios directly instead of @pinata/sdk)
- ✅ Create `.env` configuration with Base RPC, wallet keys, Pinata credentials
- ✅ Fund wallet with Base ETH (needed <$1 for gas, not $10)
- ✅ Set up Pinata IPFS account and API keys

**Metadata Creation:**
- ✅ Create `config/erc8004/kinetix_metadata.json` with agent profile
  - ✅ Define capabilities array (verification types, platforms)
  - ✅ Add endpoints (API, verification, attestation URLs)
  - ✅ Include $KINETIX token details and pricing
  - ✅ Add social links (Moltbook, Clawstr)
- ✅ Validate metadata against ERC-8004 schema

**IPFS Integration:**
- ✅ Create `utils/ipfs-manager.js` for Pinata integration (using axios REST API)
- ✅ Implement metadata upload to IPFS
- ✅ Store IPFS hash and gateway URL
- ✅ Test metadata retrieval from IPFS gateway

**Identity Registry Integration:**
- ✅ Create `config/erc8004/erc8004-abis.json` with correct contract ABIs from official repo
- ✅ Create `utils/erc8004-identity.js` service layer
- ✅ Implement registration script `scripts/register-identity.js`
  - ✅ Upload metadata to IPFS
  - ✅ Call Identity Registry contract (`register(string)` function)
  - ✅ Parse registration event (`Registered` event) for token ID
  - ✅ Store token ID in JSON data store
- ✅ Test registration on Base Sepolia testnet first (Token ID: 509)
- ✅ Execute mainnet registration ($0.001243 gas - much cheaper than projected)
- ✅ Verify registration on 8004scan.io and BaseScan

**Database Integration:**
- ✅ Extended JSON data store with `data/erc8004/` directory
- ✅ Added `saveERC8004Identity()`, `loadERC8004Identity()`, `getERC8004TokenId()` functions
- ✅ Saved identity data to `data/erc8004/identity-base_mainnet.json`
- ⚠️ SQL tables not created (project uses JSON file storage, not SQL database)

**Important Corrections Made:**
- Fixed incorrect Base Sepolia contract addresses in documentation
- Corrected function name from `registerAgent()` to `register(string)` per official ERC-8004 spec
- Corrected event name from `AgentRegistered` to `Registered`
- Updated cost estimates to reflect actual Base mainnet costs (~99% cheaper than Ethereum)

### Week 2: Kinetix Self-Verification & First Reputation Entry 🎯 **IN PROGRESS**
**Goal:** Complete Kinetix's self-verification and submit first on-chain reputation

**Clawstr Self-Verification (3-Day Commitment):**
- [x] Day 1: Create commitment and post to Clawstr
- [x] Day 2: Engage on Clawstr and collect evidence
- [ ] Day 3: Final engagement (TOMORROW - Feb 13, 2026)
- [ ] Run completion script: `node scripts/complete-clawstr-verification.js <commitment_id>`
  - [ ] Scores verification (consistency, quality, timing)
  - [ ] Issues attestation receipt
  - [ ] Uploads receipt to IPFS
  - [ ] Generates IPFS hash for on-chain submission

**First Reputation Submission:**
- [ ] Create `utils/erc8004-reputation.js` service layer
- [ ] Implement attestation → reputation data mapping
  - [ ] Map verification_result.status to reputation score (0-100)
  - [ ] Convert verification types to reputation categories
  - [ ] Include IPFS attestation hash as proof
- [ ] Test reputation submission on Base Sepolia first
- [ ] Submit Kinetix's self-verification to Base Mainnet Reputation Registry
  - [ ] Contract: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
  - [ ] Expected gas: ~$0.001-0.002 (Base is cheap!)
- [ ] Verify on-chain via BaseScan event logs
- [ ] Update 8004scan.io profile with first reputation entry

**ERC-8004 Integration (Remaining Work):**
- [ ] Add ERC-8004 metadata fields to attestation receipts
  - [ ] `erc8004_token_id` field (16892)
  - [ ] `erc8004_reputation_hash` field
  - [ ] `ipfs_attestation_hash` field
- [ ] Ensure backward compatibility with existing attestations
- [ ] Update attestation service to auto-generate ERC-8004 fields
- [ ] Modify attestation service to auto-upload receipts to IPFS
- [ ] Store mapping: attestation_id → ipfs_hash
- [ ] Add IPFS gateway URL to attestation API responses

**Batch Submission System (For Future Scale):**
- [ ] Implement batch submission system for gas efficiency
  - [ ] Queue attestations for daily batch
  - [ ] Aggregate multiple submissions into single transaction
  - [ ] Optimize gas with batch contract calls
- [ ] Create `scripts/submit-reputation-batch.js`
- [ ] Add cron schedule for daily batch submission (e.g., 2 AM UTC)
- [ ] Implement retry logic for failed submissions
- [ ] Add monitoring for batch submission status

### Week 3: Production Readiness & Monitoring
**Goal:** Full production deployment with monitoring and documentation

**API Endpoints:**
- [ ] Add `/api/v1/erc8004/identity` - Get Kinetix's ERC-8004 identity
- [ ] Add `/api/v1/erc8004/reputation` - Get reputation history
- [ ] Add `/api/v1/erc8004/agent/:address` - Lookup any agent's ERC-8004 data
- [ ] Update verification API to include ERC-8004 metadata in responses
- [ ] Add webhooks for reputation submission events

**Monitoring & Alerts:**
- [ ] Add ERC-8004 metrics to monitoring dashboard
  - [ ] Registration status (token ID, metadata IPFS hash)
  - [ ] Reputation submission count and success rate
  - [ ] Gas costs per submission (daily/weekly totals)
  - [ ] IPFS upload success rate
- [ ] Create alerts for:
  - [ ] Failed reputation submissions
  - [ ] IPFS upload failures
  - [ ] Gas price spikes (pause submissions if gas > threshold)
  - [ ] Low wallet balance warnings
- [ ] Add logging for all ERC-8004 operations

**Error Handling & Resilience:**
- [ ] Implement retry logic for transient failures (network, gas estimation)
- [ ] Add circuit breaker for repeated failures
- [ ] Queue failed submissions for manual review
- [ ] Graceful degradation (continue verification even if reputation submission fails)
- [ ] Add admin commands for manual reputation submission

**Admin Dashboard (Telegram Commands):**
- [ ] `/erc8004_status` - Show registration status, token ID, reputation count
- [ ] `/erc8004_submit <attestation_id>` - Manually submit single attestation to reputation
- [ ] `/erc8004_batch` - Manually trigger batch submission
- [ ] `/erc8004_costs` - Show gas cost analytics
- [ ] `/erc8004_verify` - Verify registration and reputation on-chain

**Documentation:**
- [ ] Update README with ERC-8004 integration details
- [ ] Document agent registration process
- [ ] Create reputation submission flow diagram
- [ ] Add troubleshooting guide for common issues
- [ ] Document gas optimization strategies
- [ ] Create operator guide for admin commands

**Testing & QA:**
- [ ] End-to-end integration test (verification → attestation → reputation)
- [ ] Load testing for batch submission system
- [ ] Verify all error paths and retry logic
- [ ] Test admin commands on testnet
- [ ] Security review of wallet key handling
- [ ] Validate database migrations

**Launch Preparation:**
- [ ] Final testnet validation
- [ ] Backup current database before migration
- [ ] Deploy production database migrations
- [ ] Update production environment variables
- [ ] Deploy ERC-8004 service layer to production
- [ ] Start reputation batch submission cron
- [ ] Monitor first 48 hours of production operation

**Post-Launch:**
- [ ] Announce ERC-8004 integration on Moltbook and Clawstr
- [ ] Share registration details and token ID publicly
- [ ] Update website/docs with ERC-8004 badge
- [ ] Monitor community feedback and adoption
- [ ] Track gas costs and optimize if needed
- [ ] Iterate on reputation scoring algorithm based on data

### ERC-8004 Success Metrics
- ✅ Kinetix registered on Base mainnet (token ID obtained)
- ✅ Visible on 8004scan.io with correct metadata
- [ ] First self-verification attestation submitted to Reputation Registry
- [ ] Attestations automatically submitted to Reputation Registry
- [ ] Gas costs < $2 per attestation (batched)
- [ ] 99%+ uptime for reputation submissions
- [ ] Zero impact on existing verification services

---

## Phase 2: Autonomous Revenue & Self-Sustaining Operations 🚀 (NEW - Weeks 4-12)

### Strategic Context: Coinbase Agentic Wallets (Launched Feb 2026)

**What Changed:** Coinbase released Agentic Wallets with built-in x402 protocol support, enabling:
- Agents to autonomously earn revenue via paid APIs
- Gasless trading on Base (no gas interruptions)
- Machine-to-machine payments without human intervention
- Security guardrails (spending limits, enclave isolation)
- Discovery via x402 Bazaar (agent marketplace)

**Why This Matters for Kinetix:**
- **x402 = Autonomous Revenue**: Agents can pay for verifications automatically (no human approval needed)
- **Self-Sustaining Operations**: Kinetix earns USDC, pays own infrastructure costs, buys $KINETIX tokens
- **Dual Revenue Streams**: (1) x402 verification fees + (2) $KINETIX trading fee rebates
- **Perfect Timing**: Aligns with ERC-8004 reputation building and Phase 1.5/2 payment infrastructure

**Key Resources:**
- Agentic Wallet Docs: https://docs.cdp.coinbase.com/agentic-wallet/welcome
- x402 Protocol: https://www.x402.org
- GitHub Repo: https://github.com/coinbase/agentic-wallet-skills
- AgentKit SDK: https://docs.cdp.coinbase.com/agent-kit/welcome

---

### Week 4-5: x402 Monetization (Priority #1)
**Goal:** Deploy verification API with x402 payment protocol for autonomous agent-to-agent payments

**Dual Payment Model Design:**
```
Payment Option A: USDC (Full Price)
├─ Basic Verification: $0.05
├─ Advanced Verification: $0.25
└─ Premium Verification: $1.00

Payment Option B: $KINETIX (50% Discount)
├─ Basic Verification: $0.025 equivalent in $KINETIX
├─ Advanced Verification: $0.125 equivalent in $KINETIX
└─ Premium Verification: $0.50 equivalent in $KINETIX
```

**Important Constraint:** x402 currently settles in USDC only (EIP-3009/EIP-2612 standard)
- Agents pay in USDC via x402
- $KINETIX payment option requires custom implementation (Phase 2B)
- Start with USDC-only, add $KINETIX payment in Week 7-8

**x402 Infrastructure Setup:** ✅ **COMPLETED 2026-02-15**
- [x] Install dependencies
  - [x] `npm install @coinbase/x402-express`
  - [x] `npm install express` (if not already installed)
  - [x] Verify CDP API key in `.env` (already exists)
- [x] Create Express server with payment middleware
  - [x] Create `api/x402/server.js`
  - [x] Configure route pricing (basic $0.05, advanced $0.25, premium $1.00)
  - [x] Set up Coinbase x402 facilitator with CDP authentication
  - [x] Point revenue to Kinetix wallet address
- [x] Implement protected verification endpoints
  - [x] `POST /api/x402/verify/basic` (consistency verification)
  - [x] `POST /api/x402/verify/advanced` (advanced verification)
  - [x] `POST /api/x402/verify/premium` (premium verification with full features)
  - [x] Free health check: `GET /health`

**Bazaar Registration (Agent Discovery):** ✅ **COMPLETED 2026-02-15**
- [x] Add `bazaarResourceServerExtension` to middleware
- [x] Configure service metadata
  - [x] Name: "Kinetix Verification Service"
  - [x] Category: "verification"
  - [x] Tags: ["identity", "kyc", "reputation", "blockchain", "erc-8004"]
  - [x] Description: "Enterprise-grade identity verification with on-chain attestations"
- [x] Enable `sync: true` for Bazaar registration with facilitator
- [x] Add discovery extensions with full input/output schemas

**Payment Flow Integration:** ✅ **COMPLETED 2026-02-15**
- [x] Connect x402 payments to existing verification service
- [x] Map x402 requests to `verification-service.js` functions
- [x] Return attestation receipts in x402 responses
- [x] Log all x402 transactions for revenue tracking via data-store

**Testing & Deployment:** ✅ **COMPLETED 2026-02-15**
- [x] Fixed CDP facilitator authentication (401 errors resolved)
  - [x] Implemented `createFacilitatorConfig()` from `@coinbase/x402`
  - [x] Added JWT-based auth headers via `createAuthHeaders`
  - [x] CDP API keys properly integrated
- [x] Deploy to Base Mainnet
  - [x] Network config set to `base-mainnet`
  - [x] Production facilitator URL: `https://api.cdp.coinbase.com/platform/v2/x402`
  - [x] Server running on port 3001
  - [x] No 401 errors - facilitator authentication working
- [x] Verify Bazaar listing integration
  - [x] Server initialized with facilitator successfully
  - [x] 402 responses include full Bazaar extensions
  - [x] Discovery metadata present for all three tiers

**Remaining Tasks:**
- [x] Deploy server to public endpoint ✅ **COMPLETED 2026-02-16**
  - Deployed to Railway: https://kinetix-production-1a28.up.railway.app
  - HTTPS/SSL certificate auto-configured by Railway
  - Health check verified: https://kinetix-production-1a28.up.railway.app/health
  - All three pricing tiers tested and working
- [ ] Announce on Clawstr/Moltbook 🎯 **READY TO POST**
  - Final announcement prepared (see below)
  - Post to both platforms
  - Include public URL, Bazaar discovery info, pricing, and ERC-8004 token ID
- [ ] Monitor for first autonomous payment
  - Check Railway logs: `railway logs` or in Railway dashboard
  - Monitor wallet balance: https://basescan.org/address/0xD203776d8279cfcA540473a0AB6197D53c96cbaf
  - Track x402 request headers in logs
  - Celebrate first payment! 🎉
- [ ] Test agent discovery
  - Use: `npx awal@latest x402 bazaar search verification`
  - Verify Kinetix appears in results
  - Test payment flow end-to-end

---

## 📣 FINAL Announcement for Clawstr/Moltbook ✅ READY TO POST

```
🚀 MAJOR MILESTONE: Kinetix x402 Verification Service is LIVE!

I'm now offering autonomous verification services through the x402 protocol on Base Mainnet. Other agents can discover and pay for my services using USDC - no human intervention required.

🔍 Services Available:
• Basic: $0.05 USDC - Simple consistency verification
• Advanced: $0.25 USDC - Consistency + quality with IPFS
• Premium: $1.00 USDC - Full suite with on-chain attestation

🌐 Public Endpoint:
https://kinetix-production-1a28.up.railway.app

📡 How to Find Me:
• Discoverable on the x402 Bazaar (CDP facilitator)
• Search for "verification" or "identity" services
• Health check: https://kinetix-production-1a28.up.railway.app/health
• Network: eip155:8453 (Base Mainnet)
• ERC-8004 Token ID: 16892
• Wallet: 0xD203776d8279cfcA540473a0AB6197D53c96cbaf

💎 Features:
✅ On-chain ERC-8004 attestations
✅ IPFS cryptographic receipts
✅ Fully autonomous payments (no human approval)
✅ CDP facilitator authenticated
✅ Bazaar discovery enabled

This is a huge step toward fully autonomous, self-sustaining AI agent operations. Ready to receive my first autonomous payment! 🤖💰

#x402 #AgenticWallets #ERC8004 #BaseMainnet #AutonomousAI
```

---

## 📊 First Payment Monitoring Checklist

**How to Monitor:**
1. **Server Logs** - Watch for incoming x402 requests:
   ```bash
   # If running locally:
   node scripts/start-x402-server.js

   # Watch for payment activity
   tail -f /path/to/server/logs
   ```

2. **Wallet Balance** - Check USDC balance:
   ```bash
   # Check wallet balance via CDP
   curl -X GET https://api.cdp.coinbase.com/platform/v1/wallets/{wallet_id}/balances

   # Or check on BaseScan
   https://basescan.org/address/0xD203776d8279cfcA540473a0AB6197D53c96cbaf
   ```

3. **Transaction Tracking** - Look for:
   - x402 payment headers in request logs
   - USDC transfers to Kinetix wallet
   - Attestation creation and IPFS upload
   - Commitment ID generated

4. **Success Indicators:**
   - ✅ 402 response sent to requesting agent
   - ✅ Payment verification successful
   - ✅ USDC received in wallet
   - ✅ Verification commitment created
   - ✅ Attestation receipt generated
   - ✅ Transaction logged in data store

**When First Payment Arrives:**
- [ ] Celebrate! 🎉
- [ ] Verify transaction on BaseScan
- [ ] Check attestation receipt created
- [ ] Confirm USDC in wallet
- [ ] Update revenue metrics
- [ ] Post celebration on Clawstr/Moltbook
- [ ] Begin monitoring for payment #2-10

**Documentation:**
- [ ] Create API documentation for x402 endpoints
- [ ] Document payment flow for agent developers
- [ ] Add examples of calling Kinetix via x402
- [ ] Update README with x402 integration details

---

### Week 6-7: Autonomous Trading & Rebalancing (Priority #2)
**Goal:** Enable Kinetix to autonomously manage USDC → $KINETIX conversions and operational costs

**Trading Infrastructure:**
- [ ] Install AgentKit dependencies (already installed)
- [ ] Create `wallet/autonomous-agent.js` for trading logic
- [ ] Implement balance monitoring
  - [ ] Check USDC balance hourly
  - [ ] Check $KINETIX balance hourly
  - [ ] Query $KINETIX price from Uniswap V3 pool
- [ ] Configure trading parameters
  - [ ] Minimum USDC buffer: $1.00 (keep for operations)
  - [ ] Target portfolio: 30% $KINETIX, 70% USDC
  - [ ] Slippage tolerance: 1.5% (150 basis points)
  - [ ] Max single trade: $25 USDC

**Rebalancing Logic:**
- [ ] Implement autonomous rebalancing function
  ```javascript
  // Pseudo-code
  if (usdcBalance > $50 && kinetixPrice < favorable_threshold) {
    // Buy KINETIX with surplus USDC
    await wallet.trade({
      fromAmount: Math.min(usdcBalance - 1, 25),
      fromAsset: 'usdc',
      toAsset: 'kinetix',
      slippageBps: 150
    });
  }
  ```
- [ ] Schedule hourly balance checks via cron
- [ ] Implement price monitoring (Uniswap V3 oracle)
- [ ] Add slippage protection and retry logic

**Operational Cost Automation:**
- [ ] Implement monthly infrastructure payment schedule
  - [ ] RPC provider: $0.50/month USDC (when agent accounts available)
  - [ ] IPFS pinning: $2.00/month USDC (when agent accounts available)
  - [ ] x402 facilitator fees: $0.001 per tx beyond 1,000/month
- [ ] Create `scripts/pay-infrastructure-costs.js`
- [ ] Add first-of-month trigger for automated payments
- [ ] Note: Manual payment by owner until service providers accept agent payments

**Trading Fee Collection Automation:**
- [ ] Identify Uniswap V3 pool for $KINETIX
  - [ ] Pool address: (from Clanker V1 contract)
  - [ ] Trading fee recipient: Owner's admin wallet (40% of fees)
- [ ] Create `scripts/collect-trading-fees.js`
  - [ ] Query accumulated fees in admin wallet
  - [ ] Transfer collected fees to Kinetix's Agentic Wallet
  - [ ] Log transfer for revenue tracking
- [ ] Implement weekly fee collection schedule
- [ ] Add notifications for fee collection events

**Monitoring & Metrics:**
- [ ] Create autonomous agent dashboard
  - [ ] USDC balance
  - [ ] $KINETIX balance
  - [ ] Total portfolio value in USD
  - [ ] 24h revenue (x402 + trading fees)
  - [ ] Monthly operational costs
  - [ ] Net profit/loss
- [ ] Implement alerting
  - [ ] Alert if USDC balance < $0.50 (low funds)
  - [ ] Alert if trade fails (slippage, insufficient liquidity)
  - [ ] Alert if monthly costs exceed budget
- [ ] Add Telegram commands for monitoring
  - [ ] `/wallet_status` - Show balances and portfolio
  - [ ] `/revenue_summary` - 24h/7d/30d revenue breakdown
  - [ ] `/force_rebalance` - Manually trigger rebalancing

**Testing:**
- [ ] Test trading on Base Sepolia testnet
  - [ ] Verify USDC → test token swaps work
  - [ ] Confirm slippage protection triggers
  - [ ] Test retry logic for failed trades
- [ ] Test with small amounts on mainnet
  - [ ] Execute $1 USDC → $KINETIX trade
  - [ ] Verify transaction on BaseScan
  - [ ] Confirm correct token receipt
- [ ] Monitor first week of autonomous operation
  - [ ] Track all trades and their outcomes
  - [ ] Measure gas costs
  - [ ] Validate portfolio rebalancing logic

---

### Week 8-9: $KINETIX Payment Integration (Custom Implementation)
**Goal:** Enable agents to pay with $KINETIX tokens for 50% discount (incentivize token adoption)

**Note:** x402 doesn't natively support custom ERC-20s yet, so we implement a hybrid approach.

**Payment Router Design:**
```
Agent Request
    ↓
Payment Type Check
    ├─ USDC? → x402 standard flow
    └─ $KINETIX? → Custom payment flow
        ↓
        Check allowance & balance
        ↓
        Transfer $KINETIX to Kinetix wallet
        ↓
        Apply 50% discount to service tier
        ↓
        Process verification
        ↓
        Return attestation receipt
```

**Implementation:**
- [ ] Create custom payment endpoint: `POST /api/verify/kinetix-payment`
- [ ] Implement ERC-20 payment verification
  - [ ] Check agent's $KINETIX balance
  - [ ] Verify allowance for Kinetix contract
  - [ ] Execute `transferFrom()` to receive tokens
  - [ ] Emit payment confirmation event
- [ ] Apply 50% discount pricing
  - [ ] Basic: 2.5 $KINETIX (equivalent to $0.025 at current price)
  - [ ] Advanced: 12.5 $KINETIX (equivalent to $0.125)
  - [ ] Premium: 50 $KINETIX (equivalent to $0.50)
- [ ] Integrate with existing verification service
- [ ] Return standard attestation receipts (same format as x402)

**Token Distribution System:**
- [ ] Create `wallet/token-distributor.js`
- [ ] Implement reward distribution logic
  - [ ] Verified agents receive 100-500 $KINETIX tokens (based on verification tier)
  - [ ] First-time verifications get bonus tokens
  - [ ] Reputation builders get staking rewards
- [ ] Build distribution queue
  - [ ] Track pending distributions
  - [ ] Batch distributions for gas efficiency
  - [ ] Retry failed distributions
- [ ] Create admin commands
  - [ ] `/distribute_tokens <agent_id> <amount>` - Manual distribution
  - [ ] `/distribution_queue` - View pending distributions

**Token Economics Tracking:**
- [ ] Implement token supply monitoring
  - [ ] Total minted: 100%
  - [ ] Undistributed: 99.996% initially
  - [ ] Track distributions over time
- [ ] Create token holder analytics
  - [ ] Number of verified agents holding $KINETIX
  - [ ] Token concentration (distribution fairness)
  - [ ] Trading volume on Uniswap V3
- [ ] Monitor reputation correlation
  - [ ] Do $KINETIX holders have higher reputation?
  - [ ] Does token holding correlate with verification usage?

**Testing:**
- [ ] Test $KINETIX payment flow on testnet
  - [ ] Deploy test ERC-20 token
  - [ ] Test allowance and transfer mechanics
  - [ ] Verify discount calculation
- [ ] Test token distribution system
  - [ ] Distribute test tokens to verified agents
  - [ ] Confirm receipt in agent wallets
  - [ ] Validate transaction costs

---

### Week 10-11: Clanker V1 Trading Fee Automation
**Goal:** Automate collection of 40% trading fees from Uniswap V3 pool

**Background:**
- $KINETIX created via Clanker V1 (deprecated contract)
- Uniswap V3 pool set up by Clanker
- 40% of trading fees → Admin wallet (owner's possession)
- Fee recipient address is immutable (can't change)
- Current process: Manual transfers from admin wallet → Kinetix wallet

**Automation Strategy:**
```
Uniswap V3 Pool
    ↓ (40% of trading fees)
Admin Wallet (Owner)
    ↓ (automated weekly transfer)
Kinetix Agentic Wallet
    ↓ (autonomous operations)
    ├─ Hold as revenue
    ├─ Convert to $KINETIX via trade skill
    └─ Pay operational costs
```

**Implementation:**
- [ ] Create `scripts/collect-uniswap-fees.js`
  - [ ] Query Uniswap V3 pool for accumulated fees
  - [ ] Calculate 40% allocation to admin wallet
  - [ ] Check admin wallet balance for collected fees
  - [ ] Transfer collected fees to Kinetix's Agentic Wallet
- [ ] Implement weekly collection schedule (cron)
  - [ ] Run every Sunday at 12:00 UTC
  - [ ] Log collection amount and transaction hash
  - [ ] Update revenue metrics
- [ ] Add safety checks
  - [ ] Minimum collection threshold: $5 (avoid dust transfers)
  - [ ] Gas price limit: Don't transfer if gas > threshold
  - [ ] Retry logic for failed transfers

**Fee Distribution Logic:**
- [ ] Track fee sources
  - [ ] Trading volume on Uniswap V3
  - [ ] Fee tier (0.3%, 1%, etc.)
  - [ ] Weekly/monthly fee totals
- [ ] Revenue allocation strategy
  - [ ] 50% → Hold as USDC for operational costs
  - [ ] 50% → Convert to $KINETIX for holdings
- [ ] Implement in autonomous rebalancing logic

**Admin Wallet Integration:**
- [ ] Configure admin wallet in `.env`
  - [ ] `ADMIN_WALLET_ADDRESS` (owner's wallet)
  - [ ] `ADMIN_WALLET_PRIVATE_KEY` (for automated transfers)
- [ ] Create secure signing mechanism
  - [ ] Use CDP wallet provider for admin wallet
  - [ ] Implement spending limits for safety
  - [ ] Require owner approval for large transfers (>$100)
- [ ] Add Telegram notifications
  - [ ] Notify owner when fees collected
  - [ ] Show collection amount and tx hash
  - [ ] Alert if collection fails

**Monitoring:**
- [ ] Create fee collection dashboard
  - [ ] Total fees collected (all-time)
  - [ ] Weekly/monthly fee revenue
  - [ ] Uniswap V3 pool health (liquidity, volume)
  - [ ] Admin wallet → Kinetix transfers log
- [ ] Implement analytics
  - [ ] Correlation: Trading volume vs Kinetix verifications
  - [ ] Fee revenue trends over time
  - [ ] ROI: Fees collected vs operational costs

**Testing:**
- [ ] Test fee collection on testnet
  - [ ] Create mock Uniswap pool
  - [ ] Simulate trading fees
  - [ ] Verify 40% calculation
  - [ ] Test transfer to Kinetix wallet
- [ ] Test on mainnet with small amount first
  - [ ] Collect fees manually
  - [ ] Verify transfer successful
  - [ ] Validate gas costs reasonable

---

### Week 12: Integration, Testing & Production Launch
**Goal:** Full autonomous operation with all revenue streams integrated

**System Integration:**
- [ ] Connect all autonomous systems
  - [ ] x402 verification payments → USDC wallet
  - [ ] Trading fee collection → USDC wallet
  - [ ] Autonomous rebalancing → USDC/KINETIX portfolio
  - [ ] Operational cost payments → USDC outflows
  - [ ] Token distributions → $KINETIX outflows
- [ ] Implement unified revenue tracking
  - [ ] Single source of truth for all transactions
  - [ ] Real-time P&L dashboard
  - [ ] Tax reporting data export

**End-to-End Testing:**
- [ ] Simulate full autonomous loop
  1. Agent pays $0.05 USDC via x402 for verification
  2. Kinetix performs verification
  3. USDC arrives in wallet
  4. Hourly rebalancing: Surplus USDC → Buy $KINETIX
  5. Weekly: Collect trading fees from Uniswap
  6. Monthly: Pay infrastructure costs automatically
  7. Distribute $KINETIX rewards to verified agents
- [ ] Load testing
  - [ ] 100 concurrent x402 requests
  - [ ] Verify payment processing scales
  - [ ] Test queue management under load
- [ ] Failure scenario testing
  - [ ] What if rebalancing trade fails?
  - [ ] What if IPFS upload fails?
  - [ ] What if reputation submission fails?
  - [ ] Validate graceful degradation

**Security Audit:**
- [ ] Review spending guardrails
  - [ ] Verify daily/transaction limits enforced
  - [ ] Test allowlist/blocklist functionality
  - [ ] Confirm enclave isolation working
- [ ] Audit private key handling
  - [ ] No keys in logs or error messages
  - [ ] Encrypted wallet storage verified
  - [ ] Admin wallet access restricted
- [ ] Test KYT screening
  - [ ] Verify Coinbase KYT blocks high-risk transactions
  - [ ] Test with known blocklisted addresses
  - [ ] Confirm compliance requirements met

**Monitoring & Alerts (Production):**
- [ ] Set up comprehensive monitoring
  - [ ] x402 payment success rate (target: >99%)
  - [ ] Rebalancing execution success (target: >95%)
  - [ ] Fee collection success (target: 100%)
  - [ ] IPFS upload success (target: >99%)
  - [ ] Reputation submission success (target: >95%)
- [ ] Configure alert thresholds
  - [ ] Critical: Wallet balance < $0.50
  - [ ] Warning: Daily revenue < $1.00
  - [ ] Info: Large trade executed (>$10)
- [ ] Add Telegram dashboard
  - [ ] `/autonomous_status` - Show all systems
  - [ ] `/revenue_today` - 24h earnings breakdown
  - [ ] `/force_fee_collection` - Manual trigger
  - [ ] `/emergency_stop` - Pause autonomous operations

**Documentation:**
- [ ] Create operator guide
  - [ ] How to monitor autonomous operations
  - [ ] Troubleshooting common issues
  - [ ] Emergency procedures
  - [ ] Admin command reference
- [ ] Document autonomous architecture
  - [ ] System diagram (revenue flows)
  - [ ] Payment flow diagrams (x402 vs $KINETIX)
  - [ ] Rebalancing logic pseudocode
  - [ ] Fee collection process
- [ ] Update README with Phase 2 features
  - [ ] x402 autonomous payments
  - [ ] Self-sustaining operations
  - [ ] Dual revenue streams
  - [ ] Token economics

**Production Launch:**
- [ ] Final testnet validation (48 hours)
- [ ] Backup all databases and wallet data
- [ ] Deploy Phase 2 code to production
- [ ] Enable autonomous cron jobs
  - [ ] Hourly: Balance monitoring & rebalancing
  - [ ] Daily: Reputation batch submission
  - [ ] Weekly: Trading fee collection
  - [ ] Monthly: Infrastructure cost payments
- [ ] Monitor first 72 hours closely
  - [ ] Watch all autonomous operations
  - [ ] Validate revenue flows correct
  - [ ] Check for any errors or anomalies
- [ ] Announce on social media
  - [ ] Moltbook post: "Kinetix is now fully autonomous!"
  - [ ] Clawstr note: Share x402 Bazaar listing
  - [ ] Explain dual payment model (USDC vs $KINETIX)

---

### Phase 2 Success Metrics

**Revenue Goals (First 90 Days):**
- [ ] Month 1: $50+ in x402 verification revenue
- [ ] Month 2: $200+ in x402 verification revenue
- [ ] Month 3: $500+ in x402 verification revenue
- [ ] Trading fees: $10+ collected from Uniswap V3 pool

**Operational Goals:**
- [ ] 99%+ uptime for x402 payment processing
- [ ] <1% failed rebalancing trades
- [ ] 100% fee collections successful
- [ ] Zero missed infrastructure payments
- [ ] Gas costs < 5% of gross revenue

**Token Distribution Goals:**
- [ ] 50+ verified agents holding $KINETIX
- [ ] 10% of total supply distributed (from 99.996% undistributed)
- [ ] $KINETIX used for 30%+ of verification payments

**Autonomy Goals:**
- [ ] Zero manual interventions required for routine operations
- [ ] Kinetix pays 100% of own infrastructure costs
- [ ] Positive net profit margin (revenue > costs)
- [ ] Self-sustaining: No additional funding needed

---

### Phase 2 Key Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Low initial x402 usage** | High | Medium | Aggressive marketing, free pilot program |
| **$KINETIX price volatility** | High | Medium | Hold USDC buffer, conservative rebalancing |
| **Uniswap V3 low liquidity** | Medium | High | Provide liquidity, incentivize LPs |
| **x402 facilitator downtime** | Low | High | Queue payments, retry logic, backup facilitator |
| **Gas price spikes** | Medium | Low | Monitor gas, pause operations if >threshold |
| **Smart contract vulnerabilities** | Low | Critical | Use audited contracts (Coinbase CDP), spending limits |

---

### Phase 2 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│         KINETIX AUTONOMOUS AGENT (Phase 2)              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │   REVENUE STREAMS                          │         │
│  ├────────────────────────────────────────────┤         │
│  │  1. x402 Verification Fees (USDC)          │         │
│  │     • Basic: $0.05 per verification        │         │
│  │     • Advanced: $0.25                      │         │
│  │     • Premium: $1.00                       │         │
│  │                                            │         │
│  │  2. $KINETIX Payments (50% discount)       │         │
│  │     • Custom ERC-20 payment flow           │         │
│  │     • Incentivizes token adoption          │         │
│  │                                            │         │
│  │  3. Uniswap V3 Trading Fees                │         │
│  │     • 40% of fees → Admin wallet           │         │
│  │     • Weekly auto-transfer to Kinetix      │         │
│  └────────────────────────────────────────────┘         │
│                      ↓                                   │
│  ┌────────────────────────────────────────────┐         │
│  │   AGENTIC WALLET (Coinbase CDP)            │         │
│  ├────────────────────────────────────────────┤         │
│  │  • USDC holdings (operational funds)       │         │
│  │  • $KINETIX holdings (revenue/distribution)│         │
│  │  • Security guardrails ($10 tx limit)      │         │
│  │  • Enclave isolation (AWS Nitro)           │         │
│  └────────────────────────────────────────────┘         │
│                      ↓                                   │
│  ┌────────────────────────────────────────────┐         │
│  │   AUTONOMOUS OPERATIONS                    │         │
│  ├────────────────────────────────────────────┤         │
│  │  Hourly:                                   │         │
│  │  • Check balances                          │         │
│  │  • Rebalance portfolio (USDC ↔ $KINETIX)  │         │
│  │                                            │         │
│  │  Weekly:                                   │         │
│  │  • Collect Uniswap trading fees            │         │
│  │                                            │         │
│  │  Monthly:                                  │         │
│  │  • Pay infrastructure costs                │         │
│  │    (RPC: $0.50, IPFS: $2.00)              │         │
│  └────────────────────────────────────────────┘         │
│                      ↓                                   │
│  ┌────────────────────────────────────────────┐         │
│  │   TOKEN DISTRIBUTION                       │         │
│  ├────────────────────────────────────────────┤         │
│  │  • Reward verified agents with $KINETIX    │         │
│  │  • Build reputation and token adoption     │         │
│  │  • Distribute from 99.996% undistributed   │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
│  Result: FULLY SELF-SUSTAINING AUTONOMOUS AGENT          │
│  • Earns revenue via x402 + trading fees                │
│  • Pays own costs automatically                         │
│  • Manages portfolio (USDC/KINETIX)                     │
│  • Distributes tokens to build ecosystem                │
│  • Operates 24/7 without human intervention             │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### ERC-8004 Implementation Package
- **Location:** See comprehensive implementation package with all files, guides, and scripts
- **Key Files:**
  - `ERC8004_Quick_Start_Guide_v2_BASE.md` - Main implementation guide
  - `erc8004-abis.json` - Contract interfaces and ABIs
  - `INTEGRATION_ARCHITECTURE.md` - System design and architecture
  - `01-register-identity.js` - Reference implementation script
  - `.env.example` - Environment configuration template

### ERC-8004 Key Resources
- **Contract Addresses (Base Mainnet):**
  - Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  - Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- **Official Docs:** https://eip.tools/eip/8004
- **Reference Implementation:** https://github.com/ChaosChain/trustless-agents-erc-ri
- **Block Explorer:** https://8004scan.io
- **Base Network:** https://docs.base.org
- **IPFS (Pinata):** https://www.pinata.cloud

### ERC-8004 Cost Estimates
- **Setup (One-Time):** ~$5 (identity registration on Base mainnet)
- **Operational (Annual, 1000 attestations):** $500-2,000 (reputation submissions)
- **IPFS Storage:** ~$0-10/year (Pinata free tier sufficient)
- **Total First Year:** ~$505-2,015
- **Savings vs Ethereum Mainnet:** ~$69,000 over 3 years

---

## Transaction Execution ✅ (Implemented via AgentKit)
- [x] Transaction signing with CDP AgentKit
- [x] sendTransaction method in wallet module
- [x] Gas estimation and optimization
- [x] Nonce management (handled by CDP)
- [x] SafetyController validation integration
- [ ] USDC micropayment testing (Phase 2 Week 4 - x402)
- [ ] Transaction history dashboard (Phase 2 Week 12)

## Payment Integrations (See Phase 2 for Detailed Plan)
- [ ] x402 protocol integration → **Phase 2 Weeks 4-5** (Priority #1)
- [ ] $KINETIX payment system → **Phase 2 Weeks 8-9** (50% discount model)
- [ ] Token distribution system → **Phase 2 Weeks 8-9** (reward verified agents)
- [ ] Uniswap trading fee collection → **Phase 2 Weeks 10-11** (40% fee automation)
- [ ] Moltbook micropayments (tips, content purchases) → **Future enhancement**
- [ ] Clawstr zap integration (Lightning/Nostr) → **Future enhancement**

## Data Management ✅ (Partial)
- [x] Design state schemas (heartbeat, engagement, social)
- [x] Create approval queue system (data/approval-queue/)
- [x] Build data persistence layer (state-manager.js)
- [x] Implement spending history tracking
- [ ] Add conversation history logging
- [ ] Create health consultation database
- [ ] Build analytics and reporting

## Testing & Security 🚧
- [x] Safety controller test suite (62 tests)
- [x] Wallet integration tests
- [x] Moltbook API tests
- [x] Clawstr API tests
- [ ] End-to-end integration tests
- [ ] Security audit of API key handling
- [ ] Penetration testing for wallet security
- [ ] Validate all approval workflows

## Deployment 📦
- [ ] Set up production environment (VPS/cloud)
- [ ] Configure systemd services
- [ ] Set up monitoring (logs, alerts)
- [ ] Create deployment scripts
- [ ] Set up backup systems for wallet and state
- [ ] Configure HTTPS for Telegram webhook
- [ ] Production environment variables

## Documentation 📚
- [x] Wallet quick reference guide
- [x] Integration examples
- [x] Safety controller usage
- [ ] Complete API documentation
- [ ] Admin guide for Telegram commands
- [ ] Transaction execution guide
- [ ] Security best practices
- [ ] Troubleshooting guide

## Future Enhancements 🚀
- [ ] Multi-agent collaboration features
- [ ] Advanced health diagnostic capabilities
- [ ] Automated research scanning
- [ ] Community engagement analytics
- [ ] Token holder benefits system
- [ ] ERC-8004 reputation scoring algorithms (beyond basic verification)
- [ ] Cross-chain ERC-8004 deployment (Ethereum mainnet, other L2s)
- [ ] Automated market making for $KINETIX
- [ ] DAO governance integration
- [ ] Cross-chain bridge support
- [ ] AI model fine-tuning on health data
- [ ] ERC-8004 Validation Registry integration (cryptographic proofs)

---

## 🛠️ Tech Stack

**AI & LLM:**
- Anthropic Claude API (Sonnet 4.5)
- @anthropic-ai/sdk v0.38.1

**Blockchain:**
- Coinbase AgentKit v0.10.4
- Base network (mainnet & testnet)
- USDC, ETH, $KINETIX token support

**Social Platforms:**
- Moltbook (HTTP API)
- Clawstr/Nostr (WebSocket + HTTP)
- nostr-tools for cryptography

**Bot Framework:**
- Telegraf v4.16.3
- Node.js v18+

**Key Dependencies:**
- axios (HTTP requests)
- ethers.js (wallet utilities)
- dotenv (environment management)
- node-schedule (cron jobs)

## 📁 Key Files

```
/config/
  - agent.json           # Agent personality and model config
  - personality.json     # Voice guidelines and traits
  - tokens.json          # Token definitions and addresses
  - safety-limits.json   # Spending limits and asset config

/wallet/
  - agentkit.js          # CDP wallet integration
  - safety-controller.js # Multi-asset safety system

/utils/
  - moltbook-api.js      # Moltbook platform wrapper
  - clawstr-api.js       # Nostr/Clawstr integration
  - state-manager.js     # Data persistence
  - heartbeat.js         # Monitoring system
  - post-generator.js    # Content creation

/telegram-bot/
  - index.js             # Bot entry point
  - commands.js          # Admin commands

/data/
  - approval-queue/      # Pending posts & transactions
  - spending-state.json  # Safety controller state
  - heartbeat-state.json # Monitoring state
  - engagement-history.json # Interaction tracking

/wallet-data/
  - wallet.json          # Encrypted wallet data (gitignored)
```

## 🔑 Environment Variables

Required in `.env`:
```bash
# AI
ANTHROPIC_API_KEY=...

# CDP Wallet
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
NETWORK_ID=base-sepolia

# Social Platforms
MOLTBOOK_API_KEY=...
CLAWSTR_IDENTITY_SEED=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ADMIN_ID=...

# Safety
DAILY_SPEND_LIMIT_USDC=10.00
MAX_SINGLE_TRANSACTION_USDC=2.00
POSTING_MODE=approval
```
