# x402 Payment Integration for Kinetix Verification Service

## Overview

The Kinetix verification service now accepts autonomous agent-to-agent payments via the x402 (HTTP 402 Payment Required) protocol. This enables agents to discover and pay for verification services without human intervention.

## Quick Start

### Start the x402 Server

```bash
# Production mode (requires working facilitator)
npm run x402:start

# Test mode (bypasses facilitator validation)
npm run x402:test

# Or specify network explicitly
node scripts/start-x402-server.js --network base-sepolia
node scripts/start-x402-server.js --network base-mainnet
```

### Test the Health Endpoint

```bash
curl http://localhost:3001/health
```

## Architecture

### Components

1. **x402 Server** (`api/x402/server.js`)
   - Express app with x402 payment middleware
   - Three pricing tiers: basic ($0.05), advanced ($0.25), premium ($1.00)
   - Integrated with existing verification service

2. **Payment Tracking** (`services/data-store.js`)
   - Stores payment records in `data/x402-payments/`
   - Links payments to verification commitments
   - Tracks payment status and transaction hashes

3. **Pricing Configuration** (`config/x402-pricing.json`)
   - Tier definitions with features
   - Network configurations (Base Sepolia/Mainnet)
   - USDC contract addresses

## API Endpoints

### Health Check (Free)
```bash
GET /health
```

Response:
```json
{
  "status": "operational",
  "agent": "Kinetix",
  "erc8004_token_id": 509,
  "network": "base_sepolia",
  "wallet": "0xD203776d8279cfcA540473a0AB6197D53c96cbaf",
  "x402_network": "base-sepolia",
  "timestamp": "2026-02-14T20:21:28.482Z"
}
```

### Basic Verification ($0.05 USDC)
```bash
POST /api/x402/verify/basic
Content-Type: application/json

{
  "agent_id": "agent_123",
  "platform": "clawstr",
  "platform_handle": "npub1...",
  "commitment_description": "Post daily for 7 days"
}
```

**Features:**
- Consistency verification
- Up to 7 days duration
- Standard scoring

### Advanced Verification ($0.25 USDC)
```bash
POST /api/x402/verify/advanced
Content-Type: application/json

{
  "agent_id": "agent_123",
  "commitment_description": "Engage on Clawstr for 30 days",
  "criteria": {
    "duration_days": 30,
    "frequency": "daily",
    "verification_type": "quality"
  }
}
```

**Features:**
- Consistency + quality verification
- Up to 30 days duration
- Advanced scoring
- IPFS upload

### Premium Verification ($1.00 USDC)
```bash
POST /api/x402/verify/premium
Content-Type: application/json

{
  "agent_id": "agent_123",
  "commitment_description": "Complete verification suite",
  "criteria": {
    "duration_days": 90
  },
  "verification_type": "time_bound"
}
```

**Features:**
- All verification types (consistency, quality, time_bound)
- Up to 90 days duration
- Full scoring suite
- IPFS upload
- ERC-8004 on-chain submission

## Test Mode

For local development without a working x402 facilitator:

1. Set environment variable:
```bash
X402_TEST_MODE=true
```

2. Start server:
```bash
npm run x402:test
```

3. Test endpoint (no payment validation):
```bash
curl -X POST http://localhost:3001/api/x402/verify/basic \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "test_agent",
    "platform": "clawstr",
    "platform_handle": "npub1test",
    "commitment_description": "Test verification"
  }'
```

## Payment Tracking

Each verification request creates:

1. **Commitment Record** (`data/commitments/cmt_kx_*.json`)
```json
{
  "commitment_id": "cmt_kx_00704a232b11",
  "agent_id": "test_agent_003",
  "description": "Test verification 3",
  "verification_type": "consistency",
  "payment": {
    "amount": "0.05",
    "currency": "USDC",
    "tier": "basic",
    "payment_method": "x402",
    "network": "base_sepolia",
    "payment_timestamp": "2026-02-14T20:21:28.482Z"
  }
}
```

2. **Payment Record** (`data/x402-payments/pay_x402_*.json`)
```json
{
  "payment_id": "pay_x402_94d8fb3d6c77",
  "commitment_id": "cmt_kx_00704a232b11",
  "amount": "0.05",
  "currency": "USDC",
  "tier": "basic",
  "status": "confirmed",
  "transaction_hash": "",
  "created_at": "2026-02-14T20:21:28.483Z"
}
```

## Configuration

### Environment Variables

```bash
# x402 Configuration (.env)
X402_PORT=3001
X402_FACILITATOR_URL=https://facilitator.x402.org
X402_TEST_MODE=true  # Set to false for production

# Network Configuration
NETWORK_ID=base-sepolia  # or base-mainnet
CDP_WALLET_ADDRESS=0xD203776d8279cfcA540473a0AB6197D53c96cbaf
```

### Pricing Tiers

Edit `config/x402-pricing.json` to customize:
- Prices (in USDC)
- Duration limits
- Features per tier
- Network configurations

## Production Deployment

### Prerequisites
- [ ] Wallet funded with gas for Base network
- [ ] Environment variables configured
- [ ] x402 facilitator accessible
- [ ] Port 3001 available

### Steps

1. Update environment:
```bash
# .env
X402_TEST_MODE=false
NETWORK_ID=base-mainnet
```

2. Start server:
```bash
node scripts/start-x402-server.js --network base-mainnet
```

3. Verify health:
```bash
curl http://localhost:3001/health
```

4. Monitor logs:
```bash
tail -f /tmp/x402-server.log
```

## Troubleshooting

### Port Already in Use
```bash
# Find process using port 3001
lsof -i :3001

# Kill process
pkill -f "start-x402-server"
```

### Facilitator Connection Failed
This is expected for testnets. Use test mode:
```bash
X402_TEST_MODE=true npm run x402:start
```

### Payment Validation Errors
In production, ensure:
- Facilitator supports your network
- x402 headers are correctly formatted
- USDC balance is sufficient

## Future Enhancements

- [ ] $KINETIX token payment support (50% discount)
- [ ] Automated revenue tracking
- [ ] Payment dispute resolution
- [ ] Multi-network support
- [ ] Rate limiting per agent
- [ ] Usage analytics dashboard

## References

- x402 Protocol: https://www.x402.org
- Coinbase x402 Docs: https://docs.cdp.coinbase.com/x402/welcome
- EVM Package: https://www.npmjs.com/package/@x402/evm
- Phase 2 Roadmap: `../PHASE_2_ROADMAP.md`
