// /utils/erc8004-reputation.js
// ERC-8004 Reputation Registry interaction service

const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

const abiData = require('../config/erc8004/erc8004-abis.json');
const dataStore = require('../services/data-store');
const { createSigner } = require('./signing-key');
const { resolveNetwork } = require('./network');
const { canonicalHash } = require('./receipt-canonical');

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
    const network = resolveNetwork(networkName);

    if (this.initialized) {
      if (this.networkName !== network) {
        throw new Error(
          `ERC8004ReputationService already initialized for ${this.networkName}; refusing to switch to ${network}.`
        );
      }
      this._log('Already initialized', {
        tokenId: this.kinetixTokenId,
        address: this.walletAddress
      });
      return;
    }

    this.network = NETWORKS[network];
    this.networkName = network;
    this.provider = new ethers.JsonRpcProvider(this.network.rpc);
    this.signer = createSigner(this.provider);
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
    // agentId: the recipient's ERC-8004 token ID (not Kinetix's own)
    const agentId = receipt.recipient?.erc8004_token_id;
    if (!agentId) {
      const err = new Error(
        `Recipient "${receipt.recipient?.agent_id}" has no erc8004_token_id. ` +
        `They must be registered on ERC-8004 for on-chain reputation submission.`
      );
      err.code = 'NOT_REGISTERED';
      throw err;
    }

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

    // feedbackHash: canonical, reproducible hash — the same payload the receipt
    // signature and the EAS receiptHash commit to (not insertion-order JSON,
    // which included the signature and mutable fields and was unreproducible).
    const feedbackHash = canonicalHash(receipt);

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
   * Throw GAS_CEILING if current gas price exceeds the configured ceiling.
   * Ceiling is MAX_SUBMISSION_FEE_GWEI (default 50 gwei — far above Base's
   * normal sub-gwei fees, so it only trips on abnormal spikes).
   */
  async _assertGasWithinCeiling() {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    if (!gasPrice) return; // fee data unavailable — do not block
    const ceilingGwei = process.env.MAX_SUBMISSION_FEE_GWEI || '50';
    const ceilingWei = ethers.parseUnits(String(ceilingGwei), 'gwei');
    if (gasPrice > ceilingWei) {
      const err = new Error(
        `GAS_CEILING: gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei exceeds ceiling ${ceilingGwei} gwei — deferring submission.`
      );
      err.code = 'GAS_CEILING';
      throw err;
    }
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
   * Returns true if the receipt is a self-verification (Kinetix verifying itself)
   */
  isSelfVerification(receipt) {
    const recipientId = (receipt.recipient?.agent_id || '').toLowerCase();
    if (['kinetix', 'kinetix_official'].includes(recipientId)) return true;

    // Address comparison must be case-insensitive: walletAddress is EIP-55
    // checksummed by ethers, while recipient.pubkey is user-supplied and may
    // be lowercase. A case mismatch here previously let a self-address slip
    // past and produce an ERC-8004 self-feedback attempt.
    const recipientPubkey = (receipt.recipient?.pubkey || '').toLowerCase();
    if (recipientPubkey && recipientPubkey === (this.walletAddress || '').toLowerCase()) {
      return true;
    }

    // Also catch the case where the recipient resolves to Kinetix's own token.
    const recipientTokenId = receipt.recipient?.erc8004_token_id;
    if (recipientTokenId != null && this.kinetixTokenId != null &&
        String(recipientTokenId) === String(this.kinetixTokenId)) {
      return true;
    }

    return false;
  }

  /**
   * Submit attestation to Reputation Registry
   * @param {Object} receipt - Attestation receipt
   * @param {string} ipfsHash - IPFS hash of attestation
   * @returns {Promise<{feedbackIndex: string, txHash: string, blockNumber: number}>}
   */
  async submitAttestation(receipt, ipfsHash, onBroadcast = null) {
    this._ensureInitialized();
    if (this.isSelfVerification(receipt)) {
      const err = new Error('SELF_VERIFICATION: Self-feedback not allowed by ERC-8004. Kinetix cannot submit on-chain entries for its own commitments.');
      err.code = 'SELF_VERIFICATION';
      throw err;
    }

    const params = this._mapReceiptToFeedback(receipt, ipfsHash);

    // Guardrail: refuse to send during a gas spike. The raw signing wallet has
    // no SafetyController gating, so this bounds per-tx fee. Base fees are
    // normally well under a gwei; the ceiling only trips on abnormal spikes.
    await this._assertGasWithinCeiling();

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

    // Broadcast complete but not yet confirmed — surface the hash so the caller
    // can persist it before awaiting confirmation. If the process dies during
    // wait(), the stored hash lets reconciliation recover instead of re-submitting.
    if (onBroadcast) {
      try {
        await onBroadcast(tx.hash);
      } catch (cbError) {
        this._log('onBroadcast callback failed (continuing to await confirmation)', { error: cbError.message });
      }
    }

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
   * Recover the outcome of a previously-broadcast submission by its tx hash,
   * without sending a new transaction. Used by reconciliation to avoid
   * duplicate on-chain writes when a prior submit was interrupted after
   * broadcast.
   * @param {string} txHash
   * @returns {Promise<{state: 'mined'|'reverted'|'pending'|'dropped', txReceipt?: Object, feedbackIndex?: string, blockNumber?: number}>}
   */
  async checkSubmissionByHash(txHash) {
    this._ensureInitialized();
    const txReceipt = await this.provider.getTransactionReceipt(txHash);
    if (txReceipt) {
      if (txReceipt.status === 0) {
        return { state: 'reverted', txReceipt };
      }
      let feedbackIndex = null;
      try {
        feedbackIndex = this._parseNewFeedbackEvent(txReceipt).feedbackIndex;
      } catch {
        // Mined successfully but event not parseable — still not a re-submit case.
      }
      return { state: 'mined', txReceipt, feedbackIndex, blockNumber: txReceipt.blockNumber };
    }
    // No receipt yet: distinguish still-pending (in mempool) from dropped.
    const tx = await this.provider.getTransaction(txHash);
    return { state: tx ? 'pending' : 'dropped' };
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
