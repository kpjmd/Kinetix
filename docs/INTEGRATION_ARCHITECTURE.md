# ERC-8004 Integration Architecture for Kinetix

## Overview

This document describes how ERC-8004 integration fits into the existing Kinetix infrastructure, including project structure, data flow, and system interactions.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Kinetix System                          │
│                                                                 │
│  ┌────────────────┐         ┌──────────────────┐              │
│  │  Telegram Bot  │────────▶│  Node.js Backend │              │
│  └────────────────┘         └──────────────────┘              │
│                                      │                          │
│                                      ▼                          │
│                    ┌─────────────────────────────┐             │
│                    │  Verification Engine        │             │
│                    │  - Consistency              │             │
│                    │  - Quality                  │             │
│                    │  - Time-bound               │             │
│                    └─────────────────────────────┘             │
│                                      │                          │
│                                      ▼                          │
│                    ┌─────────────────────────────┐             │
│                    │  Attestation Generator      │             │
│                    │  (EIP-712 Signatures)       │             │
│                    └─────────────────────────────┘             │
│                                      │                          │
│                                      ▼                          │
│                    ┌─────────────────────────────┐             │
│                    │  NEW: ERC-8004 Integration  │◀──────────┐ │
│                    │  - IPFS Upload              │           │ │
│                    │  - Reputation Submission    │           │ │
│                    │  - Token ID Management      │           │ │
│                    └─────────────────────────────┘           │ │
│                                      │                        │ │
└──────────────────────────────────────┼────────────────────────┼─┘
                                       │                        │
                                       ▼                        │
                    ┌─────────────────────────────┐            │
                    │  External Services          │            │
                    ├─────────────────────────────┤            │
                    │  - Pinata (IPFS)            │            │
                    │  - Base RPC                 │            │
                    │  - Identity Registry        │            │
                    │  - Reputation Registry      │            │
                    └─────────────────────────────┘            │
                                       │                        │
                                       ▼                        │
                    ┌─────────────────────────────┐            │
                    │  Base Blockchain            │            │
                    │  - Identity NFTs            │            │
                    │  - Reputation Data          │            │
                    └─────────────────────────────┘            │
                                                                │
                                       ┌────────────────────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────┐
                    │  8004scan.io Explorer       │
                    │  (Public Verification)      │
                    └─────────────────────────────┘
```

## Project Structure

```
kinetix/
├── src/
│   ├── bot/                    # Existing Telegram bot
│   ├── verification/           # Existing verification logic
│   ├── attestation/            # Existing attestation generation
│   │
│   └── erc8004/                # NEW: ERC-8004 integration
│       ├── config/
│       │   ├── networks.js     # Network configurations
│       │   ├── contracts.js    # Contract addresses & ABIs
│       │   └── ipfs.js         # IPFS client setup
│       │
│       ├── services/
│       │   ├── identity.js     # Identity Registry interactions
│       │   ├── reputation.js   # Reputation Registry interactions
│       │   ├── ipfs.js         # IPFS upload/retrieval
│       │   └── mapping.js      # Attestation → Reputation mapping
│       │
│       ├── models/
│       │   ├── Agent.js        # Agent model with ERC-8004 fields
│       │   └── Submission.js   # Reputation submission tracking
│       │
│       ├── utils/
│       │   ├── gas.js          # Gas estimation & optimization
│       │   ├── encoding.js     # ABI encoding helpers
│       │   └── events.js       # Event parsing
│       │
│       └── index.js            # Main ERC-8004 module export
│
├── scripts/
│   └── erc8004/
│       ├── 01-register-identity.js
│       ├── 02-test-reputation.js
│       ├── 03-batch-submit.js
│       └── 04-query-reputation.js
│
├── database/
│   └── migrations/
│       └── 001-erc8004-tables.sql
│
├── tests/
│   └── erc8004/
│       ├── identity.test.js
│       ├── reputation.test.js
│       └── integration.test.js
│
├── config/
│   ├── erc8004-abis.json       # Contract ABIs
│   └── .env.example            # Environment template
│
└── docs/
    ├── ERC8004_Quick_Start_Guide_v2_BASE.md
    └── INTEGRATION_ARCHITECTURE.md (this file)
```

## Data Flow

### 1. Agent Registration Flow

```
User Request → Telegram Bot
              │
              ▼
       Generate Metadata JSON
              │
              ▼
       Upload to IPFS (Pinata)
              │
              ▼
       Get IPFS Hash (CID)
              │
              ▼
       Call Identity Registry
       (registerAgent)
              │
              ▼
       Parse Transaction Receipt
       Extract Token ID
              │
              ▼
       Store in Database
       (agent_id → token_id mapping)
              │
              ▼
       Return Success to User
```

### 2. Attestation → Reputation Flow

```
Verification Complete
              │
              ▼
       Generate Attestation Receipt
       (Existing Process)
              │
              ▼
       Map to ERC-8004 Format
       - Extract score
       - Generate evidence hash
       - Create category
              │
              ▼
       Upload Full Attestation to IPFS
              │
              ▼
       Encode Metadata (ABI)
              │
              ▼
       Add to Batch Queue
              │
              ▼
       [Daily Batch Process]
       Submit Batch to Reputation Registry
              │
              ▼
       Store Transaction Hash
       Update Submission Status
              │
              ▼
       Success → Agent Notified
```

## Database Schema Additions

### New Tables

#### 1. `erc8004_agents` Table

```sql
CREATE TABLE erc8004_agents (
    id SERIAL PRIMARY KEY,
    agent_id VARCHAR(255) UNIQUE NOT NULL,  -- Internal Kinetix agent ID
    erc8004_token_id BIGINT UNIQUE,         -- ERC-8004 token ID (NULL until registered)
    network VARCHAR(50) DEFAULT 'base_mainnet',  -- base_mainnet, ethereum_mainnet, etc.
    metadata_ipfs_hash VARCHAR(255),         -- IPFS hash of agent metadata
    registration_tx_hash VARCHAR(66),        -- Transaction hash of registration
    registration_date TIMESTAMP,
    last_metadata_update TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agent_id ON erc8004_agents(agent_id);
CREATE INDEX idx_token_id ON erc8004_agents(erc8004_token_id);
```

#### 2. `erc8004_reputation_submissions` Table

```sql
CREATE TABLE erc8004_reputation_submissions (
    id SERIAL PRIMARY KEY,
    attestation_receipt_id VARCHAR(255) NOT NULL,  -- Links to existing attestation
    agent_erc8004_token_id BIGINT NOT NULL,
    score SMALLINT NOT NULL CHECK (score >= 0 AND score <= 100),
    evidence_hash VARCHAR(66) NOT NULL,  -- Keccak256 hash
    category VARCHAR(100) NOT NULL,
    ipfs_hash VARCHAR(255),  -- Full attestation stored on IPFS
    encoded_metadata TEXT,   -- ABI-encoded metadata
    transaction_hash VARCHAR(66),
    block_number BIGINT,
    submission_status VARCHAR(50) DEFAULT 'pending',  -- pending, submitted, confirmed, failed
    batch_id VARCHAR(255),   -- For batch submissions
    gas_used BIGINT,
    submitted_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_attestation_id ON erc8004_reputation_submissions(attestation_receipt_id);
CREATE INDEX idx_token_id ON erc8004_reputation_submissions(agent_erc8004_token_id);
CREATE INDEX idx_status ON erc8004_reputation_submissions(submission_status);
CREATE INDEX idx_batch ON erc8004_reputation_submissions(batch_id);
```

#### 3. `erc8004_batch_submissions` Table

```sql
CREATE TABLE erc8004_batch_submissions (
    id SERIAL PRIMARY KEY,
    batch_id VARCHAR(255) UNIQUE NOT NULL,
    network VARCHAR(50) NOT NULL,
    transaction_hash VARCHAR(66),
    block_number BIGINT,
    attestation_count INTEGER NOT NULL,
    total_gas_used BIGINT,
    status VARCHAR(50) DEFAULT 'pending',
    submitted_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_batch_id ON erc8004_batch_submissions(batch_id);
CREATE INDEX idx_status ON erc8004_batch_submissions(status);
```

### Modifications to Existing Tables

#### Update `attestations` Table

```sql
-- Add ERC-8004 compatibility fields
ALTER TABLE attestations ADD COLUMN erc8004_evidence_hash VARCHAR(66);
ALTER TABLE attestations ADD COLUMN erc8004_category VARCHAR(100);
ALTER TABLE attestations ADD COLUMN erc8004_ipfs_hash VARCHAR(255);
ALTER TABLE attestations ADD COLUMN erc8004_submitted BOOLEAN DEFAULT FALSE;
ALTER TABLE attestations ADD COLUMN erc8004_submission_tx VARCHAR(66);
```

## API Endpoint Additions

### New ERC-8004 Endpoints

```
POST   /api/erc8004/agents/register
GET    /api/erc8004/agents/:agentId
GET    /api/erc8004/agents/:agentId/reputation
POST   /api/erc8004/reputation/submit
GET    /api/erc8004/status
GET    /api/erc8004/batches/:batchId
```

### Modified Existing Endpoints

```
GET    /api/attestations/:receiptId
       → Now includes ERC-8004 fields if submitted

POST   /api/verification/complete
       → Automatically queues for ERC-8004 submission if enabled
```

## Configuration Management

### Environment Variables

See `.env.example` for complete list. Key variables:

```bash
# Network selection
DEFAULT_NETWORK=base_mainnet

# Feature flags
AUTO_SUBMIT_REPUTATION=false
ENABLE_BATCH_SUBMISSIONS=true

# Security
REQUIRE_MAINNET_APPROVAL=true
MAX_TX_VALUE_ETH=0.1
```

### Network Configuration

```javascript
// src/erc8004/config/networks.js
module.exports = {
  base_mainnet: {
    rpcUrl: process.env.BASE_MAINNET_RPC_URL,
    chainId: 8453,
    name: 'Base',
    explorer: 'https://basescan.org'
  },
  base_sepolia: {
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
    chainId: 84532,
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org'
  }
};
```

## Integration Points

### 1. Attestation Generation

**Current Flow:**
```javascript
// Existing code
const attestation = generateAttestation(commitment, verificationResult);
await saveToDatabase(attestation);
```

**Enhanced Flow:**
```javascript
// Enhanced with ERC-8004
const attestation = generateAttestation(commitment, verificationResult);

// Add ERC-8004 fields
attestation.erc8004 = {
  evidence_hash: calculateEvidenceHash(attestation),
  category: `verification_${commitment.verification_type}`,
  ipfs_hash: null,  // Set during submission
  submitted: false,
  submission_tx: null
};

await saveToDatabase(attestation);

// Optionally queue for ERC-8004 submission
if (config.AUTO_SUBMIT_REPUTATION) {
  await queueForERC8004Submission(attestation);
}
```

### 2. Agent Lookup

**Helper Function:**
```javascript
// src/erc8004/utils/lookup.js
async function getERC8004TokenId(agentId) {
  const record = await db.query(
    'SELECT erc8004_token_id FROM erc8004_agents WHERE agent_id = $1',
    [agentId]
  );
  
  if (!record || !record.erc8004_token_id) {
    throw new Error(`Agent ${agentId} not registered on ERC-8004`);
  }
  
  return record.erc8004_token_id;
}
```

### 3. Batch Processing

**Cron Job:**
```javascript
// Schedule daily at 2 AM UTC (low gas period)
cron.schedule('0 2 * * *', async () => {
  if (config.ENABLE_BATCH_SUBMISSIONS) {
    await processBatchReputationSubmissions();
  }
});
```

## Monitoring & Observability

### Metrics to Track

1. **Registration Metrics:**
   - Agents registered on ERC-8004
   - Registration success/failure rate
   - Gas costs per registration

2. **Reputation Metrics:**
   - Attestations submitted
   - Batch submission efficiency
   - Average gas cost per attestation
   - Submission latency (creation → on-chain)

3. **IPFS Metrics:**
   - Upload success rate
   - Retrieval success rate
   - Average upload time

4. **Error Tracking:**
   - Failed transactions (by reason)
   - Gas estimation errors
   - IPFS failures

### Logging Strategy

```javascript
// Use structured logging
logger.info('ERC-8004 reputation submitted', {
  attestationId: receipt.receipt_id,
  agentTokenId: tokenId,
  score: score,
  txHash: tx.hash,
  gasUsed: receipt.gasUsed,
  network: 'base_mainnet'
});
```

## Security Considerations

### 1. Private Key Management

- Never commit `.env` with real keys
- Use environment variables or secret management service
- Consider using hardware wallet for mainnet
- Implement transaction approval workflow for mainnet

### 2. Transaction Safety

- Estimate gas before submitting
- Set max gas price limits
- Implement retry logic with exponential backoff
- Verify transaction success before updating database

### 3. Data Validation

- Validate all inputs before blockchain interaction
- Verify signatures on attestations
- Check agent ownership before submissions
- Sanitize metadata before IPFS upload

## Testing Strategy

### 1. Unit Tests

- Test mapping functions
- Test encoding/decoding
- Test event parsing
- Mock blockchain interactions

### 2. Integration Tests

- Test on Base Sepolia testnet
- Verify full registration flow
- Test batch submissions
- Test error handling

### 3. End-to-End Tests

- Complete agent lifecycle
- Attestation → Reputation flow
- Cross-service communication

## Deployment Checklist

- [ ] Environment variables configured
- [ ] Database migrations run
- [ ] Testnet testing complete
- [ ] IPFS credentials configured
- [ ] Monitoring setup
- [ ] Error alerting configured
- [ ] Documentation updated
- [ ] Team trained on new workflows

## Rollback Plan

If issues arise:

1. Disable `AUTO_SUBMIT_REPUTATION` flag
2. Stop cron job for batch submissions
3. Existing attestation system continues working
4. No data loss (attestations still generated)
5. Fix issues, re-enable incrementally

## Future Enhancements

1. **Multi-Network Support:**
   - Register on multiple networks simultaneously
   - Aggregate reputation across chains

2. **Advanced Batching:**
   - Dynamic batch sizing based on gas prices
   - Priority queue for urgent submissions

3. **Reputation Analytics:**
   - Dashboard showing ERC-8004 metrics
   - Comparison with other verification providers

4. **Automation:**
   - Auto-registration for new agents
   - Automatic metadata updates

## Support & Resources

- **ERC-8004 Spec:** https://eip.tools/eip/8004
- **Base Docs:** https://docs.base.org
- **BaseScan:** https://basescan.org
- **8004scan Explorer:** https://8004scan.io
- **Kinetix Team:** Internal documentation

---

**Document Version:** 1.0  
**Last Updated:** February 10, 2026  
**Maintained By:** Kinetix Development Team
