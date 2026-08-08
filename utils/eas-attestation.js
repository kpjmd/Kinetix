// /utils/eas-attestation.js
// Ethereum Attestation Service (EAS) integration — chain-anchored attestations
// that require no recipient pre-registration, unlike ERC-8004 Reputation Registry
// submissions. Used as the universal on-chain proof for every issued receipt.

const { ethers } = require('ethers');
const { EAS, SchemaEncoder } = require('@ethereum-attestation-service/eas-sdk');
require('dotenv').config();

const easConfig = require('../config/eas/eas-config.json');
const { createSigner } = require('./signing-key');
const { resolveNetwork } = require('./network');
const { canonicalHash } = require('./receipt-canonical');
const { assertGasWithinCeiling } = require('./gas-guard');

const SCHEMA_STRING = 'string receiptId,bytes32 receiptHash,string verificationType,uint8 score,string ipfsUri';

// Matches the EVM-address test attestation-service.js uses when signing —
// anything that fails this was already blanked to '' in recipient.wallet_address
// before it ever reached here.
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

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
    const network = resolveNetwork(networkName);

    if (this.initialized) {
      // Pin to the first network initialized — refuse a silent switch that
      // would send attestations to a different chain than the caller expects.
      if (this.networkName !== network) {
        throw new Error(
          `EASAttestationService already initialized for ${this.networkName}; refusing to switch to ${network}.`
        );
      }
      return;
    }

    if (!NETWORKS[network].schemaUID) {
      throw new Error(
        `No EAS schema registered for ${network}. Run scripts/register-eas-schema.js --network ${network} first.`
      );
    }

    this.network = NETWORKS[network];
    this.networkName = network;
    this.provider = new ethers.JsonRpcProvider(this.network.rpc);
    this.signer = createSigner(this.provider);

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
   * Submit an EAS attestation for a receipt. Anchors every receipt
   * regardless of recipient identity: when recipient.wallet_address is a
   * real EVM address the attestation names them directly (anchor_mode
   * "recipient"); when it is absent (Nostr-only or platform-handle-only
   * agents) the attestation still lands on-chain, addressed to the zero
   * address (anchor_mode "unattributed") — the receiptHash, score, and
   * ipfsUri are still independently verifiable on Base either way. No
   * ERC-8004 (or any other) registration is needed for either mode.
   * @param {Object} receipt - Attestation receipt
   * @returns {Promise<{uid: string, txHash: string, explorerUrl: string, recipient: string, anchorMode: 'recipient'|'unattributed'}>}
   */
  async submitAttestation(receipt) {
    this._ensureInitialized();

    const rawWallet = receipt.recipient?.wallet_address;
    const hasRecipient = EVM_ADDRESS.test(rawWallet || '');
    // ethers.getAddress also normalises to EIP-55 checksum casing — worth
    // doing here since attestation-service.js stores whatever casing the
    // caller originally supplied.
    const recipient = hasRecipient ? ethers.getAddress(rawWallet) : ethers.ZeroAddress;
    const anchorMode = hasRecipient ? 'recipient' : 'unattributed';

    // Guardrail: refuse to send during a gas spike, same ceiling ERC-8004
    // submissions use. The raw signing wallet has no SafetyController gating.
    await assertGasWithinCeiling(this.provider);

    // Canonical, reproducible hash (same payload the receipt signature commits
    // to) — not keccak of insertion-order JSON.stringify, which included the
    // signature and mutable tracking fields and could not be reproduced later.
    const receiptHash = canonicalHash(receipt);

    const data = this.schemaEncoder.encodeData([
      { name: 'receiptId', value: receipt.receipt_id, type: 'string' },
      { name: 'receiptHash', value: receiptHash, type: 'bytes32' },
      { name: 'verificationType', value: receipt.commitment?.verification_type || 'unknown', type: 'string' },
      { name: 'score', value: receipt.verification_result?.overall_score || 0, type: 'uint8' },
      { name: 'ipfsUri', value: receipt.reputation_context?.ipfs_uri || '', type: 'string' }
    ]);

    this._log('Submitting EAS attestation...', { receiptId: receipt.receipt_id, recipient, anchorMode });

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
    // eas-sdk populates tx.receipt after wait(); its .hash is the tx hash.
    const txHash = tx.receipt?.hash || null;
    if (!txHash) {
      this._log('WARNING: EAS attestation confirmed but no tx hash on receipt', { uid });
    }

    this._log('EAS attestation submitted', { uid, txHash, anchorMode });

    return {
      uid,
      txHash,
      explorerUrl: `${this.network.explorer}/attestation/view/${uid}`,
      recipient,
      anchorMode
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
