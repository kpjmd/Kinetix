// /utils/erc8004-identity.js
// ERC-8004 Identity Registry interaction service

const { ethers } = require('ethers');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const abiData = require('../config/erc8004/erc8004-abis.json');

const NETWORKS = {
  base_mainnet: {
    rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    identityRegistry: abiData.IdentityRegistry.address.base_mainnet,
    chainId: 8453,
    name: 'Base Mainnet',
    explorer: 'https://basescan.org'
  },
  base_sepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    identityRegistry: abiData.IdentityRegistry.address.base_sepolia,
    chainId: 84532,
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org'
  }
};

class ERC8004IdentityService {
  constructor() {
    this.signer = null;
    this.provider = null;
    this.contract = null;
    this.network = null;
    this.walletAddress = null;
    this.initialized = false;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [ERC8004Identity] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize with network selection
   * @param {string} networkName - 'base_mainnet' or 'base_sepolia'
   */
  async initialize(networkName = null) {
    if (this.initialized) {
      this._log('Already initialized', { address: this.walletAddress });
      return;
    }

    const network = networkName || process.env.DEFAULT_NETWORK || 'base_sepolia';
    if (!NETWORKS[network]) {
      throw new Error(`Unknown network: ${network}. Use base_mainnet or base_sepolia`);
    }

    const signingKey = process.env.KINETIX_SIGNING_KEY;
    if (!signingKey) {
      throw new Error('KINETIX_SIGNING_KEY not set in .env');
    }

    this.network = NETWORKS[network];
    this.provider = new ethers.JsonRpcProvider(this.network.rpc);
    this.signer = new ethers.Wallet(signingKey, this.provider);
    this.walletAddress = this.signer.address;

    this.contract = new ethers.Contract(
      this.network.identityRegistry,
      abiData.IdentityRegistry.abi,
      this.signer
    );

    this.initialized = true;
    this._log('Initialized', {
      network: network,
      address: this.walletAddress,
      registry: this.network.identityRegistry
    });
  }

  /**
   * Check wallet ETH balance
   * @returns {Promise<{balance: bigint, formatted: string}>}
   */
  async checkBalance() {
    this._ensureInitialized();
    const balance = await this.provider.getBalance(this.walletAddress);
    const formatted = ethers.formatEther(balance);
    this._log(`Balance: ${formatted} ETH`);
    if (balance === 0n) {
      throw new Error('Wallet has zero balance. Fund it with ETH for gas.');
    }
    return { balance, formatted };
  }

  /**
   * Estimate gas for registration
   * @param {string} agentURI - ipfs:// URI
   * @returns {Promise<{gasEstimate: bigint, estimatedCostEth: string}>}
   */
  async estimateRegistrationGas(agentURI) {
    this._ensureInitialized();
    const gasEstimate = await this.contract['register(string)'].estimateGas(agentURI);
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    const estimatedCost = gasEstimate * gasPrice;
    const estimatedCostEth = ethers.formatEther(estimatedCost);

    this._log('Gas estimate', {
      gasEstimate: gasEstimate.toString(),
      gasPrice: ethers.formatUnits(gasPrice, 'gwei') + ' gwei',
      estimatedCost: estimatedCostEth + ' ETH'
    });

    return { gasEstimate, estimatedCostEth };
  }

  /**
   * Register agent on Identity Registry
   * @param {string} agentURI - ipfs:// URI
   * @returns {Promise<{tokenId: string, txHash: string, blockNumber: number}>}
   */
  async registerAgent(agentURI) {
    this._ensureInitialized();

    this._log('Submitting registration transaction...', { agentURI });

    const { gasEstimate } = await this.estimateRegistrationGas(agentURI);

    const tx = await this.contract['register(string)'](agentURI, {
      gasLimit: gasEstimate * 120n / 100n  // 20% buffer
    });

    this._log('Transaction submitted', {
      txHash: tx.hash,
      explorerUrl: `${this.network.explorer}/tx/${tx.hash}`
    });

    // Wait for confirmation
    const receipt = await tx.wait();
    this._log('Transaction confirmed', {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    });

    // Parse AgentRegistered event
    const event = this._parseAgentRegisteredEvent(receipt);

    this._log('Registration complete', {
      agentId: event.agentId,
      owner: event.owner
    });

    return {
      tokenId: event.agentId,
      controller: event.owner,
      agentURI: event.agentURI,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    };
  }

  /**
   * Verify registration by querying on-chain
   * @param {string} tokenId
   * @returns {Promise<{owner: string, tokenURI: string, isValid: boolean}>}
   */
  async verifyRegistration(tokenId) {
    this._ensureInitialized();
    const owner = await this.contract.ownerOf(tokenId);
    const tokenURI = await this.contract.tokenURI(tokenId);

    const isValid = owner.toLowerCase() === this.walletAddress.toLowerCase();
    this._log('Verification result', { tokenId, owner, tokenURI, isValid });
    return { owner, tokenURI, isValid };
  }

  /**
   * Update agent metadata URI
   * @param {string|number} tokenId - Agent token ID
   * @param {string} newURI - New ipfs:// URI
   * @returns {Promise<{txHash: string, blockNumber: number, gasUsed: string}>}
   */
  async updateAgentURI(tokenId, newURI) {
    this._ensureInitialized();

    this._log('Updating agent metadata URI...', {
      tokenId: tokenId.toString(),
      newURI
    });

    // Estimate gas
    const gasEstimate = await this.contract.setAgentURI.estimateGas(
      tokenId,
      newURI
    );

    this._log('Gas estimated', { gasEstimate: gasEstimate.toString() });

    // Submit transaction with 20% safety buffer
    const tx = await this.contract.setAgentURI(tokenId, newURI, {
      gasLimit: gasEstimate * 120n / 100n
    });

    this._log('Transaction submitted', { txHash: tx.hash });

    // Wait for confirmation
    const receipt = await tx.wait();

    this._log('Update confirmed', {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    });

    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    };
  }

  /**
   * Parse Registered event from receipt
   */
  _parseAgentRegisteredEvent(receipt) {
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed && parsed.name === 'Registered') {
          return {
            agentId: parsed.args.agentId.toString(),
            owner: parsed.args.owner,
            agentURI: parsed.args.agentURI
          };
        }
      } catch {
        // Not our event, skip
      }
    }
    throw new Error('Registered event not found in transaction logs');
  }

  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('ERC8004IdentityService not initialized. Call initialize() first.');
    }
  }
}

// Singleton export (matches attestation-service.js pattern)
module.exports = new ERC8004IdentityService();
module.exports.ERC8004IdentityService = ERC8004IdentityService;
