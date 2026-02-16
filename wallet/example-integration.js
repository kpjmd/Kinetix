/**
 * Example integration of Kinetix Wallet into the main agent
 *
 * This shows how to integrate the wallet module into your agent's workflow
 */

const kinetixWallet = require('./agentkit');

/**
 * Initialize wallet on agent startup
 */
async function initializeAgentWallet() {
  try {
    console.log('Initializing Kinetix AI agent wallet...');

    // Initialize wallet
    const address = await kinetixWallet.initialize();

    console.log('\n✓ Wallet ready!');
    console.log(`  Address: ${address}`);

    // Get initial balances
    const ethBalance = await kinetixWallet.getBalance('eth');
    const usdcBalance = await kinetixWallet.getBalance('usdc');

    console.log(`  ETH Balance: ${ethBalance.balance}`);
    console.log(`  USDC Balance: ${usdcBalance.balance}`);

    return address;

  } catch (error) {
    console.error('Failed to initialize wallet:', error.message);
    throw error;
  }
}

/**
 * Check if wallet has sufficient USDC for transaction
 */
async function checkUSDCBalance(requiredAmount) {
  try {
    const balance = await kinetixWallet.getBalance('usdc');
    const balanceNum = parseFloat(balance.balance);

    console.log(`Required: ${requiredAmount} USDC`);
    console.log(`Available: ${balanceNum} USDC`);

    if (balanceNum >= requiredAmount) {
      console.log('✓ Sufficient balance');
      return true;
    } else {
      console.log('✗ Insufficient balance');
      return false;
    }

  } catch (error) {
    console.error('Error checking balance:', error.message);
    return false;
  }
}

/**
 * Get wallet status for agent monitoring
 */
async function getWalletStatus() {
  try {
    const address = kinetixWallet.getAddress();

    if (!address) {
      return { initialized: false };
    }

    const ethBalance = await kinetixWallet.getBalance('eth');
    const usdcBalance = await kinetixWallet.getBalance('usdc');

    return {
      initialized: true,
      address: address,
      balances: {
        eth: ethBalance.balance,
        usdc: usdcBalance.balance
      }
    };

  } catch (error) {
    console.error('Error getting wallet status:', error.message);
    return { initialized: false, error: error.message };
  }
}

/**
 * Example: Daily wallet check routine
 */
async function dailyWalletCheck() {
  console.log('\n=== Daily Wallet Check ===\n');

  const status = await getWalletStatus();

  if (!status.initialized) {
    console.log('⚠ Wallet not initialized');
    return;
  }

  console.log(`Address: ${status.address}`);
  console.log(`ETH Balance: ${status.balances.eth}`);
  console.log(`USDC Balance: ${status.balances.usdc}`);

  // Check if low on funds
  const usdcBalance = parseFloat(status.balances.usdc);
  const ethBalance = parseFloat(status.balances.eth);

  if (usdcBalance < 10) {
    console.log('\n⚠ Warning: USDC balance is low (< 10 USDC)');
  }

  if (ethBalance < 0.001) {
    console.log('\n⚠ Warning: ETH balance is low (< 0.001 ETH)');
  }

  console.log('\n=========================\n');
}

// Export functions for use in main agent
module.exports = {
  initializeAgentWallet,
  checkUSDCBalance,
  getWalletStatus,
  dailyWalletCheck
};

// Example usage
if (require.main === module) {
  (async () => {
    try {
      // Initialize wallet
      await initializeAgentWallet();

      // Perform daily check
      await dailyWalletCheck();

      // Check if we can afford a transaction
      await checkUSDCBalance(5.0);

    } catch (error) {
      console.error('Example failed:', error);
      process.exit(1);
    }
  })();
}
