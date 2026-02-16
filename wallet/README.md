# Kinetix Wallet - Coinbase AgentKit Integration

Wallet module for the Kinetix AI agent using Coinbase's AgentKit and CDP EVM Wallet Provider.

## Features

- **Automatic Wallet Persistence**: Wallet data is automatically saved to `/wallet-data/wallet.json`
- **Balance Checking**: Get ETH and USDC balances
- **Wallet Export**: Export wallet data for backup
- **Network Support**: Base mainnet and Base Sepolia testnet
- **Singleton Pattern**: Single wallet instance across the application
- **Detailed Logging**: Timestamped console logs for debugging

## Setup

### 1. Install Dependencies

Already installed via:
```bash
npm install @coinbase/agentkit
```

### 2. Configure Environment Variables

Add to `.env`:
```bash
# Coinbase AgentKit (CDP API)
CDP_API_KEY_ID=your_cdp_api_key_id_here
CDP_API_KEY_SECRET=your_cdp_api_key_secret_here
CDP_WALLET_SECRET=your_wallet_secret_here  # Optional: for loading existing wallet
NETWORK_ID=base-sepolia  # or 'base-mainnet'
```

**Required:**
- `CDP_API_KEY_ID`: Your Coinbase Developer Platform API key ID
- `CDP_API_KEY_SECRET`: Your CDP API key secret

**Optional:**
- `CDP_WALLET_SECRET`: Secret for loading an existing wallet (omit to create new)
- `NETWORK_ID`: Network to use (default: `base-sepolia`)

### 3. Get CDP API Keys

1. Go to [Coinbase Developer Platform](https://portal.cdp.coinbase.com/)
2. Create a new API key
3. Save the key ID and secret to your `.env` file

## Usage

### Basic Example

```javascript
const kinetixWallet = require('./wallet/agentkit');

async function main() {
  // Initialize wallet (creates new or loads existing)
  const address = await kinetixWallet.initialize();
  console.log('Wallet address:', address);

  // Get wallet address
  const addr = kinetixWallet.getAddress();
  console.log('Address:', addr);

  // Get ETH balance
  const ethBalance = await kinetixWallet.getBalance('eth');
  console.log('ETH Balance:', ethBalance);

  // Get USDC balance
  const usdcBalance = await kinetixWallet.getBalance('usdc');
  console.log('USDC Balance:', usdcBalance);

  // Export wallet for backup
  const exportData = await kinetixWallet.exportWallet();
  console.log('Wallet export:', exportData);
}

main();
```

## API Reference

### `initialize()`

Initialize the wallet (load existing or create new).

**Returns:** `Promise<string>` - Wallet address

**Throws:** Error if CDP credentials are missing

```javascript
const address = await kinetixWallet.initialize();
```

### `getBalance(asset)`

Get balance for specified asset.

**Parameters:**
- `asset` (string, optional): Asset symbol - `'eth'` or `'usdc'` (default: `'usdc'`)

**Returns:** `Promise<object>` - Balance information
```javascript
{
  asset: 'USDC',
  balance: '100.50',
  address: '0x...'
}
```

**Example:**
```javascript
const ethBalance = await kinetixWallet.getBalance('eth');
const usdcBalance = await kinetixWallet.getBalance('usdc');
```

### `getAddress()`

Get the wallet address.

**Returns:** `string|null` - Wallet address or null if not initialized

```javascript
const address = kinetixWallet.getAddress();
```

### `exportWallet()`

Export wallet data for backup.

**Returns:** `Promise<object>` - Wallet export data
```javascript
{
  address: '0x...',
  networkId: 'base-sepolia',
  exportedAt: '2024-01-01T00:00:00.000Z',
  walletData: { /* wallet data */ }
}
```

**Example:**
```javascript
const exportData = await kinetixWallet.exportWallet();
// Save exportData securely for backup
```

## Testing

Run the test suite:

```bash
node scripts/test-wallet.js
```

Tests include:
1. Wallet initialization
2. Address retrieval
3. ETH balance checking
4. USDC balance checking
5. Wallet export
6. Persistence verification

## File Structure

```
/wallet/
  agentkit.js       # Main wallet module
  README.md         # This file

/wallet-data/
  .gitkeep          # Directory placeholder
  wallet.json       # Wallet data (auto-created, gitignored)

/scripts/
  test-wallet.js    # Test script
```

## Security Notes

- **Never commit** `wallet.json` - it's gitignored by default
- **Keep CDP credentials secure** - use environment variables only
- **Backup wallet data** - use `exportWallet()` and store securely
- **Test on testnet first** - use `base-sepolia` before mainnet

## Networks

### Base Sepolia (Testnet)
```bash
NETWORK_ID=base-sepolia
```

### Base Mainnet
```bash
NETWORK_ID=base-mainnet
```

## Troubleshooting

### "Missing required environment variables"
- Ensure `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set in `.env`
- Verify `.env` file is in project root
- Check that `dotenv` is loading correctly

### "Wallet not initialized"
- Call `initialize()` before other methods
- Check console logs for initialization errors

### Balance shows 0
- Ensure wallet is funded on the correct network
- Verify you're checking the right asset (`eth` vs `usdc`)
- For testnet, get faucet funds from Base Sepolia faucet

## Module System

This module uses **CommonJS** (`require()`) to match the existing codebase patterns.

## Dependencies

- `@coinbase/agentkit` - Coinbase AgentKit SDK
- `dotenv` - Environment variable management
- `fs/promises` - File system operations
- `path` - Path utilities

## License

Part of the Kinetix AI Agent project.
