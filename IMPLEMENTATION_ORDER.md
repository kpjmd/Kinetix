# Kinetix Phase 2: Implementation Order (Quick Reference)

## ✅ This Week - ERC-8004 Self-Verification Completion

### Day 1 (Feb 13, 2026) - Final Commitment Day
- [ ] Post to Clawstr (maintain 3-day streak)
- [ ] Collect final evidence
- [ ] Confirm commitment completion

### Day 2 (Feb 14, 2026) - First Attestation
- [ ] Run: `node scripts/complete-clawstr-verification.js <commitment_id>`
- [ ] Verify attestation receipt generated
- [ ] Check IPFS upload successful
- [ ] Run: `node scripts/test-reputation-submission.js`
- [ ] Verify on BaseScan
- [ ] Check 8004scan.io profile updated

### Days 3-5 (Feb 15-17, 2026) - Phase 2 Preparation
- [ ] Read Agentic Wallet docs: https://docs.cdp.coinbase.com/agentic-wallet/welcome
- [ ] Read x402 protocol: https://www.x402.org
- [ ] Verify CDP credentials in `.env`
- [ ] Install: `npm install @coinbase/x402-express`
- [ ] Review comprehensive exploration report in conversation

---

## 🎯 Week 4 - x402 Monetization (Priority #1)

### Setup
- [ ] Create `api/x402-server.js`
- [ ] Import `@coinbase/x402-express`
- [ ] Configure Kinetix wallet address
- [ ] Set up Coinbase facilitator URL

### Payment Routes
- [ ] Define pricing: Basic $0.05, Advanced $0.25, Premium $1.00
- [ ] Create route config object
- [ ] Apply `paymentMiddleware` to Express app
- [ ] Add `bazaarResourceServerExtension` for discovery

### Verification Integration
- [ ] Connect `/api/verify/basic` to verification service
- [ ] Connect `/api/verify/advanced` to verification service
- [ ] Connect `/api/verify/premium` to verification service
- [ ] Return attestation receipts in responses

### Testing
- [ ] Test on Base Sepolia: `NETWORK_ID=base-sepolia node api/x402-server.js`
- [ ] Use: `npx awal@latest x402 pay <endpoint>` to test
- [ ] Verify USDC arrives in wallet
- [ ] Check receipt generation works

### Production Deploy
- [ ] Deploy to Base Mainnet: `NETWORK_ID=base-mainnet node api/x402-server.js`
- [ ] Verify Bazaar listing: `npx awal@latest x402 bazaar search verification`
- [ ] Monitor first 24 hours
- [ ] Track revenue in wallet

---

## 🤖 Week 5 - x402 Production & Monitoring

### Monitoring
- [ ] Create revenue tracking dashboard
- [ ] Log all x402 transactions
- [ ] Add Telegram command: `/revenue_today`
- [ ] Set up alerts for payment failures

### Documentation
- [ ] Document x402 API for agent developers
- [ ] Create usage examples
- [ ] Update README with x402 integration
- [ ] Add troubleshooting guide

### Optimization
- [ ] Monitor response times
- [ ] Adjust pricing if needed
- [ ] Track conversion rates
- [ ] Gather agent feedback

---

## 💹 Week 6 - Autonomous Trading Setup

### Infrastructure
- [ ] Create `wallet/autonomous-agent.js`
- [ ] Implement balance monitoring function
- [ ] Add price query from Uniswap V3
- [ ] Configure trading parameters

### Rebalancing Logic
- [ ] Implement portfolio target: 30% $KINETIX, 70% USDC
- [ ] Set minimum USDC buffer: $1.00
- [ ] Add slippage protection: 1.5%
- [ ] Create max trade limit: $25

### Cron Jobs
- [ ] Set up hourly balance check
- [ ] Implement rebalancing trigger logic
- [ ] Add retry logic for failed trades
- [ ] Create transaction logging

### Testing
- [ ] Test on Sepolia with test tokens
- [ ] Execute small trade on mainnet ($1)
- [ ] Verify portfolio rebalancing works
- [ ] Monitor for 48 hours

---

## 📊 Week 7 - Trading Fee Collection

### Admin Wallet Setup
- [ ] Configure admin wallet in `.env`
- [ ] Set up CDP wallet provider for admin
- [ ] Implement spending limits for safety
- [ ] Add owner approval for large transfers (>$100)

### Fee Collection Script
- [ ] Create `scripts/collect-uniswap-fees.js`
- [ ] Query Uniswap V3 pool for fees
- [ ] Calculate 40% allocation
- [ ] Transfer to Kinetix wallet

### Automation
- [ ] Set up weekly cron job (Sundays 12:00 UTC)
- [ ] Add minimum threshold: $5
- [ ] Implement gas price check
- [ ] Add Telegram notifications

### Testing
- [ ] Test fee query from pool
- [ ] Execute manual collection
- [ ] Verify transfer successful
- [ ] Validate gas costs reasonable

---

## 💰 Week 8 - $KINETIX Payment Integration

### Custom Payment Endpoint
- [ ] Create `POST /api/verify/kinetix-payment`
- [ ] Implement ERC-20 balance check
- [ ] Add allowance verification
- [ ] Execute `transferFrom()` for payment

### Discount Pricing
- [ ] Basic: 2.5 $KINETIX (50% off $0.05)
- [ ] Advanced: 12.5 $KINETIX (50% off $0.25)
- [ ] Premium: 50 $KINETIX (50% off $1.00)
- [ ] Calculate equivalent USDC value

### Integration
- [ ] Connect to verification service
- [ ] Return attestation receipts
- [ ] Log $KINETIX payments separately
- [ ] Track payment method analytics

### Testing
- [ ] Deploy test ERC-20 on Sepolia
- [ ] Test payment flow
- [ ] Verify discount applied correctly
- [ ] Test on mainnet with real $KINETIX

---

## 🎁 Week 9 - Token Distribution System

### Distribution Logic
- [ ] Create `wallet/token-distributor.js`
- [ ] Define reward tiers: 100-500 $KINETIX per verification
- [ ] Add bonus for first-time verifications
- [ ] Implement distribution queue

### Automation
- [ ] Auto-distribute after verification completion
- [ ] Batch distributions for gas efficiency
- [ ] Add retry logic for failures
- [ ] Track distribution history

### Analytics
- [ ] Monitor token holder count
- [ ] Track distribution fairness
- [ ] Measure $KINETIX payment adoption rate
- [ ] Correlate holdings with reputation

### Testing
- [ ] Distribute test tokens on Sepolia
- [ ] Execute first mainnet distribution
- [ ] Verify agent receives tokens
- [ ] Monitor transaction costs

---

## 🔄 Week 10 - Fee Collection Automation

### Uniswap Integration
- [ ] Identify $KINETIX pool address
- [ ] Query pool contract for fees
- [ ] Calculate 40% admin allocation
- [ ] Implement transfer logic

### Weekly Collection
- [ ] Create cron: Every Sunday 12:00 UTC
- [ ] Add minimum collection: $5
- [ ] Check gas price before execution
- [ ] Log collection events

### Revenue Allocation
- [ ] 50% hold as USDC (operational buffer)
- [ ] 50% convert to $KINETIX (holdings)
- [ ] Integrate with rebalancing logic
- [ ] Track revenue sources separately

### Monitoring
- [ ] Create fee dashboard
- [ ] Track weekly/monthly totals
- [ ] Monitor pool liquidity
- [ ] Alert on collection failures

---

## 🔗 Week 11 - System Integration

### Connect All Systems
- [ ] x402 payments → USDC wallet
- [ ] Trading fees → USDC wallet
- [ ] Rebalancing → USDC/KINETIX portfolio
- [ ] Operational costs → USDC outflows
- [ ] Token distributions → $KINETIX outflows

### Unified Tracking
- [ ] Create single transaction log
- [ ] Real-time P&L dashboard
- [ ] Revenue stream breakdown
- [ ] Cost tracking by category

### Telegram Dashboard
- [ ] `/autonomous_status` - All systems overview
- [ ] `/revenue_summary` - 24h/7d/30d breakdown
- [ ] `/wallet_status` - Balances and portfolio
- [ ] `/force_rebalance` - Manual trigger
- [ ] `/emergency_stop` - Pause operations

---

## 🚀 Week 12 - Production Launch

### Testing
- [ ] End-to-end integration test
- [ ] Load testing (100 concurrent requests)
- [ ] Failure scenario testing
- [ ] Security audit

### Monitoring Setup
- [ ] x402 payment success rate monitoring
- [ ] Rebalancing execution tracking
- [ ] Fee collection success tracking
- [ ] IPFS upload success rate
- [ ] Reputation submission tracking

### Documentation
- [ ] Operator guide
- [ ] Troubleshooting guide
- [ ] Admin command reference
- [ ] Architecture documentation
- [ ] Update README

### Launch
- [ ] Final testnet validation (48 hours)
- [ ] Backup databases and wallets
- [ ] Deploy to production
- [ ] Enable all cron jobs
- [ ] Monitor first 72 hours closely

### Announcement
- [ ] Moltbook post: "Kinetix is now fully autonomous!"
- [ ] Clawstr note: Share x402 Bazaar listing
- [ ] Explain dual payment model
- [ ] Invite agents to try verification service

---

## 📈 Success Checkpoints

### Week 4-5 Checkpoint
- ✅ x402 endpoint live on Base Mainnet
- ✅ Listed in x402 Bazaar
- ✅ First 10 autonomous payments received
- ✅ USDC revenue > $0.50

### Week 6-7 Checkpoint
- ✅ First autonomous trade executed
- ✅ Hourly rebalancing running
- ✅ First Uniswap fee collected
- ✅ Weekly fee collection automated

### Week 8-9 Checkpoint
- ✅ $KINETIX payment option live
- ✅ First agent pays with tokens
- ✅ First token distribution completed
- ✅ 30%+ verifications use $KINETIX

### Week 10-11 Checkpoint
- ✅ All systems integrated
- ✅ Unified revenue tracking working
- ✅ Telegram dashboard operational
- ✅ Total revenue > operational costs

### Week 12 Checkpoint
- ✅ 72 hours stable operation
- ✅ Zero critical errors
- ✅ All cron jobs running
- ✅ Public announcement made
- ✅ **KINETIX IS SELF-SUSTAINING! 🎉**

---

## 🔧 Key Commands Reference

### Testing & Validation
```bash
# Complete verification
node scripts/complete-clawstr-verification.js <commitment_id>

# Submit to reputation registry
node scripts/test-reputation-submission.js

# Test x402 payment
npx awal@latest x402 pay <endpoint> -X POST -d '{...}'

# Search Bazaar
npx awal@latest x402 bazaar search verification

# Check wallet status
npx awal@latest status
```

### Development
```bash
# Install dependencies
npm install @coinbase/x402-express

# Test on Sepolia
NETWORK_ID=base-sepolia node api/x402-server.js

# Deploy to mainnet
NETWORK_ID=base-mainnet node api/x402-server.js
```

### Operations
```bash
# Collect trading fees
node scripts/collect-uniswap-fees.js

# Manual rebalancing
node scripts/rebalance-portfolio.js

# Distribute tokens
node scripts/distribute-rewards.js
```

### Monitoring
```bash
# View logs
tail -f logs/autonomous-agent.log

# Check cron jobs
crontab -l

# Monitor wallet
grep -i "balance" logs/autonomous-agent.log
```

---

## 📞 Emergency Contacts

**If something goes wrong:**

1. **Stop autonomous operations:**
   ```bash
   # Disable cron jobs
   crontab -r

   # Stop x402 server
   pkill -f "x402-server.js"
   ```

2. **Check wallet balance:**
   ```bash
   npx awal@latest status
   ```

3. **Review recent transactions:**
   ```bash
   tail -100 logs/autonomous-agent.log
   ```

4. **Contact owner via Telegram**
   - Use admin ID from `.env`
   - Send `/emergency_stop` command

---

**Ready to build the future of autonomous AI! 🚀**

Start with: Complete Clawstr verification tomorrow!
