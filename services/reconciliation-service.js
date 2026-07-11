// /services/reconciliation-service.js
// Periodic + on-demand retry of stalled ERC-8004 Reputation Registry
// submissions for already-issued attestations. A different lifecycle stage
// than monitoring-service.js (which watches active commitments for new
// evidence, pre-scoring) — this acts on receipts that already exist.
//
// Uses setInterval rather than node-schedule's cron string: cron minute
// fields only range 0-59, and a `*/N * * * *` pattern silently misbehaves
// for N >= 60 (this service's default interval is 180 minutes / 3 hours).

const dataStore = require('./data-store');
const reputationService = require('../utils/erc8004-reputation');
const ipfsManager = require('../utils/ipfs-manager');
const erc8004Lookup = require('../utils/erc8004-lookup');

// Once in one of these states, an attestation is never retried again.
const TERMINAL_STATUSES = ['submitted', 'skipped_self_verification', 'failed_permanent'];
const MAX_RETRY_COUNT = 10;

class ReconciliationService {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [ReconciliationService] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  initialize() {
    this._log('Initialized');
  }

  /**
   * Start periodic reconciliation
   */
  start(intervalMinutes = 180) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcileAll().catch(error => {
        this._log('Scheduled reconciliation run failed', { error: error.message });
      });
    }, intervalMinutes * 60 * 1000);
    this._log(`Reconciliation started: checking every ${intervalMinutes} minutes`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._log('Reconciliation stopped');
    }
  }

  /**
   * Scan all attestations not yet in a terminal on-chain state and retry each.
   * @returns {Promise<{succeeded: number, skipped: number, failed: number, results: Array}>}
   */
  async reconcileAll() {
    if (this.running) {
      this._log('Reconciliation already in progress, skipping this run');
      return { succeeded: 0, skipped: 0, failed: 0, results: [] };
    }

    this.running = true;
    try {
      const all = await dataStore.listAttestations();
      const targets = all.filter(r => !TERMINAL_STATUSES.includes(r.metadata?.onchain_status));

      this._log(`Reconciling ${targets.length} attestation(s)`);

      let succeeded = 0;
      let skipped = 0;
      let failed = 0;
      const results = [];

      for (const receipt of targets) {
        const outcome = await this.reconcileOne(receipt);
        results.push(outcome);
        if (outcome.status === 'submitted') succeeded++;
        else if (outcome.status.startsWith('skipped')) skipped++;
        else failed++;
      }

      this._log('Reconciliation complete', { succeeded, skipped, failed });
      return { succeeded, skipped, failed, results };
    } finally {
      this.running = false;
    }
  }

  /**
   * Resolve a missing token ID if possible, then retry ERC-8004 submission
   * for a single receipt. Never throws.
   * @param {Object} receipt
   * @returns {Promise<{receipt_id: string, status: string, detail?: string}>}
   */
  async reconcileOne(receipt) {
    const retryCount = receipt.metadata?.onchain_retry_count || 0;
    if (retryCount >= MAX_RETRY_COUNT) {
      return {
        receipt_id: receipt.receipt_id,
        status: 'failed_permanent',
        detail: `retry cap (${MAX_RETRY_COUNT}) already reached`
      };
    }

    try {
      await reputationService.initialize();

      if (!receipt.recipient?.erc8004_token_id) {
        const network = reputationService.networkName || process.env.DEFAULT_NETWORK || 'base_mainnet';
        const tokenId = await erc8004Lookup.resolveTokenId(receipt.recipient?.wallet_address, network);
        if (tokenId) {
          receipt.recipient.erc8004_token_id = tokenId;
          await dataStore.saveAttestation(receipt);
          this._log(`Resolved ERC-8004 token ID ${tokenId} for ${receipt.receipt_id}`);
        }
      }

      let ipfsHash = receipt.reputation_context?.ipfs_uri?.replace('ipfs://', '');
      if (!ipfsHash) {
        const uploadResult = await ipfsManager.uploadJSON(receipt, {
          name: `attestation_${receipt.receipt_id}`
        });
        ipfsHash = uploadResult.ipfsHash;
        receipt.reputation_context = receipt.reputation_context || {};
        receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
      }

      const result = await reputationService.submitAttestation(receipt, ipfsHash);

      receipt.metadata.onchain_status = 'submitted';
      receipt.reputation_context.submission_index = result.feedbackIndex;
      receipt.reputation_context.submitted_at = new Date().toISOString();
      await dataStore.saveAttestation(receipt);

      await dataStore.saveReputationSubmission(receipt.receipt_id, {
        status: 'success',
        network: reputationService.networkName,
        transaction_hash: result.txHash,
        block_number: result.blockNumber,
        feedback_index: result.feedbackIndex,
        ipfs_hash: ipfsHash,
        ipfs_uri: `ipfs://${ipfsHash}`,
        submitted_at: new Date().toISOString()
      });

      return { receipt_id: receipt.receipt_id, status: 'submitted', detail: result.txHash };
    } catch (error) {
      let status = 'failed';
      if (error.message?.startsWith('SELF_VERIFICATION:')) {
        status = 'skipped_self_verification';
      } else if (error.message?.includes('erc8004_token_id')) {
        status = 'skipped_not_registered';
      }

      const nextRetryCount = retryCount + 1;
      if (status !== 'skipped_self_verification' && nextRetryCount >= MAX_RETRY_COUNT) {
        status = 'failed_permanent';
      }

      receipt.metadata.onchain_status = status;
      receipt.metadata.onchain_retry_count = nextRetryCount;

      try {
        await dataStore.saveAttestation(receipt);
        await dataStore.saveReputationSubmission(receipt.receipt_id, {
          status: 'failed',
          error: error.message,
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to persist reconciliation outcome for ${receipt.receipt_id}: ${trackingError.message}`);
      }

      return { receipt_id: receipt.receipt_id, status, detail: error.message };
    }
  }
}

module.exports = new ReconciliationService();
module.exports.ReconciliationService = ReconciliationService;
