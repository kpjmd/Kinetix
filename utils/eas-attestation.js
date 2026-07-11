// /utils/eas-attestation.js
// Ethereum Attestation Service (EAS) integration — chain-anchored attestations
// that require no recipient pre-registration, unlike ERC-8004 Reputation Registry
// submissions. Used as the universal on-chain proof for every issued receipt.

const { ethers } = require('ethers');
const { EAS, SchemaEncoder } = require('@ethereum-attestation-service/eas-sdk');
require('dotenv').config();

const easConfig = require('../config/eas/eas-config.json');

const SCHEMA_STRING = 'string receiptId,bytes32 receiptHash,string verificationType,uint8 score,string ipfsUri';

const NETWORKS = {
  base_mainnet: {
    rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    easAddress: easConfig.base_mainnet.easAddress,
    schemaUID: easConfig.base_mainnet.schemaUID,
    chainId: 8453,
    name: 'Base Mainnet',
    explorer: easConfig.base_mainnet.explorer
  },
  base_sepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    easAddress: easConfig.base_sepolia.easAddress,
    schemaUID: easConfig.base_sepolia.schemaUID,
    chainId: 84532,
    name: 'Base Sepolia',
    explorer: easConfig.base_sepolia.explorer
  }
};

class EASAttestationService {
  constructor() {
    this.eas = null;
    this.signer = null;
    this.provider = null;
    this.network = null;
    this.networkName = null;
    this.schemaEncoder = new SchemaEncoder(SCHEMA_STRING);
    this.initialized = false;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [EASAttestation] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize with network selection
   * @param {string} networkName - 'base_mainnet' or 'base_sepolia'
   */
  async initialize(networkName = null) {
    if (this.initialized) return;

    const network = networkName || process.env.DEFAULT_NETWORK || 'base_mainnet';
    if (!NETWORKS[network]) {
      throw new Error(`Unknown network: ${network}. Use base_mainnet or base_sepolia`);
    }

    const signingKey = process.env.KINETIX_SIGNING_KEY;
    if (!signingKey) {
      throw new Error('KINETIX_SIGNING_KEY not set in .env');
    }

    if (!NETWORKS[network].schemaUID) {
      throw new Error(
        `No EAS schema registered for ${network}. Run scripts/register-eas-schema.js --network ${network} first.`
      );
    }

    this.network = NETWORKS[network];
    this.networkName = network;
    this.provider = new ethers.JsonRpcProvider(this.network.rpc);
    this.signer = new ethers.Wallet(signingKey, this.provider);

    this.eas = new EAS(this.network.easAddress);
    this.eas.connect(this.signer);

    this.initialized = true;
    this._log('Initialized', {
      network,
      address: this.signer.address,
      easAddress: this.network.easAddress,
      schemaUID: this.network.schemaUID
    });
  }

  /**
   * Submit an EAS attestation for a receipt. Requires only the recipient's
   * wallet address — no ERC-8004 (or any other) registration needed.
   * @param {Object} receipt - Attestation receipt
   * @returns {Promise<{uid: string, txHash: string}>}
   */
  async submitAttestation(receipt) {
    this._ensureInitialized();

    const recipient = receipt.recipient?.wallet_address;
    if (!recipient) {
      throw new Error(`NO_WALLET: recipient "${receipt.recipient?.agent_id}" has no wallet_address for EAS attestation.`);
    }

    const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(receipt)));

    const data = this.schemaEncoder.encodeData([
      { name: 'receiptId', value: receipt.receipt_id, type: 'string' },
      { name: 'receiptHash', value: receiptHash, type: 'bytes32' },
      { name: 'verificationType', value: receipt.commitment?.verification_type || 'unknown', type: 'string' },
      { name: 'score', value: receipt.verification_result?.overall_score || 0, type: 'uint8' },
      { name: 'ipfsUri', value: receipt.reputation_context?.ipfs_uri || '', type: 'string' }
    ]);

    this._log('Submitting EAS attestation...', { receiptId: receipt.receipt_id, recipient });

    const tx = await this.eas.attest({
      schema: this.network.schemaUID,
      data: {
        recipient,
        expirationTime: 0n,
        revocable: true,
        data
      }
    });

    const uid = await tx.wait();
    const txHash = tx.receipt?.hash || tx.tx?.hash || null;

    this._log('EAS attestation submitted', { uid, txHash });

    return {
      uid,
      txHash,
      explorerUrl: `${this.network.explorer}/attestation/view/${uid}`
    };
  }

  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('EASAttestationService not initialized. Call initialize() first.');
    }
  }
}

// Singleton export (matches pattern from erc8004-reputation.js)
module.exports = new EASAttestationService();
module.exports.EASAttestationService = EASAttestationService;
module.exports.SCHEMA_STRING = SCHEMA_STRING;
