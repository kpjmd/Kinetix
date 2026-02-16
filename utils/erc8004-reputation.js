// /utils/erc8004-reputation.js
// ERC-8004 Reputation Registry interaction service

const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

const abiData = require('../config/erc8004/erc8004-abis.json');
const dataStore = require('../services/data-store');

const NETWORKS = {
  base_mainnet: {
    rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    reputationRegistry: abiData.ReputationRegistry.address.base_mainnet,
    chainId: 8453,
    name: 'Base Mainnet',
    explorer: 'https://basescan.org'
  },
  base_sepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    reputationRegistry: abiData.ReputationRegistry.address.base_sepolia,
    chainId: 84532,
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org'
  }
};

class ERC8004ReputationService {
  constructor() {
    this.signer = null;
    this.provider = null;
    this.contract = null;
    this.network = null;
    this.walletAddress = null;
    this.kinetixTokenId = null;
    this.initialized = false;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [ERC8004Reputation] ${message}`);
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
      this._log('Already initialized', {
        tokenId: this.kinetixTokenId,
        address: this.walletAddress
      });
      return;
    }

    const network = networkName || process.env.DEFAULT_NETWORK || 'base_mainnet';
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
      this.network.reputationRegistry,
      abiData.ReputationRegistry.abi,
      this.signer
    );

    // Load Kinetix token ID from identity file
    const identity = await dataStore.loadERC8004Identity(network);
    if (!identity) {
      throw new Error(`Kinetix not registered on ${network}. Run registration first.`);
    }
    this.kinetixTokenId = identity.tokenId;

    this.initialized = true;
    this._log('Initialized', {
      network: network,
      address: this.walletAddress,
      registry: this.network.reputationRegistry,
      kinetixTokenId: this.kinetixTokenId
    });
  }

  /**
   * Map attestation receipt to giveFeedback parameters
   */
  _mapReceiptToFeedback(receipt, ipfsHash) {
    // agentId: Kinetix's ERC-8004 token ID
    const agentId = this.kinetixTokenId;

    // value: overall_score (0-100)
    const value = receipt.verification_result?.overall_score || 0;

    // valueDecimals: 0 (whole numbers)
    const valueDecimals = 0;

    // tag1: verification_type
    const tag1 = receipt.commitment?.verification_type || 'unknown';

    // tag2: status
    const tag2 = receipt.verification_result?.status || 'unknown';

    // endpoint: commitment description (truncate to 64 chars for gas efficiency)
    const endpoint = (receipt.commitment?.description || '').substring(0, 64);

    // feedbackURI: ipfs:// link
    const feedbackURI = `ipfs://${ipfsHash}`;

    // feedbackHash: keccak256 of receipt JSON
    const receiptString = JSON.stringify(receipt);
    const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(receiptString));

    return {
      agentId,
      value,
      valueDecimals,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash
    };
  }

  /**
   * Estimate gas for reputation submission
   * @param {Object} receipt - Attestation receipt
   * @param {string} ipfsHash - IPFS hash of attestation
   * @returns {Promise<{gasEstimate: bigint, estimatedCostEth: string}>}
   */
  async estimateSubmissionGas(receipt, ipfsHash) {
    this._ensureInitialized();

    const params = this._mapReceiptToFeedback(receipt, ipfsHash);

    const gasEstimate = await this.contract.giveFeedback.estimateGas(
      params.agentId,
      params.value,
      params.valueDecimals,
      params.tag1,
      params.tag2,
      params.endpoint,
      params.feedbackURI,
      params.feedbackHash
    );

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
   * Submit attestation to Reputation Registry
   * @param {Object} receipt - Attestation receipt
   * @param {string} ipfsHash - IPFS hash of attestation
   * @returns {Promise<{feedbackIndex: string, txHash: string, blockNumber: number}>}
   */
  async submitAttestation(receipt, ipfsHash) {
    this._ensureInitialized();

    const params = this._mapReceiptToFeedback(receipt, ipfsHash);

    this._log('Submitting reputation feedback...', {
      agentId: params.agentId,
      value: params.value,
      tag1: params.tag1,
      tag2: params.tag2,
      feedbackURI: params.feedbackURI
    });

    const { gasEstimate } = await this.estimateSubmissionGas(receipt, ipfsHash);

    const tx = await this.contract.giveFeedback(
      params.agentId,
      params.value,
      params.valueDecimals,
      params.tag1,
      params.tag2,
      params.endpoint,
      params.feedbackURI,
      params.feedbackHash,
      {
        gasLimit: gasEstimate * 120n / 100n  // 20% buffer
      }
    );

    this._log('Transaction submitted', {
      txHash: tx.hash,
      explorerUrl: `${this.network.explorer}/tx/${tx.hash}`
    });

    // Wait for confirmation
    const txReceipt = await tx.wait();
    this._log('Transaction confirmed', {
      blockNumber: txReceipt.blockNumber,
      gasUsed: txReceipt.gasUsed.toString()
    });

    // Parse NewFeedback event
    const event = this._parseNewFeedbackEvent(txReceipt);

    this._log('Reputation submitted', {
      feedbackIndex: event.feedbackIndex,
      agentId: event.agentId
    });

    return {
      feedbackIndex: event.feedbackIndex,
      txHash: txReceipt.hash,
      blockNumber: txReceipt.blockNumber,
      gasUsed: txReceipt.gasUsed.toString()
    };
  }

  /**
   * Query agent reputation summary
   * @param {string} agentId - ERC-8004 token ID
   * @param {string} tag1 - Optional filter by tag1
   * @param {string} tag2 - Optional filter by tag2
   * @returns {Promise<{count: string, sum: string, average: number}>}
   */
  async getAgentReputation(agentId, tag1 = '', tag2 = '') {
    this._ensureInitialized();

    const clientAddresses = [this.walletAddress];
    const summary = await this.contract.getSummary(agentId, clientAddresses, tag1, tag2);

    const count = summary[0].toString();
    const sum = summary[1].toString();
    const decimals = summary[2].toString();

    // Calculate average
    const average = count > 0 ? parseInt(sum) / parseInt(count) : 0;

    this._log('Reputation summary', {
      agentId,
      count,
      sum,
      decimals,
      average: average.toFixed(2)
    });

    return { count, sum, decimals, average };
  }

  /**
   * Parse NewFeedback event from transaction receipt
   */
  _parseNewFeedbackEvent(txReceipt) {
    for (const log of txReceipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed && parsed.name === 'NewFeedback') {
          return {
            agentId: parsed.args.agentId.toString(),
            clientAddress: parsed.args.clientAddress,
            feedbackIndex: parsed.args.feedbackIndex.toString(),
            value: parsed.args.value.toString(),
            valueDecimals: parsed.args.valueDecimals.toString()
          };
        }
      } catch {
        // Not our event, skip
      }
    }
    throw new Error('NewFeedback event not found in transaction logs');
  }

  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('ERC8004ReputationService not initialized. Call initialize() first.');
    }
  }
}

// Singleton export (matches pattern from erc8004-identity.js)
module.exports = new ERC8004ReputationService();
module.exports.ERC8004ReputationService = ERC8004ReputationService;
