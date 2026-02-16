const kinetixWallet = require('./agentkit');
const safetyController = require('./safety-controller');
const fs = require('fs');
const path = require('path');
const { parseUnits, encodeFunctionData } = require('viem');

/**
 * WalletManager - Unified wallet management with SafetyController integration
 *
 * Orchestrates wallet operations through AgentKit and SafetyController with:
 * - Transaction validation and approval workflows
 * - Telegram notifications for high-value transactions
 * - Multi-asset support (ETH, USDC, KINETIX)
 * - Spending tracking and limits enforcement
 */
class WalletManager {
  constructor() {
    this.wallet = kinetixWallet;
    this.safety = safetyController;
    this.initialized = false;
    this.telegramBot = null;
    this.adminId = process.env.TELEGRAM_ADMIN_ID;
    this.approvalQueueDir = path.resolve('./data/approval-queue');
    this.networkId = process.env.NETWORK_ID || 'base-sepolia';
  }

  /**
   * Log with timestamp for debugging
   */
  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WalletManager] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize WalletManager
   * @param {Object} telegramBot - Telegraf bot instance for notifications
   * @returns {Promise<string>} Wallet address
   */
  async initialize(telegramBot = null) {
    this._log('Initializing WalletManager...');

    // 1. Load SafetyController state from file
    this.safety.loadFromFile();

    // 2. Initialize AgentKit wallet
    await this.wallet.initialize();

    // 3. Store Telegram bot reference for notifications
    this.telegramBot = telegramBot;

    // 4. Resume pending transaction monitoring (expire stale transactions)
    await this._resumePendingTransactions();

    this.initialized = true;
    this._log('WalletManager initialized successfully', {
      address: this.wallet.getAddress(),
      network: this.networkId
    });

    return this.wallet.getAddress();
  }

  /**
   * Main payment method with validation and approval workflow
   * @param {string} recipient - Recipient address
   * @param {number} amount - Amount to send
   * @param {string} asset - Asset symbol (usdc, eth, kinetix)
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Transaction result
   */
  async sendPayment(recipient, amount, asset = 'usdc', metadata = {}) {
    if (!this.initialized) {
      throw new Error('WalletManager not initialized. Call initialize() first.');
    }

    this._log('Processing payment', { recipient, amount, asset });

    // Step 1: Validate with SafetyController
    const validation = await this.safety.validateTransaction(
      amount,
      asset,
      recipient,
      metadata
    );

    // Step 2: Handle validation result
    if (validation.requiresApproval) {
      // Queue for approval
      const txId = await this.safety.queueForApproval({
        asset,
        amount,
        usdValue: validation.usdValue,
        recipient,
        purpose: metadata.purpose || 'Payment',
        validation
      });

      // Notify via Telegram
      await this._notifyApprovalRequired(txId, amount, asset, recipient, validation.usdValue);

      return {
        status: 'pending_approval',
        approvalId: txId,
        usdValue: validation.usdValue,
        reason: validation.reason
      };
    }

    if (!validation.approved) {
      return {
        status: 'rejected',
        reason: validation.reason,
        checks: validation.checks
      };
    }

    // Step 3: Execute transaction
    try {
      const txResult = await this._executeTransfer(recipient, amount, asset);

      // Step 4: Record in SafetyController
      const recordId = this.safety.recordTransaction(
        amount,
        asset,
        validation.usdValue,
        { ...metadata, txHash: txResult.hash, recipient }
      );

      // Step 5: Persist state
      this.safety.saveToFile();

      return {
        status: 'executed',
        hash: txResult.hash,
        recordId,
        usdValue: validation.usdValue,
        explorerUrl: this._getExplorerUrl(txResult.hash)
      };
    } catch (error) {
      this._log('Transaction execution failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Send native ETH transfer
   * @param {string} recipient - Recipient address
   * @param {number} amount - Amount in ETH
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Transaction result
   */
  async sendNative(recipient, amount, metadata = {}) {
    return this.sendPayment(recipient, amount, 'eth', metadata);
  }

  /**
   * Send ERC-20 token transfer
   * @param {string} recipient - Recipient address
   * @param {number} amount - Amount of tokens
   * @param {string} tokenAddress - Token contract address
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Transaction result
   */
  async sendToken(recipient, amount, tokenAddress, metadata = {}) {
    // Determine asset name from address
    const assetConfig = this._getAssetByAddress(tokenAddress);
    const assetName = assetConfig ? assetConfig.name : 'token';

    if (!assetConfig) {
      throw new Error(`Unknown token address: ${tokenAddress}`);
    }

    return this.sendPayment(recipient, amount, assetName, metadata);
  }

  /**
   * Execute approved transaction from queue
   * @param {string} approvalId - Approval ID
   * @returns {Promise<Object>} Transaction result
   */
  async executeApprovedTransaction(approvalId) {
    // 1. Get approval data from queue
    const filePath = path.join(this.approvalQueueDir, `${approvalId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    const approvalData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // 2. Verify status is approved
    if (approvalData.status !== 'approved') {
      throw new Error(`Transaction ${approvalId} is not approved (status: ${approvalData.status})`);
    }

    // 3. Execute the transaction
    const { asset, amount, recipient } = approvalData.transaction;
    const txResult = await this._executeTransfer(recipient, parseFloat(amount), asset);

    // 4. Update approval file with execution details
    approvalData.status = 'executed';
    approvalData.executedAt = new Date().toISOString();
    approvalData.txHash = txResult.hash;
    fs.writeFileSync(filePath, JSON.stringify(approvalData, null, 2));

    // 5. Record in SafetyController
    const recordId = this.safety.recordTransaction(
      parseFloat(amount),
      asset,
      approvalData.transaction.usdValue,
      { txHash: txResult.hash, recipient, approvalId }
    );
    this.safety.saveToFile();

    return {
      status: 'executed',
      hash: txResult.hash,
      recordId,
      explorerUrl: this._getExplorerUrl(txResult.hash)
    };
  }

  /**
   * Get wallet status with balances and spending summary
   * @returns {Promise<Object>} Wallet status
   */
  async getStatus() {
    if (!this.initialized) {
      return { initialized: false };
    }

    const address = this.wallet.getAddress();
    const report = this.safety.getReport();
    const balances = await this.getAllBalances();

    return {
      initialized: true,
      address,
      network: this.networkId,
      balances,
      dailySpending: report.dailySpending,
      limits: report.limits,
      remainingDailyUSD: report.remainingDailyUSD,
      counters: report.counters
    };
  }

  /**
   * Get detailed spending report with per-asset breakdown
   * @returns {Promise<Object>} Spending report
   */
  async getSpendingReport() {
    const report = this.safety.getReport();
    const history = this.safety.getTransactionHistory(20);

    // Calculate per-asset breakdown
    const assetBreakdown = {};
    for (const [asset, amount] of Object.entries(report.dailySpending)) {
      if (asset === 'totalUSD') continue;
      const config = this.safety.getAssetConfig(asset);
      assetBreakdown[asset] = {
        spent: amount,
        usdValue: amount * (config?.priceUSD || 0),
        maxPerTx: config?.maxPerTx,
        countTowardLimits: config?.countTowardLimits
      };
    }

    return {
      ...report,
      assetBreakdown,
      recentTransactions: history
    };
  }

  /**
   * Get balance for a specific asset
   * @param {string} asset - Asset symbol
   * @returns {Promise<Object>} Balance information
   */
  async getAssetBalance(asset) {
    return this.wallet.getBalance(asset);
  }

  /**
   * Get balances for all configured assets
   * @returns {Promise<Object>} All balances with USD values
   */
  async getAllBalances() {
    const assets = Object.keys(this.safety.config.assets);
    const balances = {};

    for (const asset of assets) {
      try {
        const config = this.safety.getAssetConfig(asset);
        let balance;

        if (asset === 'eth') {
          const result = await this.wallet.getBalance('eth');
          balance = result.balance;
        } else if (asset === 'usdc') {
          const result = await this.wallet.getBalance('usdc');
          balance = result.balance;
        } else {
          // For other tokens, we'd need to implement ERC-20 balance reading
          // For now, return 0
          balance = '0';
        }

        const balanceNum = parseFloat(balance);
        balances[asset] = {
          balance: balance,
          usdValue: balanceNum * config.priceUSD,
          priceUSD: config.priceUSD
        };
      } catch (error) {
        balances[asset] = { error: error.message };
      }
    }

    return balances;
  }

  /**
   * Get pending wallet transaction approvals
   * @returns {Promise<Array>} Pending approvals
   */
  async getPendingApprovals() {
    // Filter for transaction approvals only (not post approvals)
    const all = await this.safety.getPendingTransactions();
    return all.filter(tx => tx.type === 'transaction');
  }

  /**
   * Approve and execute transaction
   * @param {string} approvalId - Approval ID
   * @param {string} adminName - Admin who approved
   * @returns {Promise<Object>} Transaction result
   */
  async approveTransaction(approvalId, adminName) {
    // 1. Approve in SafetyController
    const approvalData = await this.safety.approveTransaction(approvalId);

    // 2. Update with admin info
    const filePath = path.join(this.approvalQueueDir, `${approvalId}.json`);
    approvalData.approvedBy = adminName;
    fs.writeFileSync(filePath, JSON.stringify(approvalData, null, 2));

    // 3. Execute the transaction
    const result = await this.executeApprovedTransaction(approvalId);

    return result;
  }

  /**
   * Reject transaction
   * @param {string} approvalId - Approval ID
   * @param {string} adminName - Admin who rejected
   * @param {string} reason - Rejection reason
   * @returns {Promise<Object>} Rejection result
   */
  async rejectTransaction(approvalId, adminName, reason = 'Rejected by admin') {
    const rejectionData = await this.safety.rejectTransaction(approvalId, reason);

    // Update with admin info
    const filePath = path.join(this.approvalQueueDir, `${approvalId}.json`);
    rejectionData.rejectedBy = adminName;
    fs.writeFileSync(filePath, JSON.stringify(rejectionData, null, 2));

    return rejectionData;
  }

  /**
   * Update asset price
   * @param {string} asset - Asset symbol
   * @param {number} priceUSD - New USD price
   * @returns {Object} Update result
   */
  updateAssetPrice(asset, priceUSD) {
    this.safety.updateAssetPrice(asset, priceUSD);
    return { asset, priceUSD, updated: new Date().toISOString() };
  }

  /**
   * Get current prices for all assets
   * @returns {Object} Asset prices
   */
  getCurrentPrices() {
    const prices = {};
    for (const [asset, config] of Object.entries(this.safety.config.assets)) {
      prices[asset] = {
        priceUSD: config.priceUSD,
        enabled: config.enabled
      };
    }
    return prices;
  }

  /**
   * Execute token transfer via AgentKit wallet
   * @private
   */
  async _executeTransfer(recipient, amount, asset) {
    const walletProvider = this.wallet.walletProvider;
    const assetConfig = this.safety.getAssetConfig(asset);

    if (asset === 'eth') {
      // Native ETH transfer
      const amountWei = parseUnits(amount.toString(), 18);
      const hash = await walletProvider.sendTransaction({
        to: recipient,
        value: amountWei
      });
      return { hash };
    } else if (assetConfig?.contractAddress) {
      // ERC-20 transfer
      const decimals = assetConfig.decimals || 18;
      const amountInWei = parseUnits(amount.toString(), decimals);

      // ERC-20 transfer function data
      const transferData = encodeFunctionData({
        abi: [{
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: [{ name: 'success', type: 'bool' }],
          stateMutability: 'nonpayable'
        }],
        functionName: 'transfer',
        args: [recipient, amountInWei]
      });

      const hash = await walletProvider.sendTransaction({
        to: assetConfig.contractAddress,
        data: transferData
      });
      return { hash };
    } else {
      throw new Error(`Cannot execute transfer for asset: ${asset}`);
    }
  }

  /**
   * Get explorer URL for transaction
   * @private
   */
  _getExplorerUrl(hash) {
    const baseUrl = this.networkId === 'base-mainnet'
      ? 'https://basescan.org/tx/'
      : 'https://sepolia.basescan.org/tx/';
    return `${baseUrl}${hash}`;
  }

  /**
   * Send Telegram notification for approval required
   * @private
   */
  async _notifyApprovalRequired(txId, amount, asset, recipient, usdValue) {
    if (this.telegramBot && this.adminId) {
      const message =
        `🔔 *Transaction Approval Required*\n\n` +
        `💰 Amount: ${amount} ${asset.toUpperCase()}\n` +
        `💵 USD Value: $${usdValue.toFixed(2)}\n` +
        `📤 Recipient: \`${recipient.slice(0, 10)}...${recipient.slice(-8)}\`\n` +
        `🔗 ID: ${txId}\n\n` +
        `✅ /approve_tx ${txId}\n` +
        `❌ /reject_tx ${txId} <reason>`;

      try {
        await this.telegramBot.telegram.sendMessage(this.adminId, message, {
          parse_mode: 'Markdown'
        });
        this._log('Approval notification sent', { txId });
      } catch (error) {
        this._log('Failed to send Telegram notification', { error: error.message });
      }
    }
  }

  /**
   * Resume pending transactions and expire stale ones
   * @private
   */
  async _resumePendingTransactions() {
    const pending = await this.getPendingApprovals();

    // Check for stale transactions (> 24 hours old)
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours

    for (const tx of pending) {
      const createdAt = new Date(tx.createdAt).getTime();
      if (now - createdAt > staleThreshold) {
        // Auto-reject stale transactions
        await this.rejectTransaction(tx.id, 'system', 'Transaction expired after 24 hours');
        this._log('Auto-rejected stale transaction', { id: tx.id });
      }
    }

    if (pending.length > 0) {
      this._log(`Found ${pending.length} pending transaction(s)`);
    }
  }

  /**
   * Get asset by contract address
   * @private
   */
  _getAssetByAddress(tokenAddress) {
    const normalizedAddress = tokenAddress.toLowerCase();
    for (const [name, config] of Object.entries(this.safety.config.assets)) {
      if (config.contractAddress?.toLowerCase() === normalizedAddress) {
        return { name, ...config };
      }
    }
    return null;
  }
}

// Singleton export
const walletManager = new WalletManager();
module.exports = walletManager;

// Also export class for testing
module.exports.WalletManager = WalletManager;
