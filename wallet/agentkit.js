const { AgentKit, CdpEvmWalletProvider } = require('@coinbase/agentkit');
const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config();

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

/**
 * KinetixWallet - Coinbase AgentKit wallet integration for Kinetix AI agent
 *
 * Provides wallet management using Coinbase CDP EVM Wallet Provider with:
 * - Automatic wallet persistence
 * - Balance checking for ETH and USDC
 * - Wallet export for backup
 * - Support for Base mainnet and Base Sepolia testnet
 */
class KinetixWallet {
  constructor() {
    this.agentKit = null;
    this.walletProvider = null;
    this.address = null;
    this.initialized = false;
    const baseDataDir = process.env.DATA_DIR || path.join(__dirname, '..');
    this.walletDataPath = path.join(baseDataDir, 'wallet-data', 'wallet.json');
  }

  /**
   * Log with timestamp for debugging
   */
  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [KinetixWallet] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize wallet - load from file or create new
   * @returns {Promise<string>} Wallet address
   */
  async initialize() {
    if (this.initialized) {
      this._log('Wallet already initialized', { address: this.address });
      return this.address;
    }

    this._log('Starting wallet initialization...');

    // Validate required environment variables
    const requiredEnvVars = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);

    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    const networkId = process.env.NETWORK_ID || 'base-sepolia';
    this._log(`Using network: ${networkId}`);

    try {
      // Check if wallet data exists
      let walletData = null;
      try {
        const walletJson = await fs.readFile(this.walletDataPath, 'utf-8');
        walletData = JSON.parse(walletJson);
        this._log('Found existing wallet data');
      } catch (error) {
        if (error.code === 'ENOENT') {
          this._log('No existing wallet found, will create new wallet');
        } else {
          throw error;
        }
      }

      // Fallback: load wallet data from env var (for Railway where filesystem is ephemeral)
      if (!walletData && process.env.WALLET_DATA) {
        try {
          walletData = JSON.parse(process.env.WALLET_DATA);
          this._log('Loaded wallet data from WALLET_DATA env var');
        } catch (e) {
          this._log('Warning: WALLET_DATA env var is not valid JSON, ignoring');
        }
      }

      // Create wallet provider configuration
      const walletProviderConfig = {
        apiKeyId: process.env.CDP_API_KEY_ID,
        apiKeySecret: process.env.CDP_API_KEY_SECRET,
        networkId: networkId
      };

      // Wallet secret is required for CDP managed wallets
      walletProviderConfig.walletSecret = process.env.CDP_WALLET_SECRET;

      if (walletData && walletData.address) {
        walletProviderConfig.address = walletData.address;
      }

      // Initialize wallet provider
      this._log('Creating CdpEvmWalletProvider...');
      this.walletProvider = await CdpEvmWalletProvider.configureWithWallet(walletProviderConfig);

      // Initialize AgentKit
      this._log('Creating AgentKit instance...');
      this.agentKit = new AgentKit({
        walletProvider: this.walletProvider
      });

      // Get wallet address
      this.address = await this.walletProvider.getAddress();
      this._log('Wallet initialized successfully', { address: this.address });

      // Persist wallet data
      await this._persistWallet();

      this.initialized = true;
      return this.address;

    } catch (error) {
      this._log('Error initializing wallet', { error: error.message });
      throw error;
    }
  }

  /**
   * Persist wallet data to file
   */
  async _persistWallet() {
    try {
      // Export wallet data from provider
      const walletData = await this.walletProvider.exportWallet();

      // Ensure wallet-data directory exists
      const walletDataDir = path.dirname(this.walletDataPath);
      await fs.mkdir(walletDataDir, { recursive: true });

      // Save to file
      await fs.writeFile(
        this.walletDataPath,
        JSON.stringify(walletData, null, 2),
        'utf-8'
      );

      this._log('Wallet data persisted successfully');
    } catch (error) {
      this._log('Error persisting wallet data', { error: error.message });
      throw error;
    }
  }

  /**
   * Get balance for specified asset
   * @param {string} asset - Asset symbol (eth, usdc)
   * @returns {Promise<object>} Balance information
   */
  async getBalance(asset = 'usdc') {
    if (!this.initialized) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }

    this._log(`Fetching balance for ${asset.toUpperCase()}...`);

    try {
      const assetLower = asset.toLowerCase();
      let formattedBalance;

      if (assetLower === 'eth') {
        // Get ETH balance
        const balance = await this.walletProvider.getBalance();
        formattedBalance = balance.toString();
      } else if (assetLower === 'usdc') {
        // CdpEvmWalletProvider.getBalance() takes no arguments and always
        // returns the native ETH balance, so USDC needs a direct ERC-20 read.
        const usdc = await this._getErc20Balance('usdc');
        formattedBalance = ethers.formatUnits(usdc.raw, usdc.decimals);
      } else {
        throw new Error(`Unsupported asset: ${asset}. Supported assets: eth, usdc`);
      }

      const result = {
        asset: asset.toUpperCase(),
        balance: formattedBalance,
        address: this.address
      };

      this._log('Balance retrieved', result);
      return result;

    } catch (error) {
      this._log('Error getting balance', { error: error.message });
      throw error;
    }
  }

  /**
   * Read an ERC-20 balance directly via RPC, using the per-network contract
   * address configured in config/safety-limits.json.
   * @param {string} assetName - Asset key in safety-limits.json (e.g. 'usdc')
   * @returns {Promise<{raw: bigint, decimals: number}>}
   */
  async _getErc20Balance(assetName) {
    const configPath = path.join(__dirname, '../config/safety-limits.json');
    const safetyConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const assetConfig = safetyConfig.assets[assetName];
    if (!assetConfig) {
      throw new Error(`No config found for asset: ${assetName}`);
    }

    const networkId = process.env.NETWORK_ID || 'base-sepolia';
    const networkKey = networkId.replace(/-/g, '_');
    const contractAddress = assetConfig.contractAddresses?.[networkKey];
    if (!contractAddress) {
      throw new Error(`No ${assetName} contract address configured for network: ${networkKey}`);
    }

    const rpcUrl = networkKey === 'base_mainnet'
      ? (process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org')
      : (process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org');

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const token = new ethers.Contract(contractAddress, ERC20_BALANCE_ABI, provider);
    const raw = await token.balanceOf(this.address);
    return { raw, decimals: assetConfig.decimals };
  }

  /**
   * Get wallet address
   * @returns {string|null} Wallet address or null if not initialized
   */
  getAddress() {
    if (!this.initialized) {
      this._log('Wallet not initialized');
      return null;
    }
    return this.address;
  }

  /**
   * Export wallet data for backup
   * @returns {Promise<object>} Wallet export data
   */
  async exportWallet() {
    if (!this.initialized) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }

    this._log('Exporting wallet data...');

    try {
      const walletData = await this.walletProvider.exportWallet();

      const exportData = {
        address: this.address,
        networkId: process.env.NETWORK_ID || 'base-sepolia',
        exportedAt: new Date().toISOString(),
        walletData: walletData
      };

      this._log('Wallet exported successfully');
      return exportData;

    } catch (error) {
      this._log('Error exporting wallet', { error: error.message });
      throw error;
    }
  }
}

// Singleton export
const kinetixWallet = new KinetixWallet();
module.exports = kinetixWallet;
