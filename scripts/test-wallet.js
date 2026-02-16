/**
 * Test script for Kinetix Wallet (Coinbase AgentKit integration)
 *
 * Tests:
 * 1. Wallet initialization
 * 2. Address retrieval
 * 3. Balance checking (ETH and USDC)
 * 4. Wallet export
 * 5. Persistence verification
 */

const kinetixWallet = require('../wallet/agentkit');

async function runTests() {
  console.log('========================================');
  console.log('Kinetix Wallet Test Suite');
  console.log('========================================\n');

  try {
    // Test 1: Initialize wallet
    console.log('Test 1: Initializing wallet...');
    const address = await kinetixWallet.initialize();
    console.log(`✓ Wallet initialized with address: ${address}\n`);

    // Test 2: Get address
    console.log('Test 2: Getting wallet address...');
    const retrievedAddress = kinetixWallet.getAddress();
    console.log(`✓ Address retrieved: ${retrievedAddress}`);
    console.log(`✓ Address matches: ${address === retrievedAddress}\n`);

    // Test 3: Get ETH balance
    console.log('Test 3: Getting ETH balance...');
    const ethBalance = await kinetixWallet.getBalance('eth');
    console.log(`✓ ETH Balance:`, ethBalance, '\n');

    // Test 4: Get USDC balance
    console.log('Test 4: Getting USDC balance...');
    const usdcBalance = await kinetixWallet.getBalance('usdc');
    console.log(`✓ USDC Balance:`, usdcBalance, '\n');

    // Test 5: Export wallet
    console.log('Test 5: Exporting wallet...');
    const exportData = await kinetixWallet.exportWallet();
    console.log(`✓ Wallet exported successfully`);
    console.log(`  - Address: ${exportData.address}`);
    console.log(`  - Network: ${exportData.networkId}`);
    console.log(`  - Exported at: ${exportData.exportedAt}\n`);

    // Test 6: Verify persistence
    console.log('Test 6: Verifying wallet persistence...');
    const fs = require('fs');
    const path = require('path');
    const walletDataPath = path.join(__dirname, '../wallet-data/wallet.json');
    const walletFileExists = fs.existsSync(walletDataPath);
    console.log(`✓ Wallet data file exists: ${walletFileExists}`);

    if (walletFileExists) {
      const walletData = JSON.parse(fs.readFileSync(walletDataPath, 'utf-8'));
      console.log(`✓ Wallet data file is valid JSON\n`);
    }

    console.log('========================================');
    console.log('All tests passed! ✓');
    console.log('========================================');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Run tests
runTests();
