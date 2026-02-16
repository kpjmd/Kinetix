# Kinetix Wallet - Quick Reference

## Import

```javascript
const kinetixWallet = require('./wallet/agentkit');
```

---

## API Methods

### Initialize Wallet
```javascript
const address = await kinetixWallet.initialize();
// Returns: '0x1234...' (wallet address)
```

### Get Wallet Address
```javascript
const address = kinetixWallet.getAddress();
// Returns: '0x1234...' or null if not initialized
```

### Get ETH Balance
```javascript
const ethBalance = await kinetixWallet.getBalance('eth');
// Returns: { asset: 'ETH', balance: '0.5', address: '0x1234...' }
```

### Get USDC Balance
```javascript
const usdcBalance = await kinetixWallet.getBalance('usdc');
// Returns: { asset: 'USDC', balance: '100.50', address: '0x1234...' }
```

### Export Wallet (Backup)
```javascript
const exportData = await kinetixWallet.exportWallet();
// Returns: { address, networkId, exportedAt, walletData }
```

---

## Environment Variables

```bash
# Required
CDP_API_KEY_ID=your_key_id
CDP_API_KEY_SECRET=your_secret

# Optional
CDP_WALLET_SECRET=wallet_secret  # For loading existing wallet
NETWORK_ID=base-sepolia          # or 'base-mainnet'
```

---

## Basic Usage Pattern

```javascript
// 1. Initialize on startup
await kinetixWallet.initialize();

// 2. Check balance before transaction
const balance = await kinetixWallet.getBalance('usdc');
if (parseFloat(balance.balance) >= requiredAmount) {
  // Proceed with transaction
}

// 3. Get wallet info
const address = kinetixWallet.getAddress();
console.log('Wallet:', address);
```

---

## Test

```bash
node scripts/test-wallet.js
```

---

## Files

- **Module:** `/wallet/agentkit.js`
- **Docs:** `/wallet/README.md`
- **Examples:** `/wallet/example-integration.js`
- **Tests:** `/scripts/test-wallet.js`
- **Wallet Data:** `/wallet-data/wallet.json` (auto-created)

---

## Networks

| Network | ID | Purpose |
|---------|----|----|
| Base Sepolia | `base-sepolia` | Testing (default) |
| Base Mainnet | `base-mainnet` | Production |

---

## Common Patterns

### Startup Check
```javascript
try {
  const address = await kinetixWallet.initialize();
  console.log('✓ Wallet ready:', address);
} catch (error) {
  console.error('✗ Wallet failed:', error.message);
}
```

### Balance Guard
```javascript
async function hasEnoughFunds(amount) {
  const balance = await kinetixWallet.getBalance('usdc');
  return parseFloat(balance.balance) >= amount;
}
```

### Status Check
```javascript
async function getStatus() {
  const addr = kinetixWallet.getAddress();
  if (!addr) return 'Not initialized';

  const eth = await kinetixWallet.getBalance('eth');
  const usdc = await kinetixWallet.getBalance('usdc');

  return {
    address: addr,
    eth: eth.balance,
    usdc: usdc.balance
  };
}
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Missing required environment variables" | Add `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` to `.env` |
| "Wallet not initialized" | Call `initialize()` first |
| Balance is 0 | Fund wallet on correct network |
| Can't create wallet | Check CDP API credentials are valid |

---

## Security

- ✅ `wallet.json` is gitignored
- ✅ Use `.env` for credentials
- ✅ Test on testnet first
- ✅ Backup wallet with `exportWallet()`

---

## Get API Keys

1. Go to https://portal.cdp.coinbase.com/
2. Create API key
3. Copy ID and secret to `.env`
4. Run test: `node scripts/test-wallet.js`
