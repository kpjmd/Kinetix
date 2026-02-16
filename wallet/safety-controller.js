const fs = require('fs');
const path = require('path');

class SafetyController {
  constructor(configPath = './config/safety-limits.json') {
    this.configPath = path.resolve(configPath);
    this.statePath = path.resolve('./data/spending-state.json');
    this.approvalQueueDir = path.resolve('./data/approval-queue');

    this.config = null;
    this.state = {
      lastReset: new Date().toISOString().split('T')[0] + 'T00:00:00Z',
      currentHour: new Date().toISOString().split(':')[0] + ':00:00Z',
      dailySpending: {},
      hourlyTxCount: 0,
      dailyTxCount: 0,
      transactionLog: []
    };

    this._loadConfig();
  }

  // Load configuration from JSON file
  _loadConfig() {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      this._log('Configuration loaded successfully');
    } catch (error) {
      this._log('Error loading config, using defaults', { error: error.message });
      throw new Error(`Failed to load safety-limits.json: ${error.message}`);
    }
  }

  // Logging with timestamp and module name
  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [SafetyController] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  // Validate asset exists and is enabled
  _validateAsset(asset) {
    const assetLower = asset.toLowerCase();
    if (!this.config.assets[assetLower]) {
      throw new Error(`UNKNOWN_ASSET: Asset '${asset}' not configured`);
    }
    if (!this.config.assets[assetLower].enabled) {
      throw new Error(`ASSET_DISABLED: Asset '${asset}' is disabled`);
    }
    return assetLower;
  }

  // Get asset configuration
  getAssetConfig(asset) {
    const assetLower = asset.toLowerCase();
    return this.config.assets[assetLower] || null;
  }

  // Convert token amount to USD equivalent
  normalizeToUSD(amount, asset) {
    const assetLower = this._validateAsset(asset);
    const assetConfig = this.config.assets[assetLower];
    return amount * assetConfig.priceUSD;
  }

  // Update asset price (for manual updates)
  updateAssetPrice(asset, priceUSD) {
    const assetLower = this._validateAsset(asset);
    this.config.assets[assetLower].priceUSD = priceUSD;
    this._log(`Updated ${asset} price to $${priceUSD}`);
  }

  // Format amount for display
  formatAmount(amount, asset) {
    const assetLower = this._validateAsset(asset);
    const assetConfig = this.config.assets[assetLower];
    return `${amount} ${asset.toUpperCase()} ($${(amount * assetConfig.priceUSD).toFixed(2)} USD)`;
  }

  // Parse amount string to number
  parseAmount(amountStr, asset) {
    const assetLower = this._validateAsset(asset);
    return parseFloat(amountStr);
  }

  // Reset daily/hourly counters if needed
  resetCountersIfNeeded() {
    const now = new Date();
    const currentDay = now.toISOString().split('T')[0] + 'T00:00:00Z';
    const currentHour = now.toISOString().split(':')[0] + ':00:00Z';

    // Reset daily counters
    if (this.state.lastReset !== currentDay) {
      this._log('Resetting daily counters', {
        previousDay: this.state.lastReset,
        newDay: currentDay
      });
      this.state.lastReset = currentDay;
      this.state.dailySpending = {};
      this.state.dailyTxCount = 0;
    }

    // Reset hourly counter
    if (this.state.currentHour !== currentHour) {
      this._log('Resetting hourly counter', {
        previousHour: this.state.currentHour,
        newHour: currentHour
      });
      this.state.currentHour = currentHour;
      this.state.hourlyTxCount = 0;
    }
  }

  // Main validation method
  async validateTransaction(amount, asset, recipient, metadata = {}) {
    this.resetCountersIfNeeded();

    const result = {
      approved: false,
      requiresApproval: false,
      reason: null,
      usdValue: 0,
      checks: {
        assetEnabled: false,
        assetLimit: false,
        usdPerTxLimit: false,
        dailyLimit: false,
        hourlyRate: false,
        whitelist: false
      }
    };

    try {
      // Check 1: Asset exists and is enabled
      const assetLower = this._validateAsset(asset);
      result.checks.assetEnabled = true;
      const assetConfig = this.config.assets[assetLower];

      // Check 2: Asset-specific maxPerTx limit
      if (amount > assetConfig.maxPerTx) {
        result.reason = 'ASSET_LIMIT_EXCEEDED';
        this._log('Validation failed: Asset limit exceeded', {
          asset: assetLower,
          amount,
          limit: assetConfig.maxPerTx
        });
        return result;
      }
      result.checks.assetLimit = true;

      // Check 3: Convert to USD
      const usdValue = this.normalizeToUSD(amount, assetLower);
      result.usdValue = usdValue;

      // Check 4: Requires approval threshold (before rejecting)
      if (usdValue > this.config.requireApprovalAboveUSD) {
        result.requiresApproval = true;
        result.reason = 'REQUIRES_APPROVAL';
        this._log('Transaction requires approval', {
          usdValue,
          threshold: this.config.requireApprovalAboveUSD
        });
        return result;
      }

      // Check 5: USD per-transaction limit
      if (usdValue > this.config.perTxLimitUSD) {
        result.reason = 'USD_LIMIT_EXCEEDED';
        this._log('Validation failed: USD per-tx limit exceeded', {
          usdValue,
          limit: this.config.perTxLimitUSD
        });
        return result;
      }
      result.checks.usdPerTxLimit = true;

      // Check 6: Hourly rate limit
      if (this.state.hourlyTxCount >= this.config.maxTxPerHour) {
        result.reason = 'HOURLY_RATE_EXCEEDED';
        this._log('Validation failed: Hourly rate exceeded', {
          count: this.state.hourlyTxCount,
          limit: this.config.maxTxPerHour
        });
        return result;
      }
      result.checks.hourlyRate = true;

      // Check 7: Daily limit (unless countTowardLimits is false)
      if (assetConfig.countTowardLimits !== false) {
        const currentTotalUSD = this.state.dailySpending.totalUSD || 0;
        if (currentTotalUSD + usdValue > this.config.dailyLimitUSD) {
          result.reason = 'DAILY_LIMIT_EXCEEDED';
          this._log('Validation failed: Daily limit exceeded', {
            currentTotal: currentTotalUSD,
            transactionValue: usdValue,
            wouldTotal: currentTotalUSD + usdValue,
            limit: this.config.dailyLimitUSD
          });
          return result;
        }
      }
      result.checks.dailyLimit = true;

      // Check 8: Recipient whitelist (if configured)
      if (this.config.allowedRecipients.length > 0) {
        if (!this.config.allowedRecipients.includes(recipient)) {
          result.reason = 'RECIPIENT_NOT_ALLOWED';
          this._log('Validation failed: Recipient not in whitelist', { recipient });
          return result;
        }
      }
      result.checks.whitelist = true;

      // All checks passed
      result.approved = true;
      this._log('Transaction validated successfully', {
        asset: assetLower,
        amount,
        usdValue,
        recipient: recipient.substring(0, 10) + '...'
      });

      return result;

    } catch (error) {
      result.reason = error.message;
      this._log('Validation error', { error: error.message });
      return result;
    }
  }

  // Record transaction after execution
  recordTransaction(amount, asset, usdValue, metadata = {}) {
    this.resetCountersIfNeeded();

    const assetLower = asset.toLowerCase();
    const assetConfig = this.config.assets[assetLower];

    // Create transaction log entry
    const txId = `tx_${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    const txEntry = {
      id: txId,
      timestamp: new Date().toISOString(),
      asset: assetLower,
      amount: amount.toString(),
      usdValue,
      ...metadata
    };

    // Update spending counters
    if (!this.state.dailySpending[assetLower]) {
      this.state.dailySpending[assetLower] = 0;
    }
    this.state.dailySpending[assetLower] += amount;

    // Update USD total only if countTowardLimits is true
    if (assetConfig.countTowardLimits !== false) {
      if (!this.state.dailySpending.totalUSD) {
        this.state.dailySpending.totalUSD = 0;
      }
      this.state.dailySpending.totalUSD += usdValue;
    }

    // Update transaction counts
    this.state.hourlyTxCount++;
    this.state.dailyTxCount++;

    // Add to transaction log (keep last 100)
    this.state.transactionLog.unshift(txEntry);
    if (this.state.transactionLog.length > 100) {
      this.state.transactionLog = this.state.transactionLog.slice(0, 100);
    }

    this._log('Transaction recorded', {
      id: txId,
      asset: assetLower,
      amount,
      usdValue
    });

    return txId;
  }

  // Queue transaction for approval
  async queueForApproval(txDetails) {
    // Ensure approval queue directory exists
    if (!fs.existsSync(this.approvalQueueDir)) {
      fs.mkdirSync(this.approvalQueueDir, { recursive: true });
    }

    const txId = `tx_${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    const approvalData = {
      id: txId,
      type: 'transaction',
      status: 'pending',
      createdAt: new Date().toISOString(),
      transaction: {
        asset: txDetails.asset,
        amount: txDetails.amount.toString(),
        usdValue: txDetails.usdValue,
        recipient: txDetails.recipient,
        purpose: txDetails.purpose || 'No purpose specified'
      },
      validation: txDetails.validation || {}
    };

    const filePath = path.join(this.approvalQueueDir, `${txId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(approvalData, null, 2));

    this._log('Transaction queued for approval', { id: txId, filePath });
    return txId;
  }

  // Get pending transactions
  async getPendingTransactions() {
    if (!fs.existsSync(this.approvalQueueDir)) {
      return [];
    }

    const files = fs.readdirSync(this.approvalQueueDir)
      .filter(f => f.startsWith('tx_') && f.endsWith('.json'));

    const pending = [];
    for (const file of files) {
      const filePath = path.join(this.approvalQueueDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.type === 'transaction' && data.status === 'pending') {
        pending.push(data);
      }
    }

    return pending;
  }

  // Approve transaction
  async approveTransaction(txId) {
    const filePath = path.join(this.approvalQueueDir, `${txId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Transaction ${txId} not found in approval queue`);
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.status = 'approved';
    data.approvedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    this._log('Transaction approved', { id: txId });
    return data;
  }

  // Reject transaction
  async rejectTransaction(txId, reason = null) {
    const filePath = path.join(this.approvalQueueDir, `${txId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Transaction ${txId} not found in approval queue`);
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.status = 'rejected';
    data.rejectedAt = new Date().toISOString();
    if (reason) {
      data.rejectionReason = reason;
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    this._log('Transaction rejected', { id: txId, reason });
    return data;
  }

  // Get spending report
  getReport() {
    this.resetCountersIfNeeded();

    const report = {
      lastReset: this.state.lastReset,
      currentHour: this.state.currentHour,
      dailySpending: { ...this.state.dailySpending },
      limits: {
        dailyLimitUSD: this.config.dailyLimitUSD,
        perTxLimitUSD: this.config.perTxLimitUSD,
        maxTxPerHour: this.config.maxTxPerHour,
        maxTxPerDay: this.config.maxTxPerDay
      },
      counters: {
        hourlyTxCount: this.state.hourlyTxCount,
        dailyTxCount: this.state.dailyTxCount
      },
      remainingDailyUSD: this.config.dailyLimitUSD - (this.state.dailySpending.totalUSD || 0),
      remainingHourlyTx: this.config.maxTxPerHour - this.state.hourlyTxCount
    };

    return report;
  }

  // Get transaction history
  getTransactionHistory(limit = 10) {
    return this.state.transactionLog.slice(0, limit);
  }

  // Save state to file
  saveToFile() {
    try {
      const dataDir = path.dirname(this.statePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
      this._log('State saved to file', { path: this.statePath });
    } catch (error) {
      this._log('Error saving state', { error: error.message });
      throw error;
    }
  }

  // Load state from file
  loadFromFile() {
    try {
      if (fs.existsSync(this.statePath)) {
        const stateData = fs.readFileSync(this.statePath, 'utf8');
        this.state = JSON.parse(stateData);
        this._log('State loaded from file', { path: this.statePath });
      } else {
        this._log('No existing state file found, using fresh state');
      }
    } catch (error) {
      this._log('Error loading state, using fresh state', { error: error.message });
    }
  }
}

// Export singleton instance
module.exports = new SafetyController();

// Also export the class for testing
module.exports.SafetyController = SafetyController;
