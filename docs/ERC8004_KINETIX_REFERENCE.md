# ERC-8004 Implementation Reference - Kinetix Specific Information

## Last Updated: 2026-02-12

---

## 🎉 Kinetix ERC-8004 Registration - LIVE

**Status:** ✅ Successfully registered on Base Mainnet

**Base Mainnet Registration:**
- **Token ID:** `16892`
- **Wallet:** `0x821a61d2C3E02446eD03285df1618639eF25D2b9`
- **IPFS Hash:** `Qmb42i19hNCNvVhPLHJmfPnKMMCmsrxxVa8YpBRW5bzWwz`
- **Transaction:** [`0x64cce47b38c26fcdb515b66e7e3416da061358275922fbf9be1827dffb0bfff8`](https://basescan.org/tx/0x64cce47b38c26fcdb515b66e7e3416da061358275922fbf9be1827dffb0bfff8)
- **8004scan:** [View Agent Profile](https://8004scan.io/agent/16892)
- **IPFS Metadata:** [View on Gateway](https://gateway.pinata.cloud/ipfs/Qmb42i19hNCNvVhPLHJmfPnKMMCmsrxxVa8YpBRW5bzWwz)
- **Gas Cost:** 0.000000635003579828 ETH ($0.001243)
- **Registered:** 2026-02-12

**Base Sepolia Testnet (Testing):**
- **Token ID:** `509`
- **Transaction:** [`0x0f5345c48288bf647fe5c84f9bf0f7a5afac88eae5347dc590e1934bd6a74fad`](https://sepolia.basescan.org/tx/0x0f5345c48288bf647fe5c84f9bf0f7a5afac88eae5347dc590e1934bd6a74fad)
- **8004scan:** [View Test Profile](https://8004scan.io/agent/509)

This document contains Kinetix-specific addresses, configurations, and implementation details for ERC-8004 integration. Use this as the authoritative source for implementation.

---

## Kinetix Identity Information

### Agent Details
- **Name:** Kinetix
- **Type:** Verification Infrastructure Agent
- **Mission:** "Built reputation in health. Now building reputation infrastructure for all agents."
- **Specialization:** Commitment verification with diagnostic rigor (Consistency, Quality, Time-bound)

### On-Chain Addresses 

**Kinetix CDP EVM Wallet (Base):**
```
0xD239173c897C24b477F96AFd544195c1606Dd691
```
- Network: Base Mainnet (Chain ID: 8453)
- Use: Agent's primary wallet for ERC-8004 registration and reputation submissions
- Managed via: Coinbase AgentKit (CDP SDK)

**$KINETIX Token Contract:**
```
0x208a33Fa8A72b504b309a6869390072d712E179d
```
- Network: Base Mainnet
- Symbol: $KINETIX
- Decimals: 18
- Use Cases:
  - Payment for verification services (50% discount vs USDC)
  - Governance for agent behavior/priorities
  - Access to premium features
  - Community rewards
- Explorer: https://basescan.org/token/0x208a33Fa8A72b504b309a6869390072d712E179d
- DEX: https://dexscreener.com/base/0x208a33Fa8A72b504b309a6869390072d712E179d

**USDC Contract (Base):**
```
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```
- Network: Base Mainnet
- Decimals: 6
- Use: Alternative payment for verification services (base price)

---

## ERC-8004 Registration Details

### Kinetix Metadata JSON Structure

Use this template for `config/erc8004/kinetix_metadata.json`:

```json
{
  "name": "Kinetix",
  "version": "1.0.0",
  "type": "verification_infrastructure",
  "description": "Verification infrastructure agent for AI agents. Built reputation in health, now building reputation infrastructure for all agents. Specializes in commitment verification with diagnostic rigor—evidence-based, pattern recognition, objective criteria.",

  "capabilities": {
    "verification_types": [
      "consistency_verification",
      "quality_verification",
      "time_bound_verification"
    ],
    "platforms_monitored": [
      "moltbook",
      "clawstr",
      "base_onchain"
    ],
    "output_formats": [
      "cryptographic_attestations",
      "eip712_signatures",
      "ecdsa_receipts"
    ],
    "specializations": [
      "commitment_tracking",
      "evidence_collection",
      "pattern_recognition",
      "diagnostic_validation"
    ]
  },

  "endpoints": {
    "api_base": "https://kinetix-api.com/v1",
    "verification": "https://kinetix-api.com/v1/verify",
    "attestation": "https://kinetix-api.com/v1/attestation",
    "status": "https://kinetix-api.com/v1/status",
    "manifest": "https://kinetix-api.com/v1/manifest"
  },

  "protocols": [
    "ERC-8004",
    "EIP-712",
    "HTTPS/REST"
  ],

  "blockchain": {
    "primary_network": "base",
    "chain_id": 8453,
    "wallet_address": "0xD239173c897C24b477F96AFd544195c1606Dd691"
  },

  "token": {
    "symbol": "KINETIX",
    "name": "$KINETIX",
    "contract_address": "0x208a33Fa8A72b504b309a6869390072d712E179d",
    "network": "base",
    "chain_id": 8453,
    "decimals": 18,
    "purpose": "verification_service_payment",
    "explorer": "https://basescan.org/token/0x208a33Fa8A72b504b309a6869390072d712E179d",
    "dex": "https://dexscreener.com/base/0x208a33Fa8A72b504b309a6869390072d712E179d"
  },

  "pricing": {
    "base_currency": "USDC",
    "verification_fee_usdc": "5.00",
    "verification_fee_kinetix": {
      "amount_usd_equivalent": "5.00",
      "discount": "50%",
      "effective_cost": "2.50 USDC equivalent in $KINETIX"
    },
    "payment_methods": [
      "USDC",
      "$KINETIX"
    ]
  },

  "social": {
    "twitter": "@Kinetix",
    "moltbook": "https://www.moltbook.com/u/Kinetix",
    "clawstr": "npub1kinetix...",
    "github": "https://github.com/kinetix-agent",
    "website": "https://kinetix.com"
  },

  "verification_service": {
    "commitment_types": [
      {
        "type": "consistency",
        "description": "Regular frequency verification (e.g., daily posts, weekly updates)",
        "metrics": ["frequency", "timing", "adherence"]
      },
      {
        "type": "quality",
        "description": "Metrics-based verification (e.g., response time, satisfaction scores)",
        "metrics": ["quality_score", "performance", "completion"]
      },
      {
        "type": "time_bound",
        "description": "Deadline/milestone-based verification",
        "metrics": ["on_time_delivery", "milestone_completion", "deadline_adherence"]
      }
    ],
    "evidence_sources": [
      "moltbook_posts",
      "moltbook_comments",
      "clawstr_events",
      "onchain_transactions",
      "api_logs"
    ],
    "attestation_format": "cryptographic_receipt",
    "signature_scheme": "ECDSA",
    "signature_standard": "EIP-712"
  },

  "metadata": {
    "created_at": "2025-01-15T00:00:00Z",
    "updated_at": "2026-02-10T00:00:00Z",
    "erc8004_version": "1.0",
    "agent_version": "1.0.0",
    "contact": "admin@kinetix.com"
  }
}
```

---

## Implementation Sequencing (IMPORTANT)

### Phase 1: ERC-8004 Identity & Reputation (Current Priority)
**Timeline:** 3 weeks (February 2026)

**Rationale:**
- Establishes Kinetix's on-chain identity and discoverability
- Builds reputation history through attestations
- Positions as early adopter in ERC-8004 standard
- Creates trust foundation for future payment integrations

**Deliverables:**
1. Kinetix registered on ERC-8004 Identity Registry (Base mainnet)
2. Attestations automatically submitted to Reputation Registry
3. Public reputation history visible on-chain
4. IPFS metadata and attestation storage

### Phase 2: x402 Micropayment Integration (After ERC-8004)
**Timeline:** TBD (After ERC-8004 completion)

**Rationale:**
- x402 requires established reputation/trust for adoption
- Payment integrations benefit from on-chain identity verification
- Agents more likely to use verification services from registered/reputable agent
- x402 endpoints can be added to ERC-8004 metadata after implementation

**Approach:**
1. Complete ERC-8004 integration fully first
2. Build initial reputation through attestations
3. Implement x402 protocol for automated verification payments
4. Update ERC-8004 metadata with x402 endpoint information
5. Submit metadata update to IPFS and update Identity Registry

**Why This Order:**
- ✅ Identity first → Discoverability
- ✅ Reputation second → Trust building
- ✅ Payments third → Monetization with trust foundation

---

## ERC-8004 Contract Addresses

### Base Mainnet (Primary)
```
Identity Registry:   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
Reputation Registry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
```

### Base Sepolia (Testing)
```
Identity Registry:   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
Reputation Registry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
```

### Ethereum Mainnet (Optional Future)
```
Identity Registry:   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
Reputation Registry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
```

**Deployment Strategy:** Start with Base mainnet (lower gas costs), expand to Ethereum mainnet if cross-chain reputation aggregation becomes important.

---

## Key Implementation Notes

### 1. Wallet Funding
The Kinetix CDP wallet (`0xD239173c897C24b477F96AFd544195c1606Dd691`) needs Base ETH for:
- Identity registration (~$0.001-0.002 one-time on Base mainnet, FREE on Sepolia testnet)
- Reputation submissions (~$0.001-0.01 per batch on Base mainnet)
- IPFS pinning operations

**Recommended:** Fund with ~$5-10 Base ETH to cover initial setup and several months of reputation submissions. Base mainnet gas fees are extremely low compared to Ethereum mainnet.

### 2. IPFS Strategy
- Use Pinata for IPFS uploads (free tier sufficient)
- Store both:
  - Agent metadata JSON (one-time, updated occasionally)
  - Attestation receipts (ongoing, per verification)
- Keep local backup of all IPFS hashes and CIDs

### 3. Database Schema
Add to existing Kinetix database:

```sql
-- ERC-8004 Identity tracking
CREATE TABLE erc8004_identity (
  id SERIAL PRIMARY KEY,
  token_id VARCHAR(78) NOT NULL UNIQUE,  -- ERC-721 token ID
  ipfs_hash VARCHAR(64) NOT NULL,
  ipfs_gateway_url TEXT,
  metadata_json JSONB,
  registered_at TIMESTAMP DEFAULT NOW(),
  tx_hash VARCHAR(66),
  block_number BIGINT
);

-- ERC-8004 Reputation submissions
CREATE TABLE erc8004_reputation (
  id SERIAL PRIMARY KEY,
  attestation_id UUID REFERENCES attestations(id),
  ipfs_attestation_hash VARCHAR(64),
  reputation_score INTEGER CHECK (reputation_score >= 0 AND reputation_score <= 100),
  reputation_category VARCHAR(50),
  submitted BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMP,
  tx_hash VARCHAR(66),
  batch_id UUID,
  gas_used BIGINT,
  gas_price_gwei DECIMAL(10,2)
);

-- Batch submission tracking
CREATE TABLE erc8004_batches (
  id UUID PRIMARY KEY,
  attestation_count INTEGER,
  total_gas_used BIGINT,
  avg_gas_price_gwei DECIMAL(10,2),
  total_cost_eth DECIMAL(18,8),
  submitted_at TIMESTAMP,
  tx_hash VARCHAR(66),
  status VARCHAR(20)  -- pending, success, failed
);
```

### 4. Attestation → Reputation Mapping

Kinetix's attestation `verification_result.status` maps to ERC-8004 reputation scores:

| Verification Status | Reputation Score | Category |
|---------------------|-----------------|----------|
| `verified` | 90-100 | `high_quality` |
| `partial` | 50-89 | `moderate_quality` |
| `failed` | 0-49 | `needs_improvement` |

**Algorithm:**
```javascript
function calculateReputationScore(attestation) {
  const status = attestation.verification_result.status;
  const overallScore = attestation.verification_result.overall_score;

  if (status === 'verified') {
    return Math.max(90, Math.min(100, overallScore));
  } else if (status === 'partial') {
    return Math.max(50, Math.min(89, overallScore));
  } else {
    return Math.min(49, overallScore);
  }
}
```

### 5. Gas Optimization

**Batch Submission Strategy:**
- Collect attestations throughout the day
- Submit batch once daily (e.g., 2 AM UTC when gas is typically lower)
- Use multicall pattern if available in Reputation Registry
- Set gas price limit: pause submissions if gas > 10 gwei

**Estimated Costs (Base Network):**
- Single reputation submission: ~$0.001-0.01 on Base mainnet
- Batch of 10 submissions: ~$0.01-0.05 (10x cheaper per attestation)
- Annual (1000 attestations, batched): ~$10-50 on Base mainnet

**Note:** These Base mainnet costs are ~99% cheaper than Ethereum mainnet, which would cost $100-150 for identity registration and $15-25 per reputation submission.

---

## x402 Integration Notes (Future)

When implementing x402 after ERC-8004:

### x402 Endpoint Structure (To Be Added)
```json
{
  "x402": {
    "version": "1.0",
    "payment_endpoint": "https://kinetix-api.com/v1/x402/payment",
    "supported_currencies": ["USDC", "KINETIX"],
    "verification_cost": {
      "usdc": "5.00",
      "kinetix": "2.50"  // 50% discount
    },
    "payment_flow": "agent_to_agent_micropayment",
    "settlement_network": "base",
    "settlement_address": "0xD239173c897C24b477F96AFd544195c1606Dd691"
  }
}
```

### Metadata Update Process
1. Implement x402 payment handlers
2. Add x402 fields to metadata JSON
3. Upload updated metadata to IPFS (new hash)
4. Call Identity Registry `updateMetadata()` with new IPFS hash
5. Verify update on 8004scan.io

---

## Testing Checklist

### Pre-Mainnet Testing (Base Sepolia)
- [ ] Fund testnet wallet with Sepolia ETH (faucet)
- [ ] Upload test metadata to IPFS
- [ ] Register identity on testnet Identity Registry
- [ ] Verify token ID and metadata on testnet explorer
- [ ] Create test attestation
- [ ] Submit test reputation to testnet Reputation Registry
- [ ] Verify reputation on-chain
- [ ] Test batch submission with multiple attestations
- [ ] Validate gas cost estimates

### Mainnet Deployment
- [ ] Fund mainnet wallet with ~$5-10 Base ETH (Base gas fees are ~99% cheaper than Ethereum)
- [ ] Set up Pinata production account
- [ ] Upload final metadata to IPFS
- [ ] Register identity on Base mainnet
- [ ] Verify on BaseScan and 8004scan.io
- [ ] Submit first reputation (manual test)
- [ ] Deploy batch submission cron
- [ ] Monitor first 48 hours
- [ ] Announce on Moltbook and Clawstr

---

## Monitoring & Alerts

### Key Metrics to Track
- ERC-8004 token ID: [To be set after registration]
- Total reputation submissions: 0 (initial)
- Average gas cost per submission: TBD
- IPFS upload success rate: Target 99%+
- Batch submission frequency: Daily at 2 AM UTC

### Alert Thresholds
- ⚠️ Warning: Gas price > 5 gwei (pause submissions)
- 🚨 Critical: Gas price > 10 gwei (stop all submissions)
- 🚨 Critical: Wallet balance < $1 Base ETH (refill needed)
- ⚠️ Warning: IPFS upload failure rate > 5%
- 🚨 Critical: Reputation submission failure rate > 10%

---

## Implementation Contacts & Resources

### Kinetix Team
- Admin: Keith (@kpj)
- Wallet: `0xD239173c897C24b477F96AFd544195c1606Dd691`
- Contact: admin@kinetix.com

### External Resources
- ERC-8004 Spec: https://eip.tools/eip/8004
- Base Docs: https://docs.base.org
- BaseScan: https://basescan.org
- 8004scan: https://8004scan.io
- Pinata IPFS: https://www.pinata.cloud
- CDP AgentKit: https://docs.cdp.coinbase.com/agentkit

### Support Channels
- ERC-8004 Discord: [TBD]
- Base Discord: https://discord.gg/buildonbase
- Coinbase Developer Discord: [TBD]

---

## Version History

- **v1.0 (2026-02-10):** Initial reference document created
  - Added Kinetix wallet and token addresses
  - Defined implementation sequencing (ERC-8004 before x402)
  - Created metadata template
  - Established cost estimates and monitoring strategy

---

**Ready for Implementation!** 🚀

Use this document as the authoritative reference for all Kinetix-specific details during ERC-8004 integration.
