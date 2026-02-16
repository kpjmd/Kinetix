# WalletManager - Quick Reference Guide

## Overview

The WalletManager provides a unified interface for managing wallet operations with built-in safety controls and Telegram integration for transaction approvals.

## Architecture

```
┌─────────────────────┐
│  Telegram Bot       │
│  (User Interface)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  WalletManager      │
│  (Orchestrator)     │
└──────────┬──────────┘
           │
           ├────────────────┐
           ▼                ▼
┌──────────────────┐  ┌──────────────────┐
│  AgentKit Wallet │  │ SafetyController │
│  (Transactions)  │  │ (Validation)     │
└──────────────────┘  └──────────────────┘
```

## Telegram Commands

### Wallet Status
- `/wallet` - Show wallet address, balances, and daily spending
- `/balances` - All asset balances with USD equivalents
- `/spending` - Detailed spending report with per-asset breakdown

### Transaction Approval
- `/pending_tx` - List pending wallet transactions
- `/approve_tx [id]` - Approve and execute transaction
- `/reject_tx [id] [reason]` - Reject transaction with reason

### Configuration
- `/limits` - Show safety limits configuration
- `/update_price [asset] [price]` - Update asset price (e.g., `/update_price eth 3500`)
- `/tx_history [limit]` - Show recent transaction history

## Transaction Flow

### Automatic Execution (< $1)
```javascript
const result = await walletManager.sendPayment(
  '0x1234...5678',
  0.5,
  'usdc',
  { purpose: 'Micropayment' }
);

// Result:
{
  status: 'executed',
  hash: '0xabc...',
  explorerUrl: 'https://sepolia.basescan.org/tx/0xabc...'
}
```

### Requires Approval (> $5)
```javascript
const result = await walletManager.sendPayment(
  '0x1234...5678',
  7.5,
  'usdc',
  { purpose: 'Large payment' }
);

// Result:
{
  status: 'pending_approval',
  approvalId: 'tx_1234567890_123',
  usdValue: 7.5,
  reason: 'REQUIRES_APPROVAL'
}

// Admin receives Telegram notification:
// 🔔 Transaction Approval Required
// 💰 Amount: 7.5 USDC
// 💵 USD Value: $7.50
// ...
// ✅ /approve_tx tx_1234567890_123
// ❌ /reject_tx tx_1234567890_123 <reason>
```

### Rejected (Over Limit)
```javascript
const result = await walletManager.sendPayment(
  '0x1234...5678',
  1.5,
  'usdc',
  { purpose: 'Payment' }
);

// Result:
{
  status: 'rejected',
  reason: 'USD_LIMIT_EXCEEDED',
  checks: { ... }
}
```

## Safety Limits

Current configuration (`/config/safety-limits.json`):

| Limit | Value |
|-------|-------|
| Daily USD Limit | $10 |
| Per-Transaction USD | $1 |
| Require Approval Above | $5 |
| Max Tx/Hour | 5 |
| Max Tx/Day | 50 |

### Asset-Specific Limits

| Asset | Max Per Tx | Counts Toward Limits |
|-------|-----------|---------------------|
| USDC | 10 | ✓ |
| ETH | 0.01 | ✓ |
| KINETIX | 1000 | ✗ |

**Note:** KINETIX token does not count toward daily USD limits (useful for community rewards).

## Programmatic Usage

### Initialize
```javascript
const walletManager = require('./wallet/wallet-manager');

// In Telegram bot main()
await walletManager.initialize(bot);
```

### Send Payment
```javascript
// USDC payment (default)
const result = await walletManager.sendPayment(
  '0x1234567890123456789012345678901234567890',
  0.5,
  'usdc',
  { purpose: 'Payment for service' }
);

// ETH payment
const result = await walletManager.sendNative(
  '0x1234567890123456789012345678901234567890',
  0.001,
  { purpose: 'Gas refund' }
);

// Token payment by address
const result = await walletManager.sendToken(
  '0x1234567890123456789012345678901234567890',
  100,
  '0x208a33Fa8A72b504b309a6869390072d712E179d', // KINETIX contract
  { purpose: 'Reward distribution' }
);
```

### Get Status
```javascript
const status = await walletManager.getStatus();
console.log(`Address: ${status.address}`);
console.log(`Network: ${status.network}`);
console.log(`Daily spending: $${status.dailySpending.totalUSD}`);
console.log(`Remaining: $${status.remainingDailyUSD}`);
```

### Manage Approvals
```javascript
// List pending
const pending = await walletManager.getPendingApprovals();

// Approve and execute
const result = await walletManager.approveTransaction(
  'tx_1234567890_123',
  'admin'
);

// Reject
const result = await walletManager.rejectTransaction(
  'tx_1234567890_123',
  'admin',
  'Transaction not authorized'
);
```

## File Locations

| File | Purpose |
|------|---------|
| `/wallet/wallet-manager.js` | Main WalletManager class |
| `/wallet/agentkit.js` | AgentKit wallet integration |
| `/wallet/safety-controller.js` | Transaction validation |
| `/config/safety-limits.json` | Safety limits configuration |
| `/data/spending-state.json` | Daily spending state |
| `/data/approval-queue/*.json` | Pending transaction approvals |

## Testing

Run the test suite:
```bash
node scripts/test-wallet-manager.js
```

Tests cover:
- Initialization
- Balance retrieval
- Transaction validation
- Approval workflows
- Price updates
- Explorer URL generation

## Security Features

1. **Private Key Protection**: Never logged or exposed
2. **Approval Queue Persistence**: Survives restarts
3. **Failed Transaction Handling**: Only recorded after successful execution
4. **Stale Transaction Timeout**: Auto-reject after 24 hours
5. **Multi-Asset Support**: Independent limits per asset

## Network Support

- **Base Sepolia** (testnet): Default
  - Explorer: https://sepolia.basescan.org
- **Base Mainnet**: Set `NETWORK_ID=base-mainnet`
  - Explorer: https://basescan.org

## Example Telegram Workflow

1. Agent attempts large payment → Requires approval
2. Admin receives Telegram notification
3. Admin reviews with `/pending_tx`
4. Admin approves with `/approve_tx [id]`
5. Transaction executes automatically
6. Admin receives confirmation with explorer link

## Troubleshooting

### Wallet not initialized
```
❌ Wallet not initialized
```
**Solution:** Check that WalletManager is initialized in bot startup:
```javascript
await walletManager.initialize(bot);
```

### Transaction rejected
```
{ status: 'rejected', reason: 'DAILY_LIMIT_EXCEEDED' }
```
**Solution:** Check current spending with `/spending` and wait for daily reset (UTC midnight) or adjust limits in `safety-limits.json`.

### Balance is 0
```
USDC: 0 ($0.00)
```
**Solution:** Fund the wallet at the displayed address. Use Base Sepolia faucet for testnet ETH, then swap for USDC on testnet DEX.

## Advanced Configuration

### Adjust Daily Limits
Edit `/config/safety-limits.json`:
```json
{
  "dailyLimitUSD": 50,        // Increase to $50
  "perTxLimitUSD": 5,         // Increase to $5
  "requireApprovalAboveUSD": 10  // Require approval above $10
}
```

### Add New Asset
```json
"mytoken": {
  "enabled": true,
  "decimals": 18,
  "contractAddress": "0x...",
  "priceUSD": 0.1,
  "maxPerTx": 1000,
  "countTowardLimits": true
}
```

### Dynamic Price Updates
```bash
# Via Telegram
/update_price eth 3500

# Programmatically
walletManager.updateAssetPrice('eth', 3500);
```

## Support

For issues or questions:
- Test suite: `node scripts/test-wallet-manager.js`
- Check logs: Look for `[WalletManager]` prefix
- Verify config: `/limits` command in Telegram
