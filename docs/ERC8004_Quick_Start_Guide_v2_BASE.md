# ERC-8004 Integration Quick Start Guide for Kinetix

**Date:** February 10, 2026  
**Purpose:** Actionable implementation guide based on official ERC-8004 sources

## Official Sources
- **EIP Spec**: https://eip.tools/eip/8004
- **Contracts**: https://github.com/erc-8004/erc-8004-contracts
- **Reference Implementation**: https://github.com/ChaosChain/trustless-agents-erc-ri
- **Explorer**: https://github.com/alt-research/8004scan-issue-tracker

## Deployment Options & Cost Analysis

### Available Networks

**Base Mainnet** (✅ RECOMMENDED):
- Identity: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- Setup: ~$5 | Annual (1000 attestations): ~$500-2,000
- **Best for:** Fast deployment, cost optimization, scalability

**Ethereum Mainnet** (Optional Premium):
- Identity: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`  
- Reputation: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- Setup: ~$150 | Annual (1000 attestations): ~$15,000-25,000
- **Best for:** Maximum prestige, L1 credibility (if cost is not a concern)

**Base Sepolia Testnet** (Testing):
- Identity: `0x8004AA63c570c570eBF15376c0dB199918BFe9Fb`
- Reputation: `0x8004bd8daB57f14Ed299135749a5CB5c42d341BF`
- Free testnet ETH from Base Sepolia faucet

### Why Base First?

1. **97% cheaper setup** ($5 vs $150)
2. **69% cheaper over 3 years** ($6K vs $75K for 1000 annual attestations)
3. **Faster finality** (~2 seconds vs ~12 seconds)
4. **Same ERC-8004 standard** - official deployment, not a fork
5. **Coinbase backing** - credible L2 infrastructure
6. **Room to grow** - Can always mirror to Ethereum later

### Migration Path

**Phase 1** (Now - Month 3):
- Deploy on Base mainnet (~$5)
- Prove the model works
- Build reputation as verification provider

**Phase 2** (Optional, Month 6-12):
- If Kinetix becomes major player, mirror identity to Ethereum
- Maintain Base for daily operations
- Cross-reference both in marketing

## Executive Summary

**What is ERC-8004?**
The "Trustless Agents" standard for AI agent identity and reputation on Ethereum-compatible networks. Three registries:
1. Identity Registry (deployed on Ethereum & Base)
2. Reputation Registry (deployed on Ethereum & Base)
3. Validation Registry (in development)

**Official Base Mainnet Contracts:**
- Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

**Why Kinetix Should Integrate:**
- Perfect fit: Kinetix's verification services → ERC-8004's validation layer
- First-mover: No dedicated verification providers identified yet
- **Ultra-low cost**: ~$5 setup + $500-2,000/year operational (Base mainnet)
- Strategic: Positions Kinetix as trust infrastructure for agent economy

**Key Decision: Base-First Strategy** ✅
- Register identity on Base mainnet (fast & affordable, one-time ~$5)
- Submit reputation updates on Base (scalability, ~$0.30/attestation batched)
- Optional: Mirror to Ethereum later for maximum prestige (if needed)

## Week 1: Identity Registration

### Task 1: Create Kinetix Metadata JSON

Save as `kinetix_metadata.json`:

```json
{
  "$schema": "https://erc-8004.org/schemas/agent-metadata-v1.json",
  "version": "1.0.0",
  "agent": {
    "name": "Kinetix",
    "description": "Verification infrastructure for AI agents. Built reputation in musculoskeletal health, now building reputation infrastructure for all agents.",
    "type": "autonomous",
    "created": "2026-01-15T00:00:00Z"
  },
  "identity": {
    "publicKey": "[YOUR_PUBLIC_KEY]",
    "signatureScheme": "ECDSA",
    "controller": "[YOUR_WALLET_ADDRESS]"
  },
  "capabilities": [
    {
      "name": "Consistency Verification",
      "description": "Verify commitments based on action frequency across Moltbook, Clawstr, on-chain",
      "category": "verification"
    },
    {
      "name": "Quality Verification",
      "description": "Assess output quality against stated criteria",
      "category": "verification"
    },
    {
      "name": "Time-Bound Verification",
      "description": "Validate milestone completion and deadline adherence",
      "category": "verification"
    }
  ],
  "endpoints": [
    {
      "type": "api",
      "url": "https://api.kinetix.agent/v1",
      "protocol": "https",
      "authentication": "bearer"
    }
  ],
  "pricing": {
    "model": "dynamic",
    "currency": "KINETIX",
    "tokenAddress": "0x208a33Fa8A72b504b309a6869390072d712E179d",
    "basePrice": "2500000000000000000"
  },
  "verification": {
    "standards": ["ERC-8004", "EIP-712"],
    "attestationFormat": "EIP-712",
    "supportedTypes": ["consistency", "quality", "time_bound"]
  },
  "social": {
    "platforms": [
      {
        "name": "moltbook",
        "handle": "@kinetix",
        "verified": true
      }
    ]
  }
}
```

### Task 2: Upload to IPFS

```javascript
// Using Pinata
const pinata = require('@pinata/sdk')('YOUR_API_KEY', 'YOUR_SECRET');
const fs = require('fs');

const metadata = fs.readFileSync('./kinetix_metadata.json');
const result = await pinata.pinJSONToIPFS(JSON.parse(metadata));
const ipfsURI = `ipfs://${result.IpfsHash}`;
console.log('Metadata URI:', ipfsURI);
// Save this URI - you'll need it for registration
```

### Task 3: Register on Base Mainnet

```javascript
const { ethers } = require('ethers');

// Connect to Base mainnet
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Base mainnet Identity Registry
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const ABI = [
  'function registerAgent(string metadataURI) external returns (uint256)',
  'event AgentRegistered(uint256 indexed tokenId, address indexed controller, string metadataURI)'
];

const registry = new ethers.Contract(IDENTITY_REGISTRY, ABI, signer);

// Register on Base (costs ~$3-5 instead of $150!)
const tx = await registry.registerAgent(ipfsURI);
console.log('Transaction:', tx.hash);

const receipt = await tx.wait();
const event = receipt.logs.find(log => 
  log.topics[0] === ethers.id('AgentRegistered(uint256,address,string)')
);
const tokenId = ethers.toNumber(event.topics[1]);

console.log('Kinetix Token ID:', tokenId);
// SAVE THIS TOKEN ID - it's your permanent ERC-8004 identity
```

### Task 4: Verify on BaseScan & 8004scan.io

1. **BaseScan**: Visit `https://basescan.org/tx/[YOUR_TX_HASH]` to confirm transaction
2. **8004scan.io**: Visit `https://8004scan.io/agent/[YOUR_TOKEN_ID]` to see your agent profile

## Week 2: Reputation Integration

### Task 1: Map Attestation → Reputation

```javascript
function mapAttestationToReputation(attestation, agentTokenId) {
  const score = attestation.verification_result.overall_score;
  const category = `verification_${attestation.commitment.verification_type}`;
  const evidenceHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(attestation))
  );
  
  return {
    agentTokenId,
    score,
    evidenceHash,
    category
  };
}
```

### Task 2: Submit to Base Reputation Registry

```javascript
// Connect to Base mainnet
const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const baseSigner = new ethers.Wallet(process.env.PRIVATE_KEY, baseProvider);

// Base mainnet Reputation Registry
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const REP_ABI = [
  'function submitReputation(uint256 agentTokenId, uint8 score, bytes32 evidenceHash, string category, bytes metadata) external'
];

const repRegistry = new ethers.Contract(REPUTATION_REGISTRY, REP_ABI, baseSigner);

// Upload attestation to IPFS first
const ipfsResult = await pinata.pinJSONToIPFS(attestation);
const evidenceLocation = `ipfs://${ipfsResult.IpfsHash}`;

// Encode metadata
const metadata = ethers.AbiCoder.defaultAbiCoder().encode(
  ['string', 'string', 'string', 'uint256', 'string[]'],
  [
    'ERC-8004',
    'attestation',
    evidenceLocation,
    5, // difficulty score
    ['verification', attestation.commitment.verification_type]
  ]
);

// Submit to Base
const repData = mapAttestationToReputation(attestation, agentTokenId);
const tx = await repRegistry.submitReputation(
  repData.agentTokenId,
  repData.score,
  repData.evidenceHash,
  repData.category,
  metadata
);

await tx.wait();
console.log('Reputation submitted on Base:', tx.hash);
console.log('View on BaseScan:', `https://basescan.org/tx/${tx.hash}`);
```

### Task 3: Batch Submissions (Recommended)

```javascript
async function submitBatch(attestations, tokenIds) {
  const batch = attestations.map((att, i) => {
    const mapped = mapAttestationToReputation(att, tokenIds[i]);
    // Upload each to IPFS
    // Encode metadata
    return mapped;
  });
  
  await repRegistry.submitBatchReputation(
    batch.map(b => b.agentTokenId),
    batch.map(b => b.score),
    batch.map(b => b.evidenceHash),
    batch.map(b => b.category),
    batch.map(b => b.metadata)
  );
}

// Run daily: accumulate attestations, batch submit
```

## Schema Compatibility

### Upgrade Attestation Format

Add ERC-8004 fields to existing attestations:

```json
{
  "receipt_id": "uuid",
  "version": "2.0.0-erc8004",
  "commitment": {
    "agent_id": "string",
    "agent_erc8004_token_id": 12345,  // NEW: Add token ID
    // ... existing fields
  },
  "erc8004": {  // NEW: Add this section
    "evidence_hash": "0x...",
    "category": "verification_consistency",
    "ipfs_hash": "QmXXX",
    "submitted_to_chain": false,
    "submission_tx": null
  }
}
```

## Gas Costs

**Base Mainnet (RECOMMENDED):**
- Identity registration: ~$3-5 (ONE TIME) ✅
- Single reputation: ~$0.50-2
- Batch (10): ~$3 total = $0.30 each ✅

**Ethereum Mainnet (Optional Premium Tier):**
- Identity registration: ~$100-150 (ONE TIME)
- Reputation updates: ~$15-25 each

**Annual Cost Comparison** (1000 attestations):
- **Base only: $500-2,000** ✅ RECOMMENDED
- Ethereum only: $15,000-25,000
- Hybrid (ETH ID + Base Rep): $600-2,150

**3-Year Total Cost:**
- **Base: ~$6,000** ✅ RECOMMENDED
- Ethereum: ~$75,000
- **Savings: $69,000** by using Base!

## Success Checklist

**Week 1:**
- [ ] Create metadata JSON
- [ ] Upload to IPFS (Pinata)
- [ ] Register on **Base mainnet** Identity Registry (~$5)
- [ ] Get Kinetix token ID
- [ ] Verify on BaseScan & 8004scan.io

**Week 2:**
- [ ] Implement mapping function
- [ ] Test on Base Sepolia testnet
- [ ] Submit first real attestation on Base
- [ ] Set up batch submission

**Week 3:**
- [ ] Update API to include ERC-8004 fields
- [ ] Write agent onboarding docs
- [ ] Apply for verified provider status

## Next Steps

1. **TODAY**: Review this guide, approve dual-chain strategy
2. **THIS WEEK**: Complete Week 1 tasks (identity registration)
3. **NEXT WEEK**: Complete Week 2 tasks (reputation integration)
4. **ONGOING**: Batch submit attestations daily

## Resources

- Full research document: [comprehensive version with all ABIs, examples, risk analysis]
- ERC-8004 Discord: [check contracts repo for link]
- Kinetix implementation repo: [create dedicated repo for ERC-8004 integration]

---

**Ready to implement?** Start with Task 1: Create your metadata JSON!
