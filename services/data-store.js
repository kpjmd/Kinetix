// /services/data-store.js
// CRUD operations for commitments and attestations stored as JSON files

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const COMMITMENTS_DIR = path.join(__dirname, '../data/commitments');
const ATTESTATIONS_DIR = path.join(__dirname, '../data/attestations');
const ERC8004_DIR = path.join(__dirname, '../data/erc8004');
const REPUTATION_SUBMISSIONS_DIR = path.join(__dirname, '../data/erc8004/reputation-submissions');
const X402_PAYMENTS_DIR = path.join(__dirname, '../data/x402-payments');
const APPROVAL_QUEUE_DIR = path.join(__dirname, '../data/approval-queue');

/**
 * Ensure data directories exist
 */
async function ensureDirectories() {
  await fs.mkdir(COMMITMENTS_DIR, { recursive: true });
  await fs.mkdir(ATTESTATIONS_DIR, { recursive: true });
  await fs.mkdir(ERC8004_DIR, { recursive: true });
  await fs.mkdir(REPUTATION_SUBMISSIONS_DIR, { recursive: true });
  await fs.mkdir(X402_PAYMENTS_DIR, { recursive: true });
  await fs.mkdir(APPROVAL_QUEUE_DIR, { recursive: true });
  console.log('[DataStore] Directories initialized');
}

/**
 * Generate a unique ID with prefix
 * @param {string} prefix - 'cmt_kx_' or 'rcpt_kx_'
 * @returns {string} Unique ID
 */
function generateId(prefix) {
  const random = crypto.randomBytes(6).toString('hex');
  return `${prefix}${random}`;
}

/**
 * Save a commitment to disk
 * @param {Object} commitment - Commitment object (must have commitment_id)
 * @returns {Promise<Object>} Saved commitment
 */
async function saveCommitment(commitment) {
  if (!commitment.commitment_id) {
    throw new Error('Commitment must have commitment_id');
  }
  const filePath = path.join(COMMITMENTS_DIR, `${commitment.commitment_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(commitment, null, 2), 'utf-8');
  return commitment;
}

/**
 * Load a commitment by ID
 * @param {string} commitmentId
 * @returns {Promise<Object|null>}
 */
async function loadCommitment(commitmentId) {
  const filePath = path.join(COMMITMENTS_DIR, `${commitmentId}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Update a commitment (load, merge, save)
 * @param {string} commitmentId
 * @param {Object} updates - Fields to merge
 * @returns {Promise<Object>} Updated commitment
 */
async function updateCommitment(commitmentId, updates) {
  const commitment = await loadCommitment(commitmentId);
  if (!commitment) {
    throw new Error(`Commitment not found: ${commitmentId}`);
  }
  Object.assign(commitment, updates);
  await saveCommitment(commitment);
  return commitment;
}

/**
 * List all commitments, optionally filtered by status
 * @param {string|null} status - Filter by status ('active', 'completed', 'failed', null for all)
 * @returns {Promise<Array>} Array of commitment objects
 */
async function listCommitments(status = null) {
  try {
    const files = await fs.readdir(COMMITMENTS_DIR);
    const commitments = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(COMMITMENTS_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );

    if (status) {
      return commitments.filter(c => c.status === status);
    }
    return commitments;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Save an attestation/receipt to disk
 * @param {Object} receipt - Receipt object (must have receipt_id)
 * @returns {Promise<Object>} Saved receipt
 */
async function saveAttestation(receipt) {
  if (!receipt.receipt_id) {
    throw new Error('Receipt must have receipt_id');
  }
  const filePath = path.join(ATTESTATIONS_DIR, `${receipt.receipt_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
  return receipt;
}

/**
 * Load an attestation by receipt_id
 * @param {string} receiptId
 * @returns {Promise<Object|null>}
 */
async function loadAttestation(receiptId) {
  const filePath = path.join(ATTESTATIONS_DIR, `${receiptId}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * List all attestations, optionally filtered
 * @param {Object} filters - { agent_id, status, verification_type }
 * @returns {Promise<Array>}
 */
async function listAttestations(filters = {}) {
  try {
    const files = await fs.readdir(ATTESTATIONS_DIR);
    const attestations = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(ATTESTATIONS_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );

    // Apply filters
    let filtered = attestations;
    if (filters.agent_id) {
      filtered = filtered.filter(a => a.recipient?.agent_id === filters.agent_id);
    }
    if (filters.status) {
      filtered = filtered.filter(a => a.verification_result?.status === filters.status);
    }
    if (filters.verification_type) {
      filtered = filtered.filter(a => a.commitment?.verification_type === filters.verification_type);
    }

    return filtered.sort((a, b) =>
      new Date(b.metadata.issued_at) - new Date(a.metadata.issued_at)
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Save ERC-8004 identity registration data
 * @param {string} network - 'base_mainnet' or 'base_sepolia'
 * @param {Object} data - Registration result
 * @returns {Promise<Object>}
 */
async function saveERC8004Identity(network, data) {
  const filePath = path.join(ERC8004_DIR, `identity-${network}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[DataStore] Saved ERC-8004 identity for ${network}`);
  return data;
}

/**
 * Load ERC-8004 identity registration data
 * @param {string} network - 'base_mainnet' or 'base_sepolia'
 * @returns {Promise<Object|null>}
 */
async function loadERC8004Identity(network) {
  const filePath = path.join(ERC8004_DIR, `identity-${network}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Get token ID for a network, or null if not registered
 * @param {string} network
 * @returns {Promise<string|null>}
 */
async function getERC8004TokenId(network) {
  const identity = await loadERC8004Identity(network);
  return identity ? identity.tokenId : null;
}

/**
 * Save reputation submission tracking data
 * @param {string} attestationId - Receipt ID
 * @param {Object} submissionData - Submission details
 * @returns {Promise<Object>}
 */
async function saveReputationSubmission(attestationId, submissionData) {
  const filePath = path.join(REPUTATION_SUBMISSIONS_DIR, `${attestationId}.json`);
  const data = {
    attestation_id: attestationId,
    ...submissionData,
    updated_at: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[DataStore] Saved reputation submission for ${attestationId}`);
  return data;
}

/**
 * Load reputation submission data
 * @param {string} attestationId
 * @returns {Promise<Object|null>}
 */
async function loadReputationSubmission(attestationId) {
  const filePath = path.join(REPUTATION_SUBMISSIONS_DIR, `${attestationId}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * List reputation submissions by status
 * @param {string} status - 'success', 'failed', 'pending', or null for all
 * @returns {Promise<Array>}
 */
async function listReputationSubmissions(status = null) {
  try {
    const files = await fs.readdir(REPUTATION_SUBMISSIONS_DIR);
    const submissions = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(REPUTATION_SUBMISSIONS_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );

    if (status) {
      return submissions.filter(s => s.status === status);
    }
    return submissions.sort((a, b) =>
      new Date(b.updated_at) - new Date(a.updated_at)
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Save x402 payment tracking
 * @param {Object} paymentData - Payment details
 * @returns {Promise<Object>} Saved payment record
 */
async function saveX402Payment(paymentData) {
  const paymentId = generateId('pay_x402_');
  const filePath = path.join(X402_PAYMENTS_DIR, `${paymentId}.json`);

  const payment = {
    payment_id: paymentId,
    x402_request_id: paymentData.x402_request_id,
    commitment_id: paymentData.commitment_id,
    amount: paymentData.amount,
    currency: paymentData.currency,
    tier: paymentData.tier,
    status: 'confirmed', // pending/confirmed/failed/refunded
    transaction_hash: paymentData.transaction_hash,
    created_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString()
  };

  await fs.writeFile(filePath, JSON.stringify(payment, null, 2), 'utf-8');
  return payment;
}

/**
 * Load payment by x402_request_id
 * @param {string} x402_request_id - x402 request identifier
 * @returns {Promise<Object|null>}
 */
async function loadX402Payment(x402_request_id) {
  try {
    const files = await fs.readdir(X402_PAYMENTS_DIR);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(X402_PAYMENTS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const payment = JSON.parse(content);

      if (payment.x402_request_id === x402_request_id) {
        return payment;
      }
    }

    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * List all x402 payments
 * @param {Object} filters - Optional filters { tier, status, commitment_id }
 * @returns {Promise<Array>}
 */
async function listX402Payments(filters = {}) {
  try {
    const files = await fs.readdir(X402_PAYMENTS_DIR);
    const payments = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(X402_PAYMENTS_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );

    let filtered = payments;
    if (filters.tier) {
      filtered = filtered.filter(p => p.tier === filters.tier);
    }
    if (filters.status) {
      filtered = filtered.filter(p => p.status === filters.status);
    }
    if (filters.commitment_id) {
      filtered = filtered.filter(p => p.commitment_id === filters.commitment_id);
    }

    return filtered.sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

module.exports = {
  ensureDirectories,
  generateId,
  saveCommitment,
  loadCommitment,
  updateCommitment,
  listCommitments,
  saveAttestation,
  loadAttestation,
  listAttestations,
  saveERC8004Identity,
  loadERC8004Identity,
  getERC8004TokenId,
  saveReputationSubmission,
  loadReputationSubmission,
  listReputationSubmissions,
  saveX402Payment,
  loadX402Payment,
  listX402Payments
};
