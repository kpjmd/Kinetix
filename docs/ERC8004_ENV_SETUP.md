# ERC-8004 Environment Setup Guide

## Required Environment Variables

Add these variables to your `.env` file before running the registration script.

### Network Configuration

```bash
# Base Network RPC URLs
BASE_MAINNET_RPC_URL=https://mainnet.base.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Network Selection (base_sepolia or base_mainnet)
DEFAULT_NETWORK=base_sepolia

# Safety Settings
TESTNET_MODE=true
REQUIRE_MAINNET_APPROVAL=true
```

### Pinata IPFS Configuration

Get your API keys from: https://app.pinata.cloud/developers/api-keys

```bash
# Pinata API Credentials
PINATA_API_KEY=your_pinata_api_key_here
PINATA_SECRET_API_KEY=your_pinata_secret_key_here

# IPFS Gateway
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
```

### ERC-8004 Registration Results

These will be populated AFTER successful registration:

```bash
# ERC-8004 Identity (set after registration)
KINETIX_ERC8004_TOKEN_ID=
KINETIX_METADATA_IPFS_HASH=
```

## Wallet Funding

The wallet derived from `KINETIX_SIGNING_KEY` (already in your `.env`) will be used for registration.

### Check Your Wallet Address

```bash
node -e "const ethers = require('ethers'); const w = new ethers.Wallet(process.env.KINETIX_SIGNING_KEY); console.log('Wallet Address:', w.address);"
```

### Fund Your Wallet

**Base Sepolia (Testnet - FREE):**
- Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- Request free testnet ETH for testing

**Base Mainnet (Production):**
- Bridge ETH to Base: https://bridge.base.org
- Need ~$5-10 ETH for registration and future operations

## Pre-Flight Checklist

Before running registration:

- [ ] Added all environment variables to `.env`
- [ ] Obtained Pinata API keys
- [ ] Wallet is funded with Base ETH (testnet for testing, mainnet for production)
- [ ] Verified wallet address matches expectations
- [ ] Network is set to `base_sepolia` for testing

## Running the Registration

### Test on Base Sepolia First (Recommended)

```bash
npm run register:erc8004 -- --network base_sepolia
```

Or:

```bash
node scripts/register-identity.js --network base_sepolia
```

### Deploy to Base Mainnet

```bash
npm run register:erc8004 -- --network base_mainnet
```

Or:

```bash
node scripts/register-identity.js --network base_mainnet
```

## After Registration

1. The script will output your Token ID and IPFS hash
2. Copy these values into your `.env` file:
   ```bash
   KINETIX_ERC8004_TOKEN_ID=<your_token_id>
   KINETIX_METADATA_IPFS_HASH=<your_ipfs_hash>
   ```
3. Verify registration on:
   - BaseScan: https://basescan.org/tx/<tx_hash>
   - 8004scan: https://8004scan.io/agent/<token_id>
   - IPFS: https://gateway.pinata.cloud/ipfs/<ipfs_hash>

## Results Storage

Registration data is saved to:
- `data/erc8004/identity-base_sepolia.json` (testnet)
- `data/erc8004/identity-base_mainnet.json` (mainnet)

## Troubleshooting

### "Pinata API credentials not found"
- Add `PINATA_API_KEY` and `PINATA_SECRET_API_KEY` to `.env`

### "Wallet has zero balance"
- Fund your wallet with Base ETH (see wallet funding section)

### "KINETIX_SIGNING_KEY not set"
- This should already be in your `.env` - check it's properly set

### Gas estimation fails
- Check your wallet has sufficient ETH
- Verify RPC URL is accessible
- Try again with a different RPC provider if needed
