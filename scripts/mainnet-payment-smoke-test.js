#!/usr/bin/env node

/**
 * Dry-run diagnostic for the KINETIX payment path on Base mainnet.
 *
 * Overrides NETWORK_ID to 'base-mainnet' for this process only (does not
 * touch .env), so the live Telegram bot / x402 server stay on whatever
 * network they're already running with. This must happen before any
 * wallet/* module is required, since WalletManager and SafetyController
 * both read NETWORK_ID in their constructors.
 *
 * This script never calls sendPayment/_executeTransfer — it only
 * initializes the CDP wallet, reports balances, and runs
 * validateTransaction() so limits/whitelist behavior can be inspected
 * against live mainnet config without moving funds. Broadcasting a real
 * transfer is a separate, explicit follow-up step.
 */

process.env.NETWORK_ID = 'base-mainnet';

require('dotenv').config();
const { ethers } = require('ethers');
const walletManager = require('../wallet/wallet-manager');

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

// Test amount and recipient for the dry-run validateTransaction() call only.
// No transaction is broadcast to this or any other address.
const DRY_RUN_AMOUNT_KINETIX = 1;
const DRY_RUN_RECIPIENT = '0x821a61d2C3E02446eD03285df1618639eF25D2b9';

async function main() {
  console.log('\n=== KINETIX Payment Path — Base Mainnet Dry Run ===\n');
  console.log('NETWORK_ID override: base-mainnet (in-process only, .env untouched)\n');

  console.log('1. Initializing WalletManager (CDP wallet)...');
  await walletManager.initialize();
  const address = walletManager.wallet.getAddress();
  console.log(`   Resolved payment wallet address: ${address}\n`);

  console.log('2. Fetching ETH/USDC balances via CDP wallet provider...');
  const [ethBalance, usdcBalance] = await Promise.all([
    walletManager.wallet.getBalance('eth'),
    walletManager.wallet.getBalance('usdc'),
  ]);
  console.log(`   ETH:  ${ethBalance.balance}`);
  console.log(`   USDC: ${usdcBalance.balance}\n`);

  console.log('3. Fetching KINETIX balance via read-only RPC call...');
  const kinetixConfig = walletManager.safety.getAssetConfig('kinetix');
  if (!kinetixConfig?.contractAddress) {
    console.log('   KINETIX has no contract address configured for base_mainnet — skipping.\n');
  } else {
    const rpcUrl = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const token = new ethers.Contract(kinetixConfig.contractAddress, ERC20_BALANCE_ABI, provider);
    const [rawBalance, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);
    console.log(`   KINETIX contract: ${kinetixConfig.contractAddress}`);
    console.log(`   KINETIX balance: ${ethers.formatUnits(rawBalance, decimals)}\n`);
  }

  console.log('4. Running validateTransaction() dry run (no broadcast)...');
  console.log(`   Proposed: ${DRY_RUN_AMOUNT_KINETIX} KINETIX -> ${DRY_RUN_RECIPIENT}`);
  const validation = await walletManager.safety.validateTransaction(
    DRY_RUN_AMOUNT_KINETIX,
    'kinetix',
    DRY_RUN_RECIPIENT,
    { purpose: 'mainnet payment path smoke test (dry run)' }
  );
  console.log('\n   Result:');
  console.log(JSON.stringify(validation, null, 2));

  console.log('\nNote: validateTransaction() checks config-based limits/whitelist only —');
  console.log('it does not check the wallet\'s actual onchain balance. A real send would');
  console.log('still fail at broadcast time if the wallet is underfunded.\n');

  console.log('=== Dry run complete. No transaction was broadcast. ===\n');
}

main().catch((error) => {
  console.error('\nSmoke test failed:', error.message);
  console.error(error.stack);
  process.exit(1);
});
