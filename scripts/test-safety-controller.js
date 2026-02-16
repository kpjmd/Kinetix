const { SafetyController } = require('../wallet/safety-controller');
const fs = require('fs');
const path = require('path');

// Test configuration
const TEST_CONFIG_PATH = './config/safety-limits.json';
const TEST_STATE_PATH = './data/spending-state.json';

// Test utilities
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

function testSection(name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
}

// Main test suite
async function runTests() {
  console.log('\n🧪 SafetyController Test Suite\n');

  // Initialize controller
  const safety = new SafetyController(TEST_CONFIG_PATH);

  // Test 1: Configuration Loading
  testSection('Test 1: Configuration Loading');
  assert(safety.config !== null, 'Config loaded successfully');
  assert(safety.config.dailyLimitUSD === 10, 'Daily limit is $10');
  assert(safety.config.perTxLimitUSD === 1, 'Per-tx limit is $1');
  assert(safety.config.assets.usdc !== undefined, 'USDC asset configured');
  assert(safety.config.assets.eth !== undefined, 'ETH asset configured');
  assert(safety.config.assets.kinetix !== undefined, 'KINETIX asset configured');

  // Test 2: Asset Validation
  testSection('Test 2: Asset Validation');
  const usdcConfig = safety.getAssetConfig('usdc');
  assert(usdcConfig !== null, 'USDC config retrieved');
  assert(usdcConfig.decimals === 6, 'USDC has 6 decimals');
  assert(usdcConfig.priceUSD === 1.0, 'USDC price is $1.00');

  const ethConfig = safety.getAssetConfig('eth');
  assert(ethConfig !== null, 'ETH config retrieved');
  assert(ethConfig.decimals === 18, 'ETH has 18 decimals');
  assert(ethConfig.priceUSD === 3000, 'ETH price is $3000');

  // Test 3: USD Normalization
  testSection('Test 3: USD Normalization');
  const usdcValue = safety.normalizeToUSD(5.5, 'usdc');
  assert(usdcValue === 5.5, 'USDC 5.5 = $5.50 USD');

  const ethValue = safety.normalizeToUSD(0.003, 'eth');
  assert(ethValue === 9.0, 'ETH 0.003 = $9.00 USD');

  const kinetixValue = safety.normalizeToUSD(1000, 'kinetix');
  assert(kinetixValue === 1.0, 'KINETIX 1000 = $1.00 USD');

  // Test 4: Valid USDC Transaction (Within Limits)
  testSection('Test 4: Valid USDC Transaction');
  const result1 = await safety.validateTransaction(
    0.5,
    'usdc',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Test micropayment' }
  );
  assert(result1.approved === true, 'Small USDC transaction approved');
  assert(result1.requiresApproval === false, 'Does not require approval');
  assert(result1.usdValue === 0.5, 'USD value calculated correctly');
  assert(result1.checks.assetEnabled === true, 'Asset enabled check passed');
  assert(result1.checks.assetLimit === true, 'Asset limit check passed');
  assert(result1.checks.usdPerTxLimit === true, 'USD per-tx limit check passed');

  // Test 5: Valid ETH Transaction
  testSection('Test 5: Valid ETH Transaction');
  const result2 = await safety.validateTransaction(
    0.0003,
    'eth',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Gas payment' }
  );
  assert(result2.approved === true, 'Small ETH transaction approved');
  assert(Math.abs(result2.usdValue - 0.9) < 0.01, 'ETH USD value calculated correctly');

  // Test 6: KINETIX Transaction (countTowardLimits=false)
  testSection('Test 6: KINETIX Transaction (Not Counted)');
  const result3 = await safety.validateTransaction(
    500,
    'kinetix',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'KINETIX token distribution' }
  );
  assert(result3.approved === true, 'KINETIX transaction approved');
  assert(result3.usdValue === 0.5, 'KINETIX USD value calculated correctly');

  // Record the KINETIX transaction
  safety.recordTransaction(500, 'kinetix', result3.usdValue, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'KINETIX token distribution'
  });

  // Check that it didn't affect USD total
  const report1 = safety.getReport();
  assert(
    report1.dailySpending.totalUSD === undefined || report1.dailySpending.totalUSD === 0,
    'KINETIX transaction did not count toward USD limits'
  );

  // Test 7: Exceeding Asset-Specific Limit
  testSection('Test 7: Exceeding Asset-Specific Limit');
  const result4 = await safety.validateTransaction(
    15,
    'usdc',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Large USDC payment' }
  );
  assert(result4.approved === false, 'Large USDC transaction rejected');
  assert(result4.reason === 'ASSET_LIMIT_EXCEEDED', 'Correct rejection reason');

  // Test 8: Exceeding USD Per-Transaction Limit
  testSection('Test 8: Exceeding USD Per-Transaction Limit');
  const result5 = await safety.validateTransaction(
    2,
    'usdc',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Medium USDC payment' }
  );
  assert(result5.approved === false, 'Transaction exceeding USD limit rejected');
  assert(result5.reason === 'USD_LIMIT_EXCEEDED', 'Correct rejection reason');

  // Test 9: Requires Approval Threshold
  testSection('Test 9: Requires Approval Threshold');
  // First, let's test with a value exactly at the approval threshold
  const result6 = await safety.validateTransaction(
    0.002,  // 0.002 ETH = $6 USD (above $5 threshold)
    'eth',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'High-value ETH payment' }
  );
  assert(result6.approved === false, 'High-value transaction not auto-approved');
  assert(result6.requiresApproval === true, 'Requires approval flag set');
  assert(result6.reason === 'REQUIRES_APPROVAL', 'Correct reason');
  assert(result6.usdValue === 6.0, 'USD value correct');

  // Test 10: Transaction Recording
  testSection('Test 10: Transaction Recording');
  safety.recordTransaction(0.5, 'usdc', 0.5, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 1'
  });
  safety.recordTransaction(0.3, 'usdc', 0.3, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 2'
  });

  const report2 = safety.getReport();
  assert(report2.dailySpending.usdc === 0.8, 'USDC spending tracked correctly');
  assert(report2.dailySpending.totalUSD === 0.8, 'Total USD spending tracked correctly');
  assert(report2.counters.dailyTxCount >= 2, 'Transaction count tracked');

  // Test 11: Daily Limit Check
  testSection('Test 11: Daily Limit Check');
  // Record transactions to get very close to daily limit
  // Current from test 10: $0.80
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 3'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 4'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 5'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 6'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 7'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 8'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 9'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 10'
  });
  safety.recordTransaction(0.95, 'usdc', 0.95, {
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test payment 11'
  });

  const report3b = safety.getReport();
  console.log(`After additional spending: $${report3b.dailySpending.totalUSD.toFixed(2)}`);

  // Reset hourly counter to avoid hitting hourly rate limit
  safety.state.hourlyTxCount = 0;

  // Try to exceed daily limit
  const result7 = await safety.validateTransaction(
    0.95,  // Would exceed $10 daily limit
    'usdc',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Would exceed daily limit' }
  );

  assert(result7.approved === false, 'Transaction exceeding daily limit rejected');
  assert(result7.reason === 'DAILY_LIMIT_EXCEEDED', 'Correct rejection reason');

  // Test 12: Hourly Rate Limiting
  testSection('Test 12: Hourly Rate Limiting');
  // Record transactions up to hourly limit
  for (let i = 0; i < 5; i++) {
    safety.recordTransaction(0.1, 'usdc', 0.1, {
      recipient: '0x1234567890123456789012345678901234567890',
      purpose: `Rate limit test ${i + 1}`
    });
  }

  const report4 = safety.getReport();
  console.log(`Hourly transaction count: ${report4.counters.hourlyTxCount}`);

  // Try to exceed hourly rate limit
  const result8 = await safety.validateTransaction(
    0.1,
    'usdc',
    '0x1234567890123456789012345678901234567890',
    { purpose: 'Would exceed hourly rate' }
  );
  assert(result8.approved === false, 'Transaction exceeding hourly rate rejected');
  assert(result8.reason === 'HOURLY_RATE_EXCEEDED', 'Correct rejection reason');

  // Test 13: State Persistence
  testSection('Test 13: State Persistence');
  safety.saveToFile();
  assert(fs.existsSync(TEST_STATE_PATH), 'State file created');

  const savedState = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf8'));
  assert(savedState.dailySpending !== undefined, 'State has spending data');
  assert(savedState.transactionLog !== undefined, 'State has transaction log');

  // Test 14: State Loading
  testSection('Test 14: State Loading');
  const safety2 = new SafetyController(TEST_CONFIG_PATH);
  safety2.loadFromFile();
  const report5 = safety2.getReport();
  assert(report5.dailySpending.usdc !== undefined, 'State loaded with USDC spending');

  // Test 15: Transaction History
  testSection('Test 15: Transaction History');
  const history = safety.getTransactionHistory(5);
  assert(Array.isArray(history), 'History is an array');
  assert(history.length > 0, 'History contains transactions');
  assert(history[0].id !== undefined, 'Transaction has ID');
  assert(history[0].timestamp !== undefined, 'Transaction has timestamp');

  // Test 16: Format Amount
  testSection('Test 16: Format Amount');
  const formatted1 = safety.formatAmount(5.5, 'usdc');
  assert(formatted1.includes('5.5'), 'Formatted amount includes value');
  assert(formatted1.includes('USDC'), 'Formatted amount includes asset');
  assert(formatted1.includes('5.50 USD'), 'Formatted amount includes USD value');

  // Test 17: Approval Queue
  testSection('Test 17: Approval Queue');
  const txId = await safety.queueForApproval({
    asset: 'usdc',
    amount: 7.5,
    usdValue: 7.5,
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'High-value payment requiring approval',
    validation: result6
  });
  assert(txId !== undefined, 'Transaction queued with ID');

  const pending = await safety.getPendingTransactions();
  assert(pending.length > 0, 'Pending transactions list not empty');
  assert(pending[0].type === 'transaction', 'Pending item is a transaction');
  assert(pending[0].status === 'pending', 'Transaction status is pending');

  // Test 18: Transaction Approval
  testSection('Test 18: Transaction Approval');
  const approved = await safety.approveTransaction(txId);
  assert(approved.status === 'approved', 'Transaction marked as approved');
  assert(approved.approvedAt !== undefined, 'Approval timestamp set');

  // Test 19: Transaction Rejection
  testSection('Test 19: Transaction Rejection');
  const txId2 = await safety.queueForApproval({
    asset: 'eth',
    amount: 0.005,
    usdValue: 15,
    recipient: '0x1234567890123456789012345678901234567890',
    purpose: 'Test rejection'
  });
  const rejected = await safety.rejectTransaction(txId2, 'Too expensive');
  assert(rejected.status === 'rejected', 'Transaction marked as rejected');
  assert(rejected.rejectionReason === 'Too expensive', 'Rejection reason recorded');

  // Test 20: Price Update
  testSection('Test 20: Price Update');
  safety.updateAssetPrice('eth', 3500);
  const updatedConfig = safety.getAssetConfig('eth');
  assert(updatedConfig.priceUSD === 3500, 'ETH price updated to $3500');
  const newEthValue = safety.normalizeToUSD(0.001, 'eth');
  assert(newEthValue === 3.5, 'New ETH price reflected in USD calculation');

  // Final Report
  console.log('\n' + '='.repeat(60));
  console.log('📊 Final Spending Report');
  console.log('='.repeat(60));
  const finalReport = safety.getReport();
  console.log(JSON.stringify(finalReport, null, 2));

  // Test Summary
  console.log('\n' + '='.repeat(60));
  console.log('🎯 Test Summary');
  console.log('='.repeat(60));
  console.log(`✓ Passed: ${testsPassed}`);
  console.log(`✗ Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);

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
  console.error('\n💥 Test suite failed with error:');
  console.error(error);
  process.exit(1);
});
