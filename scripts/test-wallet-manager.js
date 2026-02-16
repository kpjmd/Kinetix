/**
 * Test script for WalletManager
 *
 * Tests:
 * 1. Initialization
 * 2. Status and balance retrieval
 * 3. Validation flows (approve, reject, require approval)
 * 4. Approval queue management
 * 5. Price updates
 * 6. Explorer URL generation
 */

const { WalletManager } = require('../wallet/wallet-manager');
require('dotenv').config();

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`✓ ${testName}`);
    testsPassed++;
  } else {
    console.error(`✗ ${testName}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('\n🧪 WalletManager Test Suite\n');
  console.log('='.repeat(60));

  // Use fresh instance for testing
  const manager = new WalletManager();

  // Test 1: Initialization
  console.log('\n📋 Test 1: Initialization');
  try {
    await manager.initialize();
    assert(manager.initialized === true, 'Manager initialized');
    assert(manager.wallet.getAddress() !== null, 'Wallet address available');
    console.log(`   Address: ${manager.wallet.getAddress()}`);
  } catch (error) {
    console.error('   Initialization failed:', error.message);
    testsFailed++;
  }

  // Test 2: Get Status
  console.log('\n📋 Test 2: Get Status');
  try {
    const status = await manager.getStatus();
    assert(status.initialized === true, 'Status shows initialized');
    assert(status.address !== undefined, 'Status includes address');
    assert(status.balances !== undefined, 'Status includes balances');
    assert(status.limits !== undefined, 'Status includes limits');
    console.log(`   Network: ${status.network}`);
    console.log(`   Daily spending: $${status.dailySpending.totalUSD || 0}`);
  } catch (error) {
    console.error('   Status failed:', error.message);
    testsFailed++;
  }

  // Test 3: Get All Balances
  console.log('\n📋 Test 3: Get All Balances');
  try {
    const balances = await manager.getAllBalances();
    assert(balances.eth !== undefined, 'ETH balance retrieved');
    assert(balances.usdc !== undefined, 'USDC balance retrieved');
    console.log(`   ETH: ${balances.eth.balance}`);
    console.log(`   USDC: ${balances.usdc.balance}`);
  } catch (error) {
    console.error('   Balances failed:', error.message);
    testsFailed++;
  }

  // Test 4: Spending Report
  console.log('\n📋 Test 4: Spending Report');
  try {
    const report = await manager.getSpendingReport();
    assert(report.limits !== undefined, 'Report includes limits');
    assert(report.assetBreakdown !== undefined, 'Report includes asset breakdown');
    assert(Array.isArray(report.recentTransactions), 'Report includes transaction history');
    console.log(`   Daily limit: $${report.limits.dailyLimitUSD}`);
    console.log(`   Recent transactions: ${report.recentTransactions.length}`);
  } catch (error) {
    console.error('   Report failed:', error.message);
    testsFailed++;
  }

  // Test 5: Price Management
  console.log('\n📋 Test 5: Price Management');
  try {
    const oldPrices = manager.getCurrentPrices();
    const oldEthPrice = oldPrices.eth.priceUSD;

    manager.updateAssetPrice('eth', 3500);
    const newPrices = manager.getCurrentPrices();
    assert(newPrices.eth.priceUSD === 3500, 'ETH price updated');

    // Restore original
    manager.updateAssetPrice('eth', oldEthPrice);
    console.log(`   Price update successful (tested with ETH: ${oldEthPrice} -> 3500 -> ${oldEthPrice})`);
  } catch (error) {
    console.error('   Price update failed:', error.message);
    testsFailed++;
  }

  // Test 6: Validation - Small Transaction
  console.log('\n📋 Test 6: Validation - Small Transaction');
  try {
    const validation = await manager.safety.validateTransaction(
      0.5,
      'usdc',
      '0x1234567890123456789012345678901234567890',
      { purpose: 'Test' }
    );
    // Transaction may be approved or rejected based on current spending
    // Just verify the validation structure is correct
    assert(validation.usdValue === 0.5, 'Correct USD value calculated');
    assert(validation.requiresApproval === false, 'Does not require manual approval (under $5 threshold)');
    const validReasons = ['DAILY_LIMIT_EXCEEDED', null];
    assert(
      validation.approved || validReasons.includes(validation.reason),
      'Transaction properly validated'
    );
    console.log(`   USD value: $${validation.usdValue}`);
    console.log(`   Status: ${validation.approved ? 'Approved' : `Rejected (${validation.reason})`}`);
  } catch (error) {
    console.error('   Validation failed:', error.message);
    testsFailed++;
  }

  // Test 7: Validation - Large Transaction (should require approval)
  console.log('\n📋 Test 7: Validation - Large Transaction');
  try {
    const validation = await manager.safety.validateTransaction(
      6,
      'usdc',
      '0x1234567890123456789012345678901234567890',
      { purpose: 'Test large' }
    );
    assert(validation.requiresApproval === true, 'Large transaction requires approval');
    assert(validation.reason === 'REQUIRES_APPROVAL', 'Correct reason');
    console.log(`   USD value: $${validation.usdValue}`);
  } catch (error) {
    console.error('   Validation failed:', error.message);
    testsFailed++;
  }

  // Test 8: Validation - Over Per-Tx Limit (should reject)
  console.log('\n📋 Test 8: Validation - Over Per-Tx Limit');
  try {
    const validation = await manager.safety.validateTransaction(
      1.5,
      'usdc',
      '0x1234567890123456789012345678901234567890',
      { purpose: 'Test over limit' }
    );
    assert(validation.approved === false, 'Transaction rejected');
    assert(validation.reason === 'USD_LIMIT_EXCEEDED', 'Correct rejection reason');
    console.log(`   Reason: ${validation.reason}`);
  } catch (error) {
    console.error('   Validation failed:', error.message);
    testsFailed++;
  }

  // Test 9: Pending Approvals
  console.log('\n📋 Test 9: Pending Approvals');
  try {
    const pending = await manager.getPendingApprovals();
    assert(Array.isArray(pending), 'Pending list is array');
    console.log(`   Found ${pending.length} pending transaction(s)`);
  } catch (error) {
    console.error('   Pending check failed:', error.message);
    testsFailed++;
  }

  // Test 10: Explorer URL
  console.log('\n📋 Test 10: Explorer URL Generation');
  try {
    const testHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const explorerUrl = manager._getExplorerUrl(testHash);
    assert(explorerUrl.includes(testHash), 'Explorer URL includes hash');
    assert(explorerUrl.includes('basescan.org'), 'Uses correct explorer');
    console.log(`   Explorer URL: ${explorerUrl}`);
  } catch (error) {
    console.error('   Explorer URL test failed:', error.message);
    testsFailed++;
  }

  // Test 11: Asset by Address
  console.log('\n📋 Test 11: Asset by Address Lookup');
  try {
    const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const asset = manager._getAssetByAddress(usdcAddress);
    assert(asset !== null, 'Found USDC by address');
    assert(asset.name === 'usdc', 'Correct asset name');
    console.log(`   Found: ${asset.name}`);
  } catch (error) {
    console.error('   Asset lookup failed:', error.message);
    testsFailed++;
  }

  // Test 12: Get Current Prices
  console.log('\n📋 Test 12: Get Current Prices');
  try {
    const prices = manager.getCurrentPrices();
    assert(prices.usdc !== undefined, 'USDC price available');
    assert(prices.eth !== undefined, 'ETH price available');
    assert(prices.kinetix !== undefined, 'KINETIX price available');
    console.log(`   USDC: $${prices.usdc.priceUSD}`);
    console.log(`   ETH: $${prices.eth.priceUSD}`);
    console.log(`   KINETIX: $${prices.kinetix.priceUSD}`);
  } catch (error) {
    console.error('   Get prices failed:', error.message);
    testsFailed++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('🎯 Test Summary');
  console.log('='.repeat(60));
  console.log(`✓ Passed: ${testsPassed}`);
  console.log(`✗ Failed: ${testsFailed}`);

  if (testsFailed === 0) {
    console.log('\n🎉 All tests passed!\n');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed.\n');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('\n💥 Test suite crashed:', error);
  console.error(error.stack);
  process.exit(1);
});
