// /services/attestation-service.js
// Generate cryptographically signed attestation receipts

const { ethers } = require('ethers');
const dataStore = require('./data-store');
const crypto = require('crypto');

class AttestationService {
  constructor() {
    this.signingWallet = null;
    this.kinetixAddress = null;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [AttestationService] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize the attestation service
   */
  async initialize() {
    const signingKey = process.env.KINETIX_SIGNING_KEY;

    if (!signingKey) {
      this._log('⚠️  WARNING: KINETIX_SIGNING_KEY not set. Using ephemeral key. Receipts will NOT be verifiable across restarts.');
      this.signingWallet = ethers.Wallet.createRandom();
    } else {
      try {
        this.signingWallet = new ethers.Wallet(signingKey);
      } catch (error) {
        this._log('ERROR: Invalid KINETIX_SIGNING_KEY. Using ephemeral key.');
        this.signingWallet = ethers.Wallet.createRandom();
      }
    }

    this.kinetixAddress = this.signingWallet.address;

    this._log('Attestation service initialized', {
      signingAddress: this.signingWallet.address
    });
  }

  /**
   * Generate a complete attestation receipt
   */
  async generateReceipt(commitment) {
    const receiptId = dataStore.generateId('rcpt_kx_');
    const issuedAt = new Date().toISOString();
    const disputeDeadline = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Build receipt (all fields except signatures)
    const receipt = {
      receipt_version: '1.0.0',
      receipt_id: receiptId,
      receipt_type: 'verification_attestation',

      issuer: {
        name: 'Kinetix',
        agent_id: 'kinetix_official',
        pubkey: this.signingWallet.address,
        platform_profiles: {
          moltbook: 'https://www.moltbook.com/u/Kinetix',
          clawstr: 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5'
        }
      },

      recipient: {
        agent_id: commitment.agent_id,
        pubkey: commitment.pubkey || '',
        platform_profiles: commitment.platform_profiles || {},
        wallet_address: commitment.pubkey || ''
      },

      commitment: {
        commitment_id: commitment.commitment_id,
        description: commitment.description,
        verification_type: commitment.verification_type,
        criteria: commitment.criteria,
        commitment_created_at: commitment.created_at,
        commitment_start_date: commitment.start_date,
        commitment_end_date: commitment.end_date
      },

      verification_result: commitment.scoring_result,

      evidence: commitment.evidence.map((ev, index) => ({
        evidence_id: ev.evidence_id || `ev_${String(index + 1).padStart(3, '0')}`,
        timestamp: ev.timestamp,
        platform: ev.platform,
        action_type: ev.action_type,
        action_url: ev.action_url || '',
        event_id: ev.event_id || null,
        content_hash: ev.content_hash,
        quality_score: ev.quality_score || null,
        verification_method: ev.verification_method,
        verifier_notes: ev.verifier_notes || null
      })),

      payment: commitment.payment || {
        amount: '0',
        currency: 'USDC_EQUIVALENT',
        token_used: 'KINETIX',
        network: 'base',
        discount_applied: 0,
        transaction_hash: '',
        payment_timestamp: ''
      },

      metadata: {
        issued_at: issuedAt,
        expires_at: null,
        kinetix_reputation_impact: this._calculateReputationImpact(commitment.verification_type, commitment.scoring_result.overall_score),
        verification_difficulty: commitment.difficulty,
        dispute_window_days: 7,
        dispute_deadline: disputeDeadline,
        onchain_status: 'pending',
        schema_version: '1.0.0'
      },

      reputation_context: {
        agent_id: commitment.agent_id,
        reputation_value: commitment.scoring_result.overall_score,
        reputation_tags: [commitment.verification_type, commitment.scoring_result.status],
        ipfs_uri: null,           // Filled during IPFS upload
        submission_index: null,   // Filled after on-chain submission
        submitted_at: null        // Filled after on-chain submission
      }
    };

    // Generate hash and signature
    const signatures = await this._signReceipt(receipt);
    receipt.signatures = signatures;

    this._log(`Generated receipt ${receiptId} for ${commitment.commitment_id}`);

    return receipt;
  }

  /**
   * Calculate reputation impact based on verification type and score
   */
  _calculateReputationImpact(verificationType, overallScore) {
    const impactWeights = {
      consistency: 10,
      quality: 15,
      time_bound: 12
    };
    const weight = impactWeights[verificationType] || 10;
    const impact = (overallScore / 100) * weight;
    return Math.round(impact * 100) / 100;
  }

  /**
   * Recursively sort object keys for deterministic serialization
   */
  _sortedStringify(obj) {
    if (obj === null || typeof obj !== 'object' || obj instanceof Date) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this._sortedStringify(item));
    }
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = this._sortedStringify(obj[key]);
    });
    return sorted;
  }

  /**
   * Sign a receipt - hash all fields except signatures, then ECDSA sign
   */
  async _signReceipt(receipt) {
    // 1. Serialize receipt to deterministic JSON (recursively sorted keys)
    const sortedReceipt = this._sortedStringify(receipt);
    const receiptString = JSON.stringify(sortedReceipt);

    // 2. SHA-256 hash (human-readable)
    const sha256Hash = 'sha256:' + crypto.createHash('sha256')
      .update(receiptString).digest('hex');

    // 3. Keccak256 hash for signing (ethers.js standard)
    const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(receiptString));

    // 4. ECDSA signature
    const signature = await this.signingWallet.signMessage(
      ethers.getBytes(receiptHash)
    );

    return {
      receipt_hash: sha256Hash,
      kinetix_signature: signature,
      signature_algorithm: 'ECDSA_secp256k1',
      signed_at: new Date().toISOString(),
      eip712_domain: {
        name: 'KinetixProtocol',
        version: '1',
        chainId: 8453,
        verifyingContract: '0x0000000000000000000000000000000000000000' // Placeholder for Phase 2
      }
    };
  }

  /**
   * Verify a receipt's signature
   */
  verifyReceipt(receipt) {
    try {
      // Extract signatures, rebuild receipt without them
      const { signatures, ...receiptBody } = receipt;

      // Re-serialize and hash (using same recursive sorting as signing)
      const sortedReceipt = this._sortedStringify(receiptBody);
      const receiptString = JSON.stringify(sortedReceipt);
      const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(receiptString));

      // Recover signer address
      const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(receiptHash),
        signatures.kinetix_signature
      );

      // Compare to issuer pubkey
      const isValid = recoveredAddress.toLowerCase() === receipt.issuer.pubkey.toLowerCase();

      if (isValid) {
        this._log(`Receipt ${receipt.receipt_id} signature verified`);
      } else {
        this._log(`Receipt ${receipt.receipt_id} signature INVALID`);
      }

      return isValid;
    } catch (error) {
      this._log(`Receipt verification error: ${error.message}`);
      return false;
    }
  }
}

module.exports = new AttestationService();
module.exports.AttestationService = AttestationService;
